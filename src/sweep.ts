import type { AudioEngine } from './audio';
import { clamp } from './utils';

export interface SweepOptions {
  ignore?: (target: EventTarget | null) => boolean;
  paused?: () => boolean;
  onChange?: (position: number) => void;
}

export function setupFilterSweep(audio: AudioEngine, options: SweepOptions = {}): () => void {
  const ignore = options.ignore ?? (() => false);
  const paused = options.paused ?? (() => false);

  const apply = (position: number) => {
    const value = clamp(position, 0, 1);
    audio.setFilterPosition(value);
    options.onChange?.(value);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    if (paused() || ignore(event.target)) return;
    apply(event.clientX / window.innerWidth);
  };

  let touchId: number | null = null;
  let lastX = 0;
  let touchIgnored = false;

  const onTouchStart = (event: TouchEvent) => {
    if (touchId !== null) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchId = touch.identifier;
    lastX = touch.clientX;
    touchIgnored = ignore(event.target);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (touchId === null || touchIgnored || paused()) return;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (touch.identifier !== touchId) continue;
      const dx = touch.clientX - lastX;
      lastX = touch.clientX;
      if (dx !== 0) apply(audio.filterPosition + (dx / window.innerWidth) * 1.4);
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    for (let i = 0; i < event.changedTouches.length; i++) {
      if (event.changedTouches[i].identifier === touchId) touchId = null;
    }
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
  };
}
