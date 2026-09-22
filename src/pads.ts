export interface Pad {
  index: number;
  frequency: number;
  note: string;
  /** Physical key code, e.g. "KeyA" */
  code: string;
  element: HTMLButtonElement;
}

export interface PadsOptions {
  /** Return false to ignore global key presses (e.g. when the Synthesis chapter is not on screen). */
  keysEnabled?: () => boolean;
}

export interface PadsHandle {
  pads: Pad[];
  /** Briefly light a pad up (used when the sequencer plays it). */
  flash: (pad: Pad) => void;
  dispose: () => void;
}

/**
 * Wires the Synthesis pads.
 * - Click / Enter / Space on a focused pad -> native button click -> trigger
 * - Physical keys A S D F G H J K L anywhere on the page (via event.code, so it works
 *   regardless of keyboard layout or IME state) -> trigger
 */
export function setupPads(
  container: HTMLElement,
  onTrigger: (pad: Pad) => void,
  options: PadsOptions = {},
): PadsHandle {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.pad'));
  const pads: Pad[] = buttons.map((element, index) => ({
    index,
    frequency: Number(element.dataset.freq ?? '440'),
    note: element.dataset.note ?? '',
    code: `Key${(element.dataset.key ?? '').toUpperCase()}`,
    element,
  }));
  const byCode = new Map(pads.map((pad) => [pad.code, pad]));
  const flashTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const flash = (pad: Pad) => {
    pad.element.classList.add('is-active');
    const existing = flashTimers.get(pad.index);
    if (existing) clearTimeout(existing);
    flashTimers.set(
      pad.index,
      setTimeout(() => {
        pad.element.classList.remove('is-active');
        flashTimers.delete(pad.index);
      }, 160),
    );
  };

  const fire = (pad: Pad) => {
    onTrigger(pad);
    flash(pad);
  };

  const clickHandlers = pads.map((pad) => {
    const handler = () => fire(pad);
    pad.element.addEventListener('click', handler);
    return handler;
  });

  const isTypingTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const pad = byCode.get(event.code);
    if (!pad) return;
    if (options.keysEnabled && !options.keysEnabled()) return;
    event.preventDefault();
    pad.element.classList.add('is-pressed');
    fire(pad);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const pad = byCode.get(event.code);
    if (pad) pad.element.classList.remove('is-pressed');
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const dispose = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    pads.forEach((pad, i) => pad.element.removeEventListener('click', clickHandlers[i]));
    for (const timer of flashTimers.values()) clearTimeout(timer);
    flashTimers.clear();
  };

  return { pads, flash, dispose };
}
