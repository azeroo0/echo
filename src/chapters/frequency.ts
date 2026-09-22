import * as THREE from 'three';
import type { AudioEngine } from '../audio';
import type { FrameContext, SceneManager } from '../scene';
import { damp, isMobile, lerp, smoothstep } from '../utils';
import { BaseChapter } from './base';

const MIN_HZ = 35;
const MAX_HZ = 9000;
const SPACING = 1.15;
const MAX_HEIGHT = 7.5;

/**
 * Chapter 2 — Frequency
 * A grid of instanced bars. Each bar owns one log-spaced slice of the FFT.
 * Rows run front (low frequencies) to back (high frequencies) and rise as they go.
 * Height, brightness and hue all come from getByteFrequencyData each frame.
 */
export class FrequencyChapter extends BaseChapter {
  private readonly rows: number;
  private readonly cols: number;
  private readonly count: number;

  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly floor: THREE.GridHelper;

  private readonly binLow: Uint16Array;
  private readonly binHigh: Uint16Array;
  private readonly values: Float32Array;

  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  private readonly zFront: number;
  private readonly zBack: number;

  constructor(private readonly audio: AudioEngine) {
    super('frequency', new THREE.Vector3(0, -140, 0));

    const mobile = isMobile();
    this.rows = mobile ? 12 : 24;
    this.cols = 16;
    this.count = this.rows * this.cols; // 192 on mobile, 384 on desktop

    this.zFront = ((this.rows - 1) / 2) * SPACING;
    this.zBack = -this.zFront;

    // Log-spaced frequency slices, ordered front-left -> back-right
    this.binLow = new Uint16Array(this.count);
    this.binHigh = new Uint16Array(this.count);
    this.values = new Float32Array(this.count);
    const ratio = MAX_HZ / MIN_HZ;
    for (let i = 0; i < this.count; i++) {
      const f0 = MIN_HZ * Math.pow(ratio, i / this.count);
      const f1 = MIN_HZ * Math.pow(ratio, (i + 1) / this.count);
      const b0 = audio.binForFrequency(f0);
      const b1 = Math.max(b0, audio.binForFrequency(f1) - 1);
      this.binLow[i] = b0;
      this.binHigh[i] = Math.max(b0, b1);
    }

    const box = this.track(new THREE.BoxGeometry(1, 1, 1));
    this.material = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
        metalness: 0.25,
        transparent: true,
        opacity: 1,
      }),
    );
    this.mesh = new THREE.InstancedMesh(box, this.material, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // Initialise matrices + colours (this also allocates instanceColor)
    for (let i = 0; i < this.count; i++) {
      this.writeInstance(i, 0);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }

    const width = this.cols * SPACING * 1.6;
    this.floor = new THREE.GridHelper(width, this.cols * 2, 0x1c2438, 0x10141f);
    this.floor.position.y = -0.05;
    const floorMaterial = this.floor.material as THREE.LineBasicMaterial;
    floorMaterial.transparent = true;
    floorMaterial.opacity = 0.35;
    this.track(this.floor.geometry);
    this.track(floorMaterial);

    this.group.add(this.mesh, this.floor);

    this.onFade((o) => {
      this.material.opacity = o;
      floorMaterial.opacity = 0.35 * o;
    });
  }

  private writeInstance(i: number, value: number): void {
    const row = Math.floor(i / this.cols);
    const col = i % this.cols;

    const x = (col - (this.cols - 1) / 2) * SPACING;
    const z = this.zFront - row * SPACING;
    const baseY = row * 0.12;
    const height = 0.15 + Math.pow(value, 1.5) * MAX_HEIGHT;

    this.dummy.position.set(x, baseY + height / 2, z);
    this.dummy.scale.set(0.7, height, 0.7);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);

    // Hue drifts from cyan (bass, front) to magenta (treble, back); lightness = energy
    const hue = 0.52 + (row / Math.max(1, this.rows - 1)) * 0.36;
    this.color.setHSL(hue, 0.85, 0.1 + value * 0.6);
    this.mesh.setColorAt(i, this.color);
  }

  /** Z (chapter-local) of the front / bass row — used by the hero preview to frame the field. */
  get frontZ(): number {
    return this.zFront;
  }

  /** Half the field width (chapter-local X extent of the bar grid). */
  get halfWidth(): number {
    return ((this.cols - 1) / 2) * SPACING;
  }

  setActive(active: boolean): void {
    super.setActive(active);
    // When inactive nothing is drawn or uploaded; the shared BoxGeometry (24 verts) stays resident.
    this.mesh.count = active ? this.count : 0;
  }

  update(ctx: FrameContext, manager: SceneManager): void {
    const { dt, audio, reducedMotion } = ctx;

    if (this.mesh.count > 0) {
      const spectrum = this.audio.frequency;
      for (let i = 0; i < this.count; i++) {
        const lo = this.binLow[i];
        const hi = this.binHigh[i];
        let sum = 0;
        for (let b = lo; b <= hi; b++) sum += spectrum[b];
        const raw = sum / ((hi - lo + 1) * 255);
        const current = this.values[i];
        this.values[i] = damp(current, raw, raw > current ? 26 : 8, dt);
        this.writeInstance(i, this.values[i]);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    this.material.emissive.setHSL(0.6, 0.6, audio.level * 0.15);

    if (manager.active !== this) return;

    this.smoothProgress = damp(this.smoothProgress, this.progress, 6, dt);
    const p = this.smoothProgress;
    const halfWidth = ((this.cols - 1) / 2) * SPACING;

    if (reducedMotion) {
      this.camPos.set((p - 0.5) * 2, 9, this.zFront + 15);
      this.camLook.set(0, 1.5, 0);
      this.applyCamera(manager, 12);
      return;
    }

    // Fly-through: enter low at the front, weave between columns, climb toward the back,
    // then lift up in the final stretch to look down over the whole field.
    const z = lerp(this.zFront + 13, this.zBack - 5, p);
    const climb = smoothstep(0, 1, p);
    const y = lerp(2.2, 12, climb);
    const x = Math.sin(p * Math.PI * 2) * halfWidth * 0.55;

    const lift = smoothstep(0.82, 1, p);
    const lookX = lerp(x * 0.4, 0, lift);
    const lookY = lerp(lerp(1.4, 3.2, p), 0, lift);
    const lookZ = lerp(z - 10, 0, lift);

    this.camPos.set(x, y + lift * 6, z + lift * 6);
    this.camLook.set(lookX, lookY, lookZ);
    this.applyCamera(manager, 4);
  }
}
