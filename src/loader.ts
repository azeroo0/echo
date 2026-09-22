import gsap from 'gsap';
import { clamp, damp } from './utils';

/**
 * Intro loader: a 0→100% counter that eases toward the *real* initialisation progress.
 * With prefers-reduced-motion the counter jumps straight to the reported value.
 */
export class Loader {
  private target = 0;
  private shown = 0;
  private rafId: number | null = null;
  private finished = false;
  private lastTick = performance.now();
  private resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(
    private readonly root: HTMLElement,
    private readonly countEl: HTMLElement,
    private readonly barEl: HTMLElement,
    private readonly reducedMotion: boolean,
  ) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    if (!this.reducedMotion) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  /** Report actual progress 0..1. */
  set(progress: number): void {
    this.target = clamp(progress, 0, 1);
    if (this.reducedMotion) {
      this.shown = this.target;
      this.render();
      if (this.target >= 1) this.finish();
    }
  }

  private readonly tick = (now: number): void => {
    // Time-based easing so the counter converges in ~1s regardless of frame rate
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.shown = damp(this.shown, this.target, 5, dt);
    if (this.target >= 1 && this.shown > 0.995) {
      this.shown = 1;
      this.render();
      this.finish();
      return;
    }
    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private render(): void {
    this.countEl.textContent = String(Math.round(this.shown * 100));
    this.barEl.style.transform = `scaleX(${this.shown.toFixed(4)})`;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);

    gsap.to(this.root, {
      yPercent: -100,
      duration: this.reducedMotion ? 0 : 0.85,
      delay: this.reducedMotion ? 0 : 0.25,
      ease: 'power3.inOut',
      onComplete: () => {
        this.root.hidden = true;
        this.root.style.display = 'none';
        this.resolveDone();
      },
    });
  }

  /** Replace the counter with an error message (WebGL / Web Audio unavailable). */
  fail(message: string): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const errorEl = this.root.querySelector<HTMLElement>('#loader-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
    this.countEl.parentElement?.setAttribute('aria-hidden', 'true');
  }
}

export interface GateResult {
  /** true = user chose to hear audio, false = enter muted */
  sound: boolean;
}

/**
 * Shows the "Start" gate and resolves when the user picks an option.
 * The click that resolves this is the user gesture that lets AudioContext.resume() succeed.
 */
export function openGate(gate: HTMLElement, reducedMotion: boolean): Promise<GateResult> {
  return new Promise<GateResult>((resolve) => {
    const startButton = gate.querySelector<HTMLButtonElement>('#gate-start');
    const silentButton = gate.querySelector<HTMLButtonElement>('#gate-silent');
    if (!startButton || !silentButton) {
      resolve({ sound: false });
      return;
    }

    gate.hidden = false;
    gsap.fromTo(
      gate,
      { opacity: 0 },
      { opacity: 1, duration: reducedMotion ? 0 : 0.5, ease: 'power2.out' },
    );
    const inner = gate.querySelector<HTMLElement>('.gate__inner');
    if (inner && !reducedMotion) {
      gsap.fromTo(inner, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out', delay: 0.1 });
    }
    startButton.focus({ preventScroll: true });

    const close = (result: GateResult) => {
      startButton.removeEventListener('click', onStart);
      silentButton.removeEventListener('click', onSilent);
      startButton.disabled = true;
      silentButton.disabled = true;
      gsap.to(gate, {
        opacity: 0,
        duration: reducedMotion ? 0 : 0.6,
        ease: 'power2.inOut',
        onComplete: () => {
          gate.hidden = true;
        },
      });
      resolve(result);
    };

    const onStart = () => close({ sound: true });
    const onSilent = () => close({ sound: false });

    startButton.addEventListener('click', onStart);
    silentButton.addEventListener('click', onSilent);
  });
}
