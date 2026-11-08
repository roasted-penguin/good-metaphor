// 말풍선 위치 계산(T-109). 여러 줄 문장에서는 문장 전체가 아니라 커서가 있던 줄 기준으로 둔다.
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 export 없는 클래식 스크립트로 두고 전역에 단다(site-filter.js와 같은 방식).
// 단위 테스트는 `import '../../extension/lib/place.js'`(부수효과) 뒤 globalThis.AnalogyPlace 를 쓴다.
(() => {
  // 너비·높이 0인 rect(줄바꿈 자리 등)를 뺀 줄 목록. index는 항상 이 목록 기준이다
  function lineRects(rects) {
    return rects ? Array.from(rects).filter(r => r && r.width > 0 && r.height > 0) : [];
  }

  // y가 들어 있는 첫 줄의 index, 없으면 세로로 가장 가까운 줄, 비면 -1.
  // 뷰포트 y는 스크롤하면 다른 줄을 가리키므로, 호버 때 한 번만 정해 두고 다시 배치할 때는 index로 꺼낸다
  function pickLineIndex(rects, y) {
    const list = lineRects(rects);
    if (!list.length) return -1;
    const inside = list.findIndex(r => r.top <= y && y <= r.bottom);
    if (inside >= 0) return inside;
    const dist = r => (y < r.top ? r.top - y : y - r.bottom);
    let best = 0;
    list.forEach((r, i) => { if (dist(r) < dist(list[best])) best = i; });
    return best;
  }

  function pickLineRect(rects, y) {
    const i = pickLineIndex(rects, y);
    return i < 0 ? null : lineRects(rects)[i];
  }

  // 줄 rect 아래 gap만큼 두고, 아래로 넘치면 줄 위로 뒤집는다(위도 모자라면 pad). 가로는 커서 x 중심, 좌우 pad 안
  function placeBox({ rect, mouseX, bw, bh, vw, vh, pad = 10, gap = 8 }) {
    const left = Math.min(Math.max(pad, mouseX - bw / 2), vw - bw - pad);
    let top = rect.bottom + gap;
    let flipped = false;
    if (top + bh > vh - pad) {
      top = Math.max(pad, rect.top - bh - gap);
      flipped = true;
    }
    return { left, top, flipped };
  }

  // 작은 서브프레임(광고·위젯, T-147): 말풍선이 잘리므로 띄우지도, 요청을 보내지도 않는다. 최상위는 창이 작아도 해당 없음
  const MIN_FRAME_W = 260, MIN_FRAME_H = 160;
  function tinyFrame({ isTop, vw, vh }) {
    return !isTop && (vw < MIN_FRAME_W || vh < MIN_FRAME_H);
  }

  globalThis.AnalogyPlace = Object.freeze({ lineRects, pickLineIndex, pickLineRect, placeBox, tinyFrame });
})();
