import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { ChapterTriggers } from './scroll';
import { clamp } from './utils';

gsap.registerPlugin(ScrollTrigger);

export function setupProgress(
  root: HTMLElement,
  triggers: ChapterTriggers,
  reducedMotion: boolean,
): () => void {
  const fill = root.querySelector<HTMLElement>('.progress__fill');
  const track = root.querySelector<HTMLElement>('.progress__track');
  const ticks = Array.from(root.querySelectorAll<HTMLElement>('.progress__tick'));
  if (!fill || !track || triggers.length === 0) return () => undefined;

  const first = triggers[0];
  const last = triggers[triggers.length - 1];

  const setFill: (value: number) => void = reducedMotion
    ? (value) => {
        fill.style.transform = `scaleY(${value.toFixed(4)})`;
      }
    : gsap.quickTo(fill, 'scaleY', { duration: 0.25, ease: 'power2.out' });

  const range = () => Math.max(1, last.end - first.start);

  const layout = () => {
    const total = range();
    ticks.forEach((tick, i) => {
      const position = i < triggers.length ? triggers[i].start - first.start : total;
      tick.style.top = `${((position / total) * 100).toFixed(3)}%`;
    });
  };

  let lastValue = -1;
  const update = () => {
    const y = window.scrollY;
    const value = clamp((y - first.start) / range(), 0, 1);
    if (value !== lastValue) {
      lastValue = value;
      setFill(value);
      track.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }

    const visible = y > first.start - window.innerHeight * 0.6 && y < last.end + window.innerHeight * 0.4;
    root.classList.toggle('is-visible', visible);

    ticks.forEach((tick, i) => {
      const trigger = triggers[i];
      const current = trigger ? y >= trigger.start && y < trigger.end : false;
      const link = tick.querySelector('a');
      if (link) {
        if (current) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
      tick.classList.toggle('is-current', current);
      tick.classList.toggle('is-passed', trigger ? y >= trigger.end : y >= last.end);
    });
  };

  const scrollWatcher = ScrollTrigger.create({
    start: 0,
    end: 'max',
    onUpdate: update,
  });
  const onRefresh = () => {
    layout();
    update();
  };
  ScrollTrigger.addEventListener('refresh', onRefresh);

  layout();
  update();

  return () => {
    ScrollTrigger.removeEventListener('refresh', onRefresh);
    scrollWatcher.kill();
  };
}
