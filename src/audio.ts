import { clamp, damp } from './utils';

/**
 * AudioEngine
 * -----------
 * One AudioContext shared by the whole app.
 *
 * Routing:
 *   ambient drone ──────────────────────────────┐
 *   note voices ─> voiceBus ─┬─ (dry) ──────────┼─> master GainNode ─> lowpass BiquadFilterNode ─> AnalyserNode ─> destination
 *                            ├─ reverbSend ─> ConvolverNode ─┘             (filter sweep: pointer X / XY pad)
 *                            └─ delaySend ──> DelayNode ⟲ feedback ─┘
 *
 * Every visual in the app reads from `timeDomain` / `frequency`, which are refreshed
 * once per frame in `update()` via getByteTimeDomainData / getByteFrequencyData.
 * In silent mode the master gain is 0 and those buffers are filled with a calm,
 * predefined periodic pattern instead, so the visuals keep moving without sound.
 */

export const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const;
export type Waveform = (typeof WAVEFORMS)[number];

export const isWaveform = (value: unknown): value is Waveform =>
  typeof value === 'string' && (WAVEFORMS as readonly string[]).includes(value);

/** Perceived-loudness compensation per waveform (square/saw carry far more energy). */
const VOICE_PEAK: Record<Waveform, number> = {
  sine: 0.55,
  triangle: 0.45,
  square: 0.2,
  sawtooth: 0.26,
};

/** Chord mode plays three voices per note; each is scaled down so the sum stays about as loud. */
const CHORD_VOICE_GAIN = 0.6;

/** Master low-pass sweep range (Hz) and the curve that maps pointer position 0..1 onto it. */
export const FILTER_MIN_HZ = 260;
export const FILTER_MAX_HZ = 18000;
const FILTER_CURVE = 0.7;

/** Pitch bend range in cents (±1 octave). */
export const PITCH_BEND_RANGE = 1200;

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const C4 = 261.63;
const TWO_PI = Math.PI * 2;

/**
 * Diatonic third and fifth (semitones above the root) for a root inside the C major scale.
 * C→E G (major), D→F A (minor), E→G B (minor), G→B D (major), A→C E (minor), B→D F (dim).
 * Roots outside the scale fall back to a plain major triad.
 */
export function triadIntervals(frequency: number): [number, number] {
  const semitones = Math.round(12 * Math.log2(frequency / C4));
  const pitchClass = ((semitones % 12) + 12) % 12;
  const degree = MAJOR_SCALE.indexOf(pitchClass);
  if (degree < 0) return [4, 7];
  const third = (MAJOR_SCALE[(degree + 2) % 7] - pitchClass + 12) % 12;
  const fifth = (MAJOR_SCALE[(degree + 4) % 7] - pitchClass + 12) % 12;
  return [third, fifth];
}

export interface NoteOptions {
  /** Overrides the engine-wide waveform for this note only. */
  waveform?: Waveform;
  /** seconds */
  attack?: number;
  /** seconds */
  decay?: number;
  /** linear peak gain of the voice envelope */
  peak?: number;
  /** AudioContext time to start at (defaults to now). Used by the sequencer for precise scheduling. */
  when?: number;
  /** Play only the root even when chord mode is on. */
  single?: boolean;
}

interface Voice {
  osc: OscillatorNode;
  octave: OscillatorNode;
}

interface AmbientGraph {
  bus: GainNode;
  oscillators: OscillatorNode[];
  /** Audible oscillators (not LFOs) that follow the pitch bend. */
  tonal: OscillatorNode[];
  nodes: AudioNode[];
}

const BANDS = {
  bass: [20, 250],
  mid: [250, 2000],
  treble: [2000, 8000],
} as const;

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  /** Master low-pass filter, swept by pointer X / the XY pad. Sits between master and analyser. */
  readonly filter: BiquadFilterNode;
  readonly analyser: AnalyserNode;
  /** All played notes go through here before the master (and into the effect sends). */
  readonly voiceBus: GainNode;

  private readonly reverb: ConvolverNode;
  private readonly reverbSend: GainNode;
  private readonly delay: DelayNode;
  private readonly delaySend: GainNode;
  private readonly delayFeedback: GainNode;
  private readonly delayFilter: BiquadFilterNode;
  private reverbLevel = 0;
  private delayLevel = 0;

  /** Raw time-domain samples (0..255, 128 = silence). Length = fftSize. */
  readonly timeDomain: Uint8Array<ArrayBuffer>;
  /** Raw frequency magnitudes (0..255). Length = fftSize / 2. */
  readonly frequency: Uint8Array<ArrayBuffer>;

  /** Smoothed RMS loudness 0..1 (fast attack, slow release). */
  level = 0;
  /** Smoothed band energies 0..1. */
  bass = 0;
  mid = 0;
  treble = 0;
  /** Short transient that spikes when a note is triggered and decays quickly. */
  impulse = 0;

  private readonly volume = 0.8;
  private muted = false;
  private silent = false;
  private silentTime = 0;
  private lastSilentPulse = 0;
  private chord = false;
  private bend = 0;
  private filterPos = 1;
  private waveform: Waveform = 'triangle';
  private started = false;
  private ambient: AmbientGraph | null = null;
  private readonly voices = new Set<Voice>();

  constructor(fftSize: 256 | 512 | 1024 | 2048 = 2048) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new Error('Web Audio API is not supported in this browser.');
    }

    // The context may start in "suspended" state; it is resumed in start() after a user gesture.
    this.context = new Ctor({ latencyHint: 'interactive' });

    this.master = this.context.createGain();
    this.master.gain.value = this.volume;

    // Master low-pass: fully open by default, swept by pointer X (see src/sweep.ts / src/xy.ts)
    this.filter = this.context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = FILTER_MAX_HZ;
    this.filter.Q.value = 1.2;

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.82;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.master.connect(this.filter);
    this.filter.connect(this.analyser);
    this.analyser.connect(this.context.destination);

    // ---- Voice bus + effect sends (played notes only; the drone stays dry) ----
    this.voiceBus = this.context.createGain();
    this.voiceBus.gain.value = 1;
    this.voiceBus.connect(this.master);

    // Reverb: synthesized impulse response (no audio files), send -> convolver -> master
    this.reverb = this.context.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(2.6, 3.2);
    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 0;
    this.voiceBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

    // Delay: send -> delay -> master, with a darkened feedback loop (dotted-eighth at the current tempo)
    this.delay = this.context.createDelay(2);
    this.delay.delayTime.value = 0.375;
    this.delaySend = this.context.createGain();
    this.delaySend.gain.value = 0;
    this.delayFeedback = this.context.createGain();
    this.delayFeedback.gain.value = 0.42;
    this.delayFilter = this.context.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 2400;
    this.voiceBus.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.master);

    this.setReverb(0.35);
    this.setDelay(0.25);

    this.timeDomain = new Uint8Array(this.analyser.fftSize);
    this.timeDomain.fill(128);
    this.frequency = new Uint8Array(this.analyser.frequencyBinCount);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Silent mode: master gain 0, visuals driven by a predefined pattern (hearing accessibility). */
  get isSilent(): boolean {
    return this.silent;
  }

  /** Chord mode: every note also sounds its diatonic third and fifth. */
  get chordMode(): boolean {
    return this.chord;
  }

  /** Current pitch bend in cents (applied to all voices and the drone). */
  get pitchBend(): number {
    return this.bend;
  }

  /** Master filter sweep position 0 (closed) .. 1 (open). */
  get filterPosition(): number {
    return this.filterPos;
  }

  /** Master filter cutoff in Hz that corresponds to `filterPosition`. */
  get filterCutoff(): number {
    return AudioEngine.cutoffForPosition(this.filterPos);
  }

  static cutoffForPosition(position: number): number {
    const x = clamp(position, 0, 1);
    return FILTER_MIN_HZ * Math.pow(FILTER_MAX_HZ / FILTER_MIN_HZ, Math.pow(x, FILTER_CURVE));
  }

  /** Waveform used by every oscillator that playNote() creates. */
  get currentWaveform(): Waveform {
    return this.waveform;
  }

  setWaveform(waveform: Waveform): void {
    this.waveform = waveform;
  }

  setChordMode(enabled: boolean): void {
    this.chord = enabled;
  }

  get reverbAmount(): number {
    return this.reverbLevel;
  }

  get delayAmount(): number {
    return this.delayLevel;
  }

  /** Reverb send level 0..1 (0 = dry). */
  setReverb(amount: number): void {
    this.reverbLevel = clamp(amount, 0, 1);
    this.rampParam(this.reverbSend.gain, this.reverbLevel * 1.2);
  }

  /** Delay send level 0..1 (0 = dry). */
  setDelay(amount: number): void {
    this.delayLevel = clamp(amount, 0, 1);
    this.rampParam(this.delaySend.gain, this.delayLevel * 0.9);
  }

  /** Keeps the delay time musically related to the sequencer tempo (dotted eighth). */
  setTempo(bpm: number): void {
    const beat = 60 / clamp(bpm, 30, 300);
    const t = this.context.currentTime;
    this.delay.delayTime.cancelScheduledValues(t);
    this.delay.delayTime.setTargetAtTime(beat * 0.75, t, 0.05);
  }

  /**
   * Master low-pass sweep. `position` 0 = closed (260Hz), 1 = fully open (18kHz), exponential in between.
   * Because the filter sits before the analyser, closing it also dims the visuals.
   */
  setFilterPosition(position: number): void {
    this.filterPos = clamp(position, 0, 1);
    const t = this.context.currentTime;
    this.filter.frequency.cancelScheduledValues(t);
    this.filter.frequency.setTargetAtTime(this.filterCutoff, t, 0.03);
  }

  /**
   * Pitch bend in cents (±PITCH_BEND_RANGE). Applied to every voice that is currently sounding,
   * to the audible drone oscillators, and to every voice created afterwards.
   */
  setPitchBend(cents: number): void {
    this.bend = clamp(cents, -PITCH_BEND_RANGE, PITCH_BEND_RANGE);
    const t = this.context.currentTime;
    for (const voice of this.voices) {
      this.glideDetune(voice.osc.detune, t);
      this.glideDetune(voice.octave.detune, t);
    }
    if (this.ambient) {
      for (const osc of this.ambient.tonal) this.glideDetune(osc.detune, t);
    }
  }

  private glideDetune(param: AudioParam, t: number): void {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.setTargetAtTime(this.bend, t, 0.02);
  }

  /** Bump the visual transient (used when a scheduled sequencer note actually sounds). */
  kick(amount = 0.8): void {
    this.impulse = Math.min(1.5, this.impulse + amount);
  }

  private rampParam(param: AudioParam, value: number, seconds = 0.08): void {
    const t = this.context.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  /**
   * Exponentially decaying stereo noise burst used as the reverb impulse response.
   * Normalised to unit energy so the wet level is predictable.
   */
  private createImpulseResponse(duration: number, decay: number): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const buffer = this.context.createBuffer(2, length, rate);
    let energy = 0;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const envelope = Math.pow(1 - t, decay);
        const sample = (Math.random() * 2 - 1) * envelope;
        data[i] = sample;
        energy += sample * sample;
      }
    }
    const norm = 1 / Math.sqrt(energy / 2);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] *= norm;
    }
    return buffer;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get binCount(): number {
    return this.analyser.frequencyBinCount;
  }

  /** Hz covered by a single FFT bin. */
  get binWidth(): number {
    return this.context.sampleRate / this.analyser.fftSize;
  }

  binForFrequency(hz: number): number {
    return clamp(Math.round(hz / this.binWidth), 0, this.binCount - 1);
  }

  /** Average magnitude (0..1) of all bins between lowHz and highHz (inclusive). */
  bandEnergy(lowHz: number, highHz: number): number {
    const lo = this.binForFrequency(lowHz);
    const hi = Math.max(lo, this.binForFrequency(highHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.frequency[i];
    return sum / ((hi - lo + 1) * 255);
  }

  /**
   * Must be called from a user gesture (click / keydown) because of autoplay policies.
   * Resumes the context and starts the ambient drone exactly once.
   */
  async start(): Promise<void> {
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
    if (!this.started) {
      this.started = true;
      this.startAmbient();
    }
  }

  /**
   * Low ambient drone: a 55Hz sine fundamental with a quiet fifth and a very soft
   * filtered harmonic layer so the spectrum has something to show above the fundamental.
   * Everything is synthesized – no audio files.
   */
  private startAmbient(): void {
    const ctx = this.context;
    const now = ctx.currentTime;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(1, now + 2.5);
    bus.connect(this.master);

    // Fundamental: pure sine, A1 (55Hz)
    const fundamental = ctx.createOscillator();
    fundamental.type = 'sine';
    fundamental.frequency.value = 55;
    const fundamentalGain = ctx.createGain();
    fundamentalGain.gain.value = 0.34;
    fundamental.connect(fundamentalGain).connect(bus);

    // Fifth: sine E2 (82.41Hz) with a slow tremolo LFO on its gain
    const fifth = ctx.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 82.41;
    const fifthGain = ctx.createGain();
    fifthGain.gain.value = 0.1;
    fifth.connect(fifthGain).connect(bus);

    const tremolo = ctx.createOscillator();
    tremolo.type = 'sine';
    tremolo.frequency.value = 0.13;
    const tremoloDepth = ctx.createGain();
    tremoloDepth.gain.value = 0.05;
    tremolo.connect(tremoloDepth).connect(fifthGain.gain);

    // Air: very quiet sawtooth an octave up through a slowly sweeping low-pass filter
    const air = ctx.createOscillator();
    air.type = 'sawtooth';
    air.frequency.value = 110;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 6;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.045;
    air.connect(filter).connect(airGain).connect(bus);

    const sweep = ctx.createOscillator();
    sweep.type = 'sine';
    sweep.frequency.value = 0.05;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 360;
    sweep.connect(sweepDepth).connect(filter.frequency);

    const tonal = [fundamental, fifth, air];
    for (const osc of tonal) osc.detune.value = this.bend;

    const oscillators = [fundamental, fifth, tremolo, air, sweep];
    for (const osc of oscillators) osc.start(now);

    this.ambient = {
      bus,
      oscillators,
      tonal,
      nodes: [fundamentalGain, fifthGain, tremoloDepth, filter, airGain, sweepDepth, bus],
    };
  }

  /**
   * Trigger a short synthesized note.
   * Creates a fresh OscillatorNode + GainNode, applies an attack/decay envelope,
   * and disconnects everything once playback ends so nothing leaks.
   * In chord mode the diatonic third and fifth sound together with the root.
   */
  playNote(frequency: number, options: NoteOptions = {}): void {
    if (this.context.state !== 'running') return;

    const currentTime = this.context.currentTime;
    const now = Math.max(currentTime, options.when ?? currentTime);
    const waveform = options.waveform ?? this.waveform;
    const { attack = 0.01, decay = 0.3 } = options;
    const basePeak = options.peak ?? VOICE_PEAK[waveform];
    const chord = this.chord && !options.single;
    const peak = chord ? basePeak * CHORD_VOICE_GAIN : basePeak;

    this.spawnVoice(frequency, waveform, now, attack, decay, peak);
    if (chord) {
      const [third, fifth] = triadIntervals(frequency);
      this.spawnVoice(frequency * Math.pow(2, third / 12), waveform, now, attack, decay, peak * 0.85);
      this.spawnVoice(frequency * Math.pow(2, fifth / 12), waveform, now, attack, decay, peak * 0.8);
    }

    // Scheduled (future) notes get their visual kick from the scheduler when they sound
    if (now - currentTime < 0.03) this.kick(chord ? 1 : 0.8);
  }

  private spawnVoice(
    frequency: number,
    waveform: Waveform,
    now: number,
    attack: number,
    decay: number,
    peak: number,
  ): void {
    const ctx = this.context;

    const osc = ctx.createOscillator();
    osc.type = waveform;
    osc.frequency.value = frequency;
    osc.detune.value = this.bend;

    // A quieter partial one octave up (same waveform) gives the pluck a little shimmer.
    const octave = ctx.createOscillator();
    octave.type = waveform;
    octave.frequency.value = frequency * 2;
    octave.detune.value = this.bend;
    const octaveGain = ctx.createGain();
    octaveGain.gain.value = waveform === 'sine' || waveform === 'triangle' ? 0.22 : 0.12;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(peak, now + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0005, now + attack + decay);
    envelope.gain.setValueAtTime(0, now + attack + decay + 0.005);

    osc.connect(envelope);
    octave.connect(octaveGain).connect(envelope);
    envelope.connect(this.voiceBus);

    const stopAt = now + attack + decay + 0.05;
    osc.start(now);
    octave.start(now);
    osc.stop(stopAt);
    octave.stop(stopAt);

    const voice: Voice = { osc, octave };
    this.voices.add(voice);
    osc.onended = () => {
      osc.onended = null;
      osc.disconnect();
      octave.disconnect();
      octaveGain.disconnect();
      envelope.disconnect();
      this.voices.delete(voice);
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Silent mode (hearing-accessibility alternative): master gain goes to 0 and `update()`
   * synthesizes calm periodic analyser data so every visual keeps running.
   */
  setSilentMode(enabled: boolean): void {
    if (enabled === this.silent) return;
    this.silent = enabled;
    if (enabled) {
      this.silentTime = 0;
      this.lastSilentPulse = 0;
    }
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    const t = this.context.currentTime;
    const target = this.muted || this.silent ? 0 : this.volume;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(target, t + 0.12);
  }

  /**
   * Predefined "calm waves" pattern used instead of analyser data in silent mode:
   * two slow sines in the time domain, a breathing bass hump plus a wandering mid peak in
   * the spectrum, and a soft impulse every ~2.4s so particle bursts keep happening.
   */
  private synthesizeVisualData(dt: number): void {
    this.silentTime += dt;
    const t = this.silentTime;

    const swell = 0.62 + 0.38 * Math.sin(t * 0.45);
    const a1 = 0.32 * swell;
    const a2 = 0.11 * swell;
    const phase1 = t * 1.3;
    const phase2 = -t * 2.1;
    const td = this.timeDomain;
    const n = td.length;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = a1 * Math.sin(u * TWO_PI * 3 + phase1) + a2 * Math.sin(u * TWO_PI * 7 + phase2);
      td[i] = 128 + v * 127;
    }

    const fq = this.frequency;
    const bins = fq.length;
    const center = 28 + 40 * (0.5 + 0.5 * Math.sin(t * 0.33));
    const sigma = 9;
    const bassBreath = 0.75 + 0.25 * Math.sin(t * 0.6);
    for (let b = 0; b < bins; b++) {
      const bass = 205 * Math.exp(-b / 14) * bassBreath;
      const d = (b - center) / sigma;
      const midPeak = 120 * Math.exp(-0.5 * d * d) * swell;
      const tail = 26 * Math.exp(-b / 160);
      fq[b] = Math.min(255, bass + midPeak + tail);
    }

    if (t - this.lastSilentPulse >= 2.4) {
      this.lastSilentPulse = t;
      this.impulse = Math.min(1.5, this.impulse + 0.45);
    }
  }

  /** Pull fresh analyser data and update smoothed metrics. Call once per rendered frame. */
  update(dt: number): void {
    if (this.silent) {
      this.synthesizeVisualData(dt);
    } else {
      this.analyser.getByteTimeDomainData(this.timeDomain);
      this.analyser.getByteFrequencyData(this.frequency);
    }

    // RMS of the waveform -> loudness
    let sum = 0;
    const n = this.timeDomain.length;
    for (let i = 0; i < n; i++) {
      const v = (this.timeDomain[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);
    const target = clamp(rms * 2.4, 0, 1);
    this.level = damp(this.level, target, target > this.level ? 30 : 6, dt);

    const bass = this.bandEnergy(BANDS.bass[0], BANDS.bass[1]);
    const mid = this.bandEnergy(BANDS.mid[0], BANDS.mid[1]);
    const treble = this.bandEnergy(BANDS.treble[0], BANDS.treble[1]);
    this.bass = damp(this.bass, bass, bass > this.bass ? 24 : 7, dt);
    this.mid = damp(this.mid, mid, mid > this.mid ? 24 : 7, dt);
    this.treble = damp(this.treble, treble, treble > this.treble ? 24 : 7, dt);

    this.impulse = Math.max(0, this.impulse - dt * 3);
  }

  dispose(): void {
    if (this.ambient) {
      const now = this.context.currentTime;
      for (const osc of this.ambient.oscillators) {
        try {
          osc.stop(now);
        } catch {
          /* already stopped */
        }
        osc.disconnect();
      }
      for (const node of this.ambient.nodes) node.disconnect();
      this.ambient = null;
    }
    for (const voice of this.voices) {
      for (const osc of [voice.osc, voice.octave]) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        osc.disconnect();
      }
    }
    this.voices.clear();
    for (const node of [
      this.voiceBus,
      this.reverbSend,
      this.reverb,
      this.delaySend,
      this.delay,
      this.delayFilter,
      this.delayFeedback,
    ]) {
      node.disconnect();
    }
    this.master.disconnect();
    this.filter.disconnect();
    this.analyser.disconnect();
    if (this.context.state !== 'closed') {
      void this.context.close();
    }
  }
}
