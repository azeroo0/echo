import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { Chapter, SceneManager } from './scene';
import { prefersReducedMotion, smoothstep } from './utils';

gsap.registerPlugin(ScrollTrigger);

export interface ScrollBinding {
  element: HTMLElement;
  chapter: Chapter;
  keepContent?: boolean;
}

export type ChapterTriggers = ScrollTrigger[];

export interface ConvergenceBinding {
  element: HTMLElement;
  chapter: Chapter;
  outro: HTMLElement;
}

export function transitionCurve(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const peak = 0.72;
  const value = p < peak ? smoothstep(0.18, peak, p) : 1 - smoothstep(peak, 1, p);
  return Math.pow(value, 1.2);
}

export function setupScroll(
  manager: SceneManager,
  heroElement: HTMLElement,
  bindings: ScrollBinding[],
  convergence?: ConvergenceBinding,
): ChapterTriggers {
  const chapterTriggers: ChapterTriggers = [];
  const reducedMotion = prefersReducedMotion();
  ScrollTrigger.config({ ignoreMobileResize: true });

  const pinDistance = () => Math.round(window.innerHeight * (reducedMotion ? 1.6 : 2.5));

  ScrollTrigger.create({
    trigger: heroElement,
    start: 'top top',
    end: 'bottom top',
    onToggle: (self) => {
      if (self.isActive) manager.activate('hero');
    },
  });

  const heroContent = heroElement.querySelector<HTMLElement>('.hero__content');
  const scrollHint = heroElement.querySelector<HTMLElement>('.scroll-hint');
  if (heroContent) {
    gsap.to(heroContent, {
      opacity: 0,
      y: reducedMotion ? 0 : -60,
      ease: 'none',
      scrollTrigger: {
        trigger: heroElement,
        start: 'top top',
        end: 'bottom top',
        scrub: true,
      },
    });
  }
  if (scrollHint) {
    gsap.to(scrollHint, {
      opacity: 0,
      ease: 'none',
      scrollTrigger: {
        trigger: heroElement,
        start: 'top top',
        end: '30% top',
        scrub: true,
      },
    });
  }

  for (const { element, chapter, keepContent } of bindings) {
    const content = element.querySelector<HTMLElement>('.chapter__content');
    const index = element.querySelector<HTMLElement>('.chapter__index');
    const title = element.querySelector<HTMLElement>('.chapter__title');
    const desc = element.querySelector<HTMLElement>('.chapter__desc');
    const meta = element.querySelector<HTMLElement>('.chapter__meta');
    const pads = element.querySelector<HTMLElement>('.pads-wrap');

    const timeline = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: element,
        start: 'top top',
        end: () => `+=${pinDistance()}`,
        pin: true,
        scrub: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          chapter.progress = self.progress;
        },
        onToggle: (self) => {
          if (self.isActive) manager.activate(chapter.id);
        },
      },
    });

    const rise = reducedMotion ? 0 : 40;

    if (index) timeline.from(index, { opacity: 0, y: rise * 0.5, duration: 0.08 }, 0.02);
    if (title) timeline.from(title, { opacity: 0, y: rise, duration: 0.12 }, 0.03);
    if (desc) timeline.from(desc, { opacity: 0, y: rise * 0.75, duration: 0.12 }, 0.07);
    if (meta) timeline.from(meta, { opacity: 0, y: rise * 0.5, duration: 0.1 }, 0.11);
    if (pads) timeline.from(pads, { opacity: 0, y: rise * 0.6, duration: 0.14 }, 0.1);

    if (!keepContent && content) {
      timeline.to(content, { opacity: 0, y: -rise * 0.75, duration: 0.1 }, 0.88);
    }

    timeline.set({}, {}, 1);

    if (timeline.scrollTrigger) chapterTriggers.push(timeline.scrollTrigger);
  }

  chapterTriggers.forEach((trigger, i) => {
    const previous = i > 0 ? chapterTriggers[i - 1] : null;
    ScrollTrigger.create({
      start: () => (previous ? previous.end : Math.max(0, trigger.start - window.innerHeight * 0.55)),
      end: () => trigger.start,
      onUpdate: (self) => manager.setTransition(transitionCurve(self.progress)),
      onLeave: () => manager.setTransition(0),
      onLeaveBack: () => manager.setTransition(0),
    });
  });

  if (convergence) {
    const { element, chapter, outro } = convergence;
    const outroContent = outro.querySelector<HTMLElement>('.outro__content');
    const timeline = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: element,
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          chapter.progress = self.progress;
        },
        onToggle: (self) => {
          if (self.isActive) manager.activate(chapter.id);
        },
      },
    });

    if (outroContent) {
      timeline.from(outroContent, { opacity: 0, y: reducedMotion ? 0 : 36, duration: 0.28 }, 0.7);
    }
    timeline.set({}, {}, 1);
  }

  ScrollTrigger.refresh();
  return chapterTriggers;
}

export function refreshScroll(): void {
  ScrollTrigger.refresh();
}

export function killScroll(): void {
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
}
