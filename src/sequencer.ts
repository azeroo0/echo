import type { AudioEngine } from './audio';
import { clamp } from './utils';

export interface SequencerNote {
  index: number;
  note: string;
  frequency: number;
  /** Physical key code that also assigns this note to a focused step, e.g. "KeyA" */
  code: string;
}

export interface SequencerOptions {
  root: HTMLElement;
  audio: AudioEngine;
  notes: SequencerNote[];
  /** Fired on the main thread at the moment a step sounds (for visuals). */
  onStep: (step: number, note: SequencerNote | null) => void;
}

/** Default pattern (indices into `notes`, null = rest): C4 · E4 G4 · A4 C5 · */
const DEFAULT_PATTERN: Array<number | null> = [0, null, 2, 3, null, 4, 5, null];
const TICK_MS = 25;
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * 8-step sequencer driven by the AudioContext clock.
 * A setInterval "tick" schedules any notes that fall inside the look-ahead window with
 * exact `when` times, so playback stays tight even if the main thread hiccups.
 * Visual highlights are timed with setTimeout to land when the note actually sounds.
 */
export class Sequencer {
  private readonly root: HTMLElement;
  private readonly audio: AudioEngine;
  private readonly notes: SequencerNote[];
  private readonly onStep: (step: number, note: SequencerNote | null) => void;

  private readonly stepButtons: HTMLButtonElement[];
  private readonly playButton: HTMLButtonElement | null;
  private readonly playLabel: HTMLElement | null;
  private readonly bpmInput: HTMLInputElement | null;

  private readonly steps: Array<number | null>;
  private playing = false;
  private bpm = 120;
  private current = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly visualTimers = new Set<ReturnType<typeof setTimeout>>();

  private readonly stepClickHandlers: Array<(event: MouseEvent) => void> = [];
  private readonly stepKeyHandlers: Array<(event: KeyboardEvent) => void> = [];
  private readonly onPlayClick = () => this.toggle();
  private readonly onBpmInput = () => {
    if (this.bpmInput) this.setBpm(Number(this.bpmInput.value));
  };
  private readonly onBpmBlur = () => this.renderBpm();

  constructor(options: SequencerOptions) {
    this.root = options.root;
    this.audio = options.audio;
    this.notes = options.notes;
    this.onStep = options.onStep;

    this.stepButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.step'));
    this.playButton = this.root.querySelector<HTMLButtonElement>('#seq-play');
    this.playLabel = this.root.querySelector<HTMLElement>('.seq__play-label');
    this.bpmInput = this.root.querySelector<HTMLInputElement>('#seq-bpm');

    this.steps = this.stepButtons.map((_, i) => {
      const preset = DEFAULT_PATTERN[i];
      return preset !== undefined && preset !== null && preset < this.notes.length ? preset : null;
    });

    this.stepButtons.forEach((button, i) => {
      const onClick = (event: MouseEvent) => this.cycle(i, event.shiftKey ? -1 : 1);
      const onKey = (event: KeyboardEvent) => this.handleStepKey(i, event);
      button.addEventListener('click', onClick);
      button.addEventListener('keydown', onKey);
      this.stepClickHandlers.push(onClick);
      this.stepKeyHandlers.push(onKey);
      this.renderStep(i);
    });

    this.playButton?.addEventListener('click', this.onPlayClick);
    if (this.bpmInput) {
      this.bpmInput.addEventListener('input', this.onBpmInput);
      this.bpmInput.addEventListener('blur', this.onBpmBlur);
      this.setBpm(Number(this.bpmInput.value) || this.bpm);
    } else {
      this.audio.setTempo(this.bpm);
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get tempo(): number {
    return this.bpm;
  }

  get pattern(): ReadonlyArray<number | null> {
    return this.steps;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** Replace the whole pattern (used when a shared link is opened). Does not start playback. */
  loadPattern(pattern: ReadonlyArray<number | null>): void {
    for (let i = 0; i < this.steps.length; i++) {
      const value = pattern[i];
      const noteIndex =
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < this.notes.length ? value : null;
      this.steps[i] = noteIndex;
      this.renderStep(i);
    }
  }

  private get stepDuration(): number {
    // Eight steps = one bar of eighth notes
    return 60 / this.bpm / 2;
  }

  /** Move a step to the next/previous note; wraps through a rest. Auditions the new note. */
  cycle(step: number, direction: 1 | -1): void {
    const count = this.notes.length;
    const current = this.steps[step];
    let next: number | null;
    if (current === null) next = direction > 0 ? 0 : count - 1;
    else next = current + direction;
    if (next !== null && (next < 0 || next >= count)) next = null;
    this.setStep(step, next, true);
  }

  setStep(step: number, noteIndex: number | null, audition = false): void {
    if (step < 0 || step >= this.steps.length) return;
    this.steps[step] = noteIndex;
    this.renderStep(step);
    if (audition && noteIndex !== null && !this.playing) {
      this.audio.playNote(this.notes[noteIndex].frequency);
      this.onStep(step, this.notes[noteIndex]);
    }
  }

  private handleStepKey(step: number, event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        event.preventDefault();
        this.cycle(step, 1);
        return;
      case 'ArrowDown':
      case 'ArrowLeft':
        event.preventDefault();
        this.cycle(step, -1);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.setStep(step, null);
        return;
      default:
        break;
    }
    // Pad letter keys assign that note to the focused step (the global pad handler plays it)
    if (!event.repeat) {
      const note = this.notes.find((n) => n.code === event.code);
      if (note) this.setStep(step, note.index);
    }
  }

  private renderStep(step: number): void {
    const button = this.stepButtons[step];
    const noteIndex = this.steps[step];
    const note = noteIndex === null ? null : this.notes[noteIndex];
    button.textContent = note ? note.note : '·';
    button.classList.toggle('is-rest', note === null);
    button.dataset.note = note ? note.note : '';
    button.setAttribute('aria-label', `스텝 ${step + 1}: ${note ? note.note : '휴지'}`);
  }

  private renderBpm(): void {
    if (this.bpmInput) this.bpmInput.value = String(this.bpm);
  }

  /** Set the tempo. `syncInput` also writes the field (for programmatic changes such as shared links). */
  setBpm(value: number, syncInput = false): void {
    if (!Number.isFinite(value)) return;
    this.bpm = clamp(Math.round(value), MIN_BPM, MAX_BPM);
    this.audio.setTempo(this.bpm);
    // Only normalise the field when the value is out of range so typing isn't fought
    if (this.bpmInput && (syncInput || value < MIN_BPM || value > MAX_BPM)) this.renderBpm();
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.start();
  }

  start(): void {
    if (this.playing) return;
    if (this.audio.context.state !== 'running') return;

    this.playing = true;
    this.current = 0;
    this.nextTime = this.audio.context.currentTime + 0.06;
    this.timer = setInterval(this.tick, TICK_MS);
    this.tick();

    this.root.classList.add('is-playing');
    this.playButton?.setAttribute('aria-pressed', 'true');
    this.playButton?.setAttribute('aria-label', '시퀀서 정지');
    if (this.playLabel) this.playLabel.textContent = 'Stop';
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of this.visualTimers) clearTimeout(t);
    this.visualTimers.clear();
    this.stepButtons.forEach((button) => button.classList.remove('is-playing'));

    this.root.classList.remove('is-playing');
    this.playButton?.setAttribute('aria-pressed', 'false');
    this.playButton?.setAttribute('aria-label', '시퀀서 재생');
    if (this.playLabel) this.playLabel.textContent = 'Play';
  }

  private readonly tick = (): void => {
    if (!this.playing) return;
    const ctx = this.audio.context;
    // Background tabs throttle timers to ~1s, so look further ahead there
    const lookAhead = document.hidden ? 1.2 : 0.12;
    while (this.nextTime < ctx.currentTime + lookAhead) {
      this.fire(this.current, this.nextTime);
      this.nextTime += this.stepDuration;
      this.current = (this.current + 1) % this.steps.length;
    }
  };

  private fire(step: number, when: number): void {
    const noteIndex = this.steps[step];
    const note = noteIndex === null ? null : this.notes[noteIndex];
    if (note) this.audio.playNote(note.frequency, { when });

    const delayMs = Math.max(0, (when - this.audio.context.currentTime) * 1000);
    const timer = setTimeout(() => {
      this.visualTimers.delete(timer);
      if (!this.playing) return;
      this.stepButtons.forEach((button, i) => button.classList.toggle('is-playing', i === step));
      if (note) this.audio.kick(0.6);
      this.onStep(step, note);
    }, delayMs);
    this.visualTimers.add(timer);
  }

  dispose(): void {
    this.stop();
    this.stepButtons.forEach((button, i) => {
      button.removeEventListener('click', this.stepClickHandlers[i]);
      button.removeEventListener('keydown', this.stepKeyHandlers[i]);
    });
    this.playButton?.removeEventListener('click', this.onPlayClick);
    this.bpmInput?.removeEventListener('input', this.onBpmInput);
    this.bpmInput?.removeEventListener('blur', this.onBpmBlur);
  }
}
