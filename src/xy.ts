import gsap from 'gsap';
import { AudioEngine, PITCH_BEND_RANGE } from './audio';
import { clamp } from './utils';

export interface XYPadHandle {
  readonly root: HTMLElement;
  readonly isDragging: boolean;
  setFilterPosition(position: number): void;
  setExpanded(expanded: boolean): void;
  readonly isExpanded: boolean;
  dispose(): void;
}

const KEY_STEP_X = 0.04;
const KEY_STEP_Y = 1 / 24;

const formatHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`);
const formatBend = (cents: number) => {
  const semis = Math.round(cents / 100);
  return `${semis > 0 ? '+' : ''}${semis} st`;
};

export function setupXYPad(
  root: HTMLElement,
  toggle: HTMLButtonElement,
  audio: AudioEngine,
  reducedMotion: boolean,
): XYPadHandle {
  const surface = root.querySelector<HTMLElement>('.xy__surface');
  const dot = root.querySelector<HTMLElement>('.xy__dot');
  const status = root.querySelector<HTMLElement>('.xy__status');
  if (!surface || !dot) {
    return {
      root,
      isDragging: false,
      isExpanded: false,
      setFilterPosition: () => undefined,
      setExpanded: () => undefined,
      dispose: () => undefined,
    };
  }

  const state = { x: audio.filterPosition, y: 0.5 };
  let dragging = false;
  let pointerId = -1;
  let expanded = !root.hidden;

  const renderDot = () => {
    dot.style.transform = `translate(${(state.x * 100).toFixed(2)}%, ${(state.y * 100).toFixed(2)}%)`;
  };

  const renderStatus = () => {
    if (!status) return;
    status.textContent = `Cutoff ${formatHz(audio.filterCutoff)} · Pitch ${formatBend(audio.pitchBend)}`;
  };

  const push = () => {
    audio.setFilterPosition(state.x);
    audio.setPitchBend((0.5 - state.y) * 2 * PITCH_BEND_RANGE);
    renderDot();
  };

  const applyPointer = (event: PointerEvent) => {
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    state.x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    state.y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    push();
  };

  const releasePitch = () => {
    gsap.killTweensOf(state);
    if (reducedMotion) {
      state.y = 0.5;
      push();
      renderStatus();
      return;
    }
    gsap.to(state, {
      y: 0.5,
      duration: 0.45,
      ease: 'power3.out',
      onUpdate: push,
      onComplete: renderStatus,
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    gsap.killTweensOf(state);
    dragging = true;
    pointerId = event.pointerId;
    surface.setPointerCapture(pointerId);
    surface.classList.add('is-active');
    applyPointer(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    applyPointer(event);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    surface.classList.remove('is-active');
    releasePitch();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        state.x = clamp(state.x - KEY_STEP_X, 0, 1);
        break;
      case 'ArrowRight':
        state.x = clamp(state.x + KEY_STEP_X, 0, 1);
        break;
      case 'ArrowUp':
        state.y = clamp(state.y - KEY_STEP_Y, 0, 1);
        break;
      case 'ArrowDown':
        state.y = clamp(state.y + KEY_STEP_Y, 0, 1);
        break;
      case 'Home':
        state.y = 0.5;
        break;
      case 'End':
        state.x = 1;
        break;
      case 'Escape':
        setExpanded(false);
        toggle.focus();
        return;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    gsap.killTweensOf(state);
    push();
    renderStatus();
  };

  const setExpanded = (value: boolean) => {
    expanded = value;
    root.hidden = !value;
    toggle.setAttribute('aria-expanded', String(value));
    toggle.setAttribute('aria-label', value ? 'XY 패드 닫기' : 'XY 패드 열기');
    if (value) {
      renderDot();
      renderStatus();
    }
  };

  const onToggle = () => {
    setExpanded(!expanded);
    if (expanded) surface.focus({ preventScroll: true });
  };

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);
  surface.addEventListener('keydown', onKeyDown);
  toggle.addEventListener('click', onToggle);

  setExpanded(expanded);

  return {
    root,
    get isDragging() {
      return dragging;
    },
    get isExpanded() {
      return expanded;
    },
    setFilterPosition(position: number) {
      if (dragging) return;
      state.x = clamp(position, 0, 1);
      renderDot();
    },
    setExpanded,
    dispose() {
      gsap.killTweensOf(state);
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
      surface.removeEventListener('keydown', onKeyDown);
      toggle.removeEventListener('click', onToggle);
    },
  };
}
