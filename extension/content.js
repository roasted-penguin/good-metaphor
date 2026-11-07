// 콘텐츠 스크립트: 커서 아래 문장을 찾아 강조하고, 말풍선으로 비유를 보여 준다.
(() => {
  if (window.__analogyHelperLoaded) return;
  window.__analogyHelperLoaded = true;

  const HL_NAME = 'analogy-helper-hl';
  let settings = { enabled: true, triggerMode: 'modifier', modifierKey: 'Alt', dwellMs: 900 };
  let mouse = { x: 0, y: 0, alt: false, shift: false, ctrl: false, meta: false };
  let dwellTimer = null;
  let hideTimer = null;
  let current = null;       // { key, ranges, rects }
  let reqSeq = 0;
  let port = null;
  let modifierUsed = false;

  /* ───────── 설정 ───────── */
  const SF = globalThis.AnalogySiteFilter; // lib/site-filter.js (manifest에서 먼저 주입)
  const AP = globalThis.AnalogyPlace;      // lib/place.js (manifest에서 먼저 주입, T-109)
  let theme = 'maple';      // 말풍선 테마. 미리 받기(graph:info)·stage·결과 순으로 고쳐진다
  let themeStale = true;    // 테마를 (다시) 받아야 함
  // 이 페이지 호스트가 제외 목록에 있음(T-107). 저장된 설정을 읽기 전에는 기본 목록으로 판정한다
  let siteExcluded = SF.isExcludedHost(location.hostname, SF.DEFAULT_EXCLUDED_HOSTS);
  // 켜져 있고 이 사이트가 제외 목록에 없을 때만 동작한다
  const active = () => settings.enabled && !siteExcluded;
  function loadSettings() {
    chrome.storage.local.get('settings', ({ settings: s }) => {
      settings = { ...settings, ...(s || {}) };
      siteExcluded = SF.isExcludedHost(location.hostname, settings.excludedHosts ?? SF.DEFAULT_EXCLUDED_HOSTS);
      if (!active()) hideTooltip();
      else refreshIfStale();
    });
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) loadSettings();
    if (Object.keys(changes).some(isGraphKey)) { themeStale = true; markTheme(); if (active()) refreshTheme(); }
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
  const refreshIfStale = () => { if (themeStale && !themeLoading && active()) refreshTheme(); };
  function refreshTheme() {
    const seq = ++themeSeq; // 늦게 온 옛 응답은 버린다(키가 바뀌어 다시 받은 경우)
    themeLoading = true;
    const done = got => {
      if (seq !== themeSeq) return;
      themeLoading = false;
      if (got) { theme = got; themeStale = false; } else themeStale = true;
      markTheme();
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

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK_DISPLAYS.has(getComputedStyle(el).display)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  // 비밀번호 칸이 있는 폼 안 문장은 설정과 무관하게 보내지 않는다(T-107)
  function inPasswordForm(node) {
    const form = node.parentElement?.closest('form');
    return !!form && [...form.elements].some(el => el.type === 'password');
  }

  function isSkippable(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || el.id === 'analogy-helper-host') return true;
    }
    return false;
  }

  function textNodesIn(block) {
    const out = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        // 같은 블록 안 비밀번호 폼 글자가 문장·앞 문장으로 새지 않게 뺀다(T-107)
        if (inPasswordForm(n)) return NodeFilter.FILTER_REJECT;
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

  /* ───────── 강조 ───────── */
  function highlight(range) {
    if (!window.CSS?.highlights) return;
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
    host.id = 'analogy-helper-host';
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
          box-shadow: var(--shadow); padding: 12px 14px 10px; pointer-events: auto;
          opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s; }
        .box.t-maple { border-radius: 6px; box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,.06); }
        .box.show { opacity: 1; transform: none; }
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
        .chip.alt:hover, .chip.reason:hover { background: var(--chip-bg); }
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

  // 말풍선 배치(T-109): 호버한 순간의 커서(anchorX·anchorY)가 있던 줄 rect 아래, 넘치면 그 줄 위.
  // 결과가 와서 말풍선이 커져 다시 부를 때도 같은 앵커라, 커서가 움직여도 따라다니지 않는다.
  // 줄 rect를 못 고르면 문장 전체 bounding rect(한 줄 문장은 둘이 같다)
  function place(cur) {
    const pad = 10;
    const w = Math.min(380, window.innerWidth - 2 * pad);
    box.style.maxWidth = w + 'px';
    const rect = AP.pickLineRect(cur.range.getClientRects(), cur.anchorY) || cur.range.getBoundingClientRect();
    const { left, top } = AP.placeBox({
      rect, mouseX: cur.anchorX, bw: box.offsetWidth || 300, bh: box.offsetHeight || 120,
      vw: window.innerWidth, vh: window.innerHeight, pad
    });
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
    const sent = { sentence: current.payload.sentence, provider: r.debug?.provider || '' };
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
      const res = await ask('feedback', { record: { ...sent, nodeId: r.evidence?.nodeId || null, tagId: null, vote: 'pick', pickedNodeId: data.id }, rerun: current.payload });
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

  function render(state) {
    ensureTooltip();
    if (state.result?.theme) theme = state.result.theme;
    box.className = 'box t-' + (theme === 'maple' ? 'maple' : 'neutral') + (box.classList.contains('show') ? ' show' : '');
    let html = '<button class="close" data-act="close" title="닫기 (Esc)">×</button>';
    if (state.loading) {
      if (state.meaning) html += `<div class="row"><span class="label">쉬운 뜻</span>${esc(state.meaning)}</div>`;
      html += `<div class="muted"><span class="spin"></span>${esc(STAGE_TEXT[state.stage] || '준비 중')}…</div>`;
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
        html += `<div class="row muted">${esc(r.rejected || `${r.domain}에서 딱 맞는 비유를 찾지 못했어요. 억지로 만들지 않았어요.`)}</div>`;
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
        html += `<div class="chips"><span class="chip ${r.evidence.source === 'user' ? 'user' : ''}" title="${r.evidence.source === 'user' ? '내 저장소' : '공통 저장소'}">근거: ${esc(r.evidence.nodeLabel)}</span>${r.evidence.tagLabel ? `<span class="chip tag" title="공유하는 추상 구조">${esc(r.evidence.tagLabel)}</span>` : ''}${r.feedbackApplied ? '<span class="chip fb" title="내가 남긴 피드백으로 바뀐 결과예요">내 피드백 반영</span>' : ''}</div>`;
      }
      const thumbs = state.thanked
        ? '<span class="thanks">고마워요</span>'
        : `<button class="fbtn up" data-act="up" aria-label="잘 맞아요" title="잘 맞아요">${THUMB}</button>${r.evidence && r.analogy ? `<button class="fbtn down" data-act="down" aria-label="안 맞아요" title="안 맞아요">${THUMB}</button>` : ''}`;
      html += `<div class="foot"><span>${esc(r.debug?.provider || '')}${SOURCE_TEXT[r.source] || ''}${r.cached ? ' · 캐시' : ''}</span><span class="fb">${state.busy || !r.analogy ? '' : thumbs}<button data-act="options">설정</button></span></div>`;
    }
    box.innerHTML = html;
    view = state;
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'close') hideTooltip();
      else if (act === 'options') chrome.runtime.sendMessage({ type: 'open-options' });
      else onFeedback(act, b.dataset);
    }));
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
    if (!active()) return;
    refreshIfStale(); // 미리 받기가 실패했으면 호버 때 다시(이번 말풍선은 stage theme이 고침)
    const s = sentenceAt(mouse.x, mouse.y);
    if (!s) return;
    if (current && current.key === s.key) return;
    const reqId = ++reqSeq;
    const payload = { sentence: s.text, word: s.word, context: s.context, pageTitle: document.title.slice(0, 120) };
    current = { key: s.key, range: s.range, reqId, pending: true, payload, anchorX: mouse.x, anchorY: mouse.y };
    highlight(s.range);
    render({ loading: true, stage: 'graph' });
    try {
      getPort().postMessage({
        type: 'explain', id: reqId,
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
    mouse.x = e.clientX; mouse.y = e.clientY;
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
