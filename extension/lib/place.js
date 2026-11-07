// 말풍선 위치 계산(T-109). 여러 줄 문장에서는 문장 전체가 아니라 커서가 있던 줄 기준으로 둔다.
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 export 없는 클래식 스크립트로 두고 전역에 단다(site-filter.js와 같은 방식).
// 단위 테스트는 `import '../../extension/lib/place.js'`(부수효과) 뒤 globalThis.AnalogyPlace 를 쓴다.
(() => {
  // rects(DOMRect 비슷한 목록) 중 y가 들어 있는 첫 줄, 없으면 세로로 가장 가까운 줄, 비면 null.
  // 너비·높이 0인 rect(줄바꿈 자리 등)는 무시한다
  function pickLineRect(rects, y) {
    const list = rects ? Array.from(rects).filter(r => r && r.width > 0 && r.height > 0) : [];
    if (!list.length) return null;
    const inside = list.find(r => r.top <= y && y <= r.bottom);
    if (inside) return inside;
    const dist = r => (y < r.top ? r.top - y : y - r.bottom);
    return list.reduce((best, r) => (dist(r) < dist(best) ? r : best));
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

  globalThis.AnalogyPlace = Object.freeze({ pickLineRect, placeBox });
})();
