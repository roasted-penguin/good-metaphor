// 열린 Shadow DOM 안 문장 찾기 도우미(T-111).
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 export 없는 클래식 스크립트로 두고 전역에 단다(place.js와 같은 방식).
// 단위 테스트는 `import '../../extension/lib/shadow.js'`(부수효과) 뒤 globalThis.AnalogyShadow 를 쓴다.
// 닫힌(closed) shadow root 는 el.shadowRoot 가 null 이라 들어갈 수 없다(지원하지 않음).
(() => {
  const isShadowRoot = n => !!n && n.nodeType === 11 && !!n.host;

  // 커서 (x, y) 아래 열린 shadow root 들을 바깥부터 모은다. caretPositionFromPoint 의 shadowRoots 옵션에 넘긴다.
  // document.elementFromPoint 는 가장 바깥 호스트를 돌려주므로, 그 shadowRoot.elementFromPoint 로 한 겹씩 내려간다.
  // skip(el)이 참인 호스트(우리 말풍선)는 들어가지 않는다. 깊이 상한 max
  function collectShadowRoots(doc, x, y, { skip = null, max = 10 } = {}) {
    const roots = [];
    let el = doc?.elementFromPoint?.(x, y) ?? null;
    while (el && roots.length < max) {
      const root = el.shadowRoot;
      if (!root || (skip && skip(el))) break;
      roots.push(root);
      const next = root.elementFromPoint?.(x, y) ?? null;
      if (!next || next === el) break; // 더 내려갈 곳이 없음(호스트 자신으로 retarget)
      el = next;
    }
    return roots;
  }

  // 조상 요소. shadow root 바로 아래면 그 호스트로 올라간다(isSkippable 처럼 경계를 넘어 봐야 할 때)
  function composedParent(node) {
    if (node?.parentElement) return node.parentElement;
    return isShadowRoot(node?.parentNode) ? node.parentNode.host : null;
  }

  // 문장 블록: 가장 가까운 블록 요소. shadow 경계(ShadowRoot)를 만나면 넘지 않고 그 shadow root 를 블록으로 본다.
  // 보통 문서에서는 지금처럼 stopAt(body)까지, 없으면 stopAt
  function blockFor(node, { isBlock, stopAt }) {
    let cur = node;
    while (cur) {
      const el = cur.parentElement;
      if (!el) return isShadowRoot(cur.parentNode) ? cur.parentNode : stopAt;
      if (el === stopAt) return stopAt;
      if (isBlock(el)) return el;
      cur = el;
    }
    return stopAt;
  }

  globalThis.AnalogyShadow = Object.freeze({ collectShadowRoots, composedParent, blockFor, isShadowRoot });
})();
