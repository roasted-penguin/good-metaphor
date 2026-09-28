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
    const ov = await send('overlay:get');
    $('#overlay').value = JSON.stringify(ov, null, 2);
    document.querySelector(`input[name=useCommon][value="${ov.useCommon !== false}"]`).checked = true;
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

document.querySelectorAll('input[name=useCommon]').forEach(r => r.addEventListener('change', () => {
  try {
    const ov = JSON.parse($('#overlay').value);
    ov.useCommon = r.value === 'true';
    if (!ov.useCommon && !ov.domain) { ov.domain = '내 관심사'; ov.analogyPrefix = '내 관심사로 치면'; }
    $('#overlay').value = JSON.stringify(ov, null, 2);
    setStatus($('#overlayStatus'), '바뀐 내용을 저장하세요.', 'warn');
  } catch { setStatus($('#overlayStatus'), 'JSON 형식을 먼저 고쳐 주세요.', 'err'); }
}));

$('#insertSample').addEventListener('click', () => {
  try {
    const ov = JSON.parse($('#overlay').value);
    ov.nodes = ov.nodes || [];
    if (!ov.nodes.some(n => n.id === 'u:my_routine')) {
      ov.nodes.push({
        id: 'u:my_routine',
        label: '내 아침 재획 루틴',
        facts: ['나는 출근 전 30분 동안 매일 같은 사냥터에서 재획을 한다.', '빠진 날이 생기면 주말에 몰아서 채우기 어렵다.'],
        tags: ['daily_accumulation', 'efficiency_metric']
      });
    }
    $('#overlay').value = JSON.stringify(ov, null, 2);
    setStatus($('#overlayStatus'), '예시를 넣었어요. 저장을 눌러야 반영돼요.', 'warn');
  } catch { setStatus($('#overlayStatus'), 'JSON 형식을 먼저 고쳐 주세요.', 'err'); }
});

$('#saveOverlay').addEventListener('click', async () => {
  let ov;
  try { ov = JSON.parse($('#overlay').value); } catch (e) { return setStatus($('#overlayStatus'), 'JSON 오류: ' + e.message, 'err'); }
  const r = await send('overlay:save', { overlay: ov }).catch(e => ({ ok: false, errors: [e.message] }));
  if (!r.ok) return setStatus($('#overlayStatus'), r.errors.join(' / '), 'err');
  setStatus($('#overlayStatus'), '저장했어요. 새 노드는 다음 검색 때 벡터로 바뀌어요.', 'ok');
  await loadStore();
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

/* ───────── 초기화 ───────── */
(async function init() {
  state = await send('settings:get');
  const s = state.settings;
  $('#enabled').checked = s.enabled;
  document.querySelector(`input[name=triggerMode][value="${s.triggerMode}"]`).checked = true;
  $('#modifierKey').value = s.modifierKey;
  $('#dwellMs').value = s.dwellMs;
  $('#preciseMode').checked = s.preciseMode;
  syncTriggerUI();

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
  await loadStore().catch(e => { $('#commonTitle').textContent = '불러오기 실패: ' + e.message; });
  pollEmbed();
})();
