import * as THREE from 'three';
import type { FrameContext, SceneManager } from '../scene';
import { damp, densityScale, lerp } from '../utils';
import { BaseChapter } from './base';

const SAMPLES = 256;
const RING = 12;
const LENGTH = 44;
const AMPLITUDE = 2.4;
const BASE_RADIUS = 0.32;

export class SignalChapter extends BaseChapter {
  private readonly tubeGeometry: THREE.BufferGeometry;
  private readonly tubePositions: Float32Array;
  private readonly tubeMaterial: THREE.MeshStandardMaterial;
  private readonly wireMaterial: THREE.MeshBasicMaterial;

  private readonly traceGeometry: THREE.BufferGeometry;
  private readonly tracePositions: Float32Array;
  private readonly mirrorGeometry: THREE.BufferGeometry;
  private readonly mirrorPositions: Float32Array;
  private readonly traceMaterial: THREE.LineBasicMaterial;
  private readonly mirrorMaterial: THREE.LineBasicMaterial;

  private readonly dust: THREE.Points;
  private readonly dustMaterial: THREE.PointsMaterial;

  private readonly wave = new Float32Array(SAMPLES);

  constructor() {
    super('signal', new THREE.Vector3(0, -70, 0));

    this.tubePositions = new Float32Array(SAMPLES * RING * 3);
    const indices: number[] = [];
    for (let i = 0; i < SAMPLES - 1; i++) {
      for (let k = 0; k < RING; k++) {
        const a = i * RING + k;
        const b = i * RING + ((k + 1) % RING);
        const c = (i + 1) * RING + k;
        const d = (i + 1) * RING + ((k + 1) % RING);
        indices.push(a, c, b, b, c, d);
      }
    }
    this.tubeGeometry = this.track(new THREE.BufferGeometry());
    const posAttr = new THREE.BufferAttribute(this.tubePositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    this.tubeGeometry.setAttribute('position', posAttr);
    this.tubeGeometry.setIndex(indices);

    this.tubeMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0f2740,
        emissive: 0x1a6fa8,
        emissiveIntensity: 0.9,
        roughness: 0.3,
        metalness: 0.55,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      }),
    );
    const tube = new THREE.Mesh(this.tubeGeometry, this.tubeMaterial);
    tube.frustumCulled = false;

    this.wireMaterial = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x8fe9ff,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    const wire = new THREE.Mesh(this.tubeGeometry, this.wireMaterial);
    wire.frustumCulled = false;

    this.tracePositions = new Float32Array(SAMPLES * 3);
    this.traceGeometry = this.track(new THREE.BufferGeometry());
    const traceAttr = new THREE.BufferAttribute(this.tracePositions, 3);
    traceAttr.setUsage(THREE.DynamicDrawUsage);
    this.traceGeometry.setAttribute('position', traceAttr);
    this.traceMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0xff5ea8, transparent: true, opacity: 0.9 }),
    );
    const trace = new THREE.Line(this.traceGeometry, this.traceMaterial);
    trace.frustumCulled = false;

    this.mirrorPositions = new Float32Array(SAMPLES * 3);
    this.mirrorGeometry = this.track(new THREE.BufferGeometry());
    const mirrorAttr = new THREE.BufferAttribute(this.mirrorPositions, 3);
    mirrorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mirrorGeometry.setAttribute('position', mirrorAttr);
    this.mirrorMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0x5ee6ff, transparent: true, opacity: 0.45 }),
    );
    const mirror = new THREE.Line(this.mirrorGeometry, this.mirrorMaterial);
    mirror.frustumCulled = false;

    const dustCount = Math.round(320 * densityScale());
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      dustPositions[i * 3] = (Math.random() - 0.5) * LENGTH * 1.2;
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 12;
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 12;
    }
    const dustGeometry = this.track(new THREE.BufferGeometry());
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    this.dustMaterial = this.track(
      new THREE.PointsMaterial({
        color: 0x9fb7ff,
        size: 0.07,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.dust = new THREE.Points(dustGeometry, this.dustMaterial);

    this.group.add(tube, wire, trace, mirror, this.dust);

    this.onFade((o) => {
      this.tubeMaterial.opacity = 0.95 * o;
      this.wireMaterial.opacity = 0.22 * o;
      this.traceMaterial.opacity = 0.9 * o;
      this.mirrorMaterial.opacity = 0.45 * o;
      this.dustMaterial.opacity = 0.5 * o;
    });

    this.writeGeometry(0);
  }

  setActive(active: boolean): void {
    super.setActive(active);
  }

  private writeGeometry(level: number): void {
    const step = LENGTH / (SAMPLES - 1);
    const pos = this.tubePositions;
    const trace = this.tracePositions;
    const mirror = this.mirrorPositions;

    for (let i = 0; i < SAMPLES; i++) {
      const x = -LENGTH / 2 + i * step;
      const v = this.wave[i];
      const y = v * AMPLITUDE;
      const radius = BASE_RADIUS + Math.abs(v) * 0.35 + level * 0.12;

      for (let k = 0; k < RING; k++) {
        const angle = (k / RING) * Math.PI * 2;
        const o = (i * RING + k) * 3;
        pos[o] = x;
        pos[o + 1] = y + Math.cos(angle) * radius;
        pos[o + 2] = Math.sin(angle) * radius;
      }

      const t = i * 3;
      trace[t] = x;
      trace[t + 1] = y * 0.8 + 3.4;
      trace[t + 2] = 0;

      mirror[t] = x;
      mirror[t + 1] = -y * 0.8 - 3.4;
      mirror[t + 2] = 0;
    }

    (this.tubeGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.tubeGeometry.computeVertexNormals();
    (this.traceGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.mirrorGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(ctx: FrameContext, manager: SceneManager): void {
    const { dt, audio, reducedMotion } = ctx;

    const data = audio.timeDomain;
    const stride = Math.max(1, Math.floor(data.length / SAMPLES));
    for (let i = 0; i < SAMPLES; i++) {
      let acc = 0;
      const base = i * stride;
      for (let j = 0; j < stride; j++) acc += data[base + j];
      const value = (acc / stride - 128) / 128;
      this.wave[i] = damp(this.wave[i], value, 45, dt);
    }
    this.writeGeometry(audio.level);

    this.tubeMaterial.emissiveIntensity = 0.6 + audio.level * 1.8;
    this.tubeMaterial.emissive.setHSL(0.56 - audio.treble * 0.1, 0.8, 0.35 + audio.level * 0.2);
    this.dust.rotation.x += dt * 0.02;

    if (manager.active !== this) return;

    this.smoothProgress = damp(this.smoothProgress, this.progress, 6, dt);
    const p = this.smoothProgress;

    if (reducedMotion) {
      this.camPos.set((p - 0.5) * 3, 3.2, 13);
      this.camLook.set((p - 0.5) * 2, 0, 0);
      this.applyCamera(manager, 12);
      return;
    }

    const camX = lerp(-LENGTH / 2 + 6, LENGTH / 2 - 6, p);
    const theta = lerp(0.18, 1.32, p);
    const dist = 11 - 5.5 * Math.sin(p * Math.PI);
    this.camPos.set(camX - 1.5 + Math.sin(p * Math.PI * 2) * 1.2, Math.sin(theta) * dist, Math.cos(theta) * dist);
    this.camLook.set(camX + 2.5, 0, 0);
    this.applyCamera(manager, 4);
  }
}
