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

// 프롬프트·답 읽기는 확장 도우미(T-225)와 같이 쓰는 순수 함수라 확장 lib에 둔다
import { buildTagFitPrompt, parseTagFit, TAG_FIT_RULES } from '../../extension/lib/node-checks.js';
export { buildTagFitPrompt, parseTagFit, TAG_FIT_RULES };

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
