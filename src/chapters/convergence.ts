import * as THREE from 'three';
import type { AudioEngine } from '../audio';
import type { FrameContext, SceneManager } from '../scene';
import { clamp, damp, densityScale, lerp, smoothstep } from '../utils';
import { BaseChapter } from './base';

/**
 * Convergence (Synthesis → Outro)
 * -------------------------------
 * Afterimages of the three motifs seen so far — Signal's waveform ribbon, Frequency's spectrum
 * field and Synthesis's particles — drawn as light ghosts around one point. Driven purely by
 * scroll progress (GSAP scrub):
 *
 *   0.00 – 0.50  gather: every vertex spirals in toward the centre and condenses
 *   0.50 – 0.62  hold:   ribbon and bars dissolve into a single bright core that breathes with the loudness
 *   0.62 – 1.00  disperse: the core lets go and the dust softly scatters into a sparse, slowly
 *                drifting field — the calm background the outro sits on.
 *
 * The ghosts still read the live analyser buffers, so the ribbon undulates and the bars breathe
 * right up until they are pulled into the core. Everything is a few hundred vertices, updated
 * on the CPU each frame; there is no simulation state, so scrubbing backwards is exact.
 *
 * The chapter shares Synthesis's world origin on purpose: the crossfade happens in place, so the
 * afterimages surface exactly where the sphere and its particles were, with no camera flight.
 */

const RIBBON_POINTS = 192;
const RIBBON_LENGTH = 18;
const RIBBON_Y = 3.1;
const RIBBON_AMPLITUDE = 1.15;

const BAR_COLS = 14;
const BAR_ROWS = 6;
const BAR_SPACING = 0.62;
const BAR_BASE_Y = -3.7;
const BAR_MAX_HEIGHT = 1.9;
const BAR_MIN_HZ = 40;
const BAR_MAX_HZ = 8000;

const CORE_RADIUS = 0.5; // condensed jitter radius
const DISPERSE_RADIUS = [7, 22] as const;

const pointVertexShader = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uScale;
  uniform float uPixelRatio;

  varying float vSeed;

  void main() {
    vSeed = aSeed;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale * uPixelRatio * (220.0 / max(1.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const pointFragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uHalo;

  varying float vSeed;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float disc = smoothstep(0.5, 0.12, d);
    float halo = pow(max(0.0, 1.0 - d * 2.0), 3.2);
    float soft = mix(disc, halo, uHalo);
    // Pushed above 1.0 while glowing so the bloom pass picks the core up
    vec3 color = mix(uColorA, uColorB, vSeed) * (1.0 + uGlow * 1.8);
    gl_FragColor = vec4(color, soft * uOpacity);
  }
`;

interface GhostSet {
  count: number;
  /** Chapter-local resting layout, refreshed every frame from the live audio buffers. */
  home: Float32Array;
  /** Jittered point near the centre each vertex condenses into. */
  core: Float32Array;
  /** Where each vertex ends up after dispersing. */
  spread: Float32Array;
  /** Per-vertex swirl angle (radians at full gather), stagger (0..1) and drift phase. */
  swirl: Float32Array;
  stagger: Float32Array;
  phase: Float32Array;
  /** Output positions handed to the geometry / instance matrices. */
  out: Float32Array;
}

function makeGhostSet(count: number): GhostSet {
  const set: GhostSet = {
    count,
    home: new Float32Array(count * 3),
    core: new Float32Array(count * 3),
    spread: new Float32Array(count * 3),
    swirl: new Float32Array(count),
    stagger: new Float32Array(count),
    phase: new Float32Array(count),
    out: new Float32Array(count * 3),
  };
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    // Core: dense at the very centre, thinning outwards
    const r = CORE_RADIUS * Math.pow(Math.random(), 2.2) + 0.06;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    set.core[o] = r * Math.sin(phi) * Math.cos(theta);
    set.core[o + 1] = r * Math.sin(phi) * Math.sin(theta);
    set.core[o + 2] = r * Math.cos(phi) * 0.6;

    // Spread: a wide, slightly flattened shell
    const R = lerp(DISPERSE_RADIUS[0], DISPERSE_RADIUS[1], Math.pow(Math.random(), 0.8));
    const theta2 = Math.random() * Math.PI * 2;
    const phi2 = Math.acos(2 * Math.random() - 1);
    set.spread[o] = R * Math.sin(phi2) * Math.cos(theta2);
    set.spread[o + 1] = R * Math.sin(phi2) * Math.sin(theta2) * 0.7;
    set.spread[o + 2] = R * Math.cos(phi2) * 0.8 - 2;

    set.swirl[i] = (Math.random() - 0.5) * 2 * Math.PI * 1.2;
    set.stagger[i] = Math.random();
    set.phase[i] = Math.random() * Math.PI * 2;
  }
  return set;
}

export class ConvergenceChapter extends BaseChapter {
  // Ribbon ghosts (two lines: trace + echo)
  private readonly ribbon: GhostSet;
  private readonly echo: GhostSet;
  private readonly ribbonGeometry: THREE.BufferGeometry;
  private readonly echoGeometry: THREE.BufferGeometry;
  private readonly ribbonMaterial: THREE.LineBasicMaterial;
  private readonly echoMaterial: THREE.LineBasicMaterial;
  private readonly wave = new Float32Array(RIBBON_POINTS);

  // Spectrum ghosts
  private readonly bars: GhostSet;
  private readonly barMesh: THREE.InstancedMesh;
  private readonly barMaterial: THREE.MeshBasicMaterial;
  private readonly barValues: Float32Array;
  private readonly barBinLow: Uint16Array;
  private readonly barBinHigh: Uint16Array;
  private readonly barScale = new Float32Array(BAR_COLS * BAR_ROWS);
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  // Particle ghosts + core
  private readonly dust: GhostSet;
  private readonly dustOrbit: Float32Array; // radius, azimuth, elevation, speed per particle
  private readonly dustGeometry: THREE.BufferGeometry;
  private readonly dustMaterial: THREE.ShaderMaterial;
  private readonly coreMaterial: THREE.ShaderMaterial;

  private glow = 0;
  private time = 0;

  constructor(audio: AudioEngine) {
    super('convergence', new THREE.Vector3(0, -210, 0));

    // ---- Ribbon ----
    this.ribbon = makeGhostSet(RIBBON_POINTS);
    this.echo = makeGhostSet(RIBBON_POINTS);
    // The ribbon has to stay a continuous curve while it is pulled in, so its stagger and swirl vary
    // smoothly along its length instead of per vertex: the middle goes first, the ends trail, and the
    // two halves twist in opposite directions so the line coils into the core.
    for (const [set, flip] of [
      [this.ribbon, 1],
      [this.echo, -1],
    ] as const) {
      for (let i = 0; i < RIBBON_POINTS; i++) {
        const u = i / (RIBBON_POINTS - 1);
        set.stagger[i] = Math.abs(u - 0.5) * 2;
        set.swirl[i] = flip * (u - 0.5) * 2 * Math.PI * 0.9;
      }
    }
    this.ribbonGeometry = this.track(new THREE.BufferGeometry());
    this.echoGeometry = this.track(new THREE.BufferGeometry());
    for (const [geometry, set] of [
      [this.ribbonGeometry, this.ribbon],
      [this.echoGeometry, this.echo],
    ] as const) {
      const attr = new THREE.BufferAttribute(set.out, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', attr);
    }
    this.ribbonMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0x8fe9ff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.echoMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0xff5ea8, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    const ribbonLine = new THREE.Line(this.ribbonGeometry, this.ribbonMaterial);
    const echoLine = new THREE.Line(this.echoGeometry, this.echoMaterial);
    ribbonLine.frustumCulled = false;
    echoLine.frustumCulled = false;

    // ---- Bars ----
    const barCount = BAR_COLS * BAR_ROWS;
    this.bars = makeGhostSet(barCount);
    this.barValues = new Float32Array(barCount);
    this.barBinLow = new Uint16Array(barCount);
    this.barBinHigh = new Uint16Array(barCount);
    const ratio = BAR_MAX_HZ / BAR_MIN_HZ;
    for (let i = 0; i < barCount; i++) {
      const f0 = BAR_MIN_HZ * Math.pow(ratio, i / barCount);
      const f1 = BAR_MIN_HZ * Math.pow(ratio, (i + 1) / barCount);
      const b0 = audio.binForFrequency(f0);
      this.barBinLow[i] = b0;
      this.barBinHigh[i] = Math.max(b0, audio.binForFrequency(f1) - 1);
    }
    // Bars: back (treble) rows follow the front rows in, with a little randomness per cube
    for (let i = 0; i < barCount; i++) {
      const row = Math.floor(i / BAR_COLS);
      this.bars.stagger[i] = (row / (BAR_ROWS - 1)) * 0.6 + Math.random() * 0.4;
    }
    const box = this.track(new THREE.BoxGeometry(0.3, 1, 0.3));
    this.barMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.barMesh = new THREE.InstancedMesh(box, this.barMaterial, barCount);
    this.barMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.barMesh.frustumCulled = false;
    for (let i = 0; i < barCount; i++) {
      this.dummy.position.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.barMesh.setMatrixAt(i, this.dummy.matrix);
      this.color.setHSL(0.52 + (Math.floor(i / BAR_COLS) / (BAR_ROWS - 1)) * 0.36, 0.85, 0.3);
      this.barMesh.setColorAt(i, this.color);
    }
    if (this.barMesh.instanceColor) this.barMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // ---- Dust (particle afterimages) ----
    const dustCount = Math.round(720 * densityScale());
    this.dust = makeGhostSet(dustCount);
    this.dustOrbit = new Float32Array(dustCount * 4);
    const seeds = new Float32Array(dustCount);
    const sizes = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      const o = i * 4;
      this.dustOrbit[o] = lerp(3.2, 6.6, Math.pow(Math.random(), 0.7)); // radius
      this.dustOrbit[o + 1] = Math.random() * Math.PI * 2; // azimuth
      this.dustOrbit[o + 2] = (Math.random() - 0.5) * Math.PI * 0.9; // elevation
      this.dustOrbit[o + 3] = (0.5 + Math.random()) * (Math.random() < 0.5 ? 1 : -1); // orbital speed
      seeds[i] = Math.random();
      sizes[i] = 0.5 + Math.random() * 0.9;
    }
    this.dustGeometry = this.track(new THREE.BufferGeometry());
    const dustPos = new THREE.BufferAttribute(this.dust.out, 3);
    dustPos.setUsage(THREE.DynamicDrawUsage);
    this.dustGeometry.setAttribute('position', dustPos);
    this.dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.dustMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: {
          uScale: { value: 0.1 },
          uPixelRatio: { value: pixelRatio },
          uColorA: { value: new THREE.Color(0x5ee6ff) },
          uColorB: { value: new THREE.Color(0xff5ea8) },
          uOpacity: { value: 0.85 },
          uGlow: { value: 0 },
          uHalo: { value: 0 },
        },
        vertexShader: pointVertexShader,
        fragmentShader: pointFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const dustPoints = new THREE.Points(this.dustGeometry, this.dustMaterial);
    dustPoints.frustumCulled = false;

    // ---- Core: one big soft point at the convergence point ----
    const coreGeometry = this.track(new THREE.BufferGeometry());
    coreGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    coreGeometry.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array([0.35]), 1));
    coreGeometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([1]), 1));
    this.coreMaterial = this.track(
      new THREE.ShaderMaterial({
        uniforms: {
          uScale: { value: 0 },
          uPixelRatio: { value: pixelRatio },
          uColorA: { value: new THREE.Color(0x9fe4ff) },
          uColorB: { value: new THREE.Color(0xffa8d2) },
          uOpacity: { value: 0 },
          uGlow: { value: 0 },
          uHalo: { value: 1 },
        },
        vertexShader: pointVertexShader,
        fragmentShader: pointFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const corePoint = new THREE.Points(coreGeometry, this.coreMaterial);
    corePoint.frustumCulled = false;
    corePoint.renderOrder = 2;

    this.group.add(ribbonLine, echoLine, this.barMesh, dustPoints, corePoint);

    this.onFade((o) => {
      // Motif ghosts fade with the crossfade *and* with the disperse phase (see update)
      this.applyOpacity(o);
    });

    this.layout(0, 0, 0, 1);
  }

  private motifFade = 1;
  private dustOpacity = 0.85;

  private applyOpacity(o: number): void {
    const motif = o * this.motifFade;
    this.ribbonMaterial.opacity = 0.9 * motif;
    this.echoMaterial.opacity = 0.5 * motif;
    this.barMaterial.opacity = 0.6 * motif;
    this.dustMaterial.uniforms.uOpacity.value = this.dustOpacity * o;
    this.coreMaterial.uniforms.uOpacity.value = this.glow * o;
  }

  /**
   * Blend a ghost set's resting layout toward the core and then out to its spread positions.
   * gather / scatter are the phase amounts (0..1); swirlAmount scales the spiral (0 under reduced motion).
   */
  private blend(set: GhostSet, gather: number, scatter: number, swirlAmount: number, drift: number): void {
    const { count, home, core, spread, swirl, stagger, phase, out } = set;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      // Per-vertex stagger so the pull-in / release ripple instead of moving as one block
      const g = clamp((gather - stagger[i] * 0.22) / 0.78, 0, 1);
      const gEased = g * g * (3 - 2 * g);
      const s = clamp((scatter - stagger[i] * 0.18) / 0.82, 0, 1);
      const sEased = 1 - (1 - s) * (1 - s);

      // Spiral: rotate the resting position about the view axis as it is pulled in
      const angle = swirl[i] * gEased * swirlAmount;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const hx = home[o];
      const hy = home[o + 1];
      const hz = home[o + 2];
      const rx = hx * c - hy * sn;
      const ry = hx * sn + hy * c;

      const px = lerp(rx, core[o], gEased);
      const py = lerp(ry, core[o + 1], gEased);
      const pz = lerp(hz, core[o + 2], gEased);

      // Dispersed dust keeps drifting very slowly so the outro background is never frozen
      const dx = spread[o] + Math.sin(drift + phase[i]) * 0.35;
      const dy = spread[o + 1] + Math.cos(drift * 0.8 + phase[i] * 1.3) * 0.28;
      const dz = spread[o + 2] + Math.sin(drift * 0.6 + phase[i] * 0.7) * 0.3;

      out[o] = lerp(px, dx, sEased);
      out[o + 1] = lerp(py, dy, sEased);
      out[o + 2] = lerp(pz, dz, sEased);
    }
  }

  /** Compute every ghost position for the given phase amounts and upload to the GPU. */
  private layout(gather: number, scatter: number, swirlAmount: number, barShrink: number): void {
    const drift = this.time * 0.25;

    this.blend(this.ribbon, gather, scatter, swirlAmount, drift);
    this.blend(this.echo, gather, scatter, swirlAmount, drift);
    this.blend(this.bars, gather, scatter, swirlAmount, drift);
    this.blend(this.dust, gather, scatter, swirlAmount, drift);

    (this.ribbonGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.echoGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.dustGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // Bars: instance matrices from the blended positions; they shrink into cubes as they gather
    const count = this.bars.count;
    const out = this.bars.out;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const g = clamp((gather - this.bars.stagger[i] * 0.22) / 0.78, 0, 1);
      const gEased = g * g * (3 - 2 * g); // same curve as blend(), so the cube turns with its spiral
      const height = lerp(this.barScale[i], 0.1, gEased) * barShrink;
      const width = lerp(1, 0.25, gEased) * barShrink;
      this.dummy.position.set(out[o], out[o + 1], out[o + 2]);
      this.dummy.scale.set(width, Math.max(0.001, height), width);
      this.dummy.rotation.set(0, 0, this.bars.swirl[i] * gEased * swirlAmount);
      this.dummy.updateMatrix();
      this.barMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.barMesh.instanceMatrix.needsUpdate = true;
  }

  update(ctx: FrameContext, manager: SceneManager): void {
    const { dt, elapsed, audio, reducedMotion } = ctx;
    this.time = elapsed;

    this.smoothProgress = damp(this.smoothProgress, this.progress, 6, dt);
    const p = this.smoothProgress;

    // ---- Phase curves ----
    const gather = Math.pow(smoothstep(0, 0.5, p), 1.4);
    const scatter = smoothstep(0.62, 1, p);
    const condensed = smoothstep(0.3, 0.56, p) * (1 - smoothstep(0.62, 0.84, p));
    // Ribbon and bars melt into the core during the hold, so only dust is left to disperse
    this.motifFade = 1 - smoothstep(0.46, 0.6, p);
    this.dustOpacity = lerp(0.85, 0.42, scatter);

    // ---- Live resting layouts ----
    // Ribbon: downsampled time-domain waveform (same source as Signal)
    const data = audio.timeDomain;
    const stride = Math.max(1, Math.floor(data.length / RIBBON_POINTS));
    const step = RIBBON_LENGTH / (RIBBON_POINTS - 1);
    // The wave settles as the ribbon is drawn in, otherwise the shrinking line turns jagged
    const amplitude = RIBBON_AMPLITUDE * (1 - gather * 0.85);
    for (let i = 0; i < RIBBON_POINTS; i++) {
      let acc = 0;
      const base = i * stride;
      for (let j = 0; j < stride; j++) acc += data[base + j];
      const value = (acc / stride - 128) / 128;
      this.wave[i] = damp(this.wave[i], value, 40, dt);

      const x = -RIBBON_LENGTH / 2 + i * step;
      const o = i * 3;
      this.ribbon.home[o] = x;
      this.ribbon.home[o + 1] = RIBBON_Y + this.wave[i] * amplitude;
      this.ribbon.home[o + 2] = 0;
      // Echo: same wave, mirrored and a little behind — the "afterimage of the afterimage"
      this.echo.home[o] = x;
      this.echo.home[o + 1] = RIBBON_Y - 0.55 - this.wave[i] * amplitude * 0.6;
      this.echo.home[o + 2] = -0.8;
    }

    // Bars: log-spaced spectrum slices (same source as Frequency)
    const spectrum = audio.frequency;
    const barCount = this.bars.count;
    for (let i = 0; i < barCount; i++) {
      const lo = this.barBinLow[i];
      const hi = this.barBinHigh[i];
      let sum = 0;
      for (let b = lo; b <= hi; b++) sum += spectrum[b];
      const raw = sum / ((hi - lo + 1) * 255);
      const current = this.barValues[i];
      const value = damp(current, raw, raw > current ? 24 : 8, dt);
      this.barValues[i] = value;

      const row = Math.floor(i / BAR_COLS);
      const col = i % BAR_COLS;
      const height = 0.12 + Math.pow(value, 1.5) * BAR_MAX_HEIGHT;
      this.barScale[i] = height;
      const o = i * 3;
      this.bars.home[o] = (col - (BAR_COLS - 1) / 2) * BAR_SPACING;
      this.bars.home[o + 1] = BAR_BASE_Y + row * 0.06 + height / 2;
      this.bars.home[o + 2] = 1.6 - row * BAR_SPACING;

      this.color.setHSL(0.52 + (row / (BAR_ROWS - 1)) * 0.36, 0.85, 0.16 + value * 0.5 + condensed * 0.2);
      this.barMesh.setColorAt(i, this.color);
    }
    if (this.barMesh.instanceColor) this.barMesh.instanceColor.needsUpdate = true;

    // Dust: slow deterministic orbits (speed follows loudness) around the centre
    const orbitSpeed = (reducedMotion ? 0.03 : 0.07) + audio.level * 0.16;
    const dustCount = this.dust.count;
    for (let i = 0; i < dustCount; i++) {
      const q = i * 4;
      const r = this.dustOrbit[q] * (1 + audio.level * 0.12);
      const az = this.dustOrbit[q + 1] + elapsed * orbitSpeed * this.dustOrbit[q + 3];
      const el = this.dustOrbit[q + 2] + Math.sin(elapsed * 0.3 + i) * 0.08;
      const o = i * 3;
      this.dust.home[o] = Math.cos(az) * Math.cos(el) * r;
      this.dust.home[o + 1] = Math.sin(el) * r * 0.75;
      this.dust.home[o + 2] = Math.sin(az) * Math.cos(el) * r;
    }

    // ---- Blend + upload ----
    const swirlAmount = reducedMotion ? 0 : 1;
    const barShrink = 1 - smoothstep(0.46, 0.6, p) * 0.85;
    this.layout(gather, scatter, swirlAmount, barShrink);

    // ---- Materials ----
    const pulse = reducedMotion ? 0 : Math.sin(elapsed * 2.4) * 0.08;
    this.dustMaterial.uniforms.uScale.value = lerp(0.1 + audio.level * 0.05, 0.07, scatter) + condensed * 0.04;
    this.dustMaterial.uniforms.uGlow.value = condensed * (0.5 + audio.level * 0.5);
    // Release flash: right as the core lets go, a brief extra bloom
    const release = smoothstep(0.6, 0.65, p) * (1 - smoothstep(0.65, 0.76, p));
    // Kept fairly small so it reads as a dense luminous cluster rather than a flat disc
    this.coreMaterial.uniforms.uScale.value =
      condensed * (3.6 + audio.level * 2.4 + audio.bass * 1.6 + pulse * 4) + release * 5;
    this.coreMaterial.uniforms.uGlow.value = condensed * 0.45 + release * 0.5;
    this.glow = Math.min(1, condensed * 0.85 + release * 0.9);
    this.applyOpacity(this.opacity);

    if (manager.active !== this) return;

    // ---- Camera: hold on the centre, easing back as the dust settles ----
    if (reducedMotion) {
      this.camPos.set(0, 0.3, 12.5);
      this.camLook.set(0, 0, 0);
      this.applyCamera(manager, 12);
      return;
    }
    const sway = 1 - scatter * 0.6;
    this.camPos.set(
      Math.sin(elapsed * 0.11) * 0.45 * sway,
      0.3 + Math.sin(elapsed * 0.17) * 0.22 * sway,
      lerp(12, 15.5, scatter) - condensed * 0.8,
    );
    this.camLook.set(0, 0, 0);
    this.applyCamera(manager, 3);
  }
}
