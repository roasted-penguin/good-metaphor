// 고른 범위 비유(T-182): 사용자가 드래그로 고른 글을 문장 대신 보낼 때 쓰는 순수 함수.
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 export 없는 클래식 스크립트로 두고 전역에 단다(place.js와 같은 방식).
// 단위 테스트는 `import '../../extension/lib/selection.js'`(부수효과) 뒤 globalThis.AnalogySelection 을 쓴다.
(() => {
  // 고른 글 상한. 넘치면 상한 안 마지막 문장 경계에서 자르고 말풍선에 한 줄 알린다
  const MAX_CHARS = 400;
  const sentenceSeg = new Intl.Segmenter(undefined, { granularity: 'sentence' });

  // 줄바꿈·탭·연속 공백을 한 칸으로 접고 앞뒤 공백을 뗀다
  function normalizeText(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
  }

  // 보이는 글자(공백 아님) 2자 이상 + 글자나 숫자가 하나는 있어야 고른 글로 쓴다. 아니면 문장 모드로
  function usableText(s) {
    const t = normalizeText(s);
    return t.replace(/\s/g, '').length >= 2 && /[\p{L}\p{N}]/u.test(t);
  }

  // 상한을 넘으면 앞에서부터 문장을 이어 붙여 상한 안에 드는 데까지. 첫 문장부터 넘치면 상한 안 마지막 공백
  // (상한의 60% 뒤에 있을 때만), 그것도 없으면 상한에서 자른다. text는 normalizeText를 거친 글이라고 본다
  function clampText(text, max = MAX_CHARS) {
    if (text.length <= max) return { text, truncated: false };
    let out = '';
    for (const s of sentenceSeg.segment(text)) {
      const next = out + s.segment;
      if (next.trim().length > max) break;
      out = next;
    }
    out = out.trim();
    if (!out) {
      const cut = text.lastIndexOf(' ', max);
      out = (cut >= max * 0.6 ? text.slice(0, cut) : text.slice(0, max)).trim();
    }
    return { text: out, truncated: true };
  }

  // 커서가 고른 범위 위에 있는지: 범위의 줄 rect 중 하나가 (x, y)를 품으면 참. 너비·높이 0인 rect는 뺀다
  function pointInRects(rects, x, y, slop = 2) {
    if (!rects) return false;
    for (const r of Array.from(rects)) {
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
      if (x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop) return true;
    }
    return false;
  }

  // 공백을 접은 글의 앞 n자가 원문(raw) 어디서 끝나는지(그 다음 index). 잘린 범위만 강조할 때 쓴다.
  // n번째 글자는 공백이 아니라고 본다(clampText 결과는 공백으로 끝나지 않음)
  function rawIndexFor(raw, n) {
    let count = 0, gap = false;
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) { gap = true; continue; }
      if (gap && count > 0) count++; // 접힌 공백 한 칸
      gap = false;
      if (++count >= n) return i + 1;
    }
    return raw.length;
  }

  globalThis.AnalogySelection = Object.freeze({ MAX_CHARS, normalizeText, usableText, clampText, pointInRects, rawIndexFor });
})();
