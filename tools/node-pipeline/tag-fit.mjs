// 노드 파이프라인(T-197) 태그 적합성 검사: 후보의 태그마다 "이 개념의 사실이 정말 그 태그의 구조를 드러내는가"를 LLM에 묻는다.
// T-195 관문에서 대안 정답 후보 17줄 중 14줄이 LLM no였다(예: 염색 개편 → random_reroll). 억지 태그가 관문까지 가면
// 같은 태그 문장의 1위·여유를 흔들어 회귀로 빠지거나 메인 확인 줄만 늘린다. 그래서 check 단계에서 먼저 거른다.
//
// 판정(직접 정함, T-197):
//   - 후보 하나에 LLM 한 번(태그 여러 개를 한 번에 묻고 태그마다 yes/no + 한 문장 이유). 태그마다 따로 부르면 무료 한도를 2배 쓴다
//   - 기준 자료는 tags.json의 desc + examples(다른 분야 예문). 사실에 없는 내용을 보태지 않고, 겉 낱말이 아니라 구조로 본다
//   - no인 태그는 뺀다(확인 사유 tagFitDropped). 남은 태그가 없으면 실패(tagFitNone)
//   - 답이 없거나 꼴이 틀린 태그, 호출 상한·LLM 오류로 못 물은 후보는 태그를 그대로 두고 확인 사유 tagFitPending(다음 실행에 캐시로 이어 감)
//   - 이미 실패한 후보는 묻지 않는다(한도 아끼기)
// 순수 함수 + 주입한 complete(system, user) → 답 글. 캐시·호출 수는 cli의 cachedComplete가 맡는다.

const TAG_EXAMPLES = 3;

/**
 * @param {{ node: { id, label, facts }, tags: Array<{ id, label, desc, examples? }> }} p  tags = 이 후보가 단 태그(목록 안)의 정의
 * @returns {{ system: string, user: string }}
 */
export function buildTagFitPrompt({ node, tags }) {
  const system = [
    '너는 비유 검색용 개념 그래프의 태그를 검수하는 도우미다. 추상 태그는 "무엇이 무엇에 따라 어떻게 바뀌는가"라는 구조를 뜻하고, 예문은 그 구조를 다른 분야에서 보인 것이다.',
    '아래 개념의 사실만 읽고, 태그마다 그 구조가 사실에 실제로 드러나는지 판단한다.',
    '규칙: 사실에 없는 내용을 보태지 않는다. 겉으로 비슷한 낱말이 아니라 구조가 같은지 본다. 구조의 일부만 겨우 맞거나 억지로 끌어대야 하면 no.',
    'JSON 객체만 출력한다. 형식: {"tags": [{"id": "태그 id", "verdict": "yes" 또는 "no", "reason": "한국어 한 문장, 80자 이내"}]}'
  ].join('\n');
  const user = [
    `[개념] ${node.label || node.id}`,
    ...(node.facts || []).map(f => `- ${f}`),
    '',
    '[태그]',
    ...tags.map(t => [
      `${t.id} | ${t.label || ''} — ${t.desc || ''}`,
      ...(t.examples || []).slice(0, TAG_EXAMPLES).map(e => `  예: ${e}`)
    ].join('\n'))
  ].join('\n');
  return { system, user };
}

/**
 * @param {string} text  LLM 답
 * @param {string[]} ids  물은 태그 id
 * @returns {Map<string, { verdict: 'yes'|'no', reason: string }> | null}  꼴이 틀리면 null, 답이 없는 태그는 Map에 없음
 */
export function parseTagFit(text, ids) {
  try {
    const t = String(text || '').replace(/```(?:json)?/gi, '');
    const v = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const list = Array.isArray(v.tags) ? v.tags : null;
    if (!list) return null;
    const want = new Set(ids);
    const out = new Map();
    for (const x of list) {
      if (!x || !want.has(x.id) || out.has(x.id)) continue;
      if (x.verdict !== 'yes' && x.verdict !== 'no') continue;
      out.set(x.id, { verdict: x.verdict, reason: String(x.reason || '').slice(0, 160) });
    }
    return out;
  } catch { return null; }
}

// 한도 초과 표시(cachedComplete가 상한을 넘는 새 호출에서 던진다)
export class BudgetError extends Error {
  constructor() { super('호출 상한'); this.budget = true; }
}

const statusOf = r => (r.fails.length ? 'fail' : r.warns.length ? 'warn' : 'pass');

/**
 * 검사 결과(checkBatch)에 태그 적합성을 더한다. 결과 객체를 고쳐 그대로 돌려준다
 * @param {Array} results  checkBatch 결과
 * @param {{ complete: (system, user) => Promise<string>, tags: Array, model?: string, log?: Function }} opts
 *   complete가 BudgetError를 던지면 그 뒤 후보는 모두 pending. 429면 멈추고 나머지 pending
 * @returns {Promise<{ asked: number, yes: number, no: number, failed: number, pending: number }>}
 */
export async function applyTagFit(results, { complete, tags, model = '', log = () => {} }) {
  const byId = new Map((tags || []).map(t => [t.id, t]));
  const stat = { asked: 0, yes: 0, no: 0, failed: 0, pending: 0 };
  let stopped = false;
  const pend = (r, note) => {
    r.tagFit = { status: 'pending', ...(note ? { note } : {}), verdicts: [] };
    if (!r.warns.includes('tagFitPending')) r.warns.push('tagFitPending');
    r.status = statusOf(r);
    stat.pending++;
  };
  for (const r of results) {
    if (r.status === 'fail' || !r.node?.tags?.length) continue;
    if (stopped) { pend(r, stopped); continue; }
    const ids = r.node.tags.filter(id => byId.has(id));
    const { system, user } = buildTagFitPrompt({ node: r.node, tags: ids.map(id => byId.get(id)) });
    let answer;
    try { answer = await complete(system, user); }
    catch (e) {
      if (e.budget) { stopped = '호출 상한'; pend(r, stopped); continue; }
      log(`태그 적합성 LLM 실패 ${r.node.id}: ${String(e.message || e).slice(0, 80)}`);
      if (e.status === 429) stopped = '429';
      pend(r, e.status === 429 ? '429' : 'LLM 오류');
      continue;
    }
    stat.asked++;
    const got = parseTagFit(answer, ids);
    if (!got) { pend(r, '답 꼴 틀림'); continue; }
    const verdicts = ids.map(id => ({ id, ...(got.get(id) || { verdict: 'unknown', reason: '' }) }));
    const keep = verdicts.filter(v => v.verdict !== 'no').map(v => v.id);
    stat.yes += verdicts.filter(v => v.verdict === 'yes').length;
    stat.no += verdicts.filter(v => v.verdict === 'no').length;
    r.tagFit = { status: 'done', model, verdicts };
    if (keep.length < ids.length) {
      r.warns.push('tagFitDropped');
      r.node = { ...r.node, tags: keep };
    }
    if (verdicts.some(v => v.verdict === 'unknown')) r.warns.push('tagFitPending');
    if (!keep.length) { r.fails.push('tagFitNone'); stat.failed++; }
    r.status = statusOf(r);
  }
  return stat;
}
