import './lib/site-filter.js'; // globalThis.AnalogySiteFilter (콘텐츠 스크립트와 같은 파일)

const SF = globalThis.AnalogySiteFilter;
const send = (type, extra = {}) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ type, ...extra }, r => r?.ok ? resolve(r.data) : reject(new Error(r?.error || chrome.runtime.lastError?.message))));
const $ = s => document.querySelector(s);
const KEY = { Alt: 'Alt(Option)', Shift: 'Shift', Control: 'Ctrl', Meta: 'Cmd/Win' };

// "이 사이트에서 끄기"(T-107): 체크 = 현재 탭 호스트가 제외 목록에 있음.
// 탭 주소는 activeTab(팝업을 연 순간 그 탭만)으로 읽는다. http(s)가 아니면 쓸 수 없다
let siteHost = '';
async function initSiteToggle(settings) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const url = tab?.url || '';
  siteHost = /^https?:/i.test(url) ? SF.normalizeHost(url) : '';
  if (!siteHost) {
    $('#siteOff').disabled = true;
    $('#siteHost').textContent = '이 페이지에서는 쓸 수 없어요.';
    return;
  }
  $('#siteOff').disabled = false;
  $('#siteOff').checked = SF.isExcludedHost(siteHost, settings.excludedHosts);
  $('#siteHost').textContent = siteHost;
  $('#siteHost').title = siteHost;
}

// 공통 관심사(T-302): 저장된 값을 라디오에 그린다. 모르는 값이면 메이플(로더와 같게)
function renderInterest(id) {
  const r = document.querySelector(`input[name=interest][value="${id}"]`) || document.querySelector('input[name=interest][value=maplestory]');
  r.checked = true;
}
// 지금 쓰는 그래프(병합 결과) 줄과 계정 줄. 관심사를 바꾸면 다시 그린다
async function renderGraph() {
  const info = await send('graph:info');
  $('#domain').textContent = `${info.merged.domain} · 노드 ${info.merged.nodes}개`;
  $('#account').textContent = info.session ? `${info.session.name} (내 노드 ${info.merged.userNodes})` : '로그인 안 함 · 공통 저장소';
  // 로그인해 내 관심사만 쓰면(useCommon false) 공통 관심사 선택은 검색에 쓰이지 않는다
  $('#interestNote').hidden = info.merged.usesCommon;
}

(async () => {
  const st = await send('settings:get');
  renderInterest(st.settings.interest);
  await initSiteToggle(st.settings);
  const s = st.settings;
  $('#enabled').checked = s.enabled;
  $('#howto').innerHTML = s.triggerMode === 'modifier'
    ? `<kbd>${KEY[s.modifierKey]}</kbd> 누른 채 모르는 문장에 커서를 올리세요.`
    : `모르는 문장 위에 커서를 ${(s.dwellMs / 1000).toFixed(1)}초 올려 두세요.`;
  $('#provider').textContent = `${st.providers[st.active.id].label.split(' (')[0]} · ${st.active.model}${st.active.hasKey || st.providers[st.active.id].keyOptional ? '' : ' (키 없음)'}`;
  await renderGraph();
})().catch(e => { $('#howto').textContent = e.message; });

$('#enabled').addEventListener('change', e => send('settings:save', { patch: { enabled: e.target.checked } }));
// 저장하면 열린 탭의 content.js가 storage 변경으로 바로 꺼지거나 켜진다
$('#siteOff').addEventListener('change', async e => {
  if (!siteHost) return;
  const want = e.target.checked;
  try {
    const { settings } = await send('settings:get'); // 다른 곳에서 바뀌었을 수 있어 최신 목록으로
    const list = settings.excludedHosts || [];
    if (SF.isExcludedHost(siteHost, list) === want) return;
    await send('settings:save', { patch: { excludedHosts: SF.toggleHost(list, siteHost) } });
  } catch (err) {
    // 저장 못 했으면 체크를 되돌리고, 팝업이 오류를 보이는 자리(#howto)에 알린다
    e.target.checked = !want;
    $('#howto').textContent = `사이트 설정을 저장하지 못했어요. ${err?.message || ''}`.trim();
  }
});
document.querySelectorAll('input[name=interest]').forEach(r => r.addEventListener('change', async e => {
  try {
    await send('settings:save', { patch: { interest: e.target.value } });
    await renderGraph();
  } catch (err) {
    $('#howto').textContent = `관심사를 바꾸지 못했어요. ${err?.message || ''}`.trim();
  }
}));
// 설정 화면에서 바꿔도 열린 팝업에 반영한다(읽기만)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue?.interest || 'maplestory';
  if (document.querySelector('input[name=interest]:checked')?.value === next) return;
  renderInterest(next);
  renderGraph().catch(() => {});
});
$('#open').addEventListener('click', () => chrome.runtime.openOptionsPage());
