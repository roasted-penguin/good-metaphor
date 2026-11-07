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

(async () => {
  const st = await send('settings:get');
  await initSiteToggle(st.settings);
  const s = st.settings;
  $('#enabled').checked = s.enabled;
  $('#howto').innerHTML = s.triggerMode === 'modifier'
    ? `<kbd>${KEY[s.modifierKey]}</kbd> 누른 채 모르는 문장에 커서를 올리세요.`
    : `모르는 문장 위에 커서를 ${(s.dwellMs / 1000).toFixed(1)}초 올려 두세요.`;
  $('#provider').textContent = `${st.providers[st.active.id].label.split(' (')[0]} · ${st.active.model}${st.active.hasKey || st.providers[st.active.id].keyOptional ? '' : ' (키 없음)'}`;
  const info = await send('graph:info');
  $('#domain').textContent = `${info.merged.domain} · 노드 ${info.merged.nodes}개`;
  $('#account').textContent = info.session ? `${info.session.name} (내 노드 ${info.merged.userNodes})` : '로그인 안 함 · 공통 저장소';
})().catch(e => { $('#howto').textContent = e.message; });

$('#enabled').addEventListener('change', e => send('settings:save', { patch: { enabled: e.target.checked } }));
// 저장하면 열린 탭의 content.js가 storage 변경으로 바로 꺼지거나 켜진다
$('#siteOff').addEventListener('change', async e => {
  if (!siteHost) return;
  const want = e.target.checked;
  const { settings } = await send('settings:get'); // 다른 곳에서 바뀌었을 수 있어 최신 목록으로
  const list = settings.excludedHosts || [];
  if (SF.isExcludedHost(siteHost, list) === want) return;
  await send('settings:save', { patch: { excludedHosts: SF.toggleHost(list, siteHost) } });
});
$('#open').addEventListener('click', () => chrome.runtime.openOptionsPage());
