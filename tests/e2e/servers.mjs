// e2e용 서버 세 개: 가짜 LLM(OpenAI 호환, :8765), 테스트 페이지(:8766), 가짜 analogy-api(:8767, T-404)
// 가짜 LLM은 stream:true 면 SSE로, meaning 까지 먼저 보내고 나머지는 STREAM_GAP_MS 뒤에 보낸다.
// "로딩지연테스트" 문장은 SLOW_MS 뒤에 답한다(로딩 상태 붙잡기).
// 모델이 'mock-busy'면 429(Retry-After 60)를 낸다(fallback 체인 확인용).
// 문장에 "Leverage"가 있으면 후보에 없는 nodeId 로 답한다(근거 검증 확인용)
// 정상 답에는 usedFact = 후보 [1]의 첫 fact 를 넣는다(T-123). 근거 검사 확인용 표시어:
//   "입장횟수테스트" → facts·문장에 없는 숫자를 쓴 비유, "사실조작테스트" → facts에 없는 usedFact
// 금칙어 필터 확인용(T-114, 금칙어는 테스트 코드 안에만): "금칙비유테스트" → 비유에 우회 표기한 금칙어,
//   "금칙뜻테스트" → 뜻(스트리밍으로 먼저 오는 부분)에 금칙어, "금칙추상테스트" → 정밀 모드 추상화 응답에 금칙어
export const BLOCKED_IN_ANALOGY = '리.선.족';
export const BLOCKED_IN_MEANING = '쌀 숭이';
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const calls = [];
export const analogyCalls = []; // 가짜 analogy-api 요청 기록 { headers, body }
export const STREAM_GAP_MS = 1500;
// 문장에 "로딩지연테스트"가 있으면 응답을 이만큼 늦춘다(로딩 말풍선을 붙잡아 두는 용도, T-108)
export const SLOW_MS = 2500;

function mockLLM(req, res) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const { messages, stream, model } = JSON.parse(body);
    const system = messages[0].content, user = messages.at(-1).content;
    calls.push({ system, user, model });
    if (model === 'mock-busy') {
      res.writeHead(429, { ...cors, 'content-type': 'application/json', 'retry-after': '60' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached (mock)' } }));
    }
    let content;
    if (system.includes('추상 구조로')) content = user.includes('금칙추상테스트') ? `${BLOCKED_IN_ANALOGY} 처럼 비용을 내고 시도하는 구조` : '비용을 내고 시도하면 결과가 확률에 따라 달라지는 구조';
    else if (user.includes('연결 성공')) content = '연결 성공';
    else {
      const [, id, label] = user.match(/\[1\] id=(\S+) \| (.+)/);
      const tag = user.match(/맞은 추상 태그: .+? \(id=(\S+)\)/);
      const nodeId = user.includes('Leverage') ? 'not-a-candidate' : id;
      const usedFact = user.match(/\[1\] id=[\s\S]*?facts:\n\s+- (.+)/)?.[1] ?? '';
      const meaning = user.includes('금칙뜻테스트') ? `${BLOCKED_IN_MEANING} 같은 뜻풀이예요.` : '테스트 뜻 풀이예요.';
      const answer = (analogy, fact = usedFact) => '```json\n' + JSON.stringify({ meaning, analogy, nodeId, tagId: tag?.[1] ?? null, usedFact: fact, mapping: `원문 ↔ ${label}` }) + '\n```';
      // "펭귄" 문장: 후보가 여럿이면 맞는 비유 없음, 사용자가 하나를 골라 후보가 1개면 그 개념으로 (T-106)
      if (user.includes('펭귄') && /\[2\] id=/.test(user)) content = '```json\n' + JSON.stringify({ meaning: '테스트 뜻 풀이예요.', analogy: '', nodeId: null, tagId: null, mapping: '' }) + '\n```';
      else if (user.includes('입장횟수테스트')) content = answer('메이플로 치면 일주일에 7번만 입장할 수 있는 것과 같아요.');
      else if (user.includes('금칙비유테스트')) content = answer(`메이플로 치면 ${label}과 같은 구조예요. ${BLOCKED_IN_ANALOGY}`);
      else if (user.includes('사실조작테스트')) content = answer('메이플로 치면 보스에 하루 세 번 들어가는 것과 같아요.', '보스는 하루에 세 번까지 입장할 수 있다.');
      else content = answer(`메이플로 치면 ${label}과 같은 구조예요.`);
    }
    const out = () => {
      if (stream) return streamOut(res, cors, content);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    if (user.includes('로딩지연테스트')) return void setTimeout(out, SLOW_MS);
    out();
  });
}

// meaning 값이 닫히는 곳까지 두 조각으로 먼저 보내고, 쉬었다가 나머지를 보낸다
function streamOut(res, cors, content) {
  res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
  const send = text => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  const cut = content.indexOf('",', content.indexOf('"meaning"')) + 2;
  const head = cut > 1 ? content.slice(0, cut) : content;
  send(head.slice(0, 12));
  send(head.slice(12));
  setTimeout(() => {
    if (cut > 1) send(content.slice(cut));
    res.end('data: [DONE]\n\n');
  }, cut > 1 ? STREAM_GAP_MS : 0);
}

// /frame.html·/masked.html 은 iframe 픽스처(T-111), 그 밖의 주소는 모두 테스트 페이지
const FIXTURES = { '/frame.html': './frame.html', '/masked.html': './masked.html' };
function staticPage(req, res) {
  const file = FIXTURES[new URL(req.url, 'http://x').pathname] ?? './page.html';
  // masked.html: 최상위를 불투명 출처(CSP sandbox, allow-same-origin 없음)·no-referrer 로 →
  // 그 안 iframe 의 ancestorOrigins 는 "null", referrer 는 빈 값(최상위를 모르는 프레임 재현)
  const masked = file === './masked.html' ? { 'content-security-policy': 'sandbox allow-scripts', 'referrer-policy': 'no-referrer' } : {};
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...masked });
  res.end(readFileSync(new URL(file, import.meta.url)));
}

// 가짜 analogy-api(T-404). 응답 모양은 server/app/pipeline.py 반환값과 같다.
// 문장에 표시어가 있을 때만 답한다. 그 밖의 문장(기존 e2e 문장 전부)은 500 → 확장이 로컬로 대체한다.
//   '서버정상' → 정상 결과(후보는 공통 그래프 실제 id), '서버후보밖' → 후보 밖 nodeId,
//   '서버지연' → SERVER_DELAY_MS 뒤 정상 결과(확장의 timeoutMs 보다 길게)
//   '서버금칙' → 비유에 금칙어가 섞인 결과(확장이 서버 결과도 금칙어 재검사하는지, T-114)
export const SERVER_DELAY_MS = 5000;
export const SERVER_ANALOGY = '서버가 만든 비유예요: 스타포스 강화와 같은 구조예요.';
function serverResult(nodeId) {
  return {
    meaning: '서버 뜻 풀이예요.',
    analogy: SERVER_ANALOGY,
    mapping: '원문 ↔ 스타포스 강화',
    rejected: null,
    evidence: nodeId === 'starforce' ? { nodeId: 'starforce', nodeLabel: '스타포스 강화', source: 'common', tagLabel: null } : { nodeId, nodeLabel: '없는 개념', source: 'common', tagLabel: null },
    domain: '메이플스토리',
    theme: 'maple',
    feedbackApplied: false,
    debug: {
      feedback: { excluded: [], pinned: null, similar: [] },
      candidates: [
        { id: 'starforce', label: '스타포스 강화', score: 0.8, direct: 0.8, tag: null, tagSim: null, source: 'common' },
        { id: 'cube', label: '잠재능력 재설정(큐브)', score: 0.7, direct: 0.7, tag: null, tagSim: null, source: 'common' },
        { id: 'meso', label: '메소', score: 0.6, direct: 0.6, tag: null, tagSim: null, source: 'common' }
      ],
      topTags: [], abstractText: null, embedderId: null, embedderStatus: null,
      provider: 'server/mock-analogy', fallbacks: [], llmRetries: 0, user: null,
      keywords: { hl: [], ll: [] }, ms: 5
    }
  };
}
function mockAnalogyApi(req, res) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    analogyCalls.push({ path: req.url, headers: req.headers, body });
    const sentence = String(body?.sentence || '');
    const send = result => {
      if (res.destroyed) return;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    };
    if (req.url !== '/v1/analogy') { res.writeHead(404, cors); return res.end(); }
    if (sentence.includes('서버정상')) return send(serverResult('starforce'));
    if (sentence.includes('서버후보밖')) return send(serverResult('not-a-candidate'));
    if (sentence.includes('서버금칙')) return send({ ...serverResult('starforce'), analogy: `${SERVER_ANALOGY} ${BLOCKED_IN_ANALOGY}` });
    if (sentence.includes('서버지연')) return void setTimeout(() => send(serverResult('starforce')), SERVER_DELAY_MS);
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'mock error' }));
  });
}

export async function startServers() {
  const servers = [
    http.createServer(mockLLM).listen(8765, '127.0.0.1'),
    http.createServer(staticPage).listen(8766, '127.0.0.1'),
    http.createServer(mockAnalogyApi).listen(8767, '127.0.0.1')
  ];
  await Promise.all(servers.map(s => new Promise((r, j) => { s.once('listening', r); s.once('error', j); })));
  // 지연 응답 중인 연결이 닫기를 막지 않게 한다
  return () => Promise.all(servers.map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r); })));
}
