# ECHO

오디오 반응형 3D 스크롤 스토리텔링 포트폴리오.
Web Audio API로 합성한 소리를 `AnalyserNode`로 매 프레임 분석하고, 그 데이터가 Three.js 씬을 직접 구동합니다.
사전 렌더링된 애니메이션이나 외부 음원 파일은 없습니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build  → dist/
npm run preview    # dist/ 를 http://localhost:4173 에서 서빙
```

헤드리스 스모크 테스트(Chrome/Edge 필요, 추가 의존성 없음):

```bash
npm run preview            # 별도 터미널
npm run smoke              # 로더 → Start → 오디오 running → 챕터 전환 → 패드/뮤트/리사이즈 검증
npm run smoke:reduced      # prefers-reduced-motion: reduce 에뮬레이션
```

## 구조

```
index.html                 로더, 게이트, 헤더(뮤트), 히어로, 챕터 3개, 아웃트로 (모든 텍스트는 실제 HTML)
src/main.ts                부트스트랩: 로더 → 엔진/씬/챕터 초기화 → ScrollTrigger → 게이트 → resume()
src/audio.ts               AudioEngine: 단일 AudioContext, master Gain → Analyser 라우팅, 드론, playNote, 뮤트
src/scene.ts               SceneManager: WebGLRenderer(pixelRatio ≤ 2), 카메라 댐핑, 챕터 크로스페이드,
                           visibilitychange 시 rAF 정지, 150ms debounce 리사이즈, dispose
src/scroll.ts              GSAP ScrollTrigger: 챕터별 pin:true + scrub:true 타임라인, progress/active 연동
src/loader.ts              퍼센트 카운터(실제 초기화 진행률 추종) + Start 게이트
src/preview.ts             히어로 프리뷰 플라이스루: 게이트 뒤에서 Signal→Frequency→Synthesis 공간을 ~5초 루프로 훑는 자동 카메라
src/pads.ts                Synthesis 패드: 클릭/Enter/Space + 물리 키 A~L(event.code), 포커스/프레스 상태
src/sequencer.ts           8스텝 시퀀서: AudioContext 클록 기반 look-ahead 스케줄링, 스텝 편집(클릭/↑↓/Delete/A~L), BPM
src/cursor.ts              커스텀 커서(fine pointer 전용): audio.level(평균 진폭)로 실시간 스케일 펄스
src/progress.ts            우측 세로 진행 레일: ScrollTrigger start/end 값으로 눈금 배치, 채움 갱신(reduced-motion 시 즉시)
src/sweep.ts               마스터 로우패스 필터 스윕: 마우스 X = 컷오프(절대), 터치 좌우 드래그 = 컷오프(상대)
src/xy.ts                  XY 패드: X = 필터 컷오프, Y = 피치 벤드(±1옥타브, 놓으면 중앙 복귀). 포인터/터치/키보드
src/share.ts               멜로디 링크: 시퀀서 패턴·BPM·파형·코드 모드를 URL 쿼리로 인코딩/디코딩, 클립보드 복사
src/typography.ts          오디오 반응형 챕터 제목: audio.level → --title-pulse(letter-spacing) / --title-weight(wght)
src/chapters/base.ts       공통 챕터 베이스(페이드 핸들러, disposable 추적, 로컬→월드 카메라 변환)
src/chapters/hero.ts       와이어프레임 icosahedron (level/bass로 호흡, treble로 색상)
src/chapters/signal.ts     getByteTimeDomainData → 256포인트 튜브 정점 Y/반경 + 오실로스코프 라인
src/chapters/frequency.ts  getByteFrequencyData → 로그 스케일 대역별 InstancedMesh 막대(높이/밝기/색상)
src/chapters/synthesis.ts  스펙트럼 DataTexture로 정점 변위하는 구체 + 라우드니스 구동 파티클, burst()
src/chapters/convergence.ts Synthesis→아웃트로 컨버전스: 리본·스펙트럼·파티클 잔상이 한 점으로 응축된 뒤 흩어지는 스크럽 연출
src/styles/main.css        레이아웃(390–1440px), 포커스 스타일, reduced-motion 처리
scripts/smoke.mjs          Chrome DevTools Protocol 기반 런타임 검증 스크립트
```

## 오디오 라우팅

```
ambient drone (sine 55Hz + sine 82.41Hz + filtered saw 110Hz, 모두 저볼륨) ───────────┐
note voices (선택 파형 + 옥타브 파셜, attack 0.01s / decay 0.3s, 종료 시 disconnect)  │
        │                                                                          │
        ▼                                                                          │
   voiceBus ─┬─ dry ──────────────────────────────────────────────────────────────┼─▶ master GainNode
             ├─ reverbSend ─▶ ConvolverNode (합성 IR 2.6s, 단위 에너지 정규화) ───┤      │ 뮤트/무음 = gain 0 / 0.8
             └─ delaySend ──▶ DelayNode (점8분음, BPM 연동) ⟲ lowpass·feedback 0.42 ┘      ▼
                                                                              BiquadFilterNode (lowpass, Q 1.2)
                                                                                     │  컷오프 260Hz ~ 18kHz (필터 스윕 / XY 패드 X)
                                                                                     ▼
                                                                              AnalyserNode (fftSize 2048)
                                                                                     │  매 프레임 timeDomain / frequency
                                                                                     ▼
                                                                                 destination
```

리버브/딜레이는 연주음(voiceBus)에만 걸리고 드론은 드라이로 유지됩니다. 이펙트 리턴이 master로 합류하므로
리버브 테일과 딜레이 반복도 Analyser에 잡혀 시각화에 반영됩니다. 슬라이더는 센드 게인(0~1)을 조절합니다.

### 필터 스윕 / XY 패드 / 피치 벤드

- **필터 스윕**: 마스터 뒤, Analyser 앞에 lowpass `BiquadFilterNode`가 있습니다. 마우스(또는 펜)의 화면 X좌표가
  컷오프에 그대로 매핑되고(왼쪽 = 닫힘 260Hz, 오른쪽 = 열림 18kHz, 지수 곡선), 터치에서는 화면 어디서든 좌우로
  드래그한 거리만큼 상대적으로 열리고 닫힙니다(세로 스크롤은 거의 영향 없음). 필터가 Analyser 앞에 있으므로
  닫으면 시각 효과도 함께 가라앉습니다.
- **XY 패드**(헤더 `XY pad` 버튼, ≥1024px에서는 기본 펼침): 정사각형 트랙패드. X = 같은 필터 컷오프, Y = 재생 중인
  모든 음(연주음 + 드론의 가청 오실레이터)의 `detune`(±1200센트). 드래그 중에는 전역 마우스 스윕이 멈추고,
  손을 놓으면 피치는 휠처럼 중앙으로 복귀하며 컷오프는 유지됩니다. 키보드: ←→ 컷오프, ↑↓ 1반음, Home 피치 초기화,
  End 필터 열기, Esc 닫기. 640px 이하에서는 화면 중앙 오버레이로 열립니다.
- **코드 모드**(패드 툴바 `Chord`): `AudioEngine.setChordMode(true)`면 `playNote()`가 근음과 함께 C 메이저
  다이어토닉 3도·5도를 같은 파형/엔벨로프로 울립니다(C→E·G, D→F·A, E→G·B, G→B·D, A→C·E). 패드, 시퀀서, 파형
  오디션 모두에 적용되고, 보이스별 게인은 0.6배로 낮춰 전체 음량을 맞춥니다.

### 무음 모드 (청각 접근성)

헤더 `Silent mode` 토글(및 게이트의 “소리 없이 입장”)은 마스터 게인을 0으로 내리는 대신, `AudioEngine.update()`가
Analyser 대신 미리 정의된 패턴으로 `timeDomain` / `frequency` 버퍼를 채웁니다(시간 도메인: 느린 사인 2개의 합,
스펙트럼: 숨쉬는 저역 덩어리 + 천천히 이동하는 중역 피크, 2.4초마다 부드러운 impulse). 모든 시각화는 그 두 버퍼만
읽으므로 소리 없이도 같은 파이프라인으로 계속 움직입니다. 기존 뮤트 버튼은 이전과 같이 게인만 0으로 내립니다
(시각 효과가 가라앉음).

## 렌더링

- `SceneManager`는 항상 `EffectComposer(RenderPass → [UnrealBloomPass] → GradePass → OutputPass)`로 렌더합니다.
  블룸은 강도 0.55 / 반경 0.45 / 임계값 0.82이며, 컴포저 타겟은 HalfFloat(데스크톱 MSAA 4샘플)입니다.
- 모바일(≤768px)에서는 블룸 패스를 끼우지 않고, 데스크톱에서도 3초 창 두 번 연속 평균 프레임 시간이 28ms를 넘으면
  자동으로 블룸을 해제합니다(`bloomDisabledByPerformance`). 색보정/전환 패스는 그대로 유지됩니다.
- **챕터별 색보정(GradePass, ShaderPass)**: 톤매핑 전 선형 공간에서 채도 → tint(중간/하이라이트 곱) → lift(어두운
  영역에 색 더하기) → spectral(무지개 워시) 순으로 적용합니다. 프리셋은 `GRADES`에 있으며 챕터 전환 시 1.1초 동안
  보간됩니다. Signal = 차가운 블루(채도 0.8, 네이비 lift), Frequency = 채도 1.4 + 화면 위치·밝기에 따라 천천히 흐르는
  스펙트럼 워시, Synthesis = 따뜻한 앰버(tint 1.28/1.0/0.68, 갈색 lift), Hero = 중립.
- **시그널 노이즈 전환**: 같은 패스의 `uGlitch`(0~1)가 밴드 단위 가로 찢어짐, 세로 지터, RGB 분리, 정적 그레인,
  가는 스캔라인, 위에서 아래로 스치는 스캔 바를 켭니다. 각 챕터 사이 구간(이전 챕터 pin 끝 → 다음 챕터 pin 시작,
  정확히 1 뷰포트)에 ScrollTrigger가 하나씩 붙어 진행률을 `transitionCurve()`(72%에서 피크, 이후 빠르게 소멸)로
  바꿔 `SceneManager.setTransition()`에 넘기고, 매 프레임 댐핑되어 uniform과 CSS `--glitch`(챕터 제목의 시안/마젠타
  분리)에 반영됩니다. `prefers-reduced-motion`이면 강도가 0.4배로 줄고 찢어짐/지터/RGB 분리는 꺼집니다.
- **오디오 반응형 타이포그래피**: `src/typography.ts`가 `audio.level`이 0.34를 넘는 만큼만 `--title-pulse`
  (최대 +0.016em letter-spacing)와 `--title-weight`(가변 폰트 wght 최대 +60)를 씁니다. 41Hz/67Hz 사인의 작은 흔들림을
  섞어 큰 소리에서만 살짝 떨리며, reduced-motion에서는 완전히 꺼집니다.
- Synthesis의 노트 트레일은 패드/시퀀서가 음을 낼 때마다 구체 표면에서 출발하는 나선 궤적(40포인트)을 남기고
  2.2초 동안 사라집니다. 헤드 속도는 `audio.level`에 따라 조금 빨라집니다.

뮤트는 스펙에 따라 마스터 GainNode를 0으로 내리므로, 뮤트 상태에서는 Analyser도 무음을 읽어 시각 효과가
가라앉습니다. 소리는 끄되 시각화를 유지하고 싶으면 헤더의 **Silent mode**(무음 모드)를 사용하세요 — 위 “무음 모드” 절 참고.

## 시네마틱 연출

### 히어로 프리뷰 플라이스루 (`src/preview.ts`)

- 로더가 끝나고 Start 게이트가 떠 있는 동안, 배경 3D 씬의 카메라가 히어로를 떠나 **Signal(1.8s) → Frequency(1.7s) →
  Synthesis(1.7s)** 공간을 한 샷씩 훑고 지나갑니다(총 5.2초, 무한 루프). 샷 사이는 하드 컷이며, 컷 직후 0.22초 동안
  시그널 노이즈 전환(`setTransition`)이 번쩍이고 색보정도 해당 챕터 프리셋으로 즉시 바뀝니다.
- 사용자 조작과 무관합니다. 스크롤은 잠겨 있고(`body.is-locked`), 포인터 시차도 프리뷰에는 반영되지 않습니다.
  Start 또는 ‘소리 없이 입장’을 누르면 즉시 멈추고, 카메라는 히어로 위치로 스냅되며 마지막으로 짧은 노이즈 버스트가
  한 번 지나갑니다.
- 구현: 히어로는 계속 *활성* 챕터로 남고, 프리뷰는 `SceneManager.setCameraOverride()`로 카메라만 빼앗아
  `driveCamera()`로 직접 몹니다. 각 샷의 챕터 그룹은 `setChapterVisible()`로 크로스페이드 없이 켜고 끕니다(한 번에 하나만).
  AudioContext가 아직 suspended 상태라 이 구간에서는 무음 모드 패턴(`AudioEngine.setSilentMode(true)`)으로 Analyser
  버퍼를 채워 리본·막대·구체가 움직이고, Start를 누르면 `setSilentMode(false)` 후 실제 신호로 넘어갑니다.
- 게이트 하단 캡션(`#gate-preview`)에 지금 훑고 있는 챕터 번호/이름과 샷 진행 라인이 표시되고, 프리뷰 중에는
  `body.is-previewing`이 붙어 히어로 카피를 숨깁니다. 게이트 배경은 프리뷰가 보이도록 옅게 바뀌고 카피는 글래스
  카드 위에 올라갑니다. `prefers-reduced-motion`이면 샷 안에서 카메라가 움직이지 않고(정지 프레이밍) 노이즈 플래시도 없습니다.

### Synthesis → 아웃트로 컨버전스 (`src/chapters/convergence.ts`)

- Synthesis 핀이 풀리는 지점부터 아웃트로 상단이 뷰포트 상단에 닿을 때까지(빈 스페이서 `#convergence` 170vh +
  아웃트로 100vh)를 GSAP `scrub: true` ScrollTrigger가 0~1 진행률로 넘겨줍니다. 이 구간에는 시그널 노이즈 전환이 없습니다.
- 세 모티프의 **잔상**이 Synthesis와 같은 월드 원점(y = −210)에 가벼운 고스트로 다시 등장합니다 — 카메라 비행 없이 제자리에서 크로스페이드되어 구체와 파티클이 있던 자리에 잔상이 떠오릅니다: Signal의 파형 리본(192포인트 라인 2개,
  live `timeDomain`), Frequency의 스펙트럼 필드(14×6 InstancedMesh, live `frequency`), Synthesis의 연주 파티클(720개,
  결정적 궤도). 리본의 스태거/스파이럴은 길이 방향으로 연속이라 끌려 들어가는 동안에도 곡선이 끊기지 않습니다.
  모두 진행률에 따라 CPU에서 매 프레임 재계산되므로 역스크럽도 정확합니다.
  - `0.00–0.50` 모으기: 정점마다 스태거를 두고 화면 중앙(뷰 축 기준 스파이럴)으로 서서히 끌려가 응축됩니다.
  - `0.50–0.62` 응축: 리본·막대 고스트는 코어에 녹아들어 사라지고, 중앙의 코어 하나가 `level`/`bass`에 맞춰 숨쉬며 파티클은 블룸이 잡히도록 밝아집니다.
  - `0.62–1.00` 흩어짐: 코어가 짧게 번쩍인 뒤 먼지만 넓은 셸로 부드럽게 흩어져 천천히 표류하는 옅은 배경이 되고,
    카메라가 물러납니다. 아웃트로 카피는 0.70~0.98 구간에서 같은 타임라인으로 드러납니다.
- 색보정은 `GRADES.convergence`(차분한 쿨 톤, 채도 0.8)로 넘어갑니다. `prefers-reduced-motion`이면 스파이럴이 꺼지고
  카메라가 고정되며 스페이서는 120vh로 짧아집니다.

## Synthesis 툴바

- **Waveform**: sine / square / sawtooth / triangle 세그먼트 컨트롤(라디오 그룹, 방향키 이동). 선택값은
  `AudioEngine.setWaveform()`으로 전달되어 이후 `playNote()`가 만드는 모든 오실레이터(기본음 + 옥타브 파셜)에 적용됩니다.
  파형별 체감 음량 차이는 `VOICE_PEAK` 테이블로 보정합니다. 배경 드론은 스펙대로 사인파를 유지합니다.
- **이 순간을 저장**: `SceneManager.capture()`가 프레임을 한 번 렌더한 직후 `canvas.toDataURL('image/png')`로 읽어
  `echo-YYYYMMDD-HHMMSS.png`로 다운로드합니다. (preserveDrawingBuffer 없이도 동일 태스크 안에서 읽으므로 빈 이미지가 나오지 않습니다.)

## 시퀀서

- 8스텝 = 한 마디 8분음표. 기본 패턴 `C4 · E4 G4 · A4 C5 ·`, BPM 60~200(기본 120).
- 스텝 클릭 = 다음 음, Shift+클릭 = 이전 음, 포커스 상태에서 ↑↓ 변경, Delete 휴지, A~L 키로 바로 지정.
- 25ms 간격의 타이머가 120ms look-ahead 안의 노트를 `playNote(freq, { when })`으로 정확한 시각에 예약하고,
  하이라이트와 파티클 버스트는 그 시각에 맞춰 setTimeout으로 발화합니다. 탭이 백그라운드면 look-ahead를 1.2s로 늘립니다.
- **링크 복사**: 현재 패턴·BPM·파형·코드 모드를 `?p=0-23-45-&bpm=120&w=triangle&c=1` 형태로 인코딩해
  클립보드에 복사하고 주소창도 `replaceState`로 맞춥니다(`p`는 스텝당 한 글자, base-36 음 인덱스, `-` = 휴지).
  해당 링크로 접속하면 로드 시 시퀀서·BPM·파형·코드 모드가 그대로 세팅되고 Synthesis 챕터로 이동하지만,
  자동재생 정책 때문에 재생은 사용자가 Play를 눌러야 시작됩니다.

## 교체할 것

- `index.html` `<head>`의 `og:url`, `og:image`, `twitter:image` placeholder(`https://example.com/...`). 1200x630 PNG를
  `public/og-image.png`로 추가하고 절대 URL로 바꾸세요.
- `index.html` 아웃트로의 `Your Name`, `github.com/your-handle`, `you@example.com`
- 필요하면 `src/audio.ts`의 드론 주파수/볼륨, `src/pads.ts`가 읽는 패드의 `data-freq`
