import { isWaveform, type Waveform } from './audio';

/**
 * Melody link sharing.
 * The sequencer state is encoded into the query string:
 *   ?p=0-23-45-&bpm=120&w=triangle&c=1
 *   p   one character per step: base-36 note index, "-" = rest
 *   bpm tempo
 *   w   waveform
 *   c   chord mode (1 = on)
 * Loading such a link restores the pattern without starting playback (autoplay policy).
 */

export interface SharedState {
  pattern: Array<number | null>;
  bpm: number | null;
  waveform: Waveform | null;
  chord: boolean | null;
}

const REST = '-';

export function encodePattern(pattern: ReadonlyArray<number | null>): string {
  return pattern.map((note) => (note === null ? REST : note.toString(36))).join('');
}

export function decodePattern(text: string, steps: number, noteCount: number): Array<number | null> | null {
  if (text.length !== steps) return null;
  const pattern: Array<number | null> = [];
  for (const char of text) {
    if (char === REST) {
      pattern.push(null);
      continue;
    }
    const value = parseInt(char, 36);
    if (!Number.isInteger(value) || value < 0 || value >= noteCount) return null;
    pattern.push(value);
  }
  return pattern;
}

export function buildShareUrl(state: {
  pattern: ReadonlyArray<number | null>;
  bpm: number;
  waveform: Waveform;
  chord: boolean;
}): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('p', encodePattern(state.pattern));
  url.searchParams.set('bpm', String(Math.round(state.bpm)));
  url.searchParams.set('w', state.waveform);
  if (state.chord) url.searchParams.set('c', '1');
  return url.toString();
}

export function readSharedState(search: string, steps: number, noteCount: number): SharedState | null {
  const params = new URLSearchParams(search);
  const encoded = params.get('p');
  if (!encoded) return null;
  const pattern = decodePattern(encoded, steps, noteCount);
  if (!pattern) return null;

  const bpmRaw = Number(params.get('bpm'));
  const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : null;
  const waveRaw = params.get('w');
  const waveform = isWaveform(waveRaw) ? waveRaw : null;
  const chordRaw = params.get('c');
  const chord = chordRaw === null ? null : chordRaw === '1';

  return { pattern, bpm, waveform, chord };
}

/** Clipboard write with a textarea/execCommand fallback for browsers without the async API. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
