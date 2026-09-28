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
  function loadSettings() {
    chrome.storage.local.get('settings', ({ settings: s }) => {
      settings = { ...settings, ...(s || {}) };
      if (!settings.enabled) hideTooltip();
    });
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadSettings();
  });

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
    if (isSkippable(hit.node)) return null;
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
        }
        @media (prefers-color-scheme: dark) {
          .box.t-neutral { --bg: #1d2129; --ink: #e8eaee; --muted: #9aa3b2; --line: #343a46; --label: #b99cff;
            --em: #ffffff; --chip-bg: #2a303b; --chip-ink: #cfd5df; --chip2-bg: #262d4a; --chip2-ink: #aab4ff;
            --user-bg: #15324d; --user-ink: #9fd0ff; --accent: #8d96ff; --shadow: 0 8px 28px rgba(0,0,0,.5); }
        }
        .box.t-maple {
          --bg: rgba(22, 28, 43, .97); --ink: #eef1f7; --muted: #9ba5bd; --line: #46506a;
          --label: #ffcc33;                          /* 유니크 노랑 */
          --em: #ffffff;
          --chip-bg: rgba(160, 230, 60, .14); --chip-ink: #b9ef5a;   /* 레전드리 초록 = 근거 */
          --chip2-bg: rgba(190, 140, 255, .16); --chip2-ink: #d2b1ff; /* 에픽 보라 = 추상 태그 */
          --user-bg: rgba(90, 200, 255, .15); --user-ink: #8fdcff;    /* 레어 파랑 = 내 저장소 */
          --accent: #ff9a2e;                         /* 단풍잎 주황 */
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

  function place(rect) {
    const pad = 10;
    const w = Math.min(380, window.innerWidth - 2 * pad);
    box.style.maxWidth = w + 'px';
    const bw = box.offsetWidth || 300, bh = box.offsetHeight || 120;
    let left = Math.min(Math.max(pad, mouse.x - bw / 2), window.innerWidth - bw - pad);
    let topPos = rect.bottom + 8;
    if (topPos + bh > window.innerHeight - pad) topPos = Math.max(pad, rect.top - bh - 8);
    box.style.left = left + 'px';
    box.style.top = topPos + 'px';
  }

  const STAGE_TEXT = {
    graph: '관심사 그래프 불러오는 중',
    model: '임베딩 모델 준비 중 (처음 한 번은 1분쯤 걸려요)',
    abstract: '핵심 개념 뽑는 중',
    search: '비슷한 개념 찾는 중',
    generate: '비유 만드는 중'
  };

  let theme = 'maple';
  function render(state) {
    ensureTooltip();
    if (state.result?.theme) theme = state.result.theme;
    box.className = 'box t-' + (theme === 'maple' ? 'maple' : 'neutral') + (box.classList.contains('show') ? ' show' : '');
    let html = '<button class="close" data-act="close" title="닫기 (Esc)">×</button>';
    if (state.loading) {
      html += `<div class="muted"><span class="spin"></span>${esc(STAGE_TEXT[state.stage] || '준비 중')}…</div>`;
    } else if (state.error) {
      html += `<div class="row err">${esc(state.error)}</div>
        <div class="foot"><span></span><button data-act="options">설정 열기</button></div>`;
    } else {
      const r = state.result;
      if (r.meaning) html += `<div class="row"><span class="label">쉬운 뜻</span>${esc(r.meaning)}</div>`;
      if (r.analogy) {
        html += `<div class="row"><span class="label">${esc(euro(r.domain))} 보면</span><span class="analogy">${esc(r.analogy)}</span></div>`;
      } else {
        html += `<div class="row muted">${esc(r.rejected || `${r.domain}에서 딱 맞는 비유를 찾지 못했어요. 억지로 만들지 않았어요.`)}</div>`;
      }
      if (r.evidence) {
        html += `<div class="chips"><span class="chip ${r.evidence.source === 'user' ? 'user' : ''}" title="${r.evidence.source === 'user' ? '내 저장소' : '공통 저장소'}">근거: ${esc(r.evidence.nodeLabel)}</span>${r.evidence.tagLabel ? `<span class="chip tag" title="공유하는 추상 구조">${esc(r.evidence.tagLabel)}</span>` : ''}</div>`;
      }
      html += `<div class="foot"><span>${esc(r.debug?.provider || '')}${r.cached ? ' · 캐시' : ''}</span><button data-act="options">설정</button></div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (b.dataset.act === 'close') hideTooltip();
      if (b.dataset.act === 'options') chrome.runtime.sendMessage({ type: 'open-options' });
    }));
    if (current) place(current.range.getBoundingClientRect());
    requestAnimationFrame(() => box.classList.add('show'));
  }

  function hideTooltip() {
    clearTimeout(hideTimer);
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
      if (msg.type === 'stage') render({ loading: true, stage: msg.stage });
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
    if (!settings.enabled) return;
    const s = sentenceAt(mouse.x, mouse.y);
    if (!s) return;
    if (current && current.key === s.key) return;
    const reqId = ++reqSeq;
    current = { key: s.key, range: s.range, reqId, pending: true };
    highlight(s.range);
    render({ loading: true, stage: 'graph' });
    try {
      getPort().postMessage({
        type: 'explain', id: reqId,
        payload: { sentence: s.text, word: s.word, context: s.context, pageTitle: document.title.slice(0, 120) }
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
    if (!settings.enabled) return;
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
    if (!settings.enabled || settings.triggerMode !== 'modifier') return;
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
