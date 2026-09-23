import gsap from 'gsap';
import * as THREE from 'three';
import type { SceneManager } from './scene';
import type { FrequencyChapter } from './chapters/frequency';
import { lerp, smoothstep } from './utils';

type ShotId = 'signal' | 'frequency' | 'synthesis';

interface Shot {
  id: ShotId;
  index: string;
  label: string;
  duration: number;
  camera(t: number, pos: THREE.Vector3, look: THREE.Vector3): void;
}

const CUT_FLASH = 0.22;
const SHOT_DAMPING = 6;

export interface PreviewCaption {
  root: HTMLElement;
  index: HTMLElement | null;
  name: HTMLElement | null;
  fill: HTMLElement | null;
}

export class HeroPreview {
  private readonly shots: Shot[];
  private readonly total: number;
  private readonly state = { time: 0 };
  private tween: gsap.core.Tween | null = null;
  private current = -1;
  private running = false;

  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly ease = gsap.parseEase('sine.inOut');

  constructor(
    private readonly manager: SceneManager,
    private readonly caption: PreviewCaption | null,
    private readonly reducedMotion: boolean,
  ) {
    const frequency = manager.getChapter<FrequencyChapter>('frequency');
    const frontZ = frequency?.frontZ ?? 13;
    const halfWidth = frequency?.halfWidth ?? 8.6;

    this.shots = [
      {
        id: 'signal',
        index: '01',
        label: 'Signal',
        duration: 1.8,
        camera: (t, pos, look) => {
          const x = lerp(-13, 7, t);
          pos.set(x, lerp(4.4, 2.6, t), lerp(11, 8.6, t));
          look.set(x + 7.5, lerp(0.4, -0.2, t), 0);
        },
      },
      {
        id: 'frequency',
        index: '02',
        label: 'Frequency',
        duration: 1.7,
        camera: (t, pos, look) => {
          pos.set(lerp(-halfWidth * 0.8, halfWidth * 0.55, t), lerp(2.2, 7.5, t), lerp(frontZ + 9, frontZ - 4, t));
          look.set(lerp(0, -halfWidth * 0.2, t), lerp(2, 1.4, t), lerp(frontZ - 6, -4, t));
        },
      },
      {
        id: 'synthesis',
        index: '03',
        label: 'Synthesis',
        duration: 1.7,
        camera: (t, pos, look) => {
          const angle = lerp(-0.9, 0.5, t);
          const dist = lerp(9.6, 7.2, t);
          pos.set(Math.sin(angle) * dist, lerp(2.3, 1.0, t), Math.cos(angle) * dist);
          look.set(0, 0.2, 0);
        },
      },
    ];
    this.total = this.shots.reduce((sum, shot) => sum + shot.duration, 0);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentShot(): ShotId | null {
    return this.running && this.current >= 0 ? this.shots[this.current].id : null;
  }

  get loopDuration(): number {
    return this.total;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = -1;
    this.state.time = 0;
    this.manager.setCameraOverride(true);
    document.body.classList.add('is-previewing');
    if (this.caption) this.caption.root.hidden = false;

    this.tween = gsap.fromTo(
      this.state,
      { time: 0 },
      {
        time: this.total,
        duration: this.total,
        ease: 'none',
        repeat: -1,
        onUpdate: () => this.tick(),
      },
    );
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.tween?.kill();
    this.tween = null;

    if (this.current >= 0) this.manager.setChapterVisible(this.shots[this.current].id, false);
    this.current = -1;

    this.manager.setCameraOverride(false);
    this.manager.setGrade(this.manager.active?.id ?? 'hero');
    document.body.classList.remove('is-previewing');
    if (this.caption) this.caption.root.hidden = true;

    if (this.reducedMotion) {
      this.manager.setTransition(0);
    } else {
      this.manager.setTransition(1);
      gsap.delayedCall(0.16, () => {
        if (!this.running) this.manager.setTransition(0);
      });
    }
  }

  dispose(): void {
    this.stop();
  }

  private shotAt(time: number): { index: number; local: number } {
    let acc = 0;
    for (let i = 0; i < this.shots.length; i++) {
      const next = acc + this.shots[i].duration;
      if (time < next || i === this.shots.length - 1) return { index: i, local: Math.min(time - acc, this.shots[i].duration) };
      acc = next;
    }
    return { index: 0, local: 0 };
  }

  private tick(): void {
    if (!this.running) return;
    const { index, local } = this.shotAt(this.state.time);
    const shot = this.shots[index];
    const cut = index !== this.current;

    if (cut) {
      if (this.current >= 0) this.manager.setChapterVisible(this.shots[this.current].id, false);
      this.current = index;
      this.manager.setChapterVisible(shot.id, true);
      this.manager.setGrade(shot.id, true);
      this.renderCaption(shot);
    }

    const t = this.reducedMotion ? 0.5 : this.ease(local / shot.duration);
    shot.camera(t, this.pos, this.look);
    const origin = this.manager.getChapter(shot.id)?.group.position;
    if (origin) {
      this.pos.add(origin);
      this.look.add(origin);
    }
    this.manager.driveCamera(this.pos, this.look, SHOT_DAMPING, cut);

    if (!this.reducedMotion) {
      this.manager.setTransition(1 - smoothstep(0, CUT_FLASH, local));
    }

    if (this.caption?.fill) {
      this.caption.fill.style.transform = `scaleX(${(local / shot.duration).toFixed(4)})`;
    }
  }

  private renderCaption(shot: Shot): void {
    if (!this.caption) return;
    const { root, index, name } = this.caption;
    if (index) index.textContent = shot.index;
    if (name) name.textContent = shot.label;
    root.dataset.shot = shot.id;
    if (!this.reducedMotion) {
      gsap.fromTo(root, { opacity: 0.2 }, { opacity: 1, duration: 0.45, ease: 'power2.out', overwrite: true });
    }
  }
}
