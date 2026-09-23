/**
 * Synthesis 챕터 설명 문구(.chapter__desc)를 남는 세로 공간에 맞춰 통째로 줄 단위로 자른다.
 *
 * 섹션은 flex 컬럼이라 설명 블록은 컨트롤 묶음(.pads-wrap)이 차지한 뒤 남는 높이만 받는다
 * (main.css의 .chapter--synthesis 참고). 그 높이는 뷰포트 폭·높이 조합마다 달라지므로
 * CSS만으로는 줄 수를 정할 수 없어, 여기서 실측한 높이를 줄 높이로 나눠 -webkit-line-clamp를
 * 설정한다. 이렇게 하면 마지막 줄이 중간에서 잘리는 대신 말줄임으로 끝난다.
 */
export function setupSynthesisFit(section: HTMLElement): () => void {
  const desc = section.querySelector<HTMLElement>('.chapter__desc');
  if (!desc) return () => undefined;

  const measure = () => {
    // 한도를 풀고 재측정해야 flex가 실제로 허용하는 높이를 알 수 있다.
    desc.style.webkitLineClamp = '';
    desc.style.setProperty('line-clamp', '');
    const box = desc.getBoundingClientRect().height;
    if (desc.scrollHeight <= box + 1) return; // 전부 들어가면 CSS 기본값 그대로

    const lineHeight = parseFloat(getComputedStyle(desc).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    // 서브픽셀 차이로 한 줄을 통째로 잃지 않도록 2px 여유를 둔다. 그만큼의 초과는
    // 마지막 줄 line box의 아래 여백(leading) 안에서 잘려 글자에는 닿지 않는다.
    const lines = String(Math.max(1, Math.floor((box + 2) / lineHeight)));
    desc.style.webkitLineClamp = lines;
    desc.style.setProperty('line-clamp', lines);
  };

  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      measure();
    });
  };

  const observer = new ResizeObserver(schedule);
  observer.observe(section);
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  schedule();

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
