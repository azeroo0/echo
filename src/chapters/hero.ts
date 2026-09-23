import * as THREE from 'three';
import type { FrameContext, SceneManager } from '../scene';
import { damp } from '../utils';
import { BaseChapter } from './base';

export class HeroChapter extends BaseChapter {
  private readonly outer: THREE.LineSegments;
  private readonly core: THREE.Mesh;
  private readonly inner: THREE.LineSegments;

  private readonly outerMaterial: THREE.LineBasicMaterial;
  private readonly coreMaterial: THREE.MeshStandardMaterial;
  private readonly innerMaterial: THREE.LineBasicMaterial;

  private scale = 1;

  constructor() {
    super('hero', new THREE.Vector3(0, 0, 0));

    const shape = this.track(new THREE.IcosahedronGeometry(2.2, 1));
    const outerWire = this.track(new THREE.WireframeGeometry(shape));
    this.outerMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.85 }),
    );
    this.outer = new THREE.LineSegments(outerWire, this.outerMaterial);

    this.coreMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0b1020,
        emissive: 0x0d2a44,
        emissiveIntensity: 0.9,
        roughness: 0.35,
        metalness: 0.65,
        flatShading: true,
        transparent: true,
        opacity: 0.35,
      }),
    );
    this.core = new THREE.Mesh(shape, this.coreMaterial);

    const innerShape = this.track(new THREE.IcosahedronGeometry(1.05, 0));
    const innerWire = this.track(new THREE.WireframeGeometry(innerShape));
    this.innerMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0xff5ea8, transparent: true, opacity: 0.55 }),
    );
    this.inner = new THREE.LineSegments(innerWire, this.innerMaterial);

    this.group.add(this.core, this.outer, this.inner);

    this.onFade((o) => {
      this.outerMaterial.opacity = 0.85 * o;
      this.coreMaterial.opacity = 0.35 * o;
      this.innerMaterial.opacity = 0.55 * o;
    });
  }

  update(ctx: FrameContext, manager: SceneManager): void {
    const { dt, audio, reducedMotion, pointer } = ctx;
    const speed = reducedMotion ? 0.25 : 1;

    this.outer.rotation.y += dt * 0.16 * speed;
    this.outer.rotation.x += dt * 0.07 * speed;
    this.core.rotation.copy(this.outer.rotation);
    this.inner.rotation.y -= dt * 0.28 * speed;
    this.inner.rotation.z += dt * 0.11 * speed;

    const targetScale = 1 + audio.level * 0.28 + audio.bass * 0.18;
    this.scale = damp(this.scale, targetScale, 8, dt);
    this.group.scale.setScalar(this.scale);

    this.outerMaterial.color.setHSL(0.55 - audio.treble * 0.18, 0.85, 0.62 + audio.level * 0.18);
    this.coreMaterial.emissiveIntensity = 0.6 + audio.level * 2.2;

    if (manager.active === this) {
      const px = reducedMotion ? 0 : pointer.x * 0.7;
      const py = reducedMotion ? 0 : pointer.y * 0.45;
      this.camPos.set(px, 0.2 + py, 8);
      this.camLook.set(0, 0, 0);
      this.applyCamera(manager, 3);
    }
  }
}
