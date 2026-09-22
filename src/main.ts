import './styles/main.css';

import { AudioEngine, isWaveform } from './audio';
import { setupProgress } from './progress';
import { SceneManager } from './scene';
import { HeroChapter } from './chapters/hero';
import { SignalChapter } from './chapters/signal';
import { FrequencyChapter } from './chapters/frequency';
import { SynthesisChapter } from './chapters/synthesis';
import { ConvergenceChapter } from './chapters/convergence';
import { HeroPreview } from './preview';
import { setupScroll, refreshScroll, killScroll } from './scroll';
import { Loader, openGate } from './loader';
import { setupPads } from './pads';
import { Sequencer } from './sequencer';
import { setupCursor } from './cursor';
import { setupFilterSweep } from './sweep';
import { setupXYPad } from './xy';
import { buildShareUrl, copyToClipboard, readSharedState } from './share';
import { setupTypography } from './typography';
import { nextFrame, prefersReducedMotion, requireElement } from './utils';

/**
 * Boot sequence
 * 1. Loader counts toward real initialisation progress
 * 2. AudioEngine (context stays suspended), SceneManager, chapters, shader precompile
 * 3. ScrollTrigger wiring
 * 4. Gate (with the looping hero preview fly-through behind it) -> user gesture -> AudioContext.resume() + ambient drone
 * 5. Unlock scrolling
 */
async function bootstrap(): Promise<void> {
  const reducedMotion = prefersReducedMotion();

  const loader = new Loader(
    requireElement<HTMLElement>('#loader'),
    requireElement<HTMLElement>('#loader-count'),
    requireElement<HTMLElement>('#loader-bar'),
    reducedMotion,
  );

  let audio: AudioEngine;
  let manager: SceneManager;

  try {
    loader.set(0.06);
    await nextFrame();

    audio = new AudioEngine(2048);
    loader.set(0.18);
    await nextFrame();

    const canvas = requireElement<HTMLCanvasElement>('#gl');
    manager = new SceneManager(canvas, audio);
    loader.set(0.38);
    await nextFrame();
  } catch (error) {
    console.error(error);
    loader.fail('이 브라우저에서는 WebGL 또는 Web Audio API를 사용할 수 없어 ECHO를 실행할 수 없습니다.');
    return;
  }

  // ---- Chapters ----
  const hero = new HeroChapter();
  manager.addChapter(hero);
  loader.set(0.5);
  await nextFrame();

  const signal = new SignalChapter();
  manager.addChapter(signal);
  loader.set(0.6);
  await nextFrame();

  const frequency = new FrequencyChapter(audio);
  manager.addChapter(frequency);
  loader.set(0.7);
  await nextFrame();

  const synthesis = new SynthesisChapter(audio);
  manager.addChapter(synthesis);
  loader.set(0.78);
  await nextFrame();

  // Synthesis -> Outro convergence (scroll-scrubbed, no pinned copy of its own)
  const convergence = new ConvergenceChapter(audio);
  manager.addChapter(convergence);
  loader.set(0.84);
  await nextFrame();

  manager.precompile();
  loader.set(0.9);
  await nextFrame();

  // ---- Scroll ----
  const chapterTriggers = setupScroll(manager, requireElement<HTMLElement>('#hero'), [
    { element: requireElement<HTMLElement>('#signal'), chapter: signal },
    { element: requireElement<HTMLElement>('#frequency'), chapter: frequency },
    { element: requireElement<HTMLElement>('#synthesis'), chapter: synthesis, keepContent: true },
  ], {
    element: requireElement<HTMLElement>('#convergence'),
    chapter: convergence,
    outro: requireElement<HTMLElement>('#outro'),
  });

  // ---- Progress rail ----
  const disposeProgress = setupProgress(requireElement<HTMLElement>('#progress'), chapterTriggers, reducedMotion);

  manager.activate('hero', true);
  manager.start();
  loader.set(1);

  await loader.done;

  // ---- Gate (user gesture for autoplay policy) + hero preview fly-through ----
  // While the gate is up the camera loops through the three chapter spaces. The AudioContext is
  // still suspended (autoplay policy), so the analyser buffers are filled with the silent-mode
  // pattern for now; the real signal takes over the moment the user presses Start.
  const gate = requireElement<HTMLElement>('#gate');
  const previewRoot = gate.querySelector<HTMLElement>('#gate-preview');
  const preview = new HeroPreview(
    manager,
    previewRoot
      ? {
          root: previewRoot,
          index: previewRoot.querySelector<HTMLElement>('.gate__preview-index'),
          name: previewRoot.querySelector<HTMLElement>('.gate__preview-name'),
          fill: previewRoot.querySelector<HTMLElement>('.gate__preview-fill'),
        }
      : null,
    reducedMotion,
  );
  audio.setSilentMode(true);
  preview.start();

  const { sound } = await openGate(gate, reducedMotion);

  preview.stop();
  // "소리 없이 입장" simply keeps silent mode on; Start hands the visuals back to the live analyser
  audio.setSilentMode(!sound);

  try {
    await audio.start();
  } catch (error) {
    console.warn('AudioContext could not be resumed:', error);
  }

  // ---- Mute ----
  const muteButton = requireElement<HTMLButtonElement>('#mute-toggle');
  const muteLabel = muteButton.querySelector<HTMLElement>('.mute__label');
  const renderMute = () => {
    const muted = audio.isMuted;
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.setAttribute('aria-label', muted ? '소리 켜기' : '소리 끄기');
    if (muteLabel) muteLabel.textContent = muted ? 'Sound off' : 'Sound on';
  };
  renderMute();
  muteButton.addEventListener('click', () => {
    audio.toggleMute();
    renderMute();
  });

  // ---- Silent mode (hearing-accessibility alternative: gain 0 + predefined visual pattern) ----
  const silentButton = requireElement<HTMLButtonElement>('#silent-toggle');
  const renderSilent = () => {
    const on = audio.isSilent;
    silentButton.setAttribute('aria-pressed', String(on));
    silentButton.setAttribute('aria-label', on ? '무음 모드 끄기' : '무음 모드 켜기');
    document.body.classList.toggle('is-silent', on);
  };
  renderSilent();
  const onSilentClick = () => {
    audio.setSilentMode(!audio.isSilent);
    renderSilent();
  };
  silentButton.addEventListener('click', onSilentClick);

  // Unlock scrolling and let ScrollTrigger re-measure now that the body can scroll
  document.body.classList.remove('is-locked');
  window.scrollTo({ top: 0, behavior: 'auto' });
  refreshScroll();

  // ---- Pads ----
  const padsHandle = setupPads(
    requireElement<HTMLElement>('#pads'),
    (pad) => {
      // Uses the engine-wide waveform (and chord mode) chosen in the toolbar
      audio.playNote(pad.frequency, { attack: 0.01, decay: 0.3 });
      synthesis.burst(pad.index, padsHandle.pads.length);
    },
    {
      // Letter keys only play while Synthesis is the active chapter (or a pad / step has focus)
      keysEnabled: () =>
        manager.active?.id === 'synthesis' ||
        (document.activeElement instanceof HTMLElement &&
          (document.activeElement.classList.contains('pad') || document.activeElement.classList.contains('step'))),
    },
  );
  const padCount = padsHandle.pads.length;

  // ---- FX sends (reverb / delay) ----
  const bindSlider = (id: string, apply: (amount: number) => void) => {
    const slider = requireElement<HTMLInputElement>(`#${id}`);
    const output = slider.parentElement?.querySelector<HTMLOutputElement>('.fx__value') ?? null;
    const sync = () => {
      const value = Number(slider.value);
      apply(value / 100);
      slider.setAttribute('aria-valuetext', `${value}%`);
      if (output) output.value = String(value);
    };
    slider.addEventListener('input', sync);
    sync();
    return () => slider.removeEventListener('input', sync);
  };
  const disposeReverb = bindSlider('fx-reverb', (amount) => audio.setReverb(amount));
  const disposeDelay = bindSlider('fx-delay', (amount) => audio.setDelay(amount));

  // ---- 8-step sequencer ----
  const sequencer = new Sequencer({
    root: requireElement<HTMLElement>('#sequencer'),
    audio,
    notes: padsHandle.pads.map((pad) => ({
      index: pad.index,
      note: pad.note,
      frequency: pad.frequency,
      code: pad.code,
    })),
    onStep: (_step, note) => {
      if (!note) return;
      synthesis.burst(note.index, padCount);
      padsHandle.flash(padsHandle.pads[note.index]);
    },
  });

  // ---- Custom cursor (fine pointers only) ----
  const disposeCursor = setupCursor(audio, reducedMotion);

  // ---- Audio-reactive chapter titles ----
  const disposeTypography = setupTypography(audio, reducedMotion);

  // ---- XY pad (X = cutoff, Y = pitch bend) + global filter sweep (pointer X / touch drag) ----
  const xyRoot = requireElement<HTMLElement>('#xy');
  const xyToggle = requireElement<HTMLButtonElement>('#xy-toggle');
  // Expanded by default only where it cannot collide with the chapter copy or the pads
  xyRoot.hidden = !window.matchMedia('(min-width: 1024px)').matches;
  const xyPad = setupXYPad(xyRoot, xyToggle, audio, reducedMotion);
  const disposeSweep = setupFilterSweep(audio, {
    // The XY pad and range/number inputs own their own horizontal drags
    ignore: (target) => target instanceof Element && !!target.closest('.xy, input'),
    paused: () => xyPad.isDragging,
    onChange: (position) => xyPad.setFilterPosition(position),
  });

  // ---- Waveform selector ----
  const waveformGroup = requireElement<HTMLElement>('#waveform');
  const waveformInputs = Array.from(waveformGroup.querySelectorAll<HTMLInputElement>('input[name="waveform"]'));
  const syncWaveform = () => {
    const checked = waveformInputs.find((input) => input.checked);
    if (checked && isWaveform(checked.value)) audio.setWaveform(checked.value);
  };
  syncWaveform();
  const onWaveformChange = () => {
    syncWaveform();
    // Audition the new timbre so the change is audible immediately
    audio.playNote(440, { attack: 0.01, decay: 0.3 });
    synthesis.burst(4, padCount);
  };
  waveformGroup.addEventListener('change', onWaveformChange);

  // ---- Chord mode ----
  const chordButton = requireElement<HTMLButtonElement>('#chord-toggle');
  const renderChord = () => {
    const on = audio.chordMode;
    chordButton.setAttribute('aria-pressed', String(on));
    chordButton.setAttribute('aria-label', on ? '코드 모드 끄기' : '코드 모드 켜기');
  };
  renderChord();
  const onChordClick = () => {
    audio.setChordMode(!audio.chordMode);
    renderChord();
    // Audition: C4 (as a triad when chord mode just turned on)
    audio.playNote(261.63, { attack: 0.01, decay: 0.35 });
    synthesis.burst(0, padCount);
  };
  chordButton.addEventListener('click', onChordClick);

  // ---- Melody link: load shared state from the URL (no autoplay) ----
  const shareStatus = requireElement<HTMLElement>('#seq-status');
  const shared = readSharedState(window.location.search, sequencer.stepCount, padCount);
  if (shared) {
    sequencer.loadPattern(shared.pattern);
    if (shared.bpm !== null) sequencer.setBpm(shared.bpm, true);
    if (shared.waveform) {
      const input = waveformInputs.find((item) => item.value === shared.waveform);
      if (input) input.checked = true;
      syncWaveform();
    }
    if (shared.chord !== null) {
      audio.setChordMode(shared.chord);
      renderChord();
    }
    shareStatus.textContent = '공유된 시퀀스를 불러왔습니다. 재생 버튼을 눌러 들어보세요.';
    // Jump to the Synthesis chapter so the loaded sequencer is on screen
    const synthesisTrigger = chapterTriggers[2];
    if (synthesisTrigger) {
      window.scrollTo({ top: Math.round(synthesisTrigger.start + window.innerHeight * 0.8), behavior: 'auto' });
    }
  }

  // ---- Melody link: copy ----
  const shareButton = requireElement<HTMLButtonElement>('#seq-share');
  const shareLabel = shareButton.querySelector<HTMLElement>('.seq__share-label');
  const shareDefaultLabel = shareLabel?.textContent ?? '';
  let shareResetTimer: ReturnType<typeof setTimeout> | undefined;
  const onShare = async () => {
    const url = buildShareUrl({
      pattern: sequencer.pattern,
      bpm: sequencer.tempo,
      waveform: audio.currentWaveform,
      chord: audio.chordMode,
    });
    // Keep the address bar in sync so the link can also be copied manually
    try {
      window.history.replaceState(null, '', url);
    } catch {
      /* ignore (e.g. file://) */
    }
    const ok = await copyToClipboard(url);
    shareButton.classList.toggle('is-done', ok);
    if (shareLabel) shareLabel.textContent = ok ? '복사됨' : '복사 실패';
    shareStatus.textContent = ok
      ? '멜로디 링크를 클립보드에 복사했습니다.'
      : '클립보드에 접근할 수 없습니다. 주소창의 URL을 직접 복사해주세요.';
    if (shareResetTimer) clearTimeout(shareResetTimer);
    shareResetTimer = setTimeout(() => {
      shareButton.classList.remove('is-done');
      if (shareLabel) shareLabel.textContent = shareDefaultLabel;
    }, 1600);
  };
  const onShareClick = () => {
    void onShare();
  };
  shareButton.addEventListener('click', onShareClick);

  // ---- Capture current frame ----
  const captureButton = requireElement<HTMLButtonElement>('#capture');
  const captureLabel = captureButton.querySelector<HTMLElement>('.capture__label');
  const captureStatus = requireElement<HTMLElement>('#capture-status');
  const captureDefaultLabel = captureLabel?.textContent ?? '';
  let captureResetTimer: ReturnType<typeof setTimeout> | undefined;
  const onCapture = () => {
    const stamp = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const filename =
      `echo-${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}` +
      `-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}${pad2(stamp.getSeconds())}.png`;

    try {
      const dataUrl = manager.capture();
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();

      captureButton.classList.add('is-done');
      if (captureLabel) captureLabel.textContent = '저장됨';
      captureStatus.textContent = `현재 프레임을 ${filename} 으로 저장했습니다.`;
    } catch (error) {
      console.error('Capture failed:', error);
      if (captureLabel) captureLabel.textContent = '저장 실패';
      captureStatus.textContent = '프레임을 저장할 수 없습니다.';
    }

    if (captureResetTimer) clearTimeout(captureResetTimer);
    captureResetTimer = setTimeout(() => {
      captureButton.classList.remove('is-done');
      if (captureLabel) captureLabel.textContent = captureDefaultLabel;
    }, 1600);
  };
  captureButton.addEventListener('click', onCapture);

  // Read-only debug handle (used by scripts/smoke.mjs and handy in DevTools):
  //   __echo.audio.level, __echo.manager.active?.id, __echo.audio.filterCutoff, ...
  Object.defineProperty(window, '__echo', {
    value: Object.freeze({ audio, manager, sequencer, xyPad, preview }),
    writable: false,
    configurable: false,
  });

  // ---- Teardown ----
  const teardown = () => {
    waveformGroup.removeEventListener('change', onWaveformChange);
    chordButton.removeEventListener('click', onChordClick);
    shareButton.removeEventListener('click', onShareClick);
    silentButton.removeEventListener('click', onSilentClick);
    captureButton.removeEventListener('click', onCapture);
    if (captureResetTimer) clearTimeout(captureResetTimer);
    if (shareResetTimer) clearTimeout(shareResetTimer);
    disposeSweep();
    xyPad.dispose();
    disposeTypography();
    disposeCursor();
    sequencer.dispose();
    disposeReverb();
    disposeDelay();
    disposeProgress();
    padsHandle.dispose();
    preview.dispose();
    killScroll();
    manager.dispose();
    audio.dispose();
  };
  window.addEventListener('pagehide', teardown, { once: true });
}

bootstrap().catch((error: unknown) => {
  console.error('ECHO failed to start:', error);
  const errorEl = document.querySelector<HTMLElement>('#loader-error');
  if (errorEl) {
    errorEl.textContent = '초기화 중 오류가 발생했습니다. 콘솔을 확인해주세요.';
    errorEl.hidden = false;
  }
});
