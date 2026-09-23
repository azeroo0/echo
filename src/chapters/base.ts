import * as THREE from 'three';
import type { Chapter, FrameContext, SceneManager } from '../scene';

type Disposable = { dispose(): void };

export abstract class BaseChapter implements Chapter {
  readonly group = new THREE.Group();
  progress = 0;
  opacity = 0;
  active = false;

  protected smoothProgress = 0;
  protected readonly disposables: Disposable[] = [];
  private readonly fadeHandlers: Array<(opacity: number) => void> = [];

  protected readonly camPos = new THREE.Vector3();
  protected readonly camLook = new THREE.Vector3();

  protected constructor(
    readonly id: string,
    origin: THREE.Vector3,
  ) {
    this.group.position.copy(origin);
    this.group.name = `chapter-${id}`;
  }

  abstract update(ctx: FrameContext, manager: SceneManager): void;

  protected onFade(handler: (opacity: number) => void): void {
    this.fadeHandlers.push(handler);
  }

  protected track<T extends Disposable>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  setOpacity(value: number): void {
    this.opacity = value;
    for (const handler of this.fadeHandlers) handler(value);
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  protected applyCamera(manager: SceneManager, damping = 4): void {
    if (manager.active !== this) return;
    this.camPos.add(this.group.position);
    this.camLook.add(this.group.position);
    manager.setCameraTarget(this.camPos, this.camLook, damping);
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }
}
