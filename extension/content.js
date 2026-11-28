// 콘텐츠 스크립트: 커서 아래 문장(또는 드래그로 고른 범위, T-182)을 찾아 강조하고, 말풍선으로 비유를 보여 준다.
(() => {
  if (window.__analogyHelperLoaded) return;
  window.__analogyHelperLoaded = true;

  const HL_NAME = 'good-metaphor-hl';
  let settings = { enabled: true, triggerMode: 'modifier', modifierKey: 'Alt', dwellMs: 900 };
  // inside(T-147): 커서가 이 문서 안에 있음. 첫 mousemove 전이나 iframe·창 밖으로 나가면 false라,
  // 포커스가 이 문서에 남아 keydown(Alt)이 여기로 와도 옛 좌표 문장을 트리거하지 않는다
  let mouse = { x: 0, y: 0, inside: false, alt: false, shift: false, ctrl: false, meta: false };
  let dwellTimer = null;
  let hideTimer = null;
  let current = null;       // { key, ranges, rects }
  let reqSeq = 0;
  let port = null;
  let modifierUsed = false;

  /* ───────── 설정 ───────── */
  const SF = globalThis.AnalogySiteFilter; // lib/site-filter.js (manifest에서 먼저 주입)
  const AP = globalThis.AnalogyPlace;      // lib/place.js (manifest에서 먼저 주입, T-109)
  const AS = globalThis.AnalogyShadow;     // lib/shadow.js (manifest에서 먼저 주입, T-111)
  let theme = 'maple';      // 말풍선 테마. 미리 받기(graph:info)·stage·결과 순으로 고쳐진다
  let themeStale = true;    // 테마를 (다시) 받아야 함
  /* 프레임(T-111): 모든 프레임에 주입된다(all_frames). 프레임마다 자기 안에 말풍선·강조를 띄운다.
     iframe이면 자기 호스트와 최상위 페이지 호스트 중 하나라도 제외 목록에 있으면 꺼진다
     (은행 페이지 안 다른 출처 iframe 문장이 새지 않게). topHost는 background 이중 방어용으로 페이로드에 싣는다 */
  const isTop = window === window.top;
  const { hosts, topHost, topKnown } = isTop
    ? { hosts: [SF.normalizeHost(location.hostname)], topHost: SF.normalizeHost(location.hostname), topKnown: true }
    : SF.frameHosts({
      selfHost: location.hostname,
      topHostname: (() => { try { return window.top.location.hostname; } catch { return ''; } })(), // 같은 출처 사슬만 읽힘
      ancestorOrigins: location.ancestorOrigins,
      referrer: document.referrer
    });
  // 최상위를 모르는 서브프레임(불투명·가려진 출처 + referrer 없음)은 실패 시 닫힘: 강조·말풍선·메시지 모두 없음
  const excludedBy = list => !topKnown || hosts.some(h => SF.isExcludedHost(h, list));
  // 이 프레임 표지(T-147). explain 때 background에 실어 보내면, 다른 프레임 말풍선 닫기 신호(close-bubble)에 그대로 돌아온다
  const frameToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  // 서브프레임(광고 등)은 시작 시 테마를 미리 받지 않고 처음 보조키를 누를 때(trigger) 받는다(프레임 많은 페이지의 메시지 폭주 방지)
  let themeWanted = isTop;
  // 이 페이지 호스트가 제외 목록에 있음(T-107). 저장된 설정을 읽기 전에는 기본 목록으로 판정한다
  let siteExcluded = excludedBy(SF.DEFAULT_EXCLUDED_HOSTS);
  // 부모 문서의 비밀번호 폼 안에 든 같은 출처 iframe(T-148). 시작 때 한 번, 트리거마다 다시 판정한다(아래 framedInPasswordForm)
  let framedPw = false;
  // 켜져 있고 이 사이트가 제외 목록에 없을 때만 동작한다
  const active = () => settings.enabled && !siteExcluded && !framedPw;
  function loadSettings() {
    chrome.storage.local.get('settings', ({ settings: s }) => {
      settings = { ...settings, ...(s || {}) };
      siteExcluded = excludedBy(settings.excludedHosts ?? SF.DEFAULT_EXCLUDED_HOSTS);
      if (!active()) hideTooltip();
      else refreshIfStale();
    });
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) loadSettings();
    // 공통 관심사(T-302)를 바꾸면 테마를 다시 받는다. 다른 설정 변경으로는 다시 받지 않는다
    const interestOf = v => v?.interest || 'maplestory'; // 값이 없으면 기본 관심사(DEFAULT_SETTINGS와 같게)
    const interestChanged = changes.settings && interestOf(changes.settings.oldValue) !== interestOf(changes.settings.newValue);
    if (interestChanged || Object.keys(changes).some(isGraphKey)) { themeStale = true; markTheme(); if (active() && themeWanted) refreshTheme(); }
  });

  /* ───────── 테마 미리 받기 (T-108) ─────────
     관심사 테마를 첫 결과 전에 알아 둬서 로딩 말풍선이 다른 테마로 뜨지 않게 한다.
     켜져 있고 제외 사이트가 아닐 때 한 번만 받고, 로그인 세션·내 오버레이 키가 바뀌면 다시 받는다.
     실패하면 지금 값(기본 maple)을 두고 stale로 남겨, 다음 설정 변경·호버 때 다시 받는다.
     로딩 중에는 stage 메시지의 theme이 한 번 더 고친다 */
  function isGraphKey(k) {
    return k === 'devSession' || k === 'remoteSession' || k.startsWith('devOverlay:');
  }
  let themeSeq = 0;
  let themeLoading = false; // 받는 중(같은 요청을 겹쳐 보내지 않게)
  // 지금 테마와 미리 받기 완료 여부. 콘텐츠 스크립트 격리 월드의 window라 페이지 스크립트에는 안 보인다(e2e가 기다릴 때 씀)
  const markTheme = () => { window.__analogyHelperTheme = { theme, ready: !themeStale }; };
  const refreshIfStale = () => { if (themeWanted && themeStale && !themeLoading && active()) refreshTheme(); };
  function refreshTheme() {
    const seq = ++themeSeq; // 늦게 온 옛 응답은 버린다(키가 바뀌어 다시 받은 경우)
    themeLoading = true;
    const done = got => {
      if (seq !== themeSeq) return;
      themeLoading = false;
      if (got) { theme = got; themeStale = false; } else themeStale = true;
      markTheme();
      // 테마를 기다리며 미뤄 둔 첫 로딩 말풍선(서브프레임 첫 호버, T-148). 실패해도 기본 테마로 띄워 영영 안 뜨는 일이 없게 한다
      if (current?.awaitTheme) render({ loading: true, stage: 'graph' });
    };
    try {
      chrome.runtime.sendMessage({ type: 'graph:info' }, res => {
        void chrome.runtime.lastError; // 확장이 다시 로드됐을 때 등. 기본값 유지
        done(res?.ok ? res.data?.merged?.theme : null);
      });
    } catch { done(null); /* 확장 컨텍스트가 사라짐. 기본값 유지 */ }
  }

  /* ───────── 커서 아래 문장 찾기 ───────── */
  const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'table-cell', 'flex', 'grid', 'table', 'flow-root', 'table-caption']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG']);
  const sentenceSeg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const wordSeg = new Intl.Segmenter(undefined, { granularity: 'word' });

  // 열린 Shadow DOM(T-111): 커서 아래 열린 shadow root 들을 모아 caretPositionFromPoint 에 넘긴다.
  // 옵션을 지원하지 않거나(예외) 캐럿이 여전히 글자가 아닌 곳(호스트)을 가리키면 지금 방식으로 대체
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      let p = null;
      const shadowRoots = AS.collectShadowRoots(document, x, y, { skip: el => el.id === 'good-metaphor-host' });
      if (shadowRoots.length) {
        try { p = document.caretPositionFromPoint(x, y, { shadowRoots }); } catch { p = null; }
        if (p?.offsetNode?.nodeType !== Node.TEXT_NODE) p = null;
      }
      p ??= document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  // 문장 블록. shadow 경계를 넘지 않는다(블록 요소가 없으면 그 shadow root 가 블록, T-111)
  function blockOf(node) {
    return AS.blockFor(node, { isBlock: el => BLOCK_DISPLAYS.has(getComputedStyle(el).display), stopAt: document.body });
  }

  // 비밀번호 칸이 있는 폼 안 문장은 설정과 무관하게 보내지 않는다(T-107)
  // shadow 안 문장(T-111)도 막도록 composed tree 를 올라간다: 각 트리에서 closest('form')을 보고 shadow 면 host 로 건너 다시.
  // 바깥 트리의 폼도 봐야 하므로(비밀번호 없는 shadow 안 폼이 비밀번호 있는 바깥 폼 안에 있을 수 있음) 찾을 때까지 끝까지 오른다.
  // 비밀번호 칸은 form.elements(폼 연동 호스트 포함), 폼 안 input[type=password], 그리고 폼 자손의 열린 shadow 안 칸(T-148, 상한 있음)으로 본다.
  // cache(Map 폼→결과)를 넘기면 한 번의 문장 찾기 안에서 같은 폼을 여러 번 깊게 돌지 않는다(textNodesIn 은 텍스트 노드마다 부른다)
  const hasPassword = (form, cache) => {
    if (cache?.has(form)) return cache.get(form);
    const yes = [...form.elements].some(f => f.type === 'password') || !!form.querySelector('input[type=password]') || AS.hasPasswordDeep(form);
    cache?.set(form, yes);
    return yes;
  };
  function inPasswordForm(node, cache) {
    for (let el = AS.composedParent(node); el; ) {
      const form = el.closest('form');
      if (form && hasPassword(form, cache)) return true;
      const root = el.getRootNode();
      el = AS.isShadowRoot(root) ? root.host : null;
    }
    return false;
  }

  // 부모 비밀번호 폼 안 iframe(T-148): 같은 출처면 window.frameElement 가 부모 문서의 <iframe> 요소라, 거기서 부모 쪽으로
  // inPasswordForm 과 같은 composed 검사를 하고, 부모도 서브프레임이면 그 frameElement 로 계속 오른다(최상위까지, 깊이 상한 10).
  // 다른 출처 프레임은 frameElement 가 null 이라 검사할 수 없다(그 프레임 문서에는 부모의 비밀번호 칸이 없으니 칸 자체가 새지는 않음).
  // 예외(접근 거부 등)는 '모름'으로 보고 막지 않는다 — 다른 출처 프레임은 원래 이 검사 밖이다
  function framedInPasswordForm() {
    if (isTop) return false;
    try {
      let w = window;
      for (let i = 0; i < 10; i++) {
        const fe = w.frameElement;
        if (!fe) return false;
        if (inPasswordForm(fe)) return true;
        w = fe.ownerDocument?.defaultView;
        if (!w || w === w.top) return false;
      }
    } catch { /* 다른 출처 부모 */ }
    return false;
  }
  framedPw = framedInPasswordForm();

  // shadow 안이면 호스트를 거쳐 문서까지 올라가 본다(shadow root 직속 텍스트는 parentElement 가 null, T-111)
  function isSkippable(node) {
    for (let el = AS.composedParent(node); el; el = AS.composedParent(el)) {
      if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || el.id === 'good-metaphor-host') return true;
    }
    return false;
  }

  function textNodesIn(block) {
    const out = [];
    const pwCache = new Map(); // 이번 블록 안에서 폼마다 비밀번호 검사 한 번(T-148)
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        // shadow root 바로 아래 텍스트(T-111)는 부모 요소가 없어도 받는다
        if (p ? SKIP_TAGS.has(p.tagName) : !AS.isShadowRoot(n.parentNode)) return NodeFilter.FILTER_REJECT;
        // 같은 블록 안 비밀번호 폼 글자가 문장·앞 문장으로 새지 않게 뺀다(T-107)
        if (inPasswordForm(n, pwCache)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n, pos = 0;
    while ((n = walker.nextNode())) {
      out.push({ node: n, start: pos });
      pos += n.nodeValue.length;
    }
    return out;
  }

  function locate(nodes, globalOffset, preferEnd) {
    for (let i = 0; i < nodes.length; i++) {
      const { node, start } = nodes[i];
      const end = start + node.nodeValue.length;
      if (globalOffset < end || (preferEnd && globalOffset === end)) {
        return { node, offset: Math.max(0, globalOffset - start) };
      }
    }
    const last = nodes[nodes.length - 1];
    return { node: last.node, offset: last.node.nodeValue.length };
  }

  // 커서가 실제 글자 위에 있는지 확인 (문단 여백에서는 반응하지 않게)
  function pointOnText(node, offset, x, y) {
    const len = node.nodeValue.length;
    const r = document.createRange();
    for (const o of [offset, offset - 1]) {
      if (o < 0 || o >= len) continue;
      r.setStart(node, o); r.setEnd(node, o + 1);
      for (const rect of r.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return true;
      }
    }
    return false;
  }

  function sentenceAt(x, y) {
    const hit = caretAt(x, y);
    if (!hit || hit.node?.nodeType !== Node.TEXT_NODE) return null;
    if (isSkippable(hit.node) || inPasswordForm(hit.node)) return null;
    if (!pointOnText(hit.node, hit.offset, x, y)) return null;

    const block = blockOf(hit.node);
    const nodes = textNodesIn(block);
    const entry = nodes.find(n => n.node === hit.node);
    if (!entry) return null;
    const full = nodes.map(n => n.node.nodeValue).join('');
    const g = entry.start + hit.offset;

    let seg = null, prev = null;
    for (const s of sentenceSeg.segment(full)) {
      if (g >= s.index && g < s.index + s.segment.length) { seg = s; break; }
      if (s.segment.trim()) prev = s;
    }
    if (!seg) return null;

    // 앞뒤 공백 제거
    const raw = seg.segment;
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < 8 || !/[\p{L}]/u.test(text)) return null;
    const startG = seg.index + lead;
    const endG = startG + raw.trim().length;

    let word = '';
    const localOffset = g - seg.index;
    for (const w of wordSeg.segment(raw)) {
      if (w.isWordLike && localOffset >= w.index && localOffset < w.index + w.segment.length) { word = w.segment; break; }
    }

    const a = locate(nodes, startG, false);
    const b = locate(nodes, endG, true);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);

    return {
      key: text,
      text: text.length > 600 ? text.slice(0, 600) + '…' : text,
      word,
      context: prev ? prev.segment.trim().replace(/\s+/g, ' ').slice(-300) : '',
      range
    };
  }

  /* ───────── 고른 범위 (T-182) ─────────
     드래그로 고른 글이 있고 커서가 그 위에 있으면, 커서 아래 문장 대신 고른 글 전체를 보낸다.
     문장 찾기와 같은 거름(입력칸·코드·편집 영역·비밀번호 폼 글자 빼기)을 글자 노드마다 하고, 블록이 바뀌면 한 칸 띄운다.
     글이 2자 미만이거나 커서가 범위 밖이면 null(문장 모드). 열린 shadow 안 선택은 document 선택에 잡히지 않아 문장 모드로 간다 */
  const ASel = globalThis.AnalogySelection; // lib/selection.js (manifest에서 먼저 주입)
  const SEL_NODE_CAP = 3000; // 전체 선택(Ctrl+A) 같은 큰 범위에서 글자 노드를 끝없이 돌지 않게
  function selectionAt(x, y) {
    const sel = document.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    // 입력칸·textarea 안 선택은 글자 노드가 아니다. 비밀번호 칸 값이 새지 않게 아예 다루지 않는다
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return null;
    const range = sel.getRangeAt(0);
    if (!ASel.pointInRects(range.getClientRects(), x, y)) return null;

    const rootNode = range.commonAncestorContainer;
    const walkRoot = rootNode.nodeType === Node.TEXT_NODE ? rootNode.parentNode : rootNode;
    if (!walkRoot) return null;
    const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
    let first = range.startContainer;
    if (first.nodeType !== Node.TEXT_NODE) first = first.childNodes[range.startOffset] || first;
    walker.currentNode = first;
    let n = first.nodeType === Node.TEXT_NODE ? first : walker.nextNode();
    const pwCache = new Map();
    const segs = []; // { node, s, rawStart, len } 원문 raw 안 위치
    let raw = '', visible = 0, more = false, prevBlock = null, seen = 0;
    for (; n; n = walker.nextNode()) {
      if (++seen > SEL_NODE_CAP) { more = true; break; }
      if (!range.intersectsNode(n)) {
        if (range.comparePoint(n, 0) > 0) break; // 범위 끝을 지남
        continue;
      }
      const value = n.nodeValue || '';
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : value.length;
      if (e <= s) continue;
      if (isSkippable(n) || inPasswordForm(n, pwCache)) continue;
      const blk = blockOf(n);
      if (prevBlock && blk !== prevBlock) raw += '\n';
      prevBlock = blk;
      const part = value.slice(s, e);
      segs.push({ node: n, s, rawStart: raw.length, len: part.length });
      raw += part;
      visible += part.replace(/\s/g, '').length;
      if (visible > ASel.MAX_CHARS + 100) { more = true; break; } // 상한만 넘으면 충분(뒤는 잘린다)
    }
    const norm = ASel.normalizeText(raw);
    if (!segs.length || !ASel.usableText(norm)) return null;
    const { text, truncated } = ASel.clampText(norm);

    // 강조 범위: 잘렸으면 실제로 보낸 앞부분까지만
    const hl = document.createRange();
    hl.setStart(segs[0].node, segs[0].s);
    const rawEnd = truncated ? ASel.rawIndexFor(raw, text.length) : raw.length;
    const endSeg = segs.findLast(g => g.rawStart < rawEnd) || segs[0];
    hl.setEnd(endSeg.node, endSeg.s + Math.min(endSeg.len, rawEnd - endSeg.rawStart));

    // 앞 문장: 범위 시작 블록에서 시작 앞 글의 마지막 문장(문장 모드와 같이 300자까지)
    let context = '';
    const nodes = textNodesIn(blockOf(segs[0].node));
    const entry = nodes.find(x => x.node === segs[0].node);
    if (entry) {
      const before = nodes.map(x => x.node.nodeValue).join('').slice(0, entry.start + segs[0].s);
      let last = '';
      for (const g of sentenceSeg.segment(before)) if (g.segment.trim()) last = g.segment;
      context = ASel.normalizeText(last).slice(-300);
    }
    return {
      key: text, text, word: '', context, range: hl, selection: true,
      note: truncated || more ? `앞부분 ${ASel.MAX_CHARS}자까지만 풀었어요.` : ''
    };
  }

  /* ───────── 강조 ───────── */
  // CSS.highlights 는 문서 전체 레지스트리지만 ::highlight 스타일은 shadow tree 안에 따로 있어야 보인다(T-111).
  // 열린 shadow root 에 처음 강조할 때 우리 규칙 한 줄짜리 시트를 adoptedStyleSheets 에 덧붙인다(기존 시트 보존, root 마다 한 번).
  // 페이지가 adoptedStyleSheets 를 갈아 끼워 우리 시트가 빠졌으면 같은 시트를 다시 덧붙인다. 실패하면 강조 없이 말풍선만
  const HL_RULE = `::highlight(${HL_NAME}) { background-color: rgba(255, 196, 40, .30); }`; // content.css 와 같은 색
  const shadowHlSheets = new WeakMap(); // shadow root → 우리 시트
  // 말풍선을 닫을 때(hideTooltip) 우리 시트를 다시 빼야 하는 root 들(T-148). 페이지 shadow 에 우리 시트를 남겨 두지 않는다
  const hlRoots = new Set();
  function ensureShadowHlStyle(root) {
    try {
      let sheet = shadowHlSheets.get(root);
      hlRoots.add(root);
      if (sheet && root.adoptedStyleSheets.includes(sheet)) return true;
      if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(HL_RULE); shadowHlSheets.set(root, sheet); }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return true;
    } catch { return false; }
  }
  // 우리 시트만 걸러 낸다(페이지 시트와 순서는 그대로). keep 은 지금 강조 중인 root(빼지 않음)
  function detachShadowHlStyles(keep = null) {
    for (const root of [...hlRoots]) {
      if (root === keep) continue;
      hlRoots.delete(root);
      try {
        const sheet = shadowHlSheets.get(root);
        if (sheet && root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== sheet);
      } catch { /* root 가 사라졌거나 막힘. 할 수 있는 게 없음 */ }
    }
  }
  function highlight(range) {
    if (!window.CSS?.highlights) return;
    const root = range.startContainer.getRootNode();
    detachShadowHlStyles(AS.isShadowRoot(root) ? root : null); // 다른 root 로 옮겨 가면 앞 root 의 시트는 바로 뺀다
    if (AS.isShadowRoot(root) && !ensureShadowHlStyle(root)) { clearHighlight(); return; }
    CSS.highlights.set(HL_NAME, new Highlight(range));
  }
  function clearHighlight() {
    window.CSS?.highlights?.delete(HL_NAME);
  }

  /* ───────── 말풍선 (Shadow DOM) ───────── */
  let host, shadow, box;
  function ensureTooltip() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'good-metaphor-host';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        /* 테마 토큰. t-maple = 인게임 아이템 툴팁 느낌(항상 어두움), t-neutral = 일반 사용자용 */
        .box {
          --bg: #ffffff; --ink: #1f2328; --muted: #656d76; --line: #d8dee4; --label: #8250df;
          --em: #1f2328; --chip-bg: #f1f3f5; --chip-ink: #3d4450; --chip2-bg: #eef1ff; --chip2-ink: #3a47b8;
          --user-bg: #e6f4ff; --user-ink: #0b5cad; --accent: #4f5bd5; --shadow: 0 8px 28px rgba(15, 20, 30, .16);
          --fb-bg: #e7f6ec; --fb-ink: #1a7f37;
        }
        @media (prefers-color-scheme: dark) {
          .box.t-neutral { --bg: #1d2129; --ink: #e8eaee; --muted: #9aa3b2; --line: #343a46; --label: #b99cff;
            --em: #ffffff; --chip-bg: #2a303b; --chip-ink: #cfd5df; --chip2-bg: #262d4a; --chip2-ink: #aab4ff;
            --user-bg: #15324d; --user-ink: #9fd0ff; --accent: #8d96ff; --shadow: 0 8px 28px rgba(0,0,0,.5);
            --fb-bg: #16351f; --fb-ink: #7ee2a0; }
        }
        .box.t-maple {
          --bg: rgba(22, 28, 43, .97); --ink: #eef1f7; --muted: #9ba5bd; --line: #46506a;
          --label: #ffcc33;                          /* 유니크 노랑 */
          --em: #ffffff;
          --chip-bg: rgba(160, 230, 60, .14); --chip-ink: #b9ef5a;   /* 레전드리 초록 = 근거 */
          --chip2-bg: rgba(190, 140, 255, .16); --chip2-ink: #d2b1ff; /* 에픽 보라 = 추상 태그 */
          --user-bg: rgba(90, 200, 255, .15); --user-ink: #8fdcff;    /* 레어 파랑 = 내 저장소 */
          --accent: #ff9a2e;                         /* 단풍잎 주황 */
          --fb-bg: rgba(160, 230, 60, .14); --fb-ink: #b9ef5a;       /* 레전드리 초록 = 내 피드백 반영 */
          --shadow: 0 10px 30px rgba(0, 0, 0, .45);
        }
        .box { position: fixed; max-width: 380px; min-width: 240px; box-sizing: border-box;
          font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
          color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
          box-shadow: var(--shadow); padding: 12px 14px 10px; pointer-events: none;
          opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s; }
        .box.t-maple { border-radius: 6px; box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,.06); }
        /* 보일 때만 커서를 받는다. 닫힌(투명·빈) 상자가 그 자리 아래 글자의 호버를 가로채지 않게(T-111 CI) */
        .box.show { opacity: 1; transform: none; pointer-events: auto; }
        .row { margin: 0 0 8px; }
        .label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .02em; color: var(--label); margin-bottom: 2px; }
        .analogy { font-weight: 600; color: var(--em); }
        .muted { color: var(--muted); font-size: 12.5px; }
        .sep { height: 1px; background: var(--line); margin: 8px 0; opacity: .7; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
        .chip { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--chip-bg); color: var(--chip-ink); }
        .chip.tag { background: var(--chip2-bg); color: var(--chip2-ink); }
        .chip.user { background: var(--user-bg); color: var(--user-ink); }
        .foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--muted); }
        button { all: unset; cursor: pointer; font-size: 11.5px; color: var(--accent); padding: 2px 6px; border-radius: 6px; }
        button:hover { background: var(--chip-bg); }
        .close { position: absolute; top: 6px; right: 8px; font-size: 15px; line-height: 1; color: var(--muted); }
        .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: s .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
        @keyframes s { to { transform: rotate(360deg); } }
        .err { color: #e5534b; }
        .note { margin-top: 6px; font-size: 11.5px; }
        /* 피드백 (T-106, ADR 0010): 평소엔 흐리게, 말풍선 위에서 또렷하게. 👎은 중립 회색, 반영은 초록 */
        .fb { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; }
        .fbtn { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
          color: var(--muted); opacity: .55; transition: opacity .12s; }
        .box:hover .fbtn { opacity: 1; }
        .fbtn svg { width: 16px; height: 16px; }
        .fbtn.down svg { transform: rotate(180deg); }
        .fbtn.up.on { color: var(--fb-ink); opacity: 1; }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; opacity: 1; }
        .thanks { font-size: 11.5px; color: var(--fb-ink); padding: 0 6px; }
        .fbbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); margin: 0 0 6px; padding-right: 18px; } /* 닫기(×)와 겹치지 않게 */
        .ask { font-size: 11.5px; color: var(--muted); margin: 6px 0 4px; }
        .chip.fb { background: var(--fb-bg); color: var(--fb-ink); }
        .chip.alt, .chip.reason { cursor: pointer; padding: 3px 10px; background: transparent; border: 1px solid var(--line); color: var(--ink); }
        .chip.reason { color: var(--muted); }
        .chip.ver { background: transparent; color: var(--muted); padding-left: 2px; padding-right: 2px; }
        .chip.alt:hover, .chip.reason:hover { background: var(--chip-bg); }
        /* 이어 묻기 (T-216, ADR 0017): 같은 테마 토큰을 쓴다(관심사 테마를 따름, 규칙 6) */
        .fu { max-height: 240px; overflow-y: auto; }
        .fu-q { font-size: 12px; color: var(--muted); margin: 6px 0 2px; }
        .fu-q::before { content: "Q. "; font-weight: 700; color: var(--label); }
        .fu-a { margin: 0 0 4px; }
        .chip.fuq { cursor: pointer; padding: 3px 10px; background: transparent; border: 1px solid var(--line); color: var(--ink); }
        .chip.fuq:hover { background: var(--chip-bg); }
        .fu-form { display: flex; gap: 6px; margin-top: 6px; }
        .fu-in { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: 12.5px; color: var(--ink); background: transparent;
          border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; outline: none; }
        .fu-in:focus { border-color: var(--accent); }
        .fu-in::placeholder { color: var(--muted); }
      </style>
      <div class="box" role="dialog" aria-live="polite"></div>`;
    box = shadow.querySelector('.box');
    box.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    document.documentElement.appendChild(host);
  }

  // "메이플스토리로", "게임으로": 받침(ㄹ 제외) 있으면 '으로'
  function euro(word) {
    const code = String(word).slice(-1).charCodeAt(0) - 0xac00;
    const jong = code >= 0 && code <= 11171 ? code % 28 : 0;
    return word + (jong && jong !== 8 ? '으로' : '로');
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 근거 옆 "검수 2026-10"(T-118): 공통 노드의 검수 날짜를 연-월로. 사용자 노드·날짜 없음이면 안 보인다
  function verifiedChip(ev) {
    const ym = ev.source !== 'user' && /^\d{4}-\d{2}-\d{2}$/.test(ev.verifiedAt || '') ? ev.verifiedAt.slice(0, 7) : '';
    return ym ? `<span class="chip ver" title="공식 자료로 사실을 확인한 달이에요">검수 ${esc(ym)}</span>` : '';
  }

  // 말풍선 배치(T-109): 호버할 때 정한 줄(lineIndex)의 지금 rect 아래, 넘치면 그 줄 위. 가로는 호버 때 커서 x(anchorX).
  // 결과가 와서 다시 부를 때도 같은 줄·같은 x라, 커서가 움직이거나 조금 스크롤해도 다른 줄로 옮겨 가지 않는다.
  // 줄 목록이 비면 문장 전체 bounding rect(한 줄 문장은 둘이 같다). 줄 수가 줄었으면 마지막 줄로
  function place(cur) {
    const pad = 10;
    const w = Math.min(380, window.innerWidth - 2 * pad);
    box.style.maxWidth = w + 'px';
    const lines = AP.lineRects(cur.range.getClientRects());
    const rect = lines.length ? lines[Math.min(Math.max(cur.lineIndex, 0), lines.length - 1)] : cur.range.getBoundingClientRect();
    const size = { mouseX: cur.anchorX, bw: box.offsetWidth || 300, bh: box.offsetHeight || 120, vw: window.innerWidth, vh: window.innerHeight, pad };
    // 고른 범위(T-182)는 마지막 줄 아래, 넘치면 첫 줄 위(고른 글을 가리지 않게). 줄 수가 바뀌어도 늘 마지막 줄
    const { left, top } = cur.span && lines.length
      ? AP.placeBoxSpan({ first: lines[0], last: lines.at(-1), ...size })
      : AP.placeBox({ rect, ...size });
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  const STAGE_TEXT = {
    graph: '관심사 그래프 불러오는 중',
    model: '임베딩 모델 준비 중 (처음 한 번은 1분쯤 걸려요)',
    abstract: '핵심 개념 뽑는 중',
    search: '비슷한 개념 찾는 중',
    generate: '비유 만드는 중',
    analogy: '비유 찾는 중',
    server: '서버에 묻는 중'
  };
  // 서버 모드(T-404)일 때만 결과에 source 가 있다. 꺼져 있으면 아무것도 덧붙이지 않는다
  const SOURCE_TEXT = { server: ' · 서버', local: ' · 로컬' };

  // 을/를
  function eul(word) {
    const code = String(word).slice(-1).charCodeAt(0) - 0xac00;
    return code >= 0 && code <= 11171 && code % 28 ? '을' : '를';
  }
  const THUMB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10h4z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.3 8a2 2 0 0 1-2 1.7H7"/></svg>';
  const REASON_CHIPS = [['forced', '비유가 억지예요'], ['meaning', '뜻이 틀렸어요'], ['fact', '사실이 틀렸어요']];
  // 이어 묻기 칩 질문(T-216). lib/agent-tools.js FOLLOWUP_QUESTIONS 와 같은 문구(단위 테스트가 대조)
  const FU_Q = { why: '왜 비슷해요?', other: '다른 비유는요?' };

  /* ───────── 원클릭 피드백 (T-106, ADR 0010) ─────────
     글자 입력 없음. 👎 → 그 자리에서 다른 비유, 칩은 선택. 되돌리기 5초, 칩은 3초 뒤 접힘(말풍선 위에 있으면 유지) */
  let view = null;
  let fbTimers = [];
  const ask = (type, extra) => new Promise(res => {
    try { chrome.runtime.sendMessage({ type, ...extra }, r => res(r || { ok: false, error: chrome.runtime.lastError?.message })); }
    catch (e) { res({ ok: false, error: String(e?.message || e) }); }
  });
  // 말풍선 위에 마우스가 있으면 미뤘다가 벗어난 뒤 적용
  function later(ms, fn) {
    const run = () => { if (box?.matches(':hover')) box.addEventListener('mouseleave', () => setTimeout(run, 600), { once: true }); else fn(); };
    fbTimers.push(setTimeout(run, ms));
  }
  async function onFeedback(act, data) {
    if (!current || !view?.result) return;
    const key = current.key, r = view.result, fb = view.fb || {};
    const sent = { sentence: current.payload.sentence, provider: r.debug?.provider || '', topHost }; // topHost: rerun 없는 👍도 background가 검사(T-111)
    const stillHere = () => current && current.key === key;
    const done = (res, nextFb, extra = {}) => {
      if (!stillHere()) return;
      if (!res?.ok) return render({ error: res?.error || '피드백을 저장하지 못했어요.' });
      render({ result: res.data.result || r, fb: nextFb, ...extra });
    };
    if (act === 'up') {
      const res = await ask('feedback', { record: { ...sent, nodeId: r.evidence?.nodeId || null, tagId: null, vote: 'up' } });
      return done(res, fb, { thanked: true });
    }
    if (act === 'down') {
      fbTimers.forEach(clearTimeout); fbTimers = [];
      const label = r.evidence.nodeLabel;
      const alts = (r.debug?.candidates || []).filter(c => c.id !== r.evidence.nodeId);
      const nextFb = { down: true, label, alts, chips: true, undo: true };
      render({ result: r, fb: nextFb, busy: true });
      const res = await ask('feedback', { record: { ...sent, nodeId: r.evidence.nodeId, tagId: null, vote: 'down' }, rerun: current.payload });
      nextFb.id = res?.data?.id;
      done(res, nextFb);
      later(5000, () => { nextFb.undo = false; if (stillHere() && view?.fb === nextFb) render({ ...view }); });
      later(3000, () => { nextFb.chips = false; if (stillHere() && view?.fb === nextFb) render({ ...view }); });
      return;
    }
    if (act === 'pick') {
      const picked = (fb.alts || r.debug?.candidates || []).find(c => c.id === data.id);
      const nextFb = { pick: true, label: picked?.label || data.id, undo: true };
      render({ result: r, fb: nextFb, busy: true });
      // pickedTagId: 고른 개념의 최고 태그. 교정 예문 후보가 어느 태그로 갈지 정한다(T-131)
      const res = await ask('feedback', { record: { ...sent, nodeId: r.evidence?.nodeId || null, tagId: null, vote: 'pick', pickedNodeId: data.id, pickedTagId: picked?.tagId || null }, rerun: current.payload });
      nextFb.id = res?.data?.id;
      done(res, nextFb);
      later(5000, () => { nextFb.undo = false; if (stillHere() && view?.fb === nextFb) render({ ...view }); });
      return;
    }
    if (act === 'reason' && fb.id) {
      await ask('feedback-reason', { id: fb.id, reason: data.reason });
      fb.reason = data.reason;
      if (data.reason === 'none') fb.chips = false;
      if (stillHere()) render({ ...view, fb });
      return;
    }
    if (act === 'undo' && fb.id) {
      render({ result: r, fb: {}, busy: true });
      done(await ask('feedback-undo', { id: fb.id, rerun: current.payload }), {});
    }
  }

  /* ───────── 말풍선 이어 묻기 (T-216, ADR 0017) ─────────
     결과 뒤 "이어 묻기" → 칩 두 개 + 입력칸. 보내는 글은 호버와 같은 범위(current.payload)와 방금 결과뿐이다.
     답은 background 에이전트가 규칙 1·근거 검사·금칙어를 거쳐 돌려준다. 최근 세 개만 보인다 */
  async function onFollowup(kind, text) {
    if (!current || !view?.result || view.fu?.busy) return;
    const question = kind === 'free' ? String(text || '').trim() : FU_Q[kind];
    if (!question || question.length < 2) return;
    const key = current.key, r = view.result;
    const fu = { open: true, busy: true, items: [...(view.fu?.items || [])] };
    render({ ...view, fu });
    const res = await ask('agent:ask', {
      payload: current.payload, question,
      prev: { meaning: r.meaning, analogy: r.analogy, evidence: r.evidence },
      candidateIds: (r.debug?.candidates || []).map(c => c.id)
    });
    if (!current || current.key !== key || view?.fu !== fu) return; // 그사이 닫았거나 피드백으로 바뀜
    const d = res?.ok ? res.data : null;
    const item = d
      ? { q: d.question || question, answer: d.answer, evidence: d.evidence, note: d.rejected || d.stopText || '', found: d.answer ? [] : (d.found || []) }
      : { q: question, answer: '', note: res?.error || '답을 받지 못했어요.', found: [] };
    render({ ...view, fu: { open: true, busy: false, items: [...fu.items, item].slice(-3) } });
  }
  function fuHtml(state) {
    const fu = state.fu;
    const r = state.result;
    let h = '<div class="sep"></div><div class="fu">';
    for (const it of fu.items) {
      h += `<div class="fu-q">${esc(it.q)}</div>`;
      if (it.answer) {
        h += `<div class="fu-a">${esc(it.answer)}</div>`;
        if (it.evidence) h += `<div class="chips"><span class="chip ${it.evidence.source === 'user' ? 'user' : ''}">근거: ${esc(it.evidence.nodeLabel)}</span></div>`;
      } else {
        h += `<div class="fu-a muted">${esc(it.note)}</div>`;
        if (it.found?.length) h += `<div class="muted note">살펴본 개념: ${esc(it.found.join(', '))}</div>`;
      }
    }
    if (fu.busy) h += '<div class="muted"><span class="spin"></span>알아보는 중…</div>';
    else {
      const chips = [r.analogy && r.evidence ? 'why' : null, 'other'].filter(Boolean);
      h += `<div class="chips">${chips.map(k => `<button class="chip fuq" data-act="fu-ask" data-kind="${k}">${FU_Q[k]}</button>`).join('')}</div>`;
      h += '<form class="fu-form"><input class="fu-in" type="text" maxlength="200" placeholder="더 궁금한 걸 물어보세요" aria-label="이어 묻기 질문"><button type="submit">묻기</button></form>';
    }
    return h + '</div>';
  }

  // 고른 글이 상한을 넘어 앞부분만 보냈을 때 한 줄(T-182)
  const noteHtml = () => (current?.note ? `<div class="muted note">${esc(current.note)}</div>` : '');

  function render(state) {
    ensureTooltip();
    if (current) current.awaitTheme = false; // 한 번이라도 그렸으면 더는 테마를 기다리지 않는다(T-148)
    if (state.result?.theme) theme = state.result.theme;
    box.className = 'box t-' + (theme === 'maple' ? 'maple' : 'neutral') + (box.classList.contains('show') ? ' show' : '');
    let html = '<button class="close" data-act="close" title="닫기 (Esc)">×</button>';
    if (state.loading) {
      if (state.meaning) html += `<div class="row"><span class="label">쉬운 뜻</span>${esc(state.meaning)}</div>`;
      html += `<div class="muted"><span class="spin"></span>${esc(STAGE_TEXT[state.stage] || '준비 중')}…</div>`;
      html += noteHtml();
    } else if (state.error) {
      html += `<div class="row err">${esc(state.error)}</div>
        <div class="foot"><span></span><button data-act="options">설정 열기</button></div>`;
    } else {
      const r = state.result;
      const fb = state.fb || {};
      if (fb.label) html += `<div class="fbbar"><span>${esc(fb.pick ? `'${fb.label}'${euro(fb.label).slice(fb.label.length)} 바꿨어요` : `이 문장엔 '${fb.label}'${eul(fb.label)} 안 쓸게요`)}</span>${fb.undo ? '<button data-act="undo">되돌리기</button>' : ''}</div>`;
      if (r.meaning) html += `<div class="row"><span class="label">쉬운 뜻</span>${esc(r.meaning)}</div>`;
      if (state.busy) {
        html += `<div class="muted"><span class="spin"></span>다른 비유 찾는 중…</div>`;
      } else if (r.analogy) {
        html += `<div class="row"><span class="label">${esc(euro(r.domain))} 보면</span><span class="analogy">${esc(r.analogy)}</span></div>`;
      } else {
        // 비유 없음 문구는 관심사별(T-302, 결과의 noMatchText). 비었으면(내 관심사·서버 결과) 기본 문구
        html += `<div class="row muted">${esc(r.rejected || r.noMatchText || `${r.domain}에서 딱 맞는 비유를 찾지 못했어요. 억지로 만들지 않았어요.`)}</div>`;
      }
      // 후보 칩: 👎 직후 "더 맞는 개념", 비유가 없을 때 "혹시 이 중에 있나요?" (고르면 그 개념으로 다시, 근거 검증은 그대로)
      // 지금 근거로 쓰인 개념은 다시 고를 필요가 없으니 뺀다
      const alts = (fb.down ? fb.alts : (!r.analogy && !fb.label ? (r.debug?.candidates || []) : [])).filter(c => c.id !== r.evidence?.nodeId);
      if (!state.busy && alts.length && (fb.down ? fb.chips : true)) {
        html += `<div class="ask">${fb.down ? '더 맞는 개념이 있나요?' : '혹시 이 중에 있나요?'}</div><div class="chips">${alts.map(c => `<button class="chip alt" data-act="pick" data-id="${esc(c.id)}">${esc(c.label)}</button>`).join('')}${fb.down ? '<button class="chip reason" data-act="reason" data-reason="none">없어요</button>' : ''}</div>`;
      }
      if (fb.down && fb.chips && !state.busy) {
        html += fb.reason
          ? '<div class="ask thanks">알려 줘서 고마워요</div>'
          : `<div class="ask">왜 안 맞았나요? (선택)</div><div class="chips">${REASON_CHIPS.map(([k, t]) => `<button class="chip reason" data-act="reason" data-reason="${k}">${t}</button>`).join('')}</div>`;
      }
      if (r.evidence && !state.busy) {
        html += `<div class="chips"><span class="chip ${r.evidence.source === 'user' ? 'user' : ''}" title="${r.evidence.source === 'user' ? '내 저장소' : '공통 저장소'}">근거: ${esc(r.evidence.nodeLabel)}</span>${verifiedChip(r.evidence)}${r.evidence.tagLabel ? `<span class="chip tag" title="공유하는 추상 구조">${esc(r.evidence.tagLabel)}</span>` : ''}${r.feedbackApplied ? '<span class="chip fb" title="내가 남긴 피드백으로 바뀐 결과예요">내 피드백 반영</span>' : ''}</div>`;
      }
      const thumbs = state.thanked
        ? '<span class="thanks">고마워요</span>'
        : `<button class="fbtn up" data-act="up" aria-label="잘 맞아요" title="잘 맞아요">${THUMB}</button>${r.evidence && r.analogy ? `<button class="fbtn down" data-act="down" aria-label="안 맞아요" title="안 맞아요">${THUMB}</button>` : ''}`;
      html += noteHtml();
      if (state.fu?.open && !state.busy) html += fuHtml(state);
      const fuBtn = state.busy || state.fu?.open ? '' : '<button data-act="fu-open">이어 묻기</button>';
      html += `<div class="foot"><span>${esc(r.debug?.provider || '')}${SOURCE_TEXT[r.source] || ''}${r.cached ? ' · 캐시' : ''}</span><span class="fb">${state.busy || !r.analogy ? '' : thumbs}${fuBtn}<button data-act="options">설정</button></span></div>`;
    }
    box.innerHTML = html;
    view = state;
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'close') hideTooltip();
      else if (act === 'options') chrome.runtime.sendMessage({ type: 'open-options' });
      else if (act === 'fu-open') { render({ ...view, fu: { open: true, busy: false, items: [] } }); box.querySelector('.fu-in')?.focus(); }
      else if (act === 'fu-ask') onFollowup(b.dataset.kind);
      else onFeedback(act, b.dataset);
    }));
    const fuForm = box.querySelector('.fu-form');
    if (fuForm) {
      const input = fuForm.querySelector('.fu-in');
      fuForm.addEventListener('submit', e => { e.preventDefault(); onFollowup('free', input.value); });
      // 입력 중 글자가 페이지 단축키로 새지 않게(버블 단계). Esc는 문서 캡처 단계에서 먼저 받아 말풍선을 닫는다
      for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, e => e.stopPropagation());
    }
    if (current) place(current);
    requestAnimationFrame(() => box.classList.add('show'));
  }

  function hideTooltip() {
    clearTimeout(hideTimer);
    fbTimers.forEach(clearTimeout); fbTimers = [];
    view = null;
    current = null;
    reqSeq++;
    clearHighlight();
    detachShadowHlStyles();
    if (box) { box.classList.remove('show'); box.innerHTML = ''; }
  }

  /* ───────── 백그라운드 연결 ───────── */
  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'explain' });
    port.onMessage.addListener(msg => {
      if (!current || msg.id !== current.reqId) return;
      // 뜻이 먼저 왔으면 이후 단계 표시에서도 뜻을 유지한다
      if (msg.type === 'partial') { current.meaning = msg.partial.meaning; render({ loading: true, stage: 'analogy', meaning: current.meaning }); }
      if (msg.type === 'stage' && msg.theme) { theme = msg.theme; markTheme(); } // 로딩 중에도 관심사 테마로(T-108)
      if (msg.type === 'stage') render({ loading: true, stage: msg.stage, meaning: current.meaning });
      if (msg.type === 'result') render({ result: msg.result });
      if (msg.type === 'error') render({ error: msg.error });
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (current?.pending) render({ error: '확장 프로그램과 연결이 끊겼어요. 페이지를 새로고침해 주세요.' });
    });
    return port;
  }

  function trigger() {
    // 부모 DOM 은 바뀔 수 있으니(폼에 비밀번호 칸이 나중에 생김 등) 트리거마다 다시 본다(T-148, 같은 출처 사슬만이라 가벼움)
    if (!isTop) { framedPw = framedInPasswordForm(); if (framedPw && (current || view)) hideTooltip(); }
    if (!active() || !mouse.inside) return;
    // 작은 서브프레임(광고·위젯, T-147)은 말풍선이 잘리니 테마도 받지 않고 아무것도 보내지 않는다
    if (AP.tinyFrame({ isTop, vw: window.innerWidth, vh: window.innerHeight })) return;
    themeWanted = true; // 서브프레임은 여기(처음 보조키를 누르거나 머무른 순간)서 처음 받는다(T-111)
    refreshIfStale(); // 미리 받기가 실패했으면 호버 때 다시(이번 말풍선은 stage theme이 고침)
    // 고른 범위 위면 고른 글, 아니면 커서 아래 문장(T-182)
    const s = selectionAt(mouse.x, mouse.y) || sentenceAt(mouse.x, mouse.y);
    if (!s) return;
    if (current && current.key === s.key) return;
    const reqId = ++reqSeq;
    const payload = { sentence: s.text, word: s.word, context: s.context, pageTitle: document.title.slice(0, 120), topHost };
    // 줄은 호버한 순간 한 번만 고른다(뷰포트 y는 스크롤하면 다른 줄을 가리킴).
    // 고른 범위는 마지막 줄 아래(넘치면 첫 줄 위, place의 span). 가로는 커서 x를 마지막 줄 안으로 당긴다
    const lines = AP.lineRects(s.range.getClientRects());
    const lastLine = lines.at(-1);
    const lineIndex = s.selection ? lines.length - 1 : AP.pickLineIndex(lines, mouse.y);
    const anchorX = s.selection && lastLine ? Math.min(Math.max(mouse.x, lastLine.left), lastLine.right) : mouse.x;
    // 서브프레임이 테마를 아직 모르면(T-148) 로딩 말풍선을 바로 그리지 않고, graph:info 응답이나 첫 stage(theme 실음)·결과가 오면 그린다.
    // 강조는 바로 한다. 최상위는 시작 때 미리 받으니 지금처럼 바로 그린다(받기 전이면 기본 테마)
    const awaitTheme = !isTop && themeStale;
    current = { key: s.key, range: s.range, reqId, pending: true, payload, anchorX, lineIndex, awaitTheme, span: !!s.selection, note: s.note || '' };
    highlight(s.range);
    if (!awaitTheme) render({ loading: true, stage: 'graph' });
    try {
      getPort().postMessage({
        type: 'explain', id: reqId, frameToken,
        payload
      });
    } catch {
      port = null;
      render({ error: '확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요.' });
    }
  }

  /* ───────── 입력 이벤트 ───────── */
  function modifierHeld(e) {
    const k = settings.modifierKey;
    return (k === 'Alt' && e.altKey) || (k === 'Shift' && e.shiftKey) || (k === 'Control' && e.ctrlKey) || (k === 'Meta' && e.metaKey);
  }

  function insideTooltip(x, y) {
    if (!box || !box.classList.contains('show')) return false;
    const r = box.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function nearCurrent(x, y) {
    if (!current) return false;
    for (const r of current.range.getClientRects()) {
      if (x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12) return true;
    }
    return false;
  }

  let moveRaf = 0;
  document.addEventListener('mousemove', e => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
    if (!active()) return;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (insideTooltip(mouse.x, mouse.y)) { clearTimeout(hideTimer); return; }

      if (settings.triggerMode === 'modifier') {
        if (modifierHeld(e)) { modifierUsed = true; trigger(); }
      } else {
        // 자동 모드: 같은 자리에 머물면 실행, 문장에서 벗어나면 잠시 뒤 닫기
        clearTimeout(dwellTimer);
        dwellTimer = setTimeout(trigger, settings.dwellMs);
        if (current && !nearCurrent(mouse.x, mouse.y)) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => { if (!insideTooltip(mouse.x, mouse.y) && !nearCurrent(mouse.x, mouse.y)) hideTooltip(); }, 500);
        }
      }
    });
  }, { passive: true });

  // 커서가 이 문서 밖(창 밖: relatedTarget 없음, 자식 iframe 안: relatedTarget 이 IFRAME·FRAME)으로 나가면 "밖"(T-147).
  // 자동 모드에서 이미 걸어 둔 머무름 타이머도 지운다(옛 좌표로 트리거하지 않게)
  document.addEventListener('mouseout', e => {
    const to = e.relatedTarget;
    if (to && to.tagName !== 'IFRAME' && to.tagName !== 'FRAME') return;
    mouse.inside = false;
    clearTimeout(dwellTimer);
  }, { passive: true, capture: true });
  document.addEventListener('mouseover', e => {
    if (e.target?.tagName === 'IFRAME' || e.target?.tagName === 'FRAME') return; // iframe 요소 위 = 그 프레임 안
    mouse.inside = true;
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, { passive: true, capture: true });

  // 다른 프레임에서 새 explain이 시작되면 이 프레임 말풍선을 닫는다(T-147, background가 같은 탭 모든 프레임에 보냄).
  // 보낸 프레임 자신은 자기 표지라 무시한다. 꺼짐·제외 사이트여도 닫기만 하므로 문제없다
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'close-bubble' || msg.exceptToken === frameToken) return;
    if (current || view) hideTooltip();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideTooltip(); return; }
    if (!active() || settings.triggerMode !== 'modifier') return;
    if (e.key === settings.modifierKey && !e.repeat) { modifierUsed = true; trigger(); }
  }, true);

  // 윈도우에서 Alt만 눌렀다 떼면 브라우저 메뉴로 포커스가 가는 것을 막는다
  document.addEventListener('keyup', e => {
    if (e.key === 'Alt' && settings.modifierKey === 'Alt' && modifierUsed) {
      e.preventDefault();
      modifierUsed = false;
    }
  }, true);

  document.addEventListener('mousedown', e => {
    if (host && e.composedPath().includes(host)) return;
    if (current) hideTooltip();
  }, true);

  let lastScrollY = window.scrollY;
  window.addEventListener('scroll', () => {
    if (current && Math.abs(window.scrollY - lastScrollY) > 80) hideTooltip();
    if (!current) lastScrollY = window.scrollY;
  }, { passive: true });
})();
