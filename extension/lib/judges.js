// 판정기 레지스트리 (T-120). 판정기는 글을 쓰지 않고 정해진 질문에 선택지·확률로만 답한다.
// 인터페이스: judge(판정기, { text, question, choices, multi }) → [{ id, p }] (선택지 전부, 확률 높은 순)
// 새 판정기는 JUDGES 항목 하나와 kind별 함수(KINDS)만 더한다(규칙 7과 같은 방식).
// 모두 클라우드다(규칙 8: 호버는 맥에 기대지 않는다). 지금은 평가 도구(tools/eval.mjs --judge)만 쓰고
// 호버 경로에는 연결하지 않았다(ADR 0014).
import { PROVIDERS, complete, parseJSONLoose } from './providers.js';

export const JUDGES = {
  // Gemini에 객관식 JSON으로 묻는다. HTTP·재시도·thinking 대체는 providers.js complete 그대로
  'gemini-choice': {
    label: 'Gemini 객관식 판정',
    kind: 'llm-choice',
    provider: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    cloud: true,
    free: true
  },
  // Jev(TypeSafe AI, 얼리 액세스). 공개 API 문서가 없어 아직 호출을 만들지 않았다. 키를 받으면 KINDS.jev만 채운다
  jev: {
    label: 'Jev (TypeSafe AI, 얼리 액세스)',
    kind: 'jev',
    keyEnv: 'JEV_API_KEY',
    cloud: true,
    supported: false
  }
};

export class JudgeError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function getJudge(id) {
  const def = JUDGES[id];
  if (!def) throw new JudgeError(`알 수 없는 판정기: ${id} (가능: ${Object.keys(JUDGES).join(', ')})`);
  return def;
}

/**
 * 판정기 id → 호출에 쓸 { id, def, apiKey, model }. 키는 env[def.keyEnv], 모델은 env <PROVIDER>_MODEL → admin.defaultModels → 제공자 기본값.
 * 평가 도구용(확장에 연결하면 설정 화면 키를 넘기는 쪽을 따로 만든다)
 */
export function judgeFor(id, { env = {}, admin = {} } = {}) {
  const def = getJudge(id);
  const apiKey = (def.keyEnv && env[def.keyEnv]) || '';
  let model = '';
  if (def.provider) {
    const p = PROVIDERS[def.provider];
    model = env[`${def.provider.toUpperCase()}_MODEL`] || admin.defaultModels?.[def.provider] || p.defaultModel;
  }
  return { id, def, apiKey, model };
}

// --- 질문 1: 문장 → 추상 태그 (다중 선택, 통제 어휘, 규칙 9) ---
export const TAG_QUESTION = '이 문장이 설명하는 상황의 추상 구조(주제나 단어가 아니라 원리·규칙의 모양)에 해당하는 것은 무엇인가요?';

/** tags.json의 tags 배열(또는 { tags } 그래프) → 선택지. 순서·개수는 파일 그대로(개수를 가정하지 않는다) */
export function tagChoices(tagsOrGraph) {
  const tags = Array.isArray(tagsOrGraph) ? tagsOrGraph : tagsOrGraph?.tags || [];
  return tags.map(t => ({ id: t.id, label: t.label, desc: t.desc }));
}

/** 객관식 프롬프트. 선택지 id 밖의 답은 normalizeChoices에서 버린다 */
export function buildChoicePrompt({ text, question, choices, multi = true }) {
  const rule = multi
    ? '해당하는 선택지를 모두 고르고, 각각이 맞을 확률(0~1)을 서로 독립적으로 매긴다. 확률이 높은 순으로 최대 5개.'
    : '선택지 하나를 고른다. 확률(0~1)의 합이 1이 되게 매긴다. 확률이 높은 순으로 최대 5개.';
  const system = [
    '너는 판정기다. 글을 쓰지 않고, 주어진 질문에 주어진 선택지 id로만 답한다.',
    rule,
    '선택지 목록에 없는 id를 만들지 않는다. 문장의 단어가 아니라 구조로 판단한다.',
    '출력은 JSON 하나만: {"answers":[{"id":"<선택지 id>","p":<0~1>}]}'
  ].join('\n');
  const list = choices.map(c => `- ${c.id}: ${c.label}${c.desc ? ' — ' + c.desc : ''}`).join('\n');
  const user = `질문: ${question}\n\n선택지:\n${list}\n\n문장: ${text}`;
  return { system, user };
}

// 확률 값 하나를 숫자로: 0.8, "0.8", "80%" → 0.8. 못 읽으면 NaN
function toProb(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
}

/**
 * 판정 응답 텍스트 → [{ id, p }] (정규화 전). 형식 셋을 받는다:
 * {"answers":[{id,p}]} / [{id,p}] / {"answers":{id: p}}. 읽지 못하면 null
 */
export function parseChoiceJSON(text) {
  if (!text) return null;
  let j = null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  if (cleaned.startsWith('[')) { try { j = JSON.parse(cleaned); } catch {} }
  if (j === null) j = parseJSONLoose(cleaned);
  if (j === null) return null;
  const arr = Array.isArray(j) ? j : j.answers ?? j.choices;
  if (Array.isArray(arr)) return arr.filter(x => x && typeof x.id === 'string').map(x => ({ id: x.id, p: toProb(x.p) }));
  if (arr && typeof arr === 'object') return Object.entries(arr).map(([id, p]) => ({ id, p: toProb(p) }));
  return null;
}

/**
 * 확률 정규화: 선택지 밖 id는 버리고(규칙 9), 숫자가 아니면 0, 음수는 0, 같은 id는 큰 값.
 * 빠진 선택지는 0. 단일 선택(multi false)은 합이 1이 되게 나눈다(합이 0이면 그대로). 다중 선택은 각자 독립 확률이라 [0,1]로 자른다.
 * 결과: 선택지 전부, 확률 높은 순(같으면 선택지 순서)
 */
export function normalizeChoices(raw, choices, { multi = true } = {}) {
  const p = new Map(choices.map(c => [c.id, 0]));
  for (const r of raw || []) {
    if (!p.has(r?.id)) continue;
    let v = Number(r.p);
    if (!Number.isFinite(v)) v = 0;
    // 단일 선택은 합으로 나눌 것이라 위는 자르지 않는다(3:1 → 0.75:0.25)
    v = multi ? Math.max(0, Math.min(1, v)) : Math.max(0, v);
    if (v > p.get(r.id)) p.set(r.id, v);
  }
  if (!multi) {
    const sum = [...p.values()].reduce((a, b) => a + b, 0);
    if (sum > 0) for (const [id, v] of p) p.set(id, v / sum);
  }
  const order = new Map(choices.map((c, i) => [c.id, i]));
  return [...p].map(([id, v]) => ({ id, p: v })).sort((a, b) => b.p - a.p || order.get(a.id) - order.get(b.id));
}

/** 가장 확률이 높은 선택지 id. 모두 0이거나 비면 null */
export function topChoice(result) {
  const best = (result || []).reduce((m, x) => (!m || x.p > m.p ? x : m), null);
  return best && best.p > 0 ? best.id : null;
}

// 종류별 호출. 반환은 정규화 전 [{id,p}]
const KINDS = {
  async 'llm-choice'(j, input, opts) {
    const pdef = PROVIDERS[j.def.provider];
    // 호버 판정은 클라우드만(규칙 8). 로컬 제공자를 쓰는 항목은 만들지 않는다
    if (!pdef || pdef.local) throw new JudgeError(`판정기 ${j.id}: 클라우드 제공자가 필요해요.`);
    const provider = { id: j.def.provider, def: pdef, model: j.model || pdef.defaultModel, apiKey: j.apiKey, baseUrl: pdef.baseUrl };
    const p = buildChoicePrompt(input);
    const text = await complete(provider, p.system, p.user, { json: true, stats: opts.stats, timeoutMs: opts.timeoutMs });
    const raw = parseChoiceJSON(text);
    if (!raw) throw new JudgeError(`판정 응답을 읽지 못했어요: ${String(text).slice(0, 80)}`);
    return raw;
  },
  async jev(j) {
    if (!j.apiKey) throw new JudgeError('Jev 키가 필요해요. JEV_API_KEY를 넣어 주세요(얼리 액세스).', 401);
    throw new JudgeError('Jev 판정기는 아직 미지원이에요. 공개 API 문서를 받으면 KINDS.jev를 채워요.');
  }
};

/**
 * @param {{id, def, apiKey, model}} j  judgeFor() 결과
 * @param {{text:string, question:string, choices:{id,label,desc?}[], multi?:boolean}} input
 * @param {{stats?:object, timeoutMs?:number}} opts
 * @returns {Promise<{id:string, p:number}[]>}
 */
export async function judge(j, input, opts = {}) {
  const run = KINDS[j.def.kind];
  if (!run) throw new JudgeError(`알 수 없는 판정기 종류: ${j.def.kind}`);
  const raw = await run(j, input, opts);
  return normalizeChoices(raw, input.choices, { multi: input.multi !== false });
}
