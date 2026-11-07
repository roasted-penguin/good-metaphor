// 생성 평가(T-104)의 순수 함수: 채점 프롬프트, 채점 응답 해석, 요약, 모델 같음 검사, EVAL_LOG 한 줄.
// 네트워크를 쓰지 않는다. 실행은 tools/eval-gen.mjs.
import { parseJSONLoose } from '../extension/lib/providers.js';

const JUDGE_SYSTEM = [
  '너는 비유 설명의 품질을 채점하는 심사자다. 다른 모델이 만든 한 줄 비유를 아래 기준으로 엄격하게 채점한다.',
  '- grounded: 비유에 쓴 게임 사실이 "고른 개념의 사실" 목록 안에 있으면 true. 목록에 없는 사실·수치·설정을 지어냈으면 false. 일반 상식 수준의 연결 표현(예: "~처럼")은 문제 삼지 않는다.',
  '- structure (1~5): 문장의 추상 구조(원인·결과, 상한, 위험, 누적 등)와 비유의 구조가 얼마나 맞는가. 5 = 핵심 구조가 정확히 대응, 3 = 일부만 대응, 1 = 구조가 다르거나 주제만 비슷.',
  '- natural (1~5): 한국어로 자연스럽고 짧고 이해하기 쉬운가. 5 = 바로 이해됨, 1 = 어색하거나 뜻이 흐림.',
  '- reason: 점수의 이유를 한국어 한두 문장으로. grounded가 false면 지어낸 부분을 짚는다.',
  '반드시 JSON 하나만 출력한다: {"grounded": true|false, "structure": 1-5, "natural": 1-5, "reason": "..."}'
].join('\n');

const factLines = facts => (facts || []).map(f => `  - ${f}`).join('\n') || '  (사실 없음)';

// candidates: retrieve() 결과(또는 저장된 {id, label, facts}). chosen: 비유에 쓴 후보(없으면 null)
export function buildJudgePrompt({ sentence, candidates = [], chosen = null, analogy }) {
  const others = candidates.filter(c => c.id !== chosen?.id);
  const user = [
    `문장: ${sentence}`,
    '',
    chosen ? `고른 개념: ${chosen.label} (${chosen.id})\n고른 개념의 사실:\n${factLines(chosen.facts)}` : '고른 개념: 없음',
    '',
    others.length ? `참고 — 다른 후보 개념(비유 근거로 쓰면 안 됨):\n${others.map(c => `- ${c.label} (${c.id})\n${factLines(c.facts)}`).join('\n')}` : '참고 — 다른 후보 개념: 없음',
    '',
    `채점할 비유: ${analogy}`,
    '',
    'JSON {"grounded", "structure", "natural", "reason"} 하나로 답해 줘.'
  ].join('\n');
  return { system: JUDGE_SYSTEM, user };
}

const score = v => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

// 채점 응답 → { grounded, structure, natural, reason }. 형식이 틀리거나 범위 밖이면 null
export function parseJudge(text) {
  const j = parseJSONLoose(text);
  if (!j || typeof j !== 'object') return null;
  if (typeof j.grounded !== 'boolean') return null;
  const structure = score(j.structure), natural = score(j.natural);
  if (structure == null || natural == null) return null;
  return { grounded: j.grounded, structure, natural, reason: typeof j.reason === 'string' ? j.reason : '' };
}

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// rows: eval-gen.mjs 결과 행. 비유가 빈(숨김) 행은 채점에서 빼고 hidden 으로 센다.
// error(생성 실패) 행은 errors, 비유는 있는데 채점 결과가 없는 행은 unjudged.
export function summarize(rows) {
  const errors = rows.filter(r => r.error);
  const ok = rows.filter(r => !r.error);
  const hidden = ok.filter(r => !r.answer?.analogy);
  const shown = ok.filter(r => r.answer?.analogy);
  const judged = shown.filter(r => r.judge);
  const brief = r => ({ sentence: r.sentence, analogy: r.answer.analogy, nodeId: r.answer.nodeId, structure: r.judge.structure, reason: r.judge.reason });
  return {
    n: rows.length,
    errors: errors.length,
    hidden: hidden.length,
    judged: judged.length,
    unjudged: shown.length - judged.length,
    groundedRate: judged.length ? judged.filter(r => r.judge.grounded).length / judged.length : null,
    structureAvg: avg(judged.map(r => r.judge.structure)),
    naturalAvg: avg(judged.map(r => r.judge.natural)),
    violations: judged.filter(r => !r.judge.grounded).map(brief),
    weak: judged.filter(r => r.judge.structure <= 2).map(brief)
  };
}

// 제공자 객체({id|provider, model}) 또는 '제공자/모델' 문자열 → '제공자/모델'
export function modelKey(p) {
  if (typeof p === 'string') return p;
  return `${p.id ?? p.provider}/${p.model}`;
}

// 채점 모델은 생성 모델과 달라야 한다(자기 답을 후하게 채점하는 것을 막는다)
export function assertDifferentModels(gen, judge) {
  if (modelKey(gen) === modelKey(judge)) {
    throw new Error(`채점 모델이 생성 모델과 같아요(${modelKey(judge)}). JUDGE_PROVIDER·JUDGE_MODEL로 다른 모델을 골라 주세요.`);
  }
}

// 채점 모델을 생성 체인에서 뺀다(생성 모델이 채점 모델이 될 수 없게). 순서는 그대로
export function withoutModel(chain, judge) {
  const k = modelKey(judge);
  return chain.filter(p => modelKey(p) !== k);
}

export const SAME_MODEL_SKIP = '채점 모델과 같은 모델이 생성함';

// 행을 채점할지. 숨김·생성 실패는 조용히 건너뛰고, 채점 모델이 생성한 행(--from 입력)은 표시하고 건너뛴다
export function judgePlan(row, judge) {
  if (row.error || !row.answer?.analogy) return { judge: false };
  if (row.provider && modelKey(row.provider) === modelKey(judge)) return { judge: false, judgeError: SAME_MODEL_SKIP };
  return { judge: true };
}

// --limit 값: 없으면 전부(Infinity), 0 이상 정수만
export function parseLimit(v) {
  if (v == null) return Infinity;
  if (!/^\d+$/.test(v)) throw new Error(`--limit은 0 이상 정수로 써 주세요(받은 값: ${v || '없음'})`);
  return Number(v);
}

export const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const fix2 = v => (v == null ? '—' : v.toFixed(2));
const pctText = (a, b) => `${a}/${b} (${Math.round(a / b * 100)}%)`;

// EVAL_LOG에 붙일 표 한 줄. 이 표의 칸(임베더·평가셋·설정·hit…)에 맞춰 생성 지표를 메모 칸까지 채운다.
// meta: { date, gen: ['제공자/모델', ...](실제로 답한 모델들), judge: '제공자/모델', embedder? }
export function evalLogRow(s, { date, gen = [], judge, embedder = '—' }) {
  const grounded = s.judged ? pctText(Math.round(s.groundedRate * s.judged), s.judged) : '—';
  const metrics = `근거 준수 ${grounded} · 구조 ${fix2(s.structureAvg)} · 자연스러움 ${fix2(s.naturalAvg)} · 숨김 ${s.hidden}${s.errors ? ` · 생성 실패 ${s.errors}` : ''}`;
  const memo = `T-104 생성 평가. 생성 ${gen.join(', ') || '—'} → 채점 ${judge}. 근거 위반 ${s.violations.length}건, 구조 ≤ 2 ${s.weak.length}건`;
  return `| ${date} | ${embedder} | 생성 ${s.n} | admin.retrieval | — | — | — | — | ${metrics}. ${memo} |`;
}
