import * as THREE from 'three';
import type { AudioEngine } from '../audio';
import type { FrameContext, SceneManager } from '../scene';
import { damp, densityScale, isMobile, lerp, smoothstep } from '../utils';
import { BaseChapter } from './base';

const SPECTRUM_TEXELS = 128;
const MIN_HZ = 60;
const MAX_HZ = 6000;
const PARTICLE_MAX_RADIUS = 14;

// Note trails: each played note leaves a short spiral streak that fades out
const TRAIL_POINTS = 40;
const TRAIL_DURATION = 2.2; // seconds until fully gone
const TRAIL_TRAVEL = 1.0; // seconds the head keeps moving

interface TrailState {
  active: boolean;
  age: number;
  travel: number;
  angle0: number;
  spin: number;
  pitch: number;
}

const trailVertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aColor;

  uniform float uSize;
  uniform float uPixelRatio;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    if (aAlpha <= 0.001) {
      // Park inactive points off-screen
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (0.35 + aAlpha) * uPixelRatio * (220.0 / max(1.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const trailFragmentShader = /* glsl */ `
  uniform float uOpacity;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float soft = smoothstep(0.5, 0.1, d);
    // Colour pushed above 1.0 so the bloom pass picks the streak up
    gl_FragColor = vec4(vColor * 1.6, soft * vAlpha * uOpacity);
  }
`;

const sphereVertexShader = /* glsl */ `
  uniform sampler2D uSpectrum;
  uniform float uTime;
  uniform float uLevel;
  uniform float uBass;
  uniform float uImpulse;

  varying float vDisplacement;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vec3 n = normalize(normal);

    // Map the surface direction onto the (log-scaled) spectrum texture so that
    // different notes push different regions of the sphere.
    float azimuth = atan(n.z, n.x) / 6.28318530718 + 0.5;
    float elevation = n.y * 0.5 + 0.5;
    float u = fract(azimuth + elevation * 0.35);
    float energy = texture2D(uSpectrum, vec2(u, 0.5)).r;

    float ripple = sin(elevation * 14.0 + uTime * 2.2) * 0.05 * uLevel;
    float displacement =
      energy * energy * (0.9 + uImpulse * 0.9) +
      uLevel * 0.22 +
      uBass * 0.14 +
      ripple;

    vDisplacement = displacement;
    vec3 displaced = position + n * displacement;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * n);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const sphereFragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  uniform float uWire;

  varying float vDisplacement;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.5);
    vec3 color = mix(uColorA, uColorB, clamp(vDisplacement * 1.4, 0.0, 1.0));
    color += fresnel * 0.55;
    float alpha = mix(0.55 + fresnel * 0.35, 0.85, uWire) * uOpacity;
    gl_FragColor = vec4(color, alpha);
  }
`;

const particleVertexShader = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;

  uniform float uSize;
  uniform float uPixelRatio;

  varying float vLife;
  varying float vSeed;

  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float size = uSize * (0.6 + aSeed * 0.8) * (1.0 - aLife * 0.6);
    gl_PointSize = size * uPixelRatio * (220.0 / max(1.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const particleFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uColorAlt;
  uniform float uOpacity;

  varying float vLife;
  varying float vSeed;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float soft = smoothstep(0.5, 0.12, d);
    float fade = 1.0 - vLife;
    vec3 color = mix(uColor, uColorAlt, vSeed);
    gl_FragColor = vec4(color, soft * fade * uOpacity);
  }
`;

/**
 * Chapter 3 — Synthesis
 * Central sphere displaced by the live spectrum (drone + whatever the user plays),
 * surrounded by particles whose outward speed follows loudness.
 * `burst()` is called from the pads to add a directional impulse and recolour.
 */
export class SynthesisChapter extends BaseChapter {
  private readonly sphereMaterial: THREE.ShaderMaterial;
  private readonly wireMaterial: THREE.ShaderMaterial;
  private readonly sphere: THREE.Mesh;
  private readonly wire: THREE.Mesh;

  private readonly spectrumData: Uint8Array<ArrayBuffer>;
  private readonly spectrumTexture: THREE.DataTexture;
  private readonly texelBinLow: Uint16Array;
  private readonly texelBinHigh: Uint16Array;

  private readonly particleCount: number;
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particlePositions: Float32Array;
  private readonly particleVelocities: Float32Array;
  private readonly particleLife: Float32Array;
  private pendingBurst = 0;
  private burstDirection = new THREE.Vector3(0, 1, 0);

  private readonly targetColor = new THREE.Color(0x5ee6ff);
  private readonly targetColorAlt = new THREE.Color(0xff5ea8);

  private readonly maxTrails: number;
  private readonly trailStates: TrailState[];
  private readonly trailPositions: Float32Array;
  private readonly trailAlpha: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly trailColor = new THREE.Color();
  private readonly trailHead = new THREE.Vector3();
  private nextTrail = 0;

  private orbit = 0;

  constructor(private readonly audio: AudioEngine) {
    super('synthesis', new THREE.Vector3(0, -210, 0));

    const mobile = isMobile();

    // ---- Spectrum texture (log-resampled FFT) ----
    this.spectrumData = new Uint8Array(SPECTRUM_TEXELS);
    this.spectrumTexture = this.track(
      new THREE.DataTexture(
        this.spectrumData,
        SPECTRUM_TEXELS,
        1,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      ),
    );
    this.spectrumTexture.minFilter = THREE.LinearFilter;
    this.spectrumTexture.magFilter = THREE.LinearFilter;
    this.spectrumTexture.wrapS = THREE.RepeatWrapping;
    this.spectrumTexture.unpackAlignment = 1;
    this.spectrumTexture.needsUpdate = true;

    this.texelBinLow = new Uint16Array(SPECTRUM_TEXELS);
    this.texelBinHigh = new Uint16Array(SPECTRUM_TEXELS);
    const ratio = MAX_HZ / MIN_HZ;
    for (let i = 0; i < SPECTRUM_TEXELS; i++) {
      const f0 = MIN_HZ * Math.pow(ratio, i / SPECTRUM_TEXELS);
      const f1 = MIN_HZ * Math.pow(ratio, (i + 1) / SPECTRUM_TEXELS);
      const b0 = audio.binForFrequency(f0);
      const b1 = Math.max(b0, audio.binForFrequency(f1) - 1);
      this.texelBinLow[i] = b0;
      this.texelBinHigh[i] = b1;
    }

    // ---- Sphere ----
    const sphereGeometry = this.track(new THREE.IcosahedronGeometry(1.7, mobile ? 4 : 5));
    const sharedUniforms = () => ({
      uSpectrum: { value: this.spectrumTexture },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBass: { value: 0 },
      uImpulse: { value: 0 },
      uColorA: { value: new THREE.Color(0x0c1a3a) },
      uColorB: { value: new THREE.Color(0x5ee6ff) },
      uOpacity: { value: 1 },
      uWire: { value: 0 },
    });

    this.sphereMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: sharedUniforms(),
        vertexShader: sphereVertexShader,
        fragmentShader: sphereFragmentShader,
        transparent: true,
        depthWrite: true,
      }),
    );
    this.sphere = new THREE.Mesh(sphereGeometry, this.sphereMaterial);

    this.wireMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: sharedUniforms(),
        vertexShader: sphereVertexShader,
        fragmentShader: sphereFragmentShader,
        transparent: true,
        wireframe: true,
        depthWrite: false,
      }),
    );
    this.wireMaterial.uniforms.uWire.value = 1;
    this.wireMaterial.uniforms.uColorA.value = new THREE.Color(0x224466);
    this.wireMaterial.uniforms.uColorB.value = new THREE.Color(0xffffff);
    this.wire = new THREE.Mesh(sphereGeometry, this.wireMaterial);

    // ---- Particles ----
    this.particleCount = Math.round(1400 * densityScale());
    this.particlePositions = new Float32Array(this.particleCount * 3);
    this.particleVelocities = new Float32Array(this.particleCount * 3);
    this.particleLife = new Float32Array(this.particleCount);
    const seeds = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) {
      this.respawn(i, 1, Math.random());
      seeds[i] = Math.random();
    }

    this.particleGeometry = this.track(new THREE.BufferGeometry());
    const posAttr = new THREE.BufferAttribute(this.particlePositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const lifeAttr = new THREE.BufferAttribute(this.particleLife, 1);
    lifeAttr.setUsage(THREE.DynamicDrawUsage);
    this.particleGeometry.setAttribute('position', posAttr);
    this.particleGeometry.setAttribute('aLife', lifeAttr);
    this.particleGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.particleMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: {
          uSize: { value: 0.09 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
          uColor: { value: new THREE.Color(0x5ee6ff) },
          uColorAlt: { value: new THREE.Color(0xff5ea8) },
          uOpacity: { value: 1 },
        },
        vertexShader: particleVertexShader,
        fragmentShader: particleFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    particles.frustumCulled = false;

    // ---- Note trails ----
    this.maxTrails = mobile ? 6 : 12;
    const trailVertexCount = this.maxTrails * TRAIL_POINTS;
    this.trailStates = Array.from({ length: this.maxTrails }, () => ({
      active: false,
      age: 0,
      travel: 0,
      angle0: 0,
      spin: 1,
      pitch: 0,
    }));
    this.trailPositions = new Float32Array(trailVertexCount * 3);
    this.trailAlpha = new Float32Array(trailVertexCount);
    this.trailColors = new Float32Array(trailVertexCount * 3);

    this.trailGeometry = this.track(new THREE.BufferGeometry());
    const trailPos = new THREE.BufferAttribute(this.trailPositions, 3);
    trailPos.setUsage(THREE.DynamicDrawUsage);
    const trailAlphaAttr = new THREE.BufferAttribute(this.trailAlpha, 1);
    trailAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    const trailColorAttr = new THREE.BufferAttribute(this.trailColors, 3);
    trailColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.trailGeometry.setAttribute('position', trailPos);
    this.trailGeometry.setAttribute('aAlpha', trailAlphaAttr);
    this.trailGeometry.setAttribute('aColor', trailColorAttr);

    this.trailMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: {
          uSize: { value: 0.16 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
          uOpacity: { value: 1 },
        },
        vertexShader: trailVertexShader,
        fragmentShader: trailFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const trails = new THREE.Points(this.trailGeometry, this.trailMaterial);
    trails.frustumCulled = false;

    this.group.add(this.sphere, this.wire, particles, trails);

    this.onFade((o) => {
      this.sphereMaterial.uniforms.uOpacity.value = o;
      this.wireMaterial.uniforms.uOpacity.value = o;
      this.particleMaterial.uniforms.uOpacity.value = o;
      this.trailMaterial.uniforms.uOpacity.value = o;
    });
  }

  /** Number of trails currently visible (exposed for diagnostics). */
  get activeTrailCount(): number {
    return this.trailStates.filter((state) => state.active).length;
  }

  /** Position of a trail head for travel parameter `t` (0..1): a rising spiral leaving the sphere. */
  private trailHeadPosition(state: TrailState, t: number, out: THREE.Vector3): THREE.Vector3 {
    const radius = 1.9 + t * 4.8;
    const angle = state.angle0 + t * state.spin;
    const y = lerp(-1.2, 3.2, state.pitch) * t + Math.sin(t * Math.PI) * 0.9;
    return out.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  }

  /**
   * Start a trail for the note at `index`. Lower notes spiral low and wide,
   * higher notes climb; alternate notes spin in opposite directions.
   */
  private spawnTrail(index: number, total: number): void {
    const t = total > 1 ? index / (total - 1) : 0;
    const slot = this.nextTrail;
    this.nextTrail = (slot + 1) % this.maxTrails;

    const state = this.trailStates[slot];
    state.active = true;
    state.age = 0;
    state.travel = 0;
    state.angle0 = t * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    state.spin = (index % 2 === 0 ? 1 : -1) * (2.6 + Math.random() * 0.8);
    state.pitch = t;

    this.trailColor.setHSL(0.5 + t * 0.4, 0.9, 0.65);
    this.trailHeadPosition(state, 0, this.trailHead);

    const base = slot * TRAIL_POINTS;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const o = (base + i) * 3;
      this.trailPositions[o] = this.trailHead.x;
      this.trailPositions[o + 1] = this.trailHead.y;
      this.trailPositions[o + 2] = this.trailHead.z;
      this.trailColors[o] = this.trailColor.r;
      this.trailColors[o + 1] = this.trailColor.g;
      this.trailColors[o + 2] = this.trailColor.b;
      this.trailAlpha[base + i] = 0;
    }
    (this.trailGeometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateTrails(dt: number, level: number): void {
    for (let s = 0; s < this.maxTrails; s++) {
      const state = this.trailStates[s];
      const base = s * TRAIL_POINTS;
      if (!state.active) continue;

      state.age += dt;
      if (state.age >= TRAIL_DURATION) {
        state.active = false;
        for (let i = 0; i < TRAIL_POINTS; i++) this.trailAlpha[base + i] = 0;
        continue;
      }

      // Head speed follows loudness a little, so louder passages throw longer streaks
      state.travel = Math.min(TRAIL_TRAVEL, state.travel + dt * (0.85 + level * 0.5));
      this.trailHeadPosition(state, state.travel / TRAIL_TRAVEL, this.trailHead);

      // Shift history back by one and write the new head
      for (let i = TRAIL_POINTS - 1; i > 0; i--) {
        const dst = (base + i) * 3;
        const src = (base + i - 1) * 3;
        this.trailPositions[dst] = this.trailPositions[src];
        this.trailPositions[dst + 1] = this.trailPositions[src + 1];
        this.trailPositions[dst + 2] = this.trailPositions[src + 2];
      }
      const headOffset = base * 3;
      this.trailPositions[headOffset] = this.trailHead.x;
      this.trailPositions[headOffset + 1] = this.trailHead.y;
      this.trailPositions[headOffset + 2] = this.trailHead.z;

      const fade = 1 - smoothstep(0.45, 1, state.age / TRAIL_DURATION);
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const tail = 1 - i / TRAIL_POINTS;
        this.trailAlpha[base + i] = Math.pow(tail, 1.2) * fade;
      }
    }

    // 480 vertices at most — always uploading is cheaper than tracking dirtiness
    (this.trailGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Reset particle `i` near the sphere surface with an outward velocity. */
  private respawn(i: number, speedScale: number, initialLife: number, direction?: THREE.Vector3): void {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    let dx = Math.sin(phi) * Math.cos(theta);
    let dy = Math.sin(phi) * Math.sin(theta);
    let dz = Math.cos(phi);

    if (direction) {
      // Bias the burst towards a direction so different pads feel different
      dx = dx * 0.55 + direction.x;
      dy = dy * 0.55 + direction.y;
      dz = dz * 0.55 + direction.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
    }

    const radius = 1.8 + Math.random() * 0.4 + initialLife * 6;
    const o = i * 3;
    this.particlePositions[o] = dx * radius;
    this.particlePositions[o + 1] = dy * radius;
    this.particlePositions[o + 2] = dz * radius;

    const speed = (0.6 + Math.random() * 0.9) * speedScale;
    this.particleVelocities[o] = dx * speed;
    this.particleVelocities[o + 1] = dy * speed;
    this.particleVelocities[o + 2] = dz * speed;

    this.particleLife[i] = initialLife;
  }

  /**
   * Called when a pad fires. `index` (0..8) selects a hue and a burst direction.
   * The audible note itself is what deforms the sphere — this only adds the particle kick.
   */
  burst(index: number, total = 9): void {
    const t = total > 1 ? index / (total - 1) : 0;
    this.targetColor.setHSL(0.5 + t * 0.4, 0.9, 0.62);
    this.targetColorAlt.setHSL(0.85 - t * 0.35, 0.9, 0.6);

    const angle = t * Math.PI * 2;
    this.burstDirection.set(Math.cos(angle), lerp(-0.4, 0.9, t), Math.sin(angle)).normalize();
    this.pendingBurst += Math.round(this.particleCount * 0.14);

    this.spawnTrail(index, total);
  }

  update(ctx: FrameContext, manager: SceneManager): void {
    const { dt, elapsed, audio, reducedMotion } = ctx;

    // ---- Spectrum -> texture ----
    const spectrum = this.audio.frequency;
    for (let i = 0; i < SPECTRUM_TEXELS; i++) {
      const lo = this.texelBinLow[i];
      const hi = this.texelBinHigh[i];
      let max = 0;
      for (let b = lo; b <= hi; b++) if (spectrum[b] > max) max = spectrum[b];
      this.spectrumData[i] = max;
    }
    this.spectrumTexture.needsUpdate = true;

    for (const material of [this.sphereMaterial, this.wireMaterial]) {
      material.uniforms.uTime.value = elapsed;
      material.uniforms.uLevel.value = audio.level;
      material.uniforms.uBass.value = audio.bass;
      material.uniforms.uImpulse.value = audio.impulse;
    }
    const colorB = this.sphereMaterial.uniforms.uColorB.value as THREE.Color;
    colorB.lerp(this.targetColor, 1 - Math.exp(-6 * dt));

    const spin = reducedMotion ? 0.05 : 0.18;
    this.sphere.rotation.y += dt * spin;
    this.sphere.rotation.x += dt * spin * 0.35;
    this.wire.rotation.copy(this.sphere.rotation);

    // ---- Particles ----
    const speed = 0.5 + audio.level * 4.5 + audio.impulse * 6;
    const lifeRate = 0.22 + audio.level * 0.6;
    const positions = this.particlePositions;
    const velocities = this.particleVelocities;
    const life = this.particleLife;
    const maxR2 = PARTICLE_MAX_RADIUS * PARTICLE_MAX_RADIUS;

    for (let i = 0; i < this.particleCount; i++) {
      const o = i * 3;
      positions[o] += velocities[o] * speed * dt;
      positions[o + 1] += velocities[o + 1] * speed * dt;
      positions[o + 2] += velocities[o + 2] * speed * dt;
      life[i] += lifeRate * dt;

      const r2 = positions[o] ** 2 + positions[o + 1] ** 2 + positions[o + 2] ** 2;
      if (life[i] >= 1 || r2 > maxR2) {
        if (this.pendingBurst > 0) {
          this.pendingBurst--;
          this.respawn(i, 2.2, 0, this.burstDirection);
        } else {
          this.respawn(i, 1, 0);
        }
      }
    }

    // Spend any leftover burst budget on the oldest particles right away
    if (this.pendingBurst > 0) {
      let scanned = 0;
      for (let i = 0; i < this.particleCount && this.pendingBurst > 0 && scanned < this.particleCount; i++, scanned++) {
        if (life[i] > 0.5) {
          this.pendingBurst--;
          this.respawn(i, 2.2, 0, this.burstDirection);
        }
      }
      this.pendingBurst = 0;
    }

    (this.particleGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.particleGeometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;

    this.updateTrails(dt, audio.level);

    this.particleMaterial.uniforms.uSize.value = 0.08 + audio.level * 0.12 + audio.impulse * 0.05;
    (this.particleMaterial.uniforms.uColor.value as THREE.Color).lerp(this.targetColor, 1 - Math.exp(-5 * dt));
    (this.particleMaterial.uniforms.uColorAlt.value as THREE.Color).lerp(
      this.targetColorAlt,
      1 - Math.exp(-5 * dt),
    );

    if (manager.active !== this) return;

    this.smoothProgress = damp(this.smoothProgress, this.progress, 6, dt);
    const p = this.smoothProgress;

    if (reducedMotion) {
      this.camPos.set(0, 1.2, 9.5 - p * 1.5);
      this.camLook.set(0, 0, 0);
      this.applyCamera(manager, 12);
      return;
    }

    // Slow orbit; scrolling pulls the camera closer and around
    this.orbit += dt * 0.12;
    const angle = this.orbit + p * 1.6;
    const dist = lerp(10, 6.8, p) - audio.level * 0.6;
    this.camPos.set(Math.sin(angle) * dist, 1.4 + Math.sin(elapsed * 0.22) * 0.5 + p * 0.8, Math.cos(angle) * dist);
    this.camLook.set(0, 0, 0);
    this.applyCamera(manager, 3.5);
  }

  dispose(): void {
    super.dispose();
  }
}
