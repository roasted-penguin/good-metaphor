const send = (type, extra = {}) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ type, ...extra }, r => r?.ok ? resolve(r.data) : reject(new Error(r?.error || chrome.runtime.lastError?.message))));
const $ = s => document.querySelector(s);
const KEY = { Alt: 'Alt(Option)', Shift: 'Shift', Control: 'Ctrl', Meta: 'Cmd/Win' };

(async () => {
  const st = await send('settings:get');
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
$('#open').addEventListener('click', () => chrome.runtime.openOptionsPage());
