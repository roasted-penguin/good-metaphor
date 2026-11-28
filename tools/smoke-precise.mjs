// 정밀 모드 합친 호출 스모크(T-186): 확장과 같은 buildAbstractJudgePrompt + parseAbstractJudge로
// 고정 문장을 실제 제공자에 보내 합친 JSON({abstract, tags:[{id,p}]})을 지키는지 잰다.
// 형식을 어기면 확장은 판정 없이 예전 정밀 모드로 돌아간다(runAbstract). 그래서 스모크 실패로 세지 않고 보고만 한다.
// smoke-providers.mjs가 --precise-judge(또는 PRECISE_JUDGE=1)일 때 부른다. 키 값은 다루지 않는다(호출은 부르는 쪽 ask).
import { buildAbstractJudgePrompt } from '../extension/lib/prompt.js';
import { tagChoices, parseAbstractJudge, judgeTagProbs, judgeSaysNone, topChoice, NONE_CHOICE } from '../extension/lib/judges.js';
import { parseJSONLoose } from '../extension/lib/providers.js';

// expectTag: 기대 태그(tags.json id). null은 구조 없는 일상 문장(없음이 우세해야 한다)
export const PRECISE_SENTENCES = [
  { sentence: '레버리지는 이익과 손실을 모두 키워서 작은 가격 하락에도 원금을 잃을 수 있다.', pageTitle: '투자 기초', expectTag: 'loss_risk' },
  { sentence: 'Rate limiting caps how many requests a client can make per minute.', pageTitle: 'API docs', expectTag: 'periodic_cap' },
  { sentence: '동네 아파트 매물이 줄고 사려는 사람이 몰리자 호가가 계속 뛰었다.', expectTag: 'market_price' },
  { sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', expectTag: 'inflation' },
  { sentence: '운전면허 필기에 합격해야 도로주행 시험을 볼 수 있다.', expectTag: 'progression_gate' },
  { sentence: '문자 인증번호는 한 번 받으면 3분이 지나야 다시 요청할 수 있다.', expectTag: 'cooldown' },
  { sentence: '오늘 점심은 회사 근처 김치찌개 집에서 먹었다.', expectTag: null },
  { sentence: '주말에 비가 와서 친구와 집에서 영화를 봤다.', expectTag: null }
];

/**
 * 응답 텍스트에서 목록 밖 태그 id 수. 선택지(tags.json + none)에 없는 id를 센다(확장은 버린다, 규칙 9).
 * JSON이 아니거나 tags가 배열·객체가 아니면 0
 */
export function outOfListIds(text, choices) {
  const j = parseJSONLoose(String(text || '').replace(/```(?:json)?/gi, '').trim());
  const tags = j && typeof j === 'object' && !Array.isArray(j) ? j.tags ?? j.answers : null;
  const ids = Array.isArray(tags) ? tags.map(t => t?.id).filter(id => typeof id === 'string')
    : tags && typeof tags === 'object' ? Object.keys(tags) : [];
  const ok = new Set([...choices.map(c => c.id), NONE_CHOICE.id]);
  return ids.filter(id => !ok.has(id)).length;
}

/**
 * 문장 하나를 확장과 같은 합친 프롬프트로 묻는다. ask(system, user, opts) → 응답 문자열(호출·재시도는 부르는 쪽).
 * 돌려주는 값: { sentence, expectTag, ok, json, abstract, outOfList, none, structureless, top, ms, error }
 *   json: 판정(tags)을 읽었는가(parseAbstractJudge answers가 null이 아님). abstract: 추상 구조 글이 있는가
 *   none: 없음 우세(judgeSaysNone). structureless: 하한 적용 뒤 쓸 태그가 없음(확장은 원문으로 검색)
 *   top: 없음을 뺀 1위 태그
 */
export async function checkPreciseJudge(ask, s, tags, { floor = 0 } = {}) {
  const choices = tagChoices(tags);
  const p = buildAbstractJudgePrompt({ sentence: s.sentence, word: s.word || '', pageTitle: s.pageTitle || '', choices });
  const t = Date.now();
  const row = { sentence: s.sentence, expectTag: s.expectTag ?? null };
  let text;
  try {
    text = await ask(p.system, p.user, { json: true });
  } catch (e) {
    return { ...row, ok: false, json: false, abstract: false, outOfList: 0, none: false, structureless: false, top: null, ms: Date.now() - t, error: String(e.message || e).slice(0, 160), status: e.status };
  }
  const ms = Date.now() - t;
  const { abstractText, answers } = parseAbstractJudge(text, choices);
  const probs = judgeTagProbs(answers, { floor });
  return {
    ...row, ok: true, ms,
    json: answers !== null,
    abstract: !!abstractText && answers !== null,
    outOfList: outOfListIds(text, choices),
    none: judgeSaysNone(answers),
    structureless: Array.isArray(probs) && probs.length === 0,
    top: topChoice((answers || []).filter(a => a.id !== NONE_CHOICE.id)),
    raw: answers === null ? String(text).slice(0, 120) : undefined
  };
}

const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p90 = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null; };

/** 행 목록 → 요약 수치. 지연은 응답을 받은 행만 */
export function summarizePrecise(rows) {
  const structured = rows.filter(r => r.expectTag), daily = rows.filter(r => !r.expectTag);
  const ok = rows.filter(r => r.ok);
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    json: rows.filter(r => r.json).length,
    abstract: rows.filter(r => r.abstract).length,
    outOfList: rows.reduce((a, r) => a + (r.outOfList || 0), 0),
    noneTotal: rows.filter(r => r.none).length,
    noneDaily: daily.filter(r => r.none).length, dailyN: daily.length,
    noneStructured: structured.filter(r => r.none).length,
    tagHit: structured.filter(r => r.top === r.expectTag).length, structuredN: structured.length,
    median: median(ok.map(r => r.ms)), p90: p90(ok.map(r => r.ms))
  };
}

/** 제공자 한 줄 요약 */
export function preciseSummaryLine(label, s) {
  return `  정밀 판정 요약 ${label}: JSON ${s.json}/${s.n} · 추상 구조 ${s.abstract}/${s.n} · 목록 밖 id ${s.outOfList} · 없음 우세 ${s.noneTotal}`
    + ` (일상 ${s.noneDaily}/${s.dailyN}, 구조 문장 ${s.noneStructured}/${s.structuredN}) · 기대 태그 1위 ${s.tagHit}/${s.structuredN}`
    + ` · 지연 중앙 ${s.median ?? '-'}ms p90 ${s.p90 ?? '-'}ms${s.errors ? ` · 호출 실패 ${s.errors}` : ''}`;
}

/** 행 한 줄 */
export function preciseRowLine(r) {
  if (!r.ok) return `  정밀 판정 ✗ ${r.ms}ms 호출 실패: ${r.error}  ${r.sentence.slice(0, 24)}…`;
  const mark = !r.json ? '✗' : r.expectTag ? (r.top === r.expectTag ? '✓' : '△') : (r.none ? '✓' : '△');
  const what = !r.json ? `JSON 아님: ${r.raw}` : `1위 ${r.top ?? '-'}${r.none ? ' · 없음 우세' : ''}${r.structureless ? ' · 원문 검색' : ''}${r.outOfList ? ` · 목록 밖 id ${r.outOfList}` : ''} (기대 ${r.expectTag ?? '없음'})`;
  return `  정밀 판정 ${mark} ${r.ms}ms  ${what}  ${r.sentence.slice(0, 24)}…`;
}
