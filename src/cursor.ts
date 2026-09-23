import type { AudioEngine } from './audio';

export function setupCursor(audio: AudioEngine, reducedMotion: boolean): () => void {
  const finePointer =
    window.matchMedia('(pointer: fine)').matches && window.matchMedia('(hover: hover)').matches;
  if (!finePointer) return () => undefined;

  const element = document.createElement('div');
  element.className = 'cursor';
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = '<span class="cursor__ring"></span><span class="cursor__dot"></span>';
  document.body.appendChild(element);
  document.body.classList.add('has-custom-cursor');

  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let targetX = x;
  let targetY = y;
  let scale = 1;
  let visible = false;
  let rafId: number | null = null;

  const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"], [role="slider"]';

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    targetX = event.clientX;
    targetY = event.clientY;
    if (!visible) {
      visible = true;
      x = targetX;
      y = targetY;
      element.classList.add('is-visible');
    }
    const target = event.target instanceof Element ? event.target : null;
    element.classList.toggle('is-hover', !!target?.closest(INTERACTIVE));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    element.classList.add('is-down');
  };
  const onPointerUp = () => element.classList.remove('is-down');

  const onLeave = () => {
    visible = false;
    element.classList.remove('is-visible', 'is-down');
  };

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    const follow = reducedMotion ? 1 : 0.35;
    x += (targetX - x) * follow;
    y += (targetY - y) * follow;

    const targetScale = 1 + audio.level * 1.3 + audio.impulse * 0.35;
    scale += (targetScale - scale) * 0.3;

    element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  };

  const onVisibility = () => {
    if (document.hidden) {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    } else if (rafId === null) {
      rafId = requestAnimationFrame(tick);
    }
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  document.documentElement.addEventListener('mouseleave', onLeave);
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onVisibility);
  rafId = requestAnimationFrame(tick);

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    element.remove();
    document.body.classList.remove('has-custom-cursor');
  };
}
