// e2e용 서버 세 개: 가짜 LLM(OpenAI 호환, :8765), 테스트 페이지(:8766), 가짜 analogy-api(:8767, T-404)
// 가짜 LLM은 stream:true 면 SSE로, meaning 까지 먼저 보내고 나머지는 STREAM_GAP_MS 뒤에 보낸다.
// "로딩지연테스트" 문장은 SLOW_MS 뒤에 답한다(로딩 상태 붙잡기).
// 모델이 'mock-busy'면 429(Retry-After 60)를 낸다(fallback 체인 확인용).
// 문장에 "Leverage"가 있으면 후보에 없는 nodeId 로 답한다(근거 검증 확인용)
// 정상 답에는 usedFact = 후보 [1]의 첫 fact 를 넣는다(T-123). 근거 검사 확인용 표시어:
//   "입장횟수테스트" → facts·문장에 없는 숫자를 쓴 비유, "사실조작테스트" → facts에 없는 usedFact
// 끝맺음 검사 확인용(T-122): "끝맺음교정테스트" → 첫 답만 "~입니다", "끝맺음고집테스트" → 다시 불러도 "~입니다"
// 금칙어 필터 확인용(T-114, 금칙어는 테스트 코드 안에만): "금칙비유테스트" → 비유에 우회 표기한 금칙어,
//   "금칙뜻테스트" → 뜻(스트리밍으로 먼저 오는 부분)에 금칙어, "금칙추상테스트" → 정밀 모드 추상화 응답에 금칙어
// 비유 문구는 시스템 프롬프트의 analogyPrefix("4. analogy는 "…" 문구로 시작")를 따른다(T-302, 관심사별 말머리 확인용)
// AI 초안(T-301): 시스템 프롬프트가 "개념 노드 목록으로 정리"면 DRAFT_NODES 를 코드블록 JSON으로 답한다.
//   쓸 수 있는 노드 4개(숫자 경고 1) + 목록 밖 태그만 있는 노드 1(버림) + 금칙어 사실 1개가 섞인 노드(그 사실만 버림)
// 이어 묻기 에이전트(T-216): 시스템 프롬프트가 "이어서 묻는 질문"이면 JSON 액션으로 답한다(agentReply).
//   첫 차례: 질문에 "다른"이 있으면 search_graph(근거 개념 제외), 아니면 get_node_facts(근거 개념).
//   관찰이 있으면 그 결과 첫 노드의 첫 fact로 final. 질문에 "후보밖테스트"면 첫 차례에 후보 밖(그래프에는 있는) 노드로 final(규칙 1)
// 👎 교정 진단 에이전트(T-220): 시스템 프롬프트가 "왜 틀렸는지 진단"이면 JSON 액션으로 답한다(diagnoseReply).
//   첫 차례: 후보 개념이 있으면 첫 후보로 get_node_facts, 없으면 search_graph(쓰지 말 개념 제외).
//   관찰이 있으면 cause "structure" + 그 노드 첫 fact로 새 비유 final. 문장에 "후보밖진단테스트"면 매번 후보 밖 노드로 final(검증기가 숨김)
// 새 관심사 도우미(T-225): 시스템 프롬프트 표시어(HELPER_MARK)로 계획·초안·평가·고쳐 쓰기에 답한다(helperReply).
//   계획(첫 바퀴): HELPER_CONCEPTS + skip vendor_lock_in, 다음 바퀴는 빈 목록 + 같은 skip(두 번 skip이라 없음, T-226). 초안: 개념 이름별 HELPER_FACTS("경기 시간"은 숫자 사실 → 코드가 고쳐 쓰기로).
//   평가: "억지 태그 개념"만 태그 no. 고쳐 쓰기: "억지 태그 개념"은 drop, 그 밖은 숫자 없는 사실.
//   관심사가 "도우미지연테스트"면 응답마다 HELPER_SLOW_MS 늦춘다(서비스 워커를 멈췄다 이어 가는 시험)
export const BLOCKED_IN_ANALOGY = '리.선.족';
export const BLOCKED_IN_MEANING = '쌀 숭이';
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const DRAFT_NODES = [
  { label: '오프사이드 규칙', facts: ['공격수가 마지막 수비수보다 앞에서 공을 받으면 오프사이드 반칙이다.', '오프사이드는 부심이 깃발로 알린다.'], tags: ['threshold_req'] },
  { label: '이적 시장', facts: ['인기 축구 선수는 데려가려는 구단이 몰려 이적료가 치솟는다.'], tags: ['market_price', 'scarcity_value'] },
  { label: '경기 시간', facts: ['한 경기는 전후반 90분이다.'], tags: ['periodic_cap'] },
  { label: '없는 태그 개념', facts: ['목록 밖 태그만 붙은 개념이다.'], tags: ['made_up_tag'] },
  { label: '금칙 사실 개념', facts: [`${BLOCKED_IN_ANALOGY}는 쓰면 안 되는 말이다.`, '이 사실은 남는다.'], tags: ['role_division', 'made_up_tag'] }
];

export const HELPER_CONCEPTS = [['오프사이드', 'threshold_req'], ['이적 시장', 'market_price'], ['억지 태그 개념', 'prob_upgrade'], ['경기 시간', 'periodic_cap']];
export const HELPER_FACTS = {
  '오프사이드': { facts: ['공격수가 마지막 수비수보다 앞에서 공을 받으면 반칙이 된다.'], tags: ['threshold_req'], source: 'https://example.com/laws' },
  '이적 시장': { facts: ['인기 선수는 데려가려는 구단이 몰릴수록 몸값이 오른다.'], tags: ['market_price', 'scarcity_value'] },
  '억지 태그 개념': { facts: ['선수들은 경기 전에 몸을 푼다.'], tags: ['prob_upgrade'] },
  '경기 시간': { facts: ['한 경기는 전후반 90분 동안 한다.'], tags: ['periodic_cap'] }
};
export const HELPER_FIXED_FACT = '한 경기는 정해진 시간이 끝나면 더 뛰지 않는다.';
export const HELPER_SLOW_MS = 1500;
function helperReply(system, user) {
  const out = o => JSON.stringify(o);
  const blocks = () => user.split('\n[노드] ').slice(1).map(b => ({ id: b.match(/^id=(\S+)/)[1], label: b.match(/^id=\S+ \| (.+)/)[1], tags: [...b.matchAll(/^  태그 (\S+) \|/gm)].map(m => m[1]) }));
  if (system.includes('개념 목록을 계획하는 도우미')) {
    const first = user.includes('개념 수: 많아야 10개'); // 첫 바퀴(firstPlan)만 개념을 낸다
    return out(first ? { concepts: HELPER_CONCEPTS.map(([label, tag]) => ({ label, tag, why: '팬이면 다 알아요' })), skip: ['vendor_lock_in'] } : { concepts: [], skip: ['vendor_lock_in'] });
  }
  if (system.includes('계획한 개념마다 노드 초안을 쓰는 도우미')) {
    const labels = [...user.matchAll(/^- (.+?) \| 태그 /gm)].map(m => m[1]);
    return '```json\n' + out({ nodes: labels.map(l => ({ label: l, ...(HELPER_FACTS[l] || { facts: [`${l}은 연습할수록 는다.`], tags: ['daily_accumulation'] }) })) }) + '\n```';
  }
  if (system.includes('초안 노드를 검사하는 도우미')) {
    return out({ nodes: blocks().map(b => ({ id: b.id, tags: b.tags.map(t => ({ id: t, verdict: b.label === '억지 태그 개념' ? 'no' : 'yes', reason: '판정' })), familiar: 'yes', named: 'no', reason: '' })) });
  }
  if (system.includes('검사에 걸린 노드를 고쳐 쓰는 도우미')) {
    return out({ nodes: blocks().map(b => b.label === '억지 태그 개념'
      ? { id: b.id, drop: true, reason: '이 관심사에는 이 구조가 없어요.' }
      : { id: b.id, label: b.label, facts: b.label === '경기 시간' ? [HELPER_FIXED_FACT] : HELPER_FACTS[b.label]?.facts || ['고친 사실이 생기면 달라진다.'], tags: HELPER_FACTS[b.label]?.tags || ['threshold_req'] }) });
  }
  return null;
}

export const calls = [];
// 후보 밖 final용: 그래프에 있는 노드 중 프롬프트 후보에 없는 첫 노드(T-216)
const OUTSIDE_IDS = ['level_exp', 'quick_pass', 'trait', 'profession'];
function agentReply(user) {
  const out = o => JSON.stringify(o);
  const q = user.match(/질문: (.+)/)?.[1] || '';
  const ev = user.match(/근거 개념: id=(\S+)/)?.[1] || user.match(/- id=(\S+) \|/)?.[1] || null;
  const sentence = user.match(/설명할 문장: (.+)/)?.[1] || '';
  if (q.includes('후보밖테스트')) {
    const id = OUTSIDE_IDS.find(x => !user.includes(`id=${x} `));
    return out({ final: { answer: '레벨이 오를수록 더 많이 필요한 것과 같아요.', nodeId: id, usedFact: '' } });
  }
  const results = [...user.matchAll(/결과: (.+)/g)].map(m => m[1]);
  if (!results.length) {
    return q.includes('다른')
      ? out({ action: 'search_graph', args: { text: sentence, exclude: ev ? [ev] : [] } })
      : out({ action: 'get_node_facts', args: { nodeId: ev } });
  }
  const last = results.at(-1);
  const id = last.match(/"id":"([^"]+)","label":"([^"]+)"/);
  const fact = last.match(/"facts":\["((?:[^"\\]|\\.)*)"/)?.[1];
  if (!id || !fact) return out({ final: { answer: '딱 맞는 다른 개념은 없어요.', nodeId: null, usedFact: '' } });
  return out({ final: { answer: `${id[2]}도 같은 구조라서 비슷해요.`, nodeId: id[1], usedFact: JSON.parse(`"${fact}"`) } });
}
function diagnoseReply(system, user) {
  const out = o => JSON.stringify(o);
  const sentence = user.match(/설명할 문장: (.+)/)?.[1] || '';
  const prefix = system.match(/answer는 "([^"]+)"로 시작/)?.[1] ?? '메이플로 치면';
  if (sentence.includes('후보밖진단테스트')) {
    const id = OUTSIDE_IDS.find(x => !user.includes(`id=${x} `));
    return out({ final: { diagnosis: { cause: 'structure' }, answer: `${prefix} 레벨이 오를수록 더 많이 필요한 것과 같아요.`, nodeId: id, usedFact: '' } });
  }
  const results = [...user.matchAll(/결과: (.+)/g)].map(m => m[1]).filter(r => !r.startsWith('[검증 실패]'));
  if (!results.length) {
    const first = user.match(/후보 개념:\n- id=(\S+) \|/)?.[1];
    const ex = [...(user.match(/쓰지 말 개념: (.+)/)?.[1] || '').matchAll(/id=([^\s,|]+)/g)].map(m => m[1]);
    return first ? out({ action: 'get_node_facts', args: { nodeId: first } }) : out({ action: 'search_graph', args: { text: sentence, exclude: ex } });
  }
  const last = results.at(-1);
  const id = last.match(/"id":"([^"]+)","label":"([^"]+)"/);
  const fact = last.match(/"facts":\["((?:[^"\\]|\\.)*)"/)?.[1];
  if (!id || !fact) return out({ final: { diagnosis: { cause: 'none' }, answer: '', nodeId: null, usedFact: '' } });
  return out({ final: { diagnosis: { cause: 'structure' }, answer: `${prefix} ${id[2]}와 같은 구조예요.`, nodeId: id[1], usedFact: JSON.parse(`"${fact}"`) } });
}
export const analogyCalls = []; // 가짜 analogy-api 요청 기록 { headers, body }
export const STREAM_GAP_MS = 1500;
// 문장에 "로딩지연테스트"가 있으면 응답을 이만큼 늦춘다(로딩 말풍선을 붙잡아 두는 용도, T-108)
export const SLOW_MS = 2500;
export const DRAFT_SLOW_MS = 6000; // AI 초안 마감 시험용, prepare-e2e의 admin.draft.deadlineMs(2500)보다 길게

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
    if (system.includes('개념 노드 목록으로 정리')) content = '초안이에요.\n```json\n' + JSON.stringify({ nodes: DRAFT_NODES }) + '\n```';
    else if (system.includes('추상 구조로')) {
      const abstract = user.includes('금칙추상테스트') ? `${BLOCKED_IN_ANALOGY} 처럼 비용을 내고 시도하는 구조` : '비용을 내고 시도하면 결과가 확률에 따라 달라지는 구조';
      // 정밀 모드 태그 판정이 켜져 있으면(T-184) 같은 호출이 JSON으로 추상 구조와 태그 확률을 함께 돌려준다
      content = system.includes('"tags"') ? JSON.stringify({ abstract, tags: [{ id: 'prob_upgrade', p: 0.9 }, { id: 'none', p: 0.05 }] }) : abstract;
    }
    else if (system.includes('이어서 묻는 질문')) content = agentReply(user);
    else if (system.includes('왜 틀렸는지 진단')) content = diagnoseReply(system, user);
    else if (system.includes('도우미다.') && helperReply(system, user) !== null) content = helperReply(system, user);
    else if (user.includes('연결 성공')) content = '연결 성공';
    else {
      const [, id, label] = user.match(/\[1\] id=(\S+) \| (.+)/);
      const tag = user.match(/맞은 추상 태그: .+? \(id=(\S+)\)/);
      const nodeId = user.includes('Leverage') ? 'not-a-candidate' : id;
      const prefix = system.match(/analogy는 "([^"]+)" 문구로 시작/)?.[1] ?? '메이플로 치면';
      const usedFact = user.match(/\[1\] id=[\s\S]*?facts:\n\s+- (.+)/)?.[1] ?? '';
      const meaning = user.includes('금칙뜻테스트') ? `${BLOCKED_IN_MEANING} 같은 뜻풀이예요.` : '테스트 뜻 풀이예요.';
      const answer = (analogy, fact = usedFact) => '```json\n' + JSON.stringify({ meaning, analogy, nodeId, tagId: tag?.[1] ?? null, usedFact: fact, mapping: `원문 ↔ ${label}` }) + '\n```';
      // "펭귄" 문장: 후보가 여럿이면 맞는 비유 없음, 사용자가 하나를 골라 후보가 1개면 그 개념으로 (T-106)
      if (user.includes('펭귄') && /\[2\] id=/.test(user)) content = '```json\n' + JSON.stringify({ meaning: '테스트 뜻 풀이예요.', analogy: '', nodeId: null, tagId: null, mapping: '' }) + '\n```';
      else if (user.includes('입장횟수테스트')) content = answer('메이플로 치면 일주일에 7번만 입장할 수 있는 것과 같아요.');
      else if (user.includes('금칙비유테스트')) content = answer(`메이플로 치면 ${label}과 같은 구조예요. ${BLOCKED_IN_ANALOGY}`);
      else if (user.includes('사실조작테스트')) content = answer('메이플로 치면 보스에 하루 세 번 들어가는 것과 같아요.', '보스는 하루에 세 번까지 입장할 수 있다.');
      // 끝맺음 검사(T-122): "끝맺음교정테스트"는 첫 답만 합쇼체(교정 문구가 오면 해요체), "끝맺음고집테스트"는 늘 합쇼체
      else if (user.includes('끝맺음고집테스트') || (user.includes('끝맺음교정테스트') && !user.includes('[고쳐 주세요]'))) content = answer(`${prefix} ${label}과 같은 구조입니다.`);
      else content = answer(`${prefix} ${label}과 같은 구조예요.`);
    }
    const out = () => {
      if (stream) return streamOut(res, cors, content);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    if (user.includes('로딩지연테스트')) return void setTimeout(out, SLOW_MS);
    // AI 초안 전체 마감 확인용(T-301): e2e 사본의 마감(admin.draft.deadlineMs)보다 늦게 답한다
    if (user.includes('관심사: 도우미지연테스트')) return void setTimeout(() => { if (!res.destroyed) out(); }, HELPER_SLOW_MS);
    if (user.includes('관심사: 초안지연테스트')) return void setTimeout(() => { if (!res.destroyed) out(); }, DRAFT_SLOW_MS);
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

// /frame.html·/masked.html·/pwframe.html 은 iframe 픽스처(T-111, T-148), 그 밖의 주소는 모두 테스트 페이지
const FIXTURES = { '/frame.html': './frame.html', '/masked.html': './masked.html', '/pwframe.html': './pwframe.html' }; // pwframe: T-148
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
//   '서버한도' → 429 + Retry-After: 1(초) (T-159, 확장이 그 시간만큼 서버를 쉬는지)
//   '서버로컬밖' → 근거가 서버 후보 안이지만 확장 공통 그래프에 없는 노드(T-141, 규칙 1 로컬 확인)
export const SERVER_DELAY_MS = 5000;
export const GHOST_NODE = 'ghost-node-t141';
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
        { id: 'meso', label: '메소', score: 0.6, direct: 0.6, tag: null, tagSim: null, source: 'common' },
        // '서버로컬밖'(T-141): 서버 후보에는 있지만 확장의 공통 그래프에는 없는 노드
        ...(nodeId === GHOST_NODE ? [{ id: GHOST_NODE, label: '없는 개념', score: 0.9, direct: 0.9, tag: null, tagSim: null, source: 'common' }] : [])
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
    if (sentence.includes('서버로컬밖')) return send(serverResult(GHOST_NODE));
    if (sentence.includes('서버금칙')) return send({ ...serverResult('starforce'), analogy: `${SERVER_ANALOGY} ${BLOCKED_IN_ANALOGY}` });
    if (sentence.includes('서버한도')) {
      res.writeHead(429, { ...cors, 'content-type': 'application/json', 'retry-after': '1', 'access-control-expose-headers': 'Retry-After' });
      return res.end(JSON.stringify({ detail: '요청이 너무 많아요.' }));
    }
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
