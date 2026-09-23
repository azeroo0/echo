import { clamp, damp } from './utils';

export const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const;
export type Waveform = (typeof WAVEFORMS)[number];

export const isWaveform = (value: unknown): value is Waveform =>
  typeof value === 'string' && (WAVEFORMS as readonly string[]).includes(value);

const VOICE_PEAK: Record<Waveform, number> = {
  sine: 0.55,
  triangle: 0.45,
  square: 0.2,
  sawtooth: 0.26,
};

const CHORD_VOICE_GAIN = 0.6;

export const FILTER_MIN_HZ = 260;
export const FILTER_MAX_HZ = 18000;
const FILTER_CURVE = 0.7;

export const PITCH_BEND_RANGE = 1200;

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const C4 = 261.63;
const TWO_PI = Math.PI * 2;

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
  waveform?: Waveform;
  attack?: number;
  decay?: number;
  peak?: number;
  when?: number;
  single?: boolean;
}

interface Voice {
  osc: OscillatorNode;
  octave: OscillatorNode;
}

interface AmbientGraph {
  bus: GainNode;
  oscillators: OscillatorNode[];
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
  readonly filter: BiquadFilterNode;
  readonly analyser: AnalyserNode;
  readonly voiceBus: GainNode;

  private readonly reverb: ConvolverNode;
  private readonly reverbSend: GainNode;
  private readonly delay: DelayNode;
  private readonly delaySend: GainNode;
  private readonly delayFeedback: GainNode;
  private readonly delayFilter: BiquadFilterNode;
  private reverbLevel = 0;
  private delayLevel = 0;

  readonly timeDomain: Uint8Array<ArrayBuffer>;
  readonly frequency: Uint8Array<ArrayBuffer>;

  level = 0;
  bass = 0;
  mid = 0;
  treble = 0;
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

    this.context = new Ctor({ latencyHint: 'interactive' });

    this.master = this.context.createGain();
    this.master.gain.value = this.volume;

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

    this.voiceBus = this.context.createGain();
    this.voiceBus.gain.value = 1;
    this.voiceBus.connect(this.master);

    this.reverb = this.context.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(2.6, 3.2);
    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 0;
    this.voiceBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

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

  get isSilent(): boolean {
    return this.silent;
  }

  get chordMode(): boolean {
    return this.chord;
  }

  get pitchBend(): number {
    return this.bend;
  }

  get filterPosition(): number {
    return this.filterPos;
  }

  get filterCutoff(): number {
    return AudioEngine.cutoffForPosition(this.filterPos);
  }

  static cutoffForPosition(position: number): number {
    const x = clamp(position, 0, 1);
    return FILTER_MIN_HZ * Math.pow(FILTER_MAX_HZ / FILTER_MIN_HZ, Math.pow(x, FILTER_CURVE));
  }

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

  setReverb(amount: number): void {
    this.reverbLevel = clamp(amount, 0, 1);
    this.rampParam(this.reverbSend.gain, this.reverbLevel * 1.2);
  }

  setDelay(amount: number): void {
    this.delayLevel = clamp(amount, 0, 1);
    this.rampParam(this.delaySend.gain, this.delayLevel * 0.9);
  }

  setTempo(bpm: number): void {
    const beat = 60 / clamp(bpm, 30, 300);
    const t = this.context.currentTime;
    this.delay.delayTime.cancelScheduledValues(t);
    this.delay.delayTime.setTargetAtTime(beat * 0.75, t, 0.05);
  }

  setFilterPosition(position: number): void {
    this.filterPos = clamp(position, 0, 1);
    const t = this.context.currentTime;
    this.filter.frequency.cancelScheduledValues(t);
    this.filter.frequency.setTargetAtTime(this.filterCutoff, t, 0.03);
  }

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

  kick(amount = 0.8): void {
    this.impulse = Math.min(1.5, this.impulse + amount);
  }

  private rampParam(param: AudioParam, value: number, seconds = 0.08): void {
    const t = this.context.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

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

  get binWidth(): number {
    return this.context.sampleRate / this.analyser.fftSize;
  }

  binForFrequency(hz: number): number {
    return clamp(Math.round(hz / this.binWidth), 0, this.binCount - 1);
  }

  bandEnergy(lowHz: number, highHz: number): number {
    const lo = this.binForFrequency(lowHz);
    const hi = Math.max(lo, this.binForFrequency(highHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.frequency[i];
    return sum / ((hi - lo + 1) * 255);
  }

  async start(): Promise<void> {
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
    if (!this.started) {
      this.started = true;
      this.startAmbient();
    }
  }

  private startAmbient(): void {
    const ctx = this.context;
    const now = ctx.currentTime;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(1, now + 2.5);
    bus.connect(this.master);

    const fundamental = ctx.createOscillator();
    fundamental.type = 'sine';
    fundamental.frequency.value = 55;
    const fundamentalGain = ctx.createGain();
    fundamentalGain.gain.value = 0.34;
    fundamental.connect(fundamentalGain).connect(bus);

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

  update(dt: number): void {
    if (this.silent) {
      this.synthesizeVisualData(dt);
    } else {
      this.analyser.getByteTimeDomainData(this.timeDomain);
      this.analyser.getByteFrequencyData(this.frequency);
    }

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
