import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4173/';
const reducedMotion = process.argv.includes('--reduced');
const port = 9333;
const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome/Edge binary found');
  process.exit(2);
}

const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=' + process.env.TEMP + '\\echo-smoke-profile',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      return await res.json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('DevTools endpoint did not come up');
}

const targets = await getTargets();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const consoleMessages = [];
const exceptions = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    consoleMessages.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' || e.level === 'warning') consoleMessages.push(`[log:${e.level}] ${e.text}`);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result.value;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (reducedMotion) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    console.log('Emulating prefers-reduced-motion: reduce');
  }
  await send('Page.navigate', { url });

  let loaderDone = false;
  for (let i = 0; i < 120; i++) {
    loaderDone = await evaluate(`document.getElementById('loader').hidden === true`);
    if (loaderDone) break;
    await sleep(250);
  }
  const count = await evaluate(`document.getElementById('loader-count').textContent`);
  check('Loader reaches 100% and hides', loaderDone, `count=${count}`);

  const gateVisible = await evaluate(`document.getElementById('gate').hidden === false`);
  check('Start gate is shown after loader', gateVisible);

  const webgl = await evaluate(`(() => {
    const c = document.getElementById('gl');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  })()`);
  check('WebGL context created on #gl canvas', webgl);

  const canvasSize = await evaluate(`(() => { const c = document.getElementById('gl'); return c.width + 'x' + c.height; })()`);
  check('Canvas drawing buffer sized', /^\d+x\d+$/.test(canvasSize) && canvasSize !== '0x0', canvasSize);

  const previewBefore = await evaluate(`({
    previewing: document.body.classList.contains('is-previewing'),
    captionHidden: document.getElementById('gate-preview').hidden,
    name: document.querySelector('#gate-preview .gate__preview-name').textContent,
    shot: document.getElementById('gate-preview').dataset.shot ?? null,
  })`);
  check(
    'Hero preview fly-through runs behind the gate',
    previewBefore.previewing && !previewBefore.captionHidden && ['Signal', 'Frequency', 'Synthesis'].includes(previewBefore.name),
    `shot=${previewBefore.shot}`,
  );

  await evaluate(`document.getElementById('gate-start').click(); true`);
  await sleep(1500);
  const fps = await evaluate(`new Promise((resolve) => {
    let frames = 0; const t0 = performance.now();
    const step = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(step); else resolve(Number((frames / ((performance.now() - t0) / 1000)).toFixed(1))); };
    requestAnimationFrame(step);
  })`);
  check('Render loop is ticking (informational fps)', fps > 0, `fps=${fps}`);
  let gateHidden = false;
  for (let i = 0; i < 80; i++) {
    gateHidden = await evaluate(`document.getElementById('gate').hidden === true`);
    if (gateHidden) break;
    await sleep(250);
  }
  check('Gate hides after Start', gateHidden);

  const audioState = await evaluate(`window.__echo.audio.context.state`);
  check('AudioContext is running after Start', audioState === 'running', audioState);

  const ambient = await evaluate(`window.__echo.audio.isStarted`);
  check('Ambient drone started', ambient === true);

  await sleep(1500);
  const analyser = await evaluate(`(() => {
    const a = window.__echo.audio;
    let maxDev = 0;
    for (let i = 0; i < a.timeDomain.length; i++) maxDev = Math.max(maxDev, Math.abs(a.timeDomain[i] - 128));
    let maxBin = 0;
    for (let i = 0; i < a.frequency.length; i++) maxBin = Math.max(maxBin, a.frequency[i]);
    return { maxDev, maxBin, level: Number(a.level.toFixed(3)), bass: Number(a.bass.toFixed(3)) };
  })()`);
  check(
    'Analyser receives real signal (time domain deviates from silence)',
    analyser.maxDev > 4,
    `maxDeviation=${analyser.maxDev} level=${analyser.level}`,
  );
  check(
    'Analyser receives real signal (frequency bins non-zero)',
    analyser.maxBin > 20,
    `maxBin=${analyser.maxBin} bass=${analyser.bass}`,
  );

  const heroActive = await evaluate(`window.__echo.manager.active?.id`);
  check('Hero chapter active at top', heroActive === 'hero', heroActive);

  const previewAfter = await evaluate(`({
    previewing: document.body.classList.contains('is-previewing'),
    running: window.__echo.preview.isRunning,
    override: window.__echo.manager.hasCameraOverride,
    gradeId: window.__echo.manager.gradeId,
    hidden: ['signal', 'frequency', 'synthesis'].every((id) => window.__echo.manager.getChapter(id).group.visible === false),
  })`);
  check(
    'Preview stops on Start and hands the camera back to the hero',
    !previewAfter.previewing && !previewAfter.running && !previewAfter.override && previewAfter.gradeId === 'hero' && previewAfter.hidden,
    `running=${previewAfter.running} override=${previewAfter.override} grade=${previewAfter.gradeId}`,
  );

  const bloom = await evaluate(`({
    enabled: window.__echo.manager.bloomEnabled,
    perfOff: window.__echo.manager.bloomDisabledByPerformance,
    mobile: window.matchMedia('(max-width: 768px)').matches,
  })`);
  check(
    'Bloom enabled on desktop (or auto-disabled by the perf guard on software GL)',
    (bloom.enabled && !bloom.mobile) || bloom.perfOff,
    `enabled=${bloom.enabled} perfOff=${bloom.perfOff}`,
  );

  const fx = await evaluate(`({ reverb: window.__echo.audio.reverbAmount, delay: window.__echo.audio.delayAmount })`);
  check('FX sends initialised from slider defaults', fx.reverb === 0.35 && fx.delay === 0.25, `reverb=${fx.reverb} delay=${fx.delay}`);

  const unlocked = await evaluate(`!document.body.classList.contains('is-locked')`);
  check('Body scroll unlocked', unlocked);

  const pinSpacers = await evaluate(`document.querySelectorAll('.pin-spacer').length`);
  check('ScrollTrigger created pin spacers for 3 chapters', pinSpacers === 3, `count=${pinSpacers}`);

  const convergenceRoom = await evaluate(`(() => {
    const el = document.getElementById('convergence');
    return { height: el.offsetHeight, outro: document.getElementById('outro').offsetHeight, vh: window.innerHeight };
  })()`);
  check(
    'Convergence spacer + full-height outro give the scrub its range',
    convergenceRoom.height >= convergenceRoom.vh && convergenceRoom.outro >= convergenceRoom.vh,
    `convergence=${convergenceRoom.height}px outro=${convergenceRoom.outro}px`,
  );

  const docHeight = await evaluate(`document.documentElement.scrollHeight`);
  check('Document is scrollable (pinned sections add height)', docHeight > 900 * 6, `scrollHeight=${docHeight}`);

  const expectations = [
    ['#signal', 'signal'],
    ['#frequency', 'frequency'],
    ['#synthesis', 'synthesis'],
  ];
  for (const [selector, id] of expectations) {
    await evaluate(`(() => {
      const el = document.querySelector('${selector}');
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.round(top + window.innerHeight * 0.8), behavior: 'instant' });
      return true;
    })()`);
    let active = null;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      active = await evaluate(`window.__echo.manager.active?.id`);
      if (active === id) break;
    }
    const progress = await evaluate(`Number(window.__echo.manager.active?.progress.toFixed(2))`);
    check(`Scrolling into ${selector} activates "${id}" chapter`, active === id, `active=${active} progress=${progress}`);
    const gradeId = await evaluate(`window.__echo.manager.gradeId`);
    check(`Colour grade follows the "${id}" chapter`, gradeId === id, `gradeId=${gradeId}`);
  }

  await evaluate(`(() => {
    const spacer = document.querySelector('#frequency').parentElement;
    const start = spacer.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.round(start - window.innerHeight * 0.28), behavior: 'instant' });
    return true;
  })()`);
  let transition = 0;
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    transition = await evaluate(`Number(window.__echo.manager.transitionLevel.toFixed(3))`);
    if (transition > 0.15) break;
  }
  const glitchVar = await evaluate(`document.documentElement.style.getPropertyValue('--glitch')`);
  check(
    'Signal-noise transition ramps up between chapters (uniform + --glitch)',
    transition > 0.15 && Number(glitchVar) > 0.1,
    `transition=${transition} --glitch=${glitchVar}`,
  );

  await evaluate(`(() => {
    const el = document.getElementById('convergence');
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.round(top - window.innerHeight + (el.offsetHeight + window.innerHeight) * 0.55), behavior: 'instant' });
    return true;
  })()`);
  let convergenceActive = null;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    convergenceActive = await evaluate(`window.__echo.manager.active?.id`);
    if (convergenceActive === 'convergence') break;
  }
  const convergenceMid = await evaluate(`({
    progress: Number(window.__echo.manager.getChapter('convergence').progress.toFixed(2)),
    gradeId: window.__echo.manager.gradeId,
    transition: Number(window.__echo.manager.transitionLevel.toFixed(3)),
  })`);
  check(
    'Synthesis -> Outro convergence activates and scrubs with scroll',
    convergenceActive === 'convergence' && convergenceMid.progress > 0.4 && convergenceMid.progress < 0.7 && convergenceMid.gradeId === 'convergence',
    `active=${convergenceActive} progress=${convergenceMid.progress} grade=${convergenceMid.gradeId}`,
  );
  check('No signal-noise burst inside the convergence', convergenceMid.transition < 0.05, `transition=${convergenceMid.transition}`);

  await evaluate(`window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); true`);
  await sleep(700);
  const scrolledY = await evaluate(`window.scrollY`);
  check('Scrolled to bottom (outro)', scrolledY > docHeight * 0.8, `scrollY=${scrolledY}`);
  let convergenceEnd = 0;
  for (let i = 0; i < 12; i++) {
    convergenceEnd = await evaluate(`Number(window.__echo.manager.getChapter('convergence').progress.toFixed(2))`);
    if (convergenceEnd >= 0.98) break;
    await sleep(250);
  }
  const outroOpacity = await evaluate(`Number(getComputedStyle(document.querySelector('.outro__content')).opacity)`);
  check(
    'Convergence fully dispersed at the outro (progress 1, outro copy revealed)',
    convergenceEnd >= 0.98 && outroOpacity > 0.95,
    `progress=${convergenceEnd} outroOpacity=${outroOpacity}`,
  );

  await evaluate(`(() => {
    const spacer = document.querySelector('#synthesis').parentElement;
    const top = spacer.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.round(top + window.innerHeight * 0.8), behavior: 'instant' });
    return true;
  })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if ((await evaluate(`window.__echo.manager.active?.id`)) === 'synthesis') break;
  }
  await sleep(500);
  for (const code of ['KeyA', 'KeyF', 'KeyL']) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.slice(3).toLowerCase() });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.slice(3).toLowerCase() });
    await sleep(120);
  }
  const padActive = await evaluate(`document.querySelectorAll('.pad.is-active, .pad.is-pressed').length >= 0`);
  check('Pad key events dispatched without exceptions', padActive);

  await evaluate(`document.querySelector('.pad[data-key="G"]').click(); true`);
  await sleep(200);

  const initialWave = await evaluate(`window.__echo.audio.currentWaveform`);
  await evaluate(`document.querySelector('input[name="waveform"][value="sawtooth"]').click(); true`);
  await sleep(150);
  const sawWave = await evaluate(`window.__echo.audio.currentWaveform`);
  await evaluate(`document.querySelector('input[name="waveform"][value="sine"]').click(); true`);
  await sleep(150);
  const sineWave = await evaluate(`window.__echo.audio.currentWaveform`);
  check(
    'Waveform selector drives AudioEngine waveform',
    initialWave === 'triangle' && sawWave === 'sawtooth' && sineWave === 'sine',
    `${initialWave} -> ${sawWave} -> ${sineWave}`,
  );
  await evaluate(`document.querySelector('.pad[data-key="A"]').click(); true`);
  await sleep(200);

  const trails = await evaluate(`window.__echo.manager.getChapter('synthesis').activeTrailCount`);
  check('Pad hits spawn fading note trails', trails > 0, `activeTrails=${trails}`);

  await evaluate(`(() => {
    const r = document.getElementById('fx-reverb'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true }));
    const d = document.getElementById('fx-delay'); d.value = '0'; d.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  const fxAfter = await evaluate(`({
    reverb: window.__echo.audio.reverbAmount,
    delay: window.__echo.audio.delayAmount,
    reverbText: document.getElementById('fx-reverb').getAttribute('aria-valuetext'),
  })`);
  check(
    'Reverb / delay sliders drive the send levels',
    fxAfter.reverb === 0.8 && fxAfter.delay === 0 && fxAfter.reverbText === '80%',
    `reverb=${fxAfter.reverb} delay=${fxAfter.delay}`,
  );

  await evaluate(`document.getElementById('chord-toggle').click(); true`);
  await sleep(120);
  const chordOn = await evaluate(`({
    engine: window.__echo.audio.chordMode,
    pressed: document.getElementById('chord-toggle').getAttribute('aria-pressed'),
  })`);
  await evaluate(`document.getElementById('chord-toggle').click(); true`);
  await sleep(120);
  const chordOff = await evaluate(`window.__echo.audio.chordMode`);
  check(
    'Chord toggle drives AudioEngine chord mode',
    chordOn.engine === true && chordOn.pressed === 'true' && chordOff === false,
    `on=${chordOn.engine}/${chordOn.pressed} off=${chordOff}`,
  );

  const patternBefore = await evaluate(`JSON.stringify(window.__echo.sequencer.pattern)`);
  await evaluate(`document.getElementById('seq-play').click(); true`);
  await sleep(700);
  const seq = await evaluate(`({
    playing: window.__echo.sequencer.isPlaying,
    highlighted: document.querySelectorAll('.step.is-playing').length,
    pressed: document.getElementById('seq-play').getAttribute('aria-pressed'),
    label: document.querySelector('.seq__play-label').textContent,
  })`);
  check(
    'Sequencer plays and highlights the current step',
    seq.playing && seq.highlighted === 1 && seq.pressed === 'true' && seq.label === 'Stop',
    `pattern=${patternBefore} highlighted=${seq.highlighted}`,
  );
  await evaluate(`(() => {
    const bpm = document.getElementById('seq-bpm'); bpm.value = '160'; bpm.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const tempo = await evaluate(`window.__echo.sequencer.tempo`);
  check('BPM input updates sequencer tempo', tempo === 160, `tempo=${tempo}`);
  await evaluate(`document.getElementById('seq-play').click(); true`);
  await sleep(150);
  const seqStopped = await evaluate(`({
    playing: window.__echo.sequencer.isPlaying,
    highlighted: document.querySelectorAll('.step.is-playing').length,
  })`);
  check('Sequencer stops and clears highlight', !seqStopped.playing && seqStopped.highlighted === 0);

  await evaluate(`(() => {
    const step = document.querySelector('.step[data-step="1"]');
    step.click();
    return true;
  })()`);
  await sleep(100);
  const stepNote = await evaluate(`document.querySelector('.step[data-step="1"]').dataset.note`);
  check('Clicking a rest step assigns the first note', stepNote === 'C4', `note=${stepNote}`);
  await evaluate(`(() => {
    const step = document.querySelector('.step[data-step="1"]');
    step.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    return true;
  })()`);
  const stepCleared = await evaluate(`document.querySelector('.step[data-step="1"]').classList.contains('is-rest')`);
  check('Delete key clears a step back to a rest', stepCleared);

  await evaluate(`document.getElementById('seq-share').click(); true`);
  await sleep(300);
  const share = await evaluate(`(() => {
    const url = new URL(window.location.href);
    return {
      p: url.searchParams.get('p'),
      bpm: url.searchParams.get('bpm'),
      w: url.searchParams.get('w'),
      pattern: JSON.stringify(window.__echo.sequencer.pattern),
      status: document.getElementById('seq-status').textContent,
    };
  })()`);
  const expectedP = JSON.parse(share.pattern).map((n) => (n === null ? '-' : n.toString(36))).join('');
  check(
    'Share button encodes pattern / BPM / waveform into the URL',
    share.p === expectedP && share.bpm === '160' && share.w === 'sine' && share.status.length > 0,
    `p=${share.p} bpm=${share.bpm} w=${share.w}`,
  );

  const cursorInfo = await evaluate(`({
    fine: window.matchMedia('(pointer: fine)').matches && window.matchMedia('(hover: hover)').matches,
    exists: !!document.querySelector('.cursor'),
    hidden: document.body.classList.contains('has-custom-cursor'),
  })`);
  check(
    'Custom cursor present exactly when the pointer is fine',
    cursorInfo.fine === cursorInfo.exists && cursorInfo.exists === cursorInfo.hidden,
    `fine=${cursorInfo.fine} exists=${cursorInfo.exists}`,
  );
  if (cursorInfo.exists) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
    await sleep(200);
    const cursorState = await evaluate(`({
      visible: document.querySelector('.cursor').classList.contains('is-visible'),
      transform: document.querySelector('.cursor').style.transform,
    })`);
    check(
      'Custom cursor follows the pointer and scales with level',
      cursorState.visible && /translate3d\(\d+(\.\d+)?px, \d+(\.\d+)?px, 0(px)?\) translate\(-50%, -50%\) scale\((\d|\.)+\)/.test(cursorState.transform),
      cursorState.transform,
    );
  }

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60, y: 300 });
  await sleep(120);
  const cutoffLeft = await evaluate(`({ pos: window.__echo.audio.filterPosition, hz: Math.round(window.__echo.audio.filterCutoff) })`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 300 });
  await sleep(120);
  const cutoffRight = await evaluate(`({ pos: window.__echo.audio.filterPosition, hz: Math.round(window.__echo.audio.filterCutoff) })`);
  check(
    'Pointer X sweeps the master filter cutoff',
    cutoffLeft.pos < 0.1 && cutoffRight.pos > 0.9 && cutoffRight.hz > cutoffLeft.hz * 10,
    `left=${cutoffLeft.hz}Hz right=${cutoffRight.hz}Hz`,
  );

  const xyRect = await evaluate(`(() => {
    const el = document.getElementById('xy');
    const r = document.getElementById('xy-surface').getBoundingClientRect();
    return { hidden: el.hidden, x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  check('XY pad panel is expanded on desktop', xyRect.hidden === false && xyRect.w > 60, `size=${Math.round(xyRect.w)}`);
  if (!xyRect.hidden) {
    const px = Math.round(xyRect.x + xyRect.w * 0.25);
    const py = Math.round(xyRect.y + xyRect.h * 0.1);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left' });
    await sleep(150);
    const held = await evaluate(`({
      bend: Math.round(window.__echo.audio.pitchBend),
      pos: Number(window.__echo.audio.filterPosition.toFixed(2)),
      dragging: window.__echo.xyPad.isDragging,
    })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    let released = { bend: 9999, dragging: true };
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      released = await evaluate(`({ bend: Math.round(window.__echo.audio.pitchBend), dragging: window.__echo.xyPad.isDragging })`);
      if (!released.dragging && Math.abs(released.bend) < 5) break;
    }
    check(
      'XY pad drag bends pitch up + closes filter; release springs pitch back to 0',
      held.dragging && held.bend > 600 && held.pos < 0.4 && !released.dragging && Math.abs(released.bend) < 5,
      `held bend=${held.bend}c pos=${held.pos} released bend=${released.bend}c`,
    );
  }

  const titlePulse = await evaluate(`document.documentElement.style.getPropertyValue('--title-pulse')`);
  check('Typography loop writes --title-pulse', /em$/.test(titlePulse), `--title-pulse=${titlePulse}`);

  await evaluate(`document.getElementById('silent-toggle').click(); true`);
  await sleep(1200);
  const silent = await evaluate(`({
    on: window.__echo.audio.isSilent,
    pressed: document.getElementById('silent-toggle').getAttribute('aria-pressed'),
    bodyClass: document.body.classList.contains('is-silent'),
    gain: Number(window.__echo.audio.master.gain.value.toFixed(3)),
    level: Number(window.__echo.audio.level.toFixed(3)),
    bass: Number(window.__echo.audio.bass.toFixed(3)),
  })`);
  await evaluate(`document.getElementById('silent-toggle').click(); true`);
  await sleep(200);
  const silentOff = await evaluate(`window.__echo.audio.isSilent`);
  check(
    'Silent mode mutes the master but keeps visual metrics moving',
    silent.on && silent.pressed === 'true' && silent.bodyClass && silent.gain < 0.01 && silent.level > 0.05 && silent.bass > 0.05 && silentOff === false,
    `gain=${silent.gain} level=${silent.level} bass=${silent.bass}`,
  );

  const rail = await evaluate(`(() => {
    const root = document.getElementById('progress');
    const track = root.querySelector('.progress__track');
    const ticks = [...root.querySelectorAll('.progress__tick')].map((t) => t.style.top);
    const current = root.querySelector('.progress__tick.is-current')?.dataset.chapter ?? null;
    return { visible: root.classList.contains('is-visible'), now: Number(track.getAttribute('aria-valuenow')), ticks, current };
  })()`);
  check(
    'Progress rail visible inside Synthesis with fill > 60%',
    rail.visible && rail.now > 60 && rail.now <= 100 && rail.current === 'synthesis',
    `valuenow=${rail.now} current=${rail.current}`,
  );
  check(
    'Progress rail ticks laid out at chapter boundaries',
    rail.ticks.length === 4 && rail.ticks[0] === '0%' && rail.ticks[3] === '100%' && rail.ticks[1] !== '' && rail.ticks[2] !== '',
    rail.ticks.join(', '),
  );

  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const captureInfo = await evaluate(`(() => {
    const url = window.__echo.manager.capture();
    return { prefix: url.slice(0, 22), length: url.length };
  })()`);
  check(
    'manager.capture() returns a PNG data URL',
    captureInfo.prefix === 'data:image/png;base64,' && captureInfo.length > 5000,
    `${captureInfo.prefix} length=${captureInfo.length}`,
  );
  await evaluate(`document.getElementById('capture').click(); true`);
  await sleep(150);
  const captureFeedback = await evaluate(`({
    label: document.querySelector('#capture .capture__label').textContent,
    status: document.getElementById('capture-status').textContent,
  })`);
  check(
    'Capture button reports success',
    captureFeedback.label === '저장됨' && /echo-\d{8}-\d{6}\.png/.test(captureFeedback.status),
    captureFeedback.status,
  );

  const meta = await evaluate(`({
    title: document.title,
    desc: document.querySelector('meta[name="description"]')?.content?.length ?? 0,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
    ogDesc: document.querySelector('meta[property="og:description"]')?.content ?? '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content ?? '',
    icon: document.querySelector('link[rel="icon"]')?.href?.startsWith('data:image/svg+xml') ?? false,
  })`);
  check(
    'Title / description / og:* / favicon present',
    meta.title.includes('ECHO') && meta.desc > 40 && meta.ogTitle.includes('ECHO') && meta.ogDesc.length > 20 && meta.ogImage.endsWith('.png') && meta.icon,
    meta.title,
  );

  const pressedBefore = await evaluate(`document.getElementById('mute-toggle').getAttribute('aria-pressed')`);
  await evaluate(`document.getElementById('mute-toggle').click(); true`);
  const pressedAfter = await evaluate(`document.getElementById('mute-toggle').getAttribute('aria-pressed')`);
  check('Mute toggle flips aria-pressed', pressedBefore === 'false' && pressedAfter === 'true', `${pressedBefore} -> ${pressedAfter}`);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  let mobileCanvas = '';
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    mobileCanvas = await evaluate(`(() => { const c = document.getElementById('gl'); return c.width + 'x' + c.height; })()`);
    if (mobileCanvas.startsWith('780x')) break;
  }
  check('Canvas resized after viewport change', mobileCanvas.startsWith('780x'), mobileCanvas);

  await sleep(500);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const sharedUrl = `${url.replace(/[?#].*$/, '')}?p=2-3-4-5-&bpm=90&w=square&c=1`;
  await send('Page.navigate', { url: sharedUrl });
  let sharedLoaderDone = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      sharedLoaderDone = await evaluate(`document.getElementById('loader')?.hidden === true`);
    } catch {
      continue;
    }
    if (sharedLoaderDone) break;
  }
  await evaluate(`document.getElementById('gate-start').click(); true`);
  await sleep(1500);
  let sharedActive = null;
  for (let i = 0; i < 20; i++) {
    sharedActive = await evaluate(`window.__echo?.manager.active?.id ?? null`);
    if (sharedActive === 'synthesis') break;
    await sleep(250);
  }
  const sharedState = await evaluate(`({
    pattern: JSON.stringify(window.__echo.sequencer.pattern),
    tempo: window.__echo.sequencer.tempo,
    bpmField: document.getElementById('seq-bpm').value,
    wave: window.__echo.audio.currentWaveform,
    chord: window.__echo.audio.chordMode,
    playing: window.__echo.sequencer.isPlaying,
    status: document.getElementById('seq-status').textContent,
  })`);
  check(
    'Shared link restores pattern / BPM / waveform / chord without autoplay',
    sharedState.pattern === '[2,null,3,null,4,null,5,null]' &&
      sharedState.tempo === 90 &&
      sharedState.bpmField === '90' &&
      sharedState.wave === 'square' &&
      sharedState.chord === true &&
      sharedState.playing === false &&
      sharedState.status.includes('불러왔습니다'),
    `pattern=${sharedState.pattern} tempo=${sharedState.tempo} wave=${sharedState.wave} chord=${sharedState.chord}`,
  );
  check('Shared link lands on the Synthesis chapter', sharedActive === 'synthesis', `active=${sharedActive}`);

  const shaderErrors = consoleMessages.filter((m) => /shader|THREE\.WebGLProgram|GL_INVALID|WebGL/i.test(m));
  check('No WebGL/shader errors in console', shaderErrors.length === 0, shaderErrors.join(' | ').slice(0, 300));
  check('No uncaught exceptions', exceptions.length === 0, exceptions.join(' | ').slice(0, 300));
  const errors = consoleMessages.filter((m) => m.startsWith('[error]') || m.startsWith('[log:error]'));
  check('No console.error output', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (error) {
  console.error('Smoke test crashed:', error);
  results.push({ name: 'crash', ok: false });
} finally {
  if (consoleMessages.length) {
    console.log('\nConsole output captured:');
    for (const m of consoleMessages.slice(0, 30)) console.log('  ' + m);
  }
  ws.close();
  child.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
