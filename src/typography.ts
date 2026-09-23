import type { AudioEngine } from './audio';

const THRESHOLD = 0.34;
const MAX_SPACING_EM = 0.016;
const MAX_WEIGHT = 60;

export function setupTypography(audio: AudioEngine, reducedMotion: boolean): () => void {
  const root = document.documentElement;
  if (reducedMotion) {
    root.style.setProperty('--title-pulse', '0em');
    root.style.setProperty('--title-weight', '0');
    return () => undefined;
  }

  let pulse = 0;
  let lastWritten = -1;
  let rafId: number | null = null;
  const start = performance.now();

  const tick = (now: number) => {
    rafId = requestAnimationFrame(tick);

    const excess = Math.max(0, audio.level - THRESHOLD) / (1 - THRESHOLD);
    const t = (now - start) / 1000;
    const wobble = excess > 0 ? Math.sin(t * 41) * 0.35 + Math.sin(t * 67) * 0.2 : 0;
    const target = excess * (1 + wobble * 0.6) + audio.impulse * 0.35 * excess;
    pulse += (target - pulse) * 0.25;
    if (pulse < 0.001) pulse = 0;

    const rounded = Math.round(pulse * 500) / 500;
    if (rounded === lastWritten) return;
    lastWritten = rounded;
    root.style.setProperty('--title-pulse', `${(rounded * MAX_SPACING_EM).toFixed(4)}em`);
    root.style.setProperty('--title-weight', (rounded * MAX_WEIGHT).toFixed(1));
  };

  const onVisibility = () => {
    if (document.hidden) {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    } else if (rafId === null) {
      rafId = requestAnimationFrame(tick);
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  rafId = requestAnimationFrame(tick);

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.removeEventListener('visibilitychange', onVisibility);
    root.style.removeProperty('--title-pulse');
    root.style.removeProperty('--title-weight');
  };
}
