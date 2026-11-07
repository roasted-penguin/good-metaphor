// 테스트 전용 콘텐츠 스크립트(T-144). e2e 확장 사본(.tmp/ext-e2e)에만 들어간다(scripts/prepare-e2e.mjs).
// 실제 extension/ 에는 절대 넣지 않는다(규칙 4, 배포물에 테스트 코드 금지).
// content.js의 제외 판정을 거치지 않고 background에 바로 보내, background 이중 방어를 확인하는 데 쓴다.
// 페이지: window.postMessage({ __e2eHook: 'explain-port' | 'explain-msg' | 'feedback', id, payload })
// 응답:   window.postMessage({ __e2eHookResult: { id, kind, ok, type?, error?, result?, data?, stages? } })
(() => {
  const reply = r => window.postMessage({ __e2eHookResult: r }, '*');

  function viaPort(id, payload) {
    const port = chrome.runtime.connect({ name: 'explain' });
    const stages = [];
    const stageThemes = []; // stage 메시지마다 실린 theme (T-108)
    port.onMessage.addListener(m => {
      if (m.type === 'stage') stageThemes.push(m.theme ?? null);
      if (m.type === 'stage' || m.type === 'partial') { stages.push(m.type === 'stage' ? m.stage : 'partial'); return; }
      if (m.type === 'result' || m.type === 'error') {
        reply({ id, kind: 'explain-port', ok: m.type === 'result', type: m.type, error: m.error ?? null, result: m.result ?? null, stages, stageThemes });
        port.disconnect();
      }
    });
    port.postMessage({ type: 'explain', id: 1, payload });
  }

  function viaMessage(id, kind, msg) {
    chrome.runtime.sendMessage(msg, res => {
      const err = chrome.runtime.lastError?.message;
      reply({ id, kind, ok: !!res?.ok, error: res?.error ?? err ?? null, data: res?.data ?? null });
    });
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || typeof e.data.__e2eHook !== 'string') return;
    const { __e2eHook: kind, id, payload } = e.data;
    if (kind === 'explain-port') viaPort(id, payload);
    else if (kind === 'explain-msg') viaMessage(id, kind, { type: 'explain', ...payload });
    else if (kind === 'feedback') viaMessage(id, kind, {
      type: 'feedback',
      record: { sentence: payload.sentence, provider: 'e2e', nodeId: 'starforce', tagId: null, vote: 'down' },
      rerun: payload
    });
  });
})();
