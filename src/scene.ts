import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import gsap from 'gsap';
import type { AudioEngine } from './audio';
import { damp, debounce, densityScale, isMobile, prefersReducedMotion } from './utils';

/** Per-frame data handed to every chapter. */
export interface FrameContext {
  dt: number;
  elapsed: number;
  audio: AudioEngine;
  reducedMotion: boolean;
  /** Normalized pointer (-1..1) */
  pointer: THREE.Vector2;
}

/** A scroll chapter that owns a THREE.Group inside the shared scene. */
export interface Chapter {
  readonly id: string;
  readonly group: THREE.Group;
  /** Scroll progress within the pinned section, 0..1 */
  progress: number;
  /** Crossfade opacity, animated by SceneManager */
  opacity: number;
  active: boolean;
  update(ctx: FrameContext, manager: SceneManager): void;
  setOpacity(value: number): void;
  setActive(active: boolean): void;
  dispose(): void;
}

const CLEAR_COLOR = 0x050507;

/** Bloom is switched off automatically if the average frame time stays above this for two windows. */
const BLOOM_MAX_FRAME_TIME = 1 / 36;
const BLOOM_PERF_WINDOW = 3; // seconds

/**
 * Per-chapter colour grade, applied in linear space right before the OutputPass.
 * tint multiplies mids/highlights, lift colours the shadows, saturation scales chroma,
 * spectral blends a slowly drifting rainbow wash over the frame (Frequency only).
 */
export interface GradePreset {
  tint: [number, number, number];
  lift: [number, number, number];
  saturation: number;
  spectral: number;
}

export const GRADES: Record<string, GradePreset> = {
  hero: { tint: [1, 1, 1], lift: [0, 0, 0], saturation: 1, spectral: 0 },
  // Signal: cold, desaturated blue with navy shadows
  signal: { tint: [0.7, 0.9, 1.25], lift: [0.0, 0.012, 0.034], saturation: 0.8, spectral: 0 },
  // Frequency: the whole spectrum – boosted saturation plus a rainbow wash
  frequency: { tint: [1.04, 1.0, 1.05], lift: [0.008, 0.004, 0.012], saturation: 1.4, spectral: 1 },
  // Synthesis: warm amber highlights, brown-orange shadows
  synthesis: { tint: [1.28, 1.0, 0.68], lift: [0.034, 0.014, 0.0], saturation: 1.06, spectral: 0 },
  // Convergence -> outro: calm, slightly cool and desaturated
  convergence: { tint: [0.96, 1.0, 1.08], lift: [0.004, 0.008, 0.02], saturation: 0.8, spectral: 0 },
};

/**
 * Grade + "signal noise" transition shader.
 * uGlitch (0..1) drives static, scanlines and a sweeping scan bar; uShake (0/1) enables the
 * displacement / RGB-split parts, which are disabled under prefers-reduced-motion.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uLift: { value: new THREE.Color(0, 0, 0) },
    uSaturation: { value: 1 },
    uSpectral: { value: 0 },
    uGlitch: { value: 0 },
    uShake: { value: 1 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform vec3 uLift;
    uniform float uSaturation;
    uniform float uSpectral;
    uniform float uGlitch;
    uniform float uShake;
    uniform float uTime;
    uniform vec2 uResolution;

    varying vec2 vUv;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123); }

    // hue 0..1 -> saturated rainbow
    vec3 spectrum(float h) {
      vec3 c = abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0;
      return clamp(c, 0.0, 1.0);
    }

    void main() {
      vec2 uv = vUv;
      float g = uGlitch;
      float t = uTime;
      float shake = g * uShake;

      // ---- signal noise: horizontal band tearing + vertical jitter ----
      if (shake > 0.001) {
        float band = floor(uv.y * 18.0 + t * 7.0);
        float r = hash(band + floor(t * 11.0));
        float tear = (r - 0.5) * step(0.72 - g * 0.45, r) * 0.085 * shake;
        uv.x += tear;
        uv.y += (hash(floor(t * 19.0)) - 0.5) * 0.012 * shake;
      }

      // ---- RGB split ----
      float split = 0.007 * shake;
      vec3 col;
      if (split > 0.0001) {
        col.r = texture2D(tDiffuse, uv + vec2(split, 0.0)).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - vec2(split, 0.0)).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // ---- chapter grade (linear space, before tone mapping) ----
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);
      col = col * uTint + uLift * (1.0 - smoothstep(0.0, 0.35, lum));
      if (uSpectral > 0.001) {
        vec3 spec = spectrum(fract(vUv.x * 0.9 + vUv.y * 0.25 + lum * 0.6 + t * 0.03));
        vec3 washed = col * (0.55 + spec * 0.95) + spec * 0.012;
        col = mix(col, washed, uSpectral);
      }

      // ---- static, fine scanlines, one bright scan bar sweeping down ----
      if (g > 0.001) {
        float grain = hash2(vUv * uResolution * 0.5 + fract(t) * 100.0);
        float scan = 0.5 + 0.5 * sin(vUv.y * uResolution.y * 1.2 + t * 30.0);
        float sweepPos = 1.0 - fract(t * 0.55);
        float sweep = smoothstep(0.05, 0.0, abs(vUv.y - sweepPos));
        col = mix(col, vec3(grain * 0.28), g * 0.55);
        col *= 1.0 - scan * 0.35 * g;
        col += vec3(0.65, 0.9, 1.0) * sweep * g * 0.3;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * SceneManager
 * ------------
 * Owns the renderer, camera, lights, starfield and the render loop.
 * Chapters register themselves and the manager crossfades between them.
 * Post-processing: RenderPass -> [UnrealBloomPass] -> GradePass (colour grade + transition noise) -> OutputPass.
 */
export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly fog: THREE.FogExp2;
  readonly pointer = new THREE.Vector2();
  readonly reducedMotion: boolean;

  private readonly clock = new THREE.Clock(false);
  private readonly chapters = new Map<string, Chapter>();
  private activeChapter: Chapter | null = null;

  private readonly cameraTargetPosition = new THREE.Vector3(0, 0.2, 8);
  private readonly cameraTargetLook = new THREE.Vector3(0, 0, 0);
  private readonly cameraLook = new THREE.Vector3(0, 0, 0);
  private cameraDamping = 4;
  private snapCameraNextFrame = true;
  // While a scripted sequence (hero preview fly-through) owns the camera, chapter camera
  // requests are ignored and driveCamera() writes the target directly.
  private cameraOverride = false;

  private readonly keyLight: THREE.PointLight;
  private readonly starfield: THREE.Points;
  private readonly starGeometry: THREE.BufferGeometry;
  private readonly starMaterial: THREE.PointsMaterial;

  private rafId: number | null = null;
  private running = false;
  private elapsed = 0;

  // Post-processing. The composer (grade + output) always exists; bloom is optional:
  // never on mobile, auto-disabled on slow desktops.
  private readonly composer: EffectComposer;
  private readonly gradePass: ShaderPass;
  private readonly outputPass: OutputPass;
  private bloomPass: UnrealBloomPass | null = null;
  private bloomOn = false;
  private bloomPerfDisabled = false;
  private perfAccum = 0;
  private perfFrames = 0;
  private perfSlowWindows = 0;

  // Colour grade state (tweened between chapter presets)
  private readonly grade = {
    tint: new THREE.Color(1, 1, 1),
    lift: new THREE.Color(0, 0, 0),
    saturation: 1,
    spectral: 0,
  };
  private currentGrade = 'hero';

  // Transition ("signal noise") intensity, 0..1, damped toward the scroll-driven target
  private transitionTarget = 0;
  private transition = 0;
  private lastGlitchVar = -1;

  private readonly onResize: () => void;
  private readonly onVisibility: () => void;
  private readonly onPointerMove: (event: PointerEvent) => void;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly audio: AudioEngine,
  ) {
    this.reducedMotion = prefersReducedMotion();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(CLEAR_COLOR, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.fog = new THREE.FogExp2(CLEAR_COLOR, 0.012);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      260,
    );
    this.camera.position.copy(this.cameraTargetPosition);
    this.camera.lookAt(this.cameraTargetLook);

    // ---- Composer: RenderPass -> (bloom) -> GradePass -> OutputPass ----
    const mobile = isMobile();
    const size = this.renderer.getSize(new THREE.Vector2());
    const pixelRatio = this.renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
      type: THREE.HalfFloatType,
      samples: mobile ? 0 : 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(size.x, size.y);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.uTint.value = this.grade.tint;
    this.gradePass.uniforms.uLift.value = this.grade.lift;
    this.gradePass.uniforms.uShake.value = this.reducedMotion ? 0 : 1;
    this.gradePass.uniforms.uResolution.value.set(size.x * pixelRatio, size.y * pixelRatio);
    this.composer.addPass(this.gradePass);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // Bloom only where the GPU budget allows it
    if (!mobile) this.setBloom(true);

    // Lights (shared by all chapters)
    const hemi = new THREE.HemisphereLight(0x8fa8ff, 0x140a1c, 0.7);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 8, 6);
    this.keyLight = new THREE.PointLight(0x5ee6ff, 18, 40, 1.6);
    this.scene.add(hemi, sun, this.keyLight);

    // Starfield (follows the camera like a sky shell)
    const starCount = Math.round(1800 * densityScale());
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 60 + Math.random() * 80;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    this.starGeometry = new THREE.BufferGeometry();
    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xbfd6ff,
      size: 0.45,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      fog: false,
    });
    this.starfield = new THREE.Points(this.starGeometry, this.starMaterial);
    this.starfield.frustumCulled = false;
    this.scene.add(this.starfield);

    // Events
    this.onResize = debounce(() => this.resize(), 150);
    this.onVisibility = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    this.onPointerMove = (event: PointerEvent) => {
      this.pointer.set(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1,
      );
    };
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
  }

  get active(): Chapter | null {
    return this.activeChapter;
  }

  /** Id of the colour-grade preset currently targeted (follows the active chapter). */
  get gradeId(): string {
    return this.currentGrade;
  }

  /** Current (damped) signal-noise transition intensity 0..1. */
  get transitionLevel(): number {
    return this.transition;
  }

  addChapter(chapter: Chapter): void {
    this.chapters.set(chapter.id, chapter);
    chapter.group.visible = false;
    chapter.opacity = 0;
    chapter.setOpacity(0);
    chapter.setActive(false);
    this.scene.add(chapter.group);
  }

  getChapter<T extends Chapter = Chapter>(id: string): T | undefined {
    return this.chapters.get(id) as T | undefined;
  }

  /** Crossfade to a chapter. Previous chapter fades out and is deactivated afterwards. */
  activate(id: string, immediate = false): void {
    const next = this.chapters.get(id);
    if (!next || next === this.activeChapter) return;

    const prev = this.activeChapter;
    this.activeChapter = next;

    next.group.visible = true;
    next.setActive(true);
    gsap.killTweensOf(next);
    gsap.to(next, {
      opacity: 1,
      duration: immediate ? 0 : 0.9,
      ease: 'power2.out',
      onUpdate: () => next.setOpacity(next.opacity),
    });

    if (prev) {
      gsap.killTweensOf(prev);
      gsap.to(prev, {
        opacity: 0,
        duration: immediate ? 0 : 0.7,
        ease: 'power2.in',
        onUpdate: () => prev.setOpacity(prev.opacity),
        onComplete: () => {
          if (this.activeChapter !== prev) {
            prev.group.visible = false;
            prev.setActive(false);
          }
        },
      });
    }

    this.setGrade(id, immediate);

    if (this.reducedMotion || immediate) {
      this.snapCameraNextFrame = true;
    }
  }

  /** Tween the full-screen colour grade to a chapter preset (falls back to neutral). */
  setGrade(id: string, immediate = false): void {
    const preset = GRADES[id] ?? GRADES.hero;
    this.currentGrade = id in GRADES ? id : 'hero';
    const duration = immediate ? 0 : 1.1;
    const ease = 'power2.inOut';
    gsap.killTweensOf(this.grade.tint);
    gsap.killTweensOf(this.grade.lift);
    gsap.killTweensOf(this.grade);
    gsap.to(this.grade.tint, { r: preset.tint[0], g: preset.tint[1], b: preset.tint[2], duration, ease });
    gsap.to(this.grade.lift, { r: preset.lift[0], g: preset.lift[1], b: preset.lift[2], duration, ease });
    gsap.to(this.grade, { saturation: preset.saturation, spectral: preset.spectral, duration, ease });
  }

  /**
   * Scroll-driven "signal noise" intensity (0..1) between chapters.
   * The value is damped per frame so quick scroll jumps still read as a short burst.
   */
  setTransition(intensity: number): void {
    this.transitionTarget = Math.min(1, Math.max(0, intensity)) * (this.reducedMotion ? 0.4 : 1);
  }

  /** Chapters call this every frame while active. Ignored while a camera override is set. */
  setCameraTarget(position: THREE.Vector3, look: THREE.Vector3, damping = 4): void {
    if (this.cameraOverride) return;
    this.cameraTargetPosition.copy(position);
    this.cameraTargetLook.copy(look);
    this.cameraDamping = damping;
  }

  /** True while a scripted sequence owns the camera (see driveCamera). */
  get hasCameraOverride(): boolean {
    return this.cameraOverride;
  }

  /**
   * Take the camera away from (or hand it back to) the active chapter.
   * Handing it back snaps the camera to the chapter's target on the next frame.
   */
  setCameraOverride(enabled: boolean): void {
    if (enabled === this.cameraOverride) return;
    this.cameraOverride = enabled;
    if (!enabled) this.snapCameraNextFrame = true;
  }

  /**
   * Write the camera target directly, bypassing the override guard (world space).
   * `snap` skips the damping for one frame — used for hard cuts.
   */
  driveCamera(position: THREE.Vector3, look: THREE.Vector3, damping = 6, snap = false): void {
    this.cameraTargetPosition.copy(position);
    this.cameraTargetLook.copy(look);
    this.cameraDamping = damping;
    if (snap) this.snapCameraNextFrame = true;
  }

  /**
   * Show or hide a non-active chapter outside the crossfade system (fully opaque, no tween).
   * The hero preview uses this to render a chapter's space while the hero stays the active chapter.
   */
  setChapterVisible(id: string, visible: boolean): void {
    const chapter = this.chapters.get(id);
    if (!chapter || chapter === this.activeChapter) return;
    gsap.killTweensOf(chapter);
    chapter.group.visible = visible;
    chapter.opacity = visible ? 1 : 0;
    chapter.setOpacity(chapter.opacity);
    chapter.setActive(visible);
  }

  snapCamera(): void {
    this.camera.position.copy(this.cameraTargetPosition);
    this.cameraLook.copy(this.cameraTargetLook);
    this.camera.lookAt(this.cameraLook);
  }

  setFogDensity(density: number, duration = 1): void {
    gsap.killTweensOf(this.fog);
    gsap.to(this.fog, { density, duration, ease: 'power2.inOut' });
  }

  /** Force-compile every chapter's shaders up front so the first frames don't hitch. */
  precompile(): void {
    const previous: boolean[] = [];
    const list = [...this.chapters.values()];
    for (const ch of list) {
      previous.push(ch.group.visible);
      ch.group.visible = true;
    }
    this.renderer.compile(this.scene, this.camera);
    list.forEach((ch, i) => {
      ch.group.visible = previous[i];
    });
  }

  get bloomEnabled(): boolean {
    return this.bloomOn;
  }

  /** True when bloom was turned off by the runtime performance guard. */
  get bloomDisabledByPerformance(): boolean {
    return this.bloomPerfDisabled;
  }

  /**
   * Toggle UnrealBloom post-processing. The bloom pass is inserted right after the RenderPass;
   * the grade pass and OutputPass (tone mapping + sRGB) stay in place either way.
   */
  setBloom(enabled: boolean): void {
    if (enabled === this.bloomOn) return;

    if (enabled) {
      const size = this.renderer.getSize(new THREE.Vector2());
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.45, 0.82);
      this.composer.insertPass(this.bloomPass, 1);
    } else if (this.bloomPass) {
      this.composer.removePass(this.bloomPass);
      this.bloomPass.dispose();
      this.bloomPass = null;
    }

    this.bloomOn = enabled;
  }

  private renderFrame(): void {
    this.composer.render();
  }

  /** Drop bloom if the frame budget is consistently blown (checked in 3-second windows). */
  private guardBloomPerformance(dt: number): void {
    if (!this.bloomOn) return;
    this.perfAccum += dt;
    this.perfFrames += 1;
    if (this.perfAccum < BLOOM_PERF_WINDOW) return;

    const average = this.perfAccum / this.perfFrames;
    this.perfAccum = 0;
    this.perfFrames = 0;
    if (average > BLOOM_MAX_FRAME_TIME) {
      this.perfSlowWindows += 1;
      if (this.perfSlowWindows >= 2) {
        this.setBloom(false);
        this.bloomPerfDisabled = true;
        console.info(`[ECHO] Bloom disabled: average frame time ${(average * 1000).toFixed(1)}ms`);
      }
    } else {
      this.perfSlowWindows = 0;
    }
  }

  /**
   * Render one fresh frame and return it as a PNG data URL.
   * The WebGL drawing buffer is cleared after each frame (preserveDrawingBuffer is off),
   * so we render synchronously right before reading it back.
   */
  capture(): string {
    this.renderFrame();
    return this.renderer.domElement.toDataURL('image/png');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Stop requesting frames (used when the tab is hidden). Audio keeps playing. */
  pause(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clock.stop();
  }

  resume(): void {
    if (!this.running || this.rafId !== null) return;
    this.clock.start();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    this.pause();
  }

  private updatePostUniforms(dt: number): void {
    const u = this.gradePass.uniforms;
    u.uTime.value = this.elapsed;
    u.uSaturation.value = this.grade.saturation;
    u.uSpectral.value = this.grade.spectral;

    this.transition = damp(this.transition, this.transitionTarget, 14, dt);
    if (this.transition < 0.002) this.transition = 0;
    u.uGlitch.value = this.transition;

    // Mirror the intensity to CSS so the chapter titles can split/shift with the frame
    const cssValue = Math.round(this.transition * 200) / 200;
    if (cssValue !== this.lastGlitchVar) {
      this.lastGlitchVar = cssValue;
      document.documentElement.style.setProperty('--glitch', cssValue.toFixed(3));
    }
  }

  private readonly loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;

    this.audio.update(dt);

    const ctx: FrameContext = {
      dt,
      elapsed: this.elapsed,
      audio: this.audio,
      reducedMotion: this.reducedMotion,
      pointer: this.pointer,
    };

    for (const chapter of this.chapters.values()) {
      if (chapter.group.visible) chapter.update(ctx, this);
    }

    // Camera follow
    if (this.snapCameraNextFrame) {
      this.snapCamera();
      this.snapCameraNextFrame = false;
    } else {
      const damping = this.reducedMotion ? 12 : this.cameraDamping;
      const k = 1 - Math.exp(-damping * dt);
      this.camera.position.lerp(this.cameraTargetPosition, k);
      this.cameraLook.lerp(this.cameraTargetLook, k);
      this.camera.lookAt(this.cameraLook);
    }

    // Key light rides slightly above the camera
    this.keyLight.position.copy(this.camera.position);
    this.keyLight.position.y += 2;
    this.keyLight.intensity = 14 + this.audio.level * 24;

    // Starfield: shell around camera, slow drift, subtle loudness pulse
    this.starfield.position.copy(this.camera.position);
    this.starfield.rotation.y += dt * (this.reducedMotion ? 0.002 : 0.01);
    this.starMaterial.size = 0.45 + this.audio.level * 0.35;
    this.starMaterial.opacity = 0.6 + this.audio.treble * 0.4;

    this.updatePostUniforms(dt);
    this.renderFrame();
    this.guardBloomPerformance(dt);
  };

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.gradePass.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pointermove', this.onPointerMove);

    for (const chapter of this.chapters.values()) {
      gsap.killTweensOf(chapter);
      chapter.dispose();
      this.scene.remove(chapter.group);
    }
    this.chapters.clear();
    gsap.killTweensOf(this.grade.tint);
    gsap.killTweensOf(this.grade.lift);
    gsap.killTweensOf(this.grade);

    this.starGeometry.dispose();
    this.starMaterial.dispose();
    this.scene.remove(this.starfield);

    this.setBloom(false);
    this.gradePass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
