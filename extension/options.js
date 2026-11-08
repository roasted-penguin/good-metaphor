import { localDay, formatFeedbackStats } from './lib/feedback.js';
import { validateOverlay, normalizeOverlay } from './lib/stores.js';
import { formToNode, nodeToForm, upsertNode, removeNode, setHidden, setBoost, clampBoost, tagChoices, SAMPLE_FORM, BOOST_MIN, BOOST_MAX } from './lib/overlay-form.js';
import { confirmFact, confirmAllFacts, removeFact, reviewAfterEdit, addDraftNodes, startNewInterest, draftNodes, hasNumber, validDraftName, DRAFT_LIMITS } from './lib/draft.js';
import './lib/site-filter.js'; // globalThis.AnalogySiteFilter (콘텐츠 스크립트와 같은 파일)

const SF = globalThis.AnalogySiteFilter;

const $ = s => document.querySelector(s);
const send = (type, extra = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type, ...extra }, res => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!res) return reject(new Error('응답이 없어요.'));
    res.ok ? resolve(res.data) : reject(new Error(res.error));
  });
});
const setStatus = (el, text, kind = '') => { el.textContent = text; el.className = 'status ' + kind; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;

/* ───────── 사용 방식 ───────── */
async function saveTrigger() {
  await send('settings:save', { patch: {
    enabled: $('#enabled').checked,
    triggerMode: document.querySelector('input[name=triggerMode]:checked')?.value || 'modifier',
    modifierKey: $('#modifierKey').value,
    dwellMs: Math.min(3000, Math.max(300, +$('#dwellMs').value || 900)),
    preciseMode: $('#preciseMode').checked
  } });
}
for (const el of ['#enabled', '#modifierKey', '#dwellMs', '#preciseMode']) $(el).addEventListener('change', saveTrigger);
document.querySelectorAll('input[name=triggerMode]').forEach(r => r.addEventListener('change', () => { saveTrigger(); syncTriggerUI(); }));
function syncTriggerUI() {
  const mode = document.querySelector('input[name=triggerMode]:checked')?.value;
  $('#modifierKey').disabled = mode !== 'modifier';
  $('#dwellMs').disabled = mode !== 'auto';
}
// 저장된 설정을 "사용 방식" 칸에 그린다 (초기화와 첫 실행 안내가 같이 씀)
function renderTrigger(s) {
  $('#enabled').checked = s.enabled;
  const r = document.querySelector(`input[name=triggerMode][value="${s.triggerMode}"]`);
  if (r) r.checked = true;
  $('#modifierKey').value = s.modifierKey;
  $('#dwellMs').value = s.dwellMs;
  $('#preciseMode').checked = s.preciseMode;
  syncTriggerUI();
}

/* ───────── 제외 사이트 (T-107, T-144) ───────── */
// 저장된 순서 그대로 그린다. 읽기·그리기만 하고 저장하지 않는다(onChanged 갱신이 루프를 만들지 않게)
let siteHosts = [];
function renderSites(list) {
  siteHosts = Array.isArray(list) ? [...list] : [...SF.DEFAULT_EXCLUDED_HOSTS];
  $('#siteList').innerHTML = siteHosts.map((h, i) => `
    <li><span class="site-host" title="${esc(h)}">${esc(h)}</span>
      <button type="button" class="site-del" data-i="${i}" aria-label="${esc(h)} 지우기">×</button></li>`).join('');
  // 빈 목록 안내는 목록 밖 문단으로(접근성)
  $('#siteList').hidden = !siteHosts.length;
  $('#siteEmpty').hidden = !!siteHosts.length;
}
// 저장 실패면 화면을 저장 전 목록으로 되돌린다
async function saveSites(next) {
  const prev = siteHosts;
  renderSites(next);
  try {
    state.settings = await send('settings:save', { patch: { excludedHosts: next } });
    return true;
  } catch {
    renderSites(prev);
    setStatus($('#siteStatus'), '저장하지 못했어요. 다시 시도해 주세요.', 'err');
    return false;
  }
}
const SITE_ERR = { invalid: '주소를 확인해 주세요.', duplicate: '이미 들어 있어요.' };
$('#siteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = SF.validateHostInput($('#siteInput').value, siteHosts);
  if (!v.ok) return setStatus($('#siteStatus'), SITE_ERR[v.error], 'err');
  setStatus($('#siteStatus'), '');
  if (await saveSites([...siteHosts, v.host])) $('#siteInput').value = '';
});
$('#siteList').addEventListener('click', e => {
  const b = e.target.closest('.site-del');
  if (!b) return;
  setStatus($('#siteStatus'), '');
  saveSites(siteHosts.filter((_, i) => i !== +b.dataset.i));
});
$('#siteReset').addEventListener('click', () => {
  setStatus($('#siteStatus'), '');
  saveSites([...SF.DEFAULT_EXCLUDED_HOSTS]);
});
// 팝업 "이 사이트에서 끄기" 등 다른 곳에서 바뀌면 다시 그린다(읽기만)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue?.excludedHosts;
  if (JSON.stringify(next ?? SF.DEFAULT_EXCLUDED_HOSTS) !== JSON.stringify(siteHosts)) renderSites(next);
});

/* ───────── 첫 실행 안내 (T-116) ───────── */
async function initOnboarding() {
  try {
    const { onboarding } = await chrome.storage.local.get('onboarding');
    $('#onboarding').hidden = !onboarding?.pending;
  } catch (err) {
    console.warn('첫 실행 안내 상태를 읽지 못했어요:', err);
  } finally {
    $('#onboarding').dataset.ready = '1'; // 보일지 말지 정해졌다는 표시(e2e가 기다림)
  }
}
document.querySelectorAll('input[name=obTrigger]').forEach(r => r.addEventListener('change', () => {
  $('#obAutoWarn').hidden = document.querySelector('input[name=obTrigger]:checked')?.value !== 'auto';
}));
for (const id of ['#obShareYes', '#obShareNo']) $(id).addEventListener('click', e => {
  // 누른 쪽만 눌림. 미리 선택된 값은 없다(웹스토어 사용자 데이터 정책)
  for (const b of ['#obShareYes', '#obShareNo']) $(b).setAttribute('aria-pressed', String($(b) === e.currentTarget));
});
async function finishOnboarding(patch) {
  try {
    // patch가 없으면(넘기기) 설정은 그대로 두고 안내만 닫는다
    state.settings = patch ? await send('settings:save', { patch }) : (await send('settings:get')).settings;
    await chrome.storage.local.set({ onboarding: { pending: false, doneAt: Date.now() } });
    $('#onboarding').hidden = true;
    renderTrigger(state.settings);
    await loadFeedback(); // #fbShare를 저장된 값으로
  } catch (err) { setStatus($('#obStatus'), err.message, 'err'); }
}
$('#obStart').addEventListener('click', () => finishOnboarding({
  triggerMode: document.querySelector('input[name=obTrigger]:checked')?.value || 'modifier',
  feedbackShare: $('#obShareYes').getAttribute('aria-pressed') === 'true'
}));
$('#obSkip').addEventListener('click', () => finishOnboarding(null));

/* ───────── AI 제공자 ───────── */
function fillProvider(id) {
  const p = state.providers[id];
  const s = state.settings;
  $('#modelList').innerHTML = (p.models || []).map(m => `<option value="${esc(m)}">`).join('');
  $('#model').value = s.models?.[id] || state.admin.defaultModels?.[id] || p.defaultModel || '';
  $('#apiKey').value = s.apiKeys?.[id] || '';
  const shared = state.admin.sharedApiKeys?.[id];
  $('#apiKey').placeholder = shared ? '관리자가 배포한 키를 사용 중 (직접 넣으면 덮어써요)' : (p.keyOptional ? '필요 없으면 비워 두세요' : '키를 붙여 넣으세요');
  $('#keyHint').innerHTML = [
    p.free ? '<span class="badge legend">무료 티어</span>' : '',
    p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">키 발급 페이지</a>` : '',
    id === 'gemini' ? '무료 티어는 입력 내용이 구글의 제품 개선에 쓰일 수 있어요.' : '',
    id === 'demo' ? 'AI를 부르지 않고 검색 결과만으로 문장을 만들어요.' : ''
  ].filter(Boolean).join(' · ');
  document.querySelectorAll('.custom-only').forEach(el => el.hidden = id !== 'custom');
  $('#customBaseUrl').value = s.customBaseUrl || state.admin.customBaseUrl || '';
}

$('#provider').addEventListener('change', e => fillProvider(e.target.value));

$('#saveProvider').addEventListener('click', async () => {
  const id = $('#provider').value;
  const s = state.settings;
  const patch = {
    provider: id,
    models: { ...(s.models || {}), [id]: $('#model').value.trim() },
    apiKeys: { ...(s.apiKeys || {}), [id]: $('#apiKey').value.trim() }
  };
  if (id === 'custom') {
    const url = $('#customBaseUrl').value.trim();
    patch.customBaseUrl = url;
    if (url) {
      try {
        const origin = new URL(url).origin + '/*';
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) return setStatus($('#providerStatus'), '이 주소에 접근 권한이 필요해요.', 'err');
      } catch { return setStatus($('#providerStatus'), '주소 형식이 올바르지 않아요.', 'err'); }
    }
  }
  state.settings = await send('settings:save', { patch });
  setStatus($('#providerStatus'), '저장했어요.', 'ok');
});

$('#testProvider').addEventListener('click', async () => {
  setStatus($('#providerStatus'), '확인 중…');
  try {
    const r = await send('provider:test');
    setStatus($('#providerStatus'), `연결됨: ${r.text}`, 'ok');
  } catch (e) { setStatus($('#providerStatus'), e.message, 'err'); }
});

/* ───────── 저장소 ───────── */
async function loadStore() {
  const info = await send('graph:info');
  const c = info.common;
  $('#commonTitle').textContent = `${c.domain} · ${c.version}`;
  $('#commonStats').innerHTML = `<div><b>${c.nodes}</b>개념 노드</div><div><b>${c.tags}</b>추상 태그</div><div><b>${info.merged.usesCommon ? '사용 중' : '꺼짐'}</b>현재 검색 대상</div>`;
  $('#commonList').innerHTML = `<p><b>노드</b> ${c.nodeList.map(n => esc(n.label)).join(' · ')}</p><p><b>태그</b> ${c.tagList.map(t => `${esc(t.label)} <code>${esc(t.id)}</code>`).join(' · ')}</p>`;

  const auth = await send('auth:status');
  $('#adapterHint').textContent = auth.adapter === 'none'
    ? '이 배포에서는 로그인이 꺼져 있어요. 공통 저장소만 쓸 수 있어요.'
    : auth.adapter === 'local-dev'
      ? '지금은 개발용 로그인이에요. 서버 없이 이 브라우저에만 저장돼요.'
      : '서버 계정으로 로그인해요.';
  $('#nickname').hidden = auth.adapter !== 'local-dev';
  $('#login').disabled = auth.adapter === 'none';

  if (auth.session) {
    $('#loggedOut').hidden = true;
    $('#loggedIn').hidden = false;
    $('#userTitle').textContent = `${auth.session.name} 님의 오버레이 · 내 노드 ${info.merged.userNodes}개`;
    $('#whoami').textContent = `${auth.adapterLabel}로 로그인됨`;
    commonNodes = c.nodeList;
    commonTags = c.tagList;
    ov = normalizeOverlay(await send('overlay:get'));
    resetNodeForm();
    renderOverlayEditor();
  } else {
    $('#loggedOut').hidden = false;
    $('#loggedIn').hidden = true;
    $('#userTitle').textContent = '로그인이 필요해요';
  }
}

$('#login').addEventListener('click', async () => {
  setStatus($('#loginStatus'), '로그인 중…');
  try { await send('auth:login', { nickname: $('#nickname').value }); setStatus($('#loginStatus'), ''); await loadStore(); }
  catch (e) { setStatus($('#loginStatus'), e.message, 'err'); }
});
$('#logout').addEventListener('click', async () => { await send('auth:logout'); await loadStore(); });

/* ───────── 그래프 편집 (T-202) ─────────
   폼이 바꾸는 것은 메모리의 ov뿐이고, 저장 버튼이 overlay:save로 보낸다.
   폼은 아는 필드(nodes, hiddenNodeIds, nodeBoosts, useCommon)만 고치고 나머지(feedbackBoosts, tags 등)는 그대로 둔다.
   사용자 입력은 모두 textContent로 넣는다(innerHTML 금지). */
let ov = null;            // 편집 중인 오버레이
let commonNodes = [];     // graph:info의 공통 노드 목록 [{id,label}]
let commonTags = [];      // 공통 태그 사전 [{id,label}]
let editingId = null;     // 수정 중인 내 노드 id (새 노드면 null)
let formTags = [];        // 폼에서 고른 태그 id (고른 순서)

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}
const fmtBoost = v => (v > 0 ? '+' : '') + Number(v).toFixed(2);

function markDirty() {
  $('#overlay').value = JSON.stringify(ov, null, 2);
  $('#overlayErrors').hidden = true;
  setStatus($('#overlayStatus'), '바뀐 내용을 저장하세요.', 'warn');
}

// 가중치 슬라이더 + 값 + (있으면) 피드백 가중치 읽기 전용
function boostControls(id, label) {
  const val = clampBoost(ov.nodeBoosts?.[id]);
  const out = el('output', { class: 'ov-boost-val', text: fmtBoost(val) });
  const range = el('input', { type: 'range', class: 'ov-boost', min: BOOST_MIN, max: BOOST_MAX, step: '0.01', 'aria-label': `${label} 가중치` });
  range.value = String(val);
  range.addEventListener('input', () => { out.textContent = fmtBoost(+range.value); });
  range.addEventListener('change', () => { ov = setBoost(ov, id, range.value); markDirty(); });
  const fb = clampBoost(ov.feedbackBoosts?.[id]);
  return el('span', { class: 'ov-boost-wrap' }, [range, out, fb ? el('span', { class: 'ov-fb', title: '👎 기록으로 정해진 값이라 여기서 고치지 않아요.', text: `피드백 ${fmtBoost(fb)}` }) : null]);
}

function renderMyNodes() {
  const list = $('#myNodeList');
  list.replaceChildren();
  const tagLabel = new Map(tagChoices(commonTags, ov.tags).map(t => [t.id, t.label]));
  // 검수 대기(draft) 노드는 아래 "검수 대기" 구역에만 보인다(T-301)
  const mine = (ov.nodes || []).filter(n => n.draft !== true);
  for (const n of mine) {
    const chips = el('span', { class: 'chips small' }, (n.tags || []).map(t => el('span', { class: 'chip', text: tagLabel.get(t) || t })));
    list.append(el('li', { dataset: { id: n.id } }, [
      el('span', { class: 'ov-main' }, [el('span', { class: 'ov-label', text: n.label || n.id }), chips]),
      boostControls(n.id, n.label || n.id),
      el('button', { class: 'ov-edit', text: '수정', onclick: () => startEdit(n.id) }),
      el('button', { class: 'ov-del', text: '지우기', onclick: () => deleteNode(n.id) })
    ]));
  }
  const empty = !mine.length;
  list.hidden = empty;
  $('#myNodesEmpty').hidden = !empty;
  renderReview();
}

/* 검수 대기 (T-301): 사실마다 확인·지우기, 노드마다 모두 확인·수정·노드 지우기.
   모든 사실이 확인되면 draft가 풀려 내 노드 목록으로 옮겨 간다. 바꾸는 것은 메모리의 ov뿐이고 저장 버튼이 반영한다 */
function updateNode(id, fn) {
  const n = (ov.nodes || []).find(x => x.id === id);
  if (!n) return;
  const next = fn(n);
  ov = next ? upsertNode(ov, next) : removeNode(ov, id);
  if (!next && editingId === id) resetNodeForm();
  renderMyNodes();
  markDirty();
}

function renderReview() {
  const drafts = draftNodes(ov);
  const list = $('#reviewList');
  list.replaceChildren();
  const tagLabel = new Map(tagChoices(commonTags, ov.tags).map(t => [t.id, t.label]));
  for (const n of drafts) {
    const chips = el('span', { class: 'chips small' }, (n.tags || []).map(t => el('span', { class: 'chip', text: tagLabel.get(t) || t })));
    const facts = el('ul', { class: 'rv-facts' }, n.facts.map((f, i) => {
      const done = n.factsReviewed?.[i] === true;
      return el('li', { class: 'rv-fact' + (done ? ' done' : ''), dataset: { i: String(i) } }, [
        el('span', { class: 'rv-text', text: f }),
        hasNumber(f) ? el('span', { class: 'rv-warn', title: '자주 바뀌는 값(가격·확률·날짜)이면 지우거나 고쳐 주세요.', text: '숫자 확인' }) : null,
        done ? el('span', { class: 'rv-done', text: '확인됨' }) : el('button', { class: 'rv-ok', text: '확인', onclick: () => updateNode(n.id, x => confirmFact(x, i)) }),
        el('button', { class: 'rv-del', text: '지우기', 'aria-label': `사실 ${i + 1} 지우기`, onclick: () => updateNode(n.id, x => removeFact(x, i)) })
      ]);
    }));
    list.append(el('li', { dataset: { id: n.id } }, [
      el('div', { class: 'rv-head' }, [
        el('span', { class: 'ov-main' }, [el('span', { class: 'ov-label rv-label', text: n.label }), chips]),
        el('button', { class: 'rv-all', text: '모두 확인', onclick: () => updateNode(n.id, confirmAllFacts) }),
        el('button', { class: 'rv-edit', text: '수정', onclick: () => startEdit(n.id) }),
        el('button', { class: 'rv-del-node', text: '노드 지우기', onclick: () => deleteNode(n.id) })
      ]),
      facts
    ]));
  }
  $('#reviewCount').textContent = drafts.length ? `${drafts.length}개` : '';
  $('#reviewBox').hidden = !drafts.length;
}

function renderCommonNodes() {
  $('#commonNodesBox').hidden = ov.useCommon === false;
  const hidden = new Set(ov.hiddenNodeIds || []);
  const list = $('#commonNodeList');
  list.replaceChildren();
  for (const n of commonNodes) {
    const box = el('input', { type: 'checkbox', class: 'ov-hide' });
    box.checked = hidden.has(n.id);
    box.addEventListener('change', () => { ov = setHidden(ov, n.id, box.checked); markDirty(); });
    list.append(el('li', { dataset: { id: n.id } }, [
      el('span', { class: 'ov-main' }, [el('span', { class: 'ov-label', text: n.label })]),
      el('label', { class: 'ov-hide-label' }, [box, document.createTextNode(' 숨기기')]),
      boostControls(n.id, n.label)
    ]));
  }
}

function renderTagChips() {
  const wrap = $('#nfTags');
  wrap.replaceChildren();
  for (const t of tagChoices(commonTags, ov.tags)) {
    const b = el('button', { type: 'button', class: 'chip-btn' + (t.source === 'user' ? ' user' : ''), dataset: { tag: t.id }, title: t.id, text: t.label });
    b.setAttribute('aria-pressed', String(formTags.includes(t.id)));
    b.addEventListener('click', () => {
      formTags = formTags.includes(t.id) ? formTags.filter(x => x !== t.id) : [...formTags, t.id];
      b.setAttribute('aria-pressed', String(formTags.includes(t.id)));
    });
    wrap.append(b);
  }
  // 사전에 없는 태그(고급 JSON으로 넣었거나 사전에서 빠진 것)는 눌러서 뺄 수만 있는 칩으로 보인다
  const known = new Set(tagChoices(commonTags, ov.tags).map(t => t.id));
  for (const id of formTags.filter(t => !known.has(t))) {
    const b = el('button', { type: 'button', class: 'chip-btn unknown', dataset: { tag: id }, title: '사전에 없는 태그예요. 눌러서 빼세요.', 'aria-pressed': 'true', text: id + ' ×' });
    b.addEventListener('click', () => { formTags = formTags.filter(x => x !== id); renderTagChips(); });
    wrap.append(b);
  }
}

function renderOverlayEditor() {
  const r = document.querySelector(`input[name=useCommon][value="${ov.useCommon !== false}"]`);
  if (r) r.checked = true;
  renderMyNodes();
  renderCommonNodes();
  renderTagChips();
  $('#overlay').value = JSON.stringify(ov, null, 2);
}

/* 노드 폼 */
const FORM_FIELDS = { label: '#nfLabel', facts: '#nfFacts', aliases: '#nfAliases' };
const ERR_FIELDS = { label: '#nfLabelErr', facts: '#nfFactsErr', tags: '#nfTagsErr', aliases: '#nfAliasesErr' };
function showFormErrors(errors = {}) {
  for (const [k, sel] of Object.entries(ERR_FIELDS)) $(sel).textContent = errors[k] || '';
}
function fillForm(form) {
  for (const [k, sel] of Object.entries(FORM_FIELDS)) $(sel).value = form[k] || '';
  formTags = [...(form.tags || [])];
  renderTagChips();
}
function readForm() {
  return { label: $('#nfLabel').value, facts: $('#nfFacts').value, aliases: $('#nfAliases').value, tags: [...formTags] };
}
function formHasInput() {
  const f = readForm();
  return !!(f.label.trim() || f.facts.trim() || f.aliases.trim() || f.tags.length);
}
function resetNodeForm() {
  editingId = null;
  fillForm({ label: '', facts: '', tags: [], aliases: '' });
  showFormErrors();
  $('#nodeFormTitle').textContent = '새 노드';
  $('#nfApply').textContent = '노드 추가';
}
function startEdit(id) {
  const n = (ov.nodes || []).find(x => x.id === id);
  if (!n) return;
  editingId = id;
  fillForm(nodeToForm(n));
  showFormErrors();
  $('#nodeFormTitle').textContent = '노드 수정';
  $('#nfApply').textContent = '수정 반영';
  $('#nfLabel').focus();
}
// 폼 → ov. 성공하면 true
function applyNodeForm() {
  const prev = editingId ? (ov.nodes || []).find(x => x.id === editingId) : null;
  const existingIds = [...(ov.nodes || []).map(n => n.id), ...commonNodes.map(n => n.id)];
  const { node: formed, errors } = formToNode(readForm(), { prev, existingIds });
  showFormErrors(errors);
  if (!formed) return false;
  // 초안 노드를 고쳤으면 고친 사실은 확인된 것으로(T-301). 모두 확인되면 일반 노드가 된다
  const node = reviewAfterEdit(prev, formed);
  ov = upsertNode(ov, node);
  resetNodeForm();
  renderMyNodes();
  markDirty();
  return true;
}
function deleteNode(id) {
  if (!confirm('이 노드를 지울까요?')) return;
  ov = removeNode(ov, id);
  if (editingId === id) resetNodeForm();
  renderMyNodes();
  markDirty();
}

$('#nfApply').addEventListener('click', applyNodeForm);
$('#nfCancel').addEventListener('click', resetNodeForm);
$('#insertSample').addEventListener('click', () => {
  editingId = null;
  $('#nodeFormTitle').textContent = '새 노드';
  $('#nfApply').textContent = '노드 추가';
  fillForm(SAMPLE_FORM);
  showFormErrors();
  setStatus($('#overlayStatus'), '예시를 폼에 채웠어요. 저장하면 반영돼요.', 'warn');
});

document.querySelectorAll('input[name=useCommon]').forEach(r => r.addEventListener('change', () => {
  if (!ov) return;
  ov = { ...ov, useCommon: r.value === 'true' };
  if (!ov.useCommon && !ov.domain) ov = { ...ov, domain: '내 관심사', analogyPrefix: '내 관심사로 치면' };
  renderCommonNodes();
  markDirty();
}));

// 고급: JSON을 고쳐 적용하면 검사 후 폼을 다시 그린다. 실패하면 오류만 보이고 폼은 그대로
// keepForm: 저장 버튼이 자동 적용할 때는 폼에 적던 값을 지운다(그 뒤 폼 적용이 이어진다)
function applyJsonBox({ keepForm = false } = {}) {
  let parsed;
  try { parsed = JSON.parse($('#overlay').value); } catch (e) { setStatus($('#jsonStatus'), 'JSON 오류: ' + e.message, 'err'); return false; }
  const errors = validateOverlay(parsed);
  if (errors.length) { setStatus($('#jsonStatus'), errors.join(' / '), 'err'); return false; }
  ov = normalizeOverlay(parsed);
  if (!keepForm) resetNodeForm();
  else if (editingId && !(ov.nodes || []).some(n => n.id === editingId)) editingId = null;
  renderOverlayEditor();
  markDirty();
  setStatus($('#jsonStatus'), '폼에 반영했어요.', 'ok');
  return true;
}
$('#applyJson').addEventListener('click', () => applyJsonBox());
const jsonBoxChanged = () => $('#overlay').value !== JSON.stringify(ov, null, 2);

function showSaveErrors(errors) {
  const ul = $('#overlayErrors');
  ul.replaceChildren(...errors.map(e => el('li', { text: e })));
  ul.hidden = !errors.length;
}

$('#saveOverlay').addEventListener('click', () => saveOverlayNow());
// 저장 버튼과 AI 초안이 같이 쓴다. 저장했으면 true
async function saveOverlayNow() {
  if (!ov) return false;
  // 고급 JSON을 고치고 "JSON 적용"을 안 눌렀으면 같은 길로 먼저 적용한다. 실패하면 저장하지 않는다
  if (jsonBoxChanged() && !applyJsonBox({ keepForm: true })) {
    $('#advanced').open = true;
    setStatus($('#overlayStatus'), '저장하지 않았어요. 고급 JSON 오류를 고쳐 주세요.', 'err');
    return false;
  }
  // 폼에 적다 만 노드가 있으면 먼저 넣는다. 오류면 저장하지 않는다
  if (formHasInput() && !applyNodeForm()) { setStatus($('#overlayStatus'), '노드 입력을 먼저 고쳐 주세요.', 'err'); return false; }
  const errors = validateOverlay(ov);
  if (errors.length) { showSaveErrors(errors); setStatus($('#overlayStatus'), '저장하지 않았어요. 아래 오류를 고쳐 주세요.', 'err'); return false; }
  try {
    // feedbackBoosts는 폼이 고치지 않는다. 편집하는 동안 👎로 바뀌었을 수 있으니 저장 직전 값을 쓴다
    const fresh = await send('overlay:get');
    const r = await send('overlay:save', { overlay: { ...ov, feedbackBoosts: fresh.feedbackBoosts || {} } });
    if (!r.ok) { showSaveErrors(r.errors || []); setStatus($('#overlayStatus'), '저장하지 않았어요. 아래 오류를 고쳐 주세요.', 'err'); return false; }
  } catch (e) { setStatus($('#overlayStatus'), e.message, 'err'); return false; }
  showSaveErrors([]);
  setStatus($('#overlayStatus'), '저장했어요. 새 노드는 다음 검색 때 벡터로 바뀌어요.', 'ok');
  setStatus($('#jsonStatus'), '');
  await loadStore();
  return true;
}

/* ───────── AI 초안 (T-301) ─────────
   background graph:draft(기존 제공자 체인 한 번) → 검수 대기 노드를 ov에 더하고 바로 저장한다(초안을 잃지 않게).
   새 관심사로 시작이면 useCommon false·domain·analogyPrefix도 함께. 기존 내 노드는 지우지 않는다(더하기만) */
$('#draftRun').addEventListener('click', async () => {
  if (!ov) return;
  const status = $('#draftStatus');
  const droppedList = $('#draftDropped');
  const name = validDraftName($('#draftName').value);
  if (!name) return setStatus(status, `관심사 이름을 1~${DRAFT_LIMITS.name}자로 적어 주세요.`, 'err');
  const mode = document.querySelector('input[name=draftMode]:checked')?.value === 'new' ? 'new' : 'add';
  const existing = (ov.nodes || []).length;
  if (mode === 'new' && existing && !confirm(`기존 내 노드 ${existing}개가 있어요. 초안을 더할까요?`)) {
    return setStatus(status, '초안 만들기를 그만뒀어요.');
  }
  $('#draftRun').disabled = true;
  droppedList.hidden = true;
  setStatus(status, 'AI가 초안을 만드는 중이에요…');
  try {
    const r = await send('graph:draft', { name, mode });
    droppedList.replaceChildren(...(r.dropped || []).map(d => el('li', { text: d.label ? `${d.label}: ${d.reason}` : d.reason })));
    droppedList.hidden = !(r.dropped || []).length;
    if (!r.nodes.length) return setStatus(status, r.error || '쓸 수 있는 초안이 없어요. 이름을 바꿔 다시 해 보세요.', 'err');
    // 그사이 다른 곳에서 노드가 생겼을 수 있어 id가 겹치면 그 노드만 뺀다
    const taken = new Set((ov.nodes || []).map(n => n.id));
    const fresh = r.nodes.filter(n => !taken.has(n.id));
    if (mode === 'new') ov = startNewInterest(ov, r.name);
    ov = addDraftNodes(ov, fresh);
    renderOverlayEditor();
    markDirty();
    const few = fresh.length < DRAFT_LIMITS.min ? ` AI가 만든 초안이 ${DRAFT_LIMITS.min}개보다 적어요.` : '';
    if (await saveOverlayNow()) setStatus(status, `초안 ${fresh.length}개를 검수 대기에 넣고 저장했어요. 사실을 하나씩 확인해 주세요.${few}`, 'ok');
    else setStatus(status, '초안을 저장하지 못했어요. 아래 저장 버튼 옆 문구를 확인해 주세요.', 'err');
  } catch (e) {
    setStatus(status, e.message, 'err');
  } finally {
    $('#draftRun').disabled = false;
  }
});

/* ───────── 임베딩 ───────── */
let pollTimer = null;
async function pollEmbed() {
  const st = await send('embed:status').catch(() => null);
  if (!st) return;
  const text = {
    idle: '아직 준비 전이에요.',
    loading: `모델 받는 중… ${Math.round((st.progress || 0) * 100)}%`,
    ready: `준비 완료 (${st.embedderId})`,
    fallback: `대체 검색 사용 중 (${st.embedderId})${st.error ? ' · 모델 로드 실패: ' + st.error : ''}`,
    error: '오류: ' + st.error
  }[st.status] || st.status;
  setStatus($('#embedStatus'), text, st.status === 'ready' ? 'ok' : st.status === 'loading' ? '' : st.status === 'idle' ? '' : 'warn');
  if (st.status !== 'loading') { clearInterval(pollTimer); pollTimer = null; }
}
$('#warmup').addEventListener('click', async () => {
  setStatus($('#embedStatus'), '준비 중…');
  if (!pollTimer) pollTimer = setInterval(pollEmbed, 700);
  try {
    const r = await send('embed:warmup');
    setStatus($('#embedStatus'), `준비 완료 · 벡터 ${r.vectors}개 · ${r.embedderId}`, r.status === 'ready' ? 'ok' : 'warn');
  } catch (e) { setStatus($('#embedStatus'), e.message, 'err'); }
  clearInterval(pollTimer); pollTimer = null;
});
$('#clearCache').addEventListener('click', async () => { await send('cache:clear'); setStatus($('#embedStatus'), '벡터·결과 캐시를 비웠어요.', 'ok'); });

/* ───────── 시험해 보기 ───────── */
$('#tryRun').addEventListener('click', async () => {
  const sentence = $('#trySentence').value.trim();
  if (!sentence) return;
  setStatus($('#tryStatus'), '만드는 중… (처음엔 모델을 받느라 오래 걸려요)');
  if (!pollTimer) pollTimer = setInterval(pollEmbed, 700);
  $('#tryOut').innerHTML = '';
  try {
    const r = await send('explain', { sentence, word: '', context: '', pageTitle: '설정 페이지 테스트', noCache: true });
    setStatus($('#tryStatus'), `${r.debug.ms}ms · ${r.debug.provider} · ${r.debug.embedderId}`, 'ok');
    const max = Math.max(...r.debug.candidates.map(c => c.score), 0.0001);
    $('#tryOut').innerHTML = `
      <div class="result">
        ${r.meaning ? `<div class="l">쉬운 뜻</div><div style="margin-bottom:8px">${esc(r.meaning)}</div>` : ''}
        <div class="l">${esc(r.domain)}에 빗대면</div>
        <div class="a">${esc(r.analogy || r.rejected || '딱 맞는 비유를 찾지 못했어요.')}</div>
        ${r.evidence ? `<div class="m" style="margin-top:6px">근거: ${esc(r.evidence.nodeLabel)} · ${esc(r.evidence.tagLabel || '')}${r.mapping ? ' · ' + esc(r.mapping) : ''}</div>` : ''}
      </div>
      ${r.debug.abstractText ? `<p class="hint">정밀 모드 추상화: ${esc(r.debug.abstractText)}</p>` : ''}
      <table>
        <thead><tr><th>검색 후보</th><th>맞은 태그</th><th>종합</th><th>직접</th><th>태그</th><th style="width:30%"></th></tr></thead>
        <tbody>${r.debug.candidates.map(c => `
          <tr><td>${esc(c.label)} ${c.source === 'user' ? '<span class="badge rare">내 것</span>' : ''}</td><td>${esc(c.tag || '')}</td>
          <td class="num">${c.score.toFixed(3)}</td><td class="num">${c.direct.toFixed(3)}</td><td class="num">${(c.tagSim ?? 0).toFixed(3)}</td>
          <td><div class="bar" style="width:${Math.round(c.score / max * 100)}%"></div></td></tr>`).join('')}
        </tbody>
      </table>
      <p class="hint">문장과 가까운 추상 태그: ${r.debug.topTags.map(t => `${esc(t.label)} ${t.sim.toFixed(3)}`).join(' · ')}</p>`;
  } catch (e) { setStatus($('#tryStatus'), e.message, 'err'); }
  clearInterval(pollTimer); pollTimer = null;
});

/* ───────── 내 피드백 (T-132) ───────── */
const VOTE_MARK = { up: '👍', down: '👎', pick: '교정' };
let fbItems = [];
const clip = (s, n = 40) => { const cs = [...String(s ?? '')]; return cs.length > n ? cs.slice(0, n).join('') + '…' : cs.join(''); };

function renderSharePreview() {
  const on = $('#fbShare').checked;
  $('#fbSharePreview').hidden = !on;
  $('#fbSharePreview').textContent = fbItems.length ? '이렇게 가려서 보내요: ' + fbItems[0].masked : '보낼 피드백이 아직 없어요.';
}

// 목록·통계를 읽어 그린다. 읽기만 하고 저장하지 않는다(storage.onChanged 갱신이 루프를 만들지 않게).
// 여러 번 겹쳐 불려도 마지막 요청 결과만 그린다. 읽기가 실패하면 이전 목록을 그대로 두고 던진다
let fbLoadSeq = 0;
let fbSharePending = false; // 보내기 토글 저장 중
async function loadFeedback() {
  const seq = ++fbLoadSeq;
  const [list, st] = await Promise.all([send('feedback:list'), send('feedback:stats')]);
  if (seq !== fbLoadSeq) return;
  fbItems = list.items;
  $('#fbStats').textContent = formatFeedbackStats(st);
  $('#fbList').innerHTML = fbItems.map(it => {
    // 라벨이 없으면(고른 개념 없음 등) 날짜만. 구분점이 홀로 남지 않게
    const meta = [it.vote === 'pick' ? it.pickedLabel : it.nodeLabel, localDay(it.ts)].filter(Boolean).join(' · ');
    return `
    <li data-id="${esc(it.id)}">
      <span class="fb-vote v-${esc(it.vote)}">${esc(VOTE_MARK[it.vote] || it.vote)}</span>
      <span class="fb-text"><span class="fb-sentence" title="${esc(it.sentence)}">${esc(clip(it.sentence))}</span>
        <span class="hint">${esc(meta)}</span></span>
      <button class="fb-undo">되돌리기</button>
    </li>`;
  }).join('');
  // 빈 목록 안내는 목록 밖 문단으로(접근성)
  $('#fbList').hidden = !fbItems.length;
  $('#fbEmpty').hidden = !!fbItems.length;
  if (!fbSharePending) $('#fbShare').checked = list.share; // 저장 중이면 누른 값을 덮지 않는다
  renderSharePreview();
  $('#fbExport').disabled = !fbItems.length;
  $('#fbCorrections').disabled = !fbItems.length;
  $('#fbClear').disabled = !fbItems.length;
}
// 되돌리기·지우기 뒤 다시 읽기. 실패하면 이전 목록을 두고 오류 문구
const reloadFeedback = () => loadFeedback().catch(() => setStatus($('#fbStatus'), '목록을 다시 읽지 못했어요.', 'err'));

// 다른 탭에서 남긴 피드백·호버도 열린 화면에 반영한다. loadFeedback은 읽기만 해서 다시 이벤트가 나지 않는다.
// 호버가 이어질 때 매번 읽지 않게 짧게 모아서 한 번만 읽는다
let fbChangeTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.feedback || changes.hoverCounts)) return;
  clearTimeout(fbChangeTimer);
  fbChangeTimer = setTimeout(reloadFeedback, 150);
});

$('#fbList').addEventListener('click', async e => {
  const li = e.target.closest('.fb-undo')?.closest('li');
  if (!li) return;
  try { await send('feedback-undo', { id: li.dataset.id }); setStatus($('#fbStatus'), '되돌렸어요.', 'ok'); }
  catch (err) { setStatus($('#fbStatus'), err.message, 'err'); }
  await reloadFeedback();
});

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 목록 응답의 items 배열을 그대로 파일로
$('#fbExport').addEventListener('click', () => downloadJson(fbItems, `good-metaphor-feedback-${localDay(Date.now())}.json`));

// 운영자용 교정 내보내기(T-131). 공통 노드·공통 태그 대상만, 문장은 가린 것만. 로컬 파일로만 받는다
$('#fbCorrections').addEventListener('click', async () => {
  try {
    const data = await send('corrections:export');
    downloadJson(data, `good-metaphor-corrections-${localDay(Date.now())}.json`);
    const n = data.exampleCandidates.length;
    setStatus($('#fbStatus'), n ? `예문 후보 ${n}개를 내보냈어요.` : '공통 그래프 교정이 아직 없어요. 빈 파일을 내보냈어요.', 'ok');
  } catch (err) { setStatus($('#fbStatus'), err.message, 'err'); }
});

$('#fbClear').addEventListener('click', async () => {
  if (!confirm('남긴 피드백을 모두 지울까요? 되돌릴 수 없어요.')) return;
  try { await send('feedback:clear'); setStatus($('#fbStatus'), '모두 지웠어요.', 'ok'); }
  catch (err) { setStatus($('#fbStatus'), err.message, 'err'); }
  await reloadFeedback();
});

$('#fbShare').addEventListener('change', async () => {
  const on = $('#fbShare').checked;
  renderSharePreview();
  fbSharePending = true;
  try { state.settings = await send('settings:save', { patch: { feedbackShare: on } }); }
  catch {
    // 저장하지 못했으면 체크를 되돌린다
    $('#fbShare').checked = !on;
    renderSharePreview();
    setStatus($('#fbStatus'), '저장하지 못했어요. 다시 시도해 주세요.', 'err');
  } finally { fbSharePending = false; }
});

/* ───────── 초기화 ───────── */
(async function init() {
  state = await send('settings:get');
  renderTrigger(state.settings);
  renderSites(state.settings.excludedHosts);
  initOnboarding();

  const allowed = state.admin.allowedProviders || Object.keys(state.providers);
  $('#provider').innerHTML = allowed.filter(id => state.providers[id])
    .map(id => `<option value="${id}">${esc(state.providers[id].label)}</option>`).join('');
  $('#provider').value = state.active.id;
  fillProvider(state.active.id);
  if (state.active.locked) {
    $('#lockedNote').hidden = false;
    $('#provider').disabled = true;
    $('#model').disabled = true;
  }
  loadFeedback().catch(e => setStatus($('#fbStatus'), '피드백을 불러오지 못했어요: ' + e.message, 'err'));
  await loadStore().catch(e => { $('#commonTitle').textContent = '불러오기 실패: ' + e.message; });
  pollEmbed();
})();
