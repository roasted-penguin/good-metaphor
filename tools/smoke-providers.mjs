// 제공자 스모크: 키가 있는 제공자만 실제 API로 비유 프롬프트를 보내 요청 형식이 맞는지 확인한다.
// 사용법 (프로젝트 루트에서):
//   GEMINI_API_KEY=... GROQ_API_KEY=... npm run smoke:providers
//   OPENAI_API_KEY, ANTHROPIC_API_KEY 도 같은 방식. 모델은 GEMINI_MODEL 처럼 <제공자>_MODEL 로 바꾼다.
//   OpenAI 호환 주소(Ollama, OpenRouter 등): CUSTOM_BASE_URL=http://127.0.0.1:11434/v1 CUSTOM_MODEL=gemma4:12b [CUSTOM_API_KEY=...]
//   로컬 Ollama(PROVIDERS.ollama)는 127.0.0.1:11434 가 떠 있으면 자동으로 포함. 모델은 OLLAMA_MODEL
//   -- --all-models : 레지스트리의 모델 목록을 모두 시험 (무료 한도에 주의)
//   -- --compare N  : 평가셋(tools/eval-set.json)에서 고르게 N문장을 골라 제공자별 비교표를 낸다(T-122).
//                     뜻까지 시간·JSON·규칙 1·근거 검사·존댓말(첫 답/최종). -- --rpm 4 로 제공자별 분당 호출 수(기본 4,
//                     Groq 무료 분당 토큰 한도에 맞춘 값). 비교표는 실패로 세지 않는다
// 검색은 글자 n-gram 대체 임베더로 한다. 여기서 보는 것은 검색 품질이 아니라 요청·응답 형식과 생성 품질이다.
// 생성은 확장과 같은 runAnalogy(규칙 1·근거 검사·금칙어·끝맺음 검사, T-104·T-122)로 한다. 키 값은 출력하지 않는다.
import fs from 'node:fs';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildAbstractPrompt, leakedTerms } from '../extension/lib/prompt.js';
import { runAnalogy } from '../extension/lib/pipeline.js';
import { REJECTED_TEXT } from '../extension/lib/analogy-server.js';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from './load-graph.mjs';
import { retrieve, retrievalFor } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const blocklist = JSON.parse(fs.readFileSync(new URL('../extension/data/common/blocklist.json', here))).terms || [];
const common = loadCommonGraphFromDisk(); // 그래프 + tags.json (T-304)
const argv = process.argv.slice(2);
const argValue = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const allModels = argv.includes('--all-models');
const compareN = Number(argValue('--compare') ?? process.env.COMPARE ?? 0) || 0;
const compareRpm = Number(argValue('--rpm') ?? process.env.COMPARE_RPM ?? 4) || 4;

// jargon: 정밀 모드 추상화에 그대로 남으면 안 되는 원문 전문용어(T-122). 띄어쓰기·대소문자 무시
const SENTENCES = [
  { sentence: '레버리지는 이익과 손실을 모두 키워서 작은 가격 하락에도 원금을 잃을 수 있다.', pageTitle: '투자 기초', jargon: ['레버리지', 'leverage'] },
  { sentence: 'Rate limiting caps how many requests a client can make per minute.', pageTitle: 'API docs', jargon: ['rate limit', '레이트리미', '레이트리밋'] }
];

const graph = mergeGraphs(common, null);
const vecs = new Map(embedItems(graph, admin.retrieval).map(it => [it.key, hashEmbed(it.text)])); // 확장과 같은 구성 (T-154)

// 로컬 제공자(Ollama)는 키 대신 서버가 떠 있는지로 판단한다
async function reachable(baseUrl) {
  try { const r = await fetch(baseUrl.replace(/\/v1$/, '') + '/api/version', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function targets() {
  const out = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (id === 'demo') continue;
    if (def.local) {
      if (!(await reachable(def.baseUrl))) { out.push({ id, skip: true }); continue; }
      const model = process.env[`${id.toUpperCase()}_MODEL`] || admin.defaultModels?.[id] || def.defaultModel;
      out.push({ id, def, model, apiKey: '', baseUrl: def.baseUrl });
      continue;
    }
    const env = id.toUpperCase();
    const apiKey = process.env[`${env}_API_KEY`] || '';
    const baseUrl = id === 'custom' ? process.env.CUSTOM_BASE_URL || '' : def.baseUrl;
    if (id === 'custom' ? !baseUrl : !apiKey) { out.push({ id, skip: true }); continue; }
    const models = process.env[`${env}_MODEL`] ? [process.env[`${env}_MODEL`]]
      : allModels && def.models.length ? def.models
      : [admin.defaultModels?.[id] || def.defaultModel];
    for (const model of models) out.push({ id, def, model, apiKey, baseUrl });
  }
  return out;
}

// fn 에 stats 를 넘기고, 걸린 시간과 재시도 횟수를 함께 돌려준다
async function timed(fn) {
  const t = Date.now(), stats = {};
  const tail = () => ({ ms: Date.now() - t, retry: stats.retries ? ` (재시도 ${stats.retries}회)` : '' });
  try { return { ok: true, value: await fn(stats), ...tail() }; }
  catch (e) { return { ok: false, error: e.message, status: e.status, ...tail() }; }
}

// 확장과 같은 생성 한 번(runAnalogy). 첫 글자·뜻 완성·전체 시간과 호출 수, 첫 답 문체를 함께 잰다
async function generate(p, s) {
  const candidates = retrieve(hashEmbed(s.sentence), graph, vecs, { ...retrievalFor(admin.retrieval, graph), aliasText: s.sentence });
  const t0 = Date.now(), at = {}, stats = {};
  let calls = 0, firstRaw = null;
  const ask = async (system, user, opts) => {
    calls++;
    const onText = opts.onText && (text => { at.first ??= Date.now() - t0; opts.onText(text); });
    const text = await complete(p, system, user, { ...opts, stats, onText });
    firstRaw ??= text;
    return text;
  };
  const row = { sentence: s.sentence, candidates: candidates.map(c => c.id) };
  try {
    const r = await runAnalogy({
      sentence: s.sentence, word: '', context: s.context || '', pageTitle: s.pageTitle || '', graph, candidates, ask,
      providerKind: p.def.kind, blocklist, onPartial: () => { at.meaning ??= Date.now() - t0; }
    });
    Object.assign(row, {
      ok: true, answer: r.answer, nodeId: r.answer.nodeId ?? null, rejected: r.rejected, grounding: r.grounding,
      hidden: r.groundingHidden, ending: r.ending, rule1: r.rejected !== REJECTED_TEXT
    });
  } catch (e) {
    Object.assign(row, { ok: false, error: e.message.slice(0, 200), status: e.status, raw: firstRaw?.slice(0, 200) });
  }
  return Object.assign(row, { ms: Date.now() - t0, first: at.first ?? null, meaningMs: at.meaning ?? null, calls, retries: stats.retries || 0 });
}

function describe(row) {
  const a = row.answer || {};
  const style = row.ending ? (row.ending.ok ? (row.ending.retried ? '다시 불러 고침' : '통과') : `실패(${row.ending.issues.map(i => `${i.field}:${i.style}`).join(', ')})`) : '-';
  const lines = [
    `    → [${row.nodeId}] ${a.analogy || (row.hidden ? `(숨김: ${row.hidden.analogy})` : '(비유 없음)')}`,
    `      뜻: ${a.meaning}`,
    `      존댓말: ${style}`
  ];
  if (row.grounding) lines.push(`      근거 검사: ${row.grounding.ok ? '통과' : `숨김(${row.grounding.reason})`}  usedFact: ${a.usedFact || '(없음)'}`);
  return lines.join('\n');
}

const list = await targets();
const skipped = list.filter(t => t.skip).map(t => t.id);
const runs = list.filter(t => !t.skip);
if (skipped.length) console.log(`건너뜀(키 없음·로컬 서버 꺼짐): ${skipped.join(', ')}`);
if (!runs.length) {
  console.log('시험할 제공자가 없어요. GEMINI_API_KEY 나 GROQ_API_KEY 를 넣고 다시 실행해 주세요.');
  process.exit(0);
}

let failed = 0;
for (const p of runs) {
  console.log(`\n== ${p.id} / ${p.model}`);
  // 정밀 모드 1단계(json 아님). 원문 전문용어가 추상화에 그대로 남으면 실패(T-122)
  for (const s of SENTENCES) {
    const ab = buildAbstractPrompt(s);
    const r0 = await timed(stats => complete(p, ab.system, ab.user, { json: false, stats }));
    const leaked = r0.ok ? leakedTerms(r0.value, s.jargon) : [];
    const bad = !r0.ok || leaked.length;
    if (bad) failed++;
    console.log(`  추상화    ${bad ? '✗' : '✓'} ${r0.ms}ms${r0.retry}  ${r0.ok ? r0.value.trim().slice(0, 100) : r0.error}`);
    if (leaked.length) console.log(`    문제: 원문 용어가 그대로 남음: ${leaked.join(', ')}`);
  }
  // 비유 생성(json, 스트리밍). 확장과 같은 검사: JSON, 규칙 1, 끝맺음(다시 불러도 어기면 실패). 근거 검사는 결과만 보인다
  for (const s of SENTENCES) {
    const row = await generate(p, s);
    const problem = !row.ok ? row.error
      : !row.answer.meaning ? 'meaning 없음'
      : !row.rule1 ? `후보에 없는 nodeId: ${row.nodeId}`
      : row.ending && !row.ending.ok ? `존댓말 아님: ${row.ending.issues.map(i => `${i.field}(${i.style})`).join(', ')}`
      : null;
    if (problem) failed++;
    const marks = `첫 글자 ${row.first ?? '-'}ms · 뜻 ${row.meaningMs ?? '-'}ms · 전체 ${row.ms}ms${row.calls > 1 ? ` · 호출 ${row.calls}회` : ''}${row.retries ? ` (재시도 ${row.retries}회)` : ''}`;
    console.log(`  비유 생성  ${problem ? '✗' : '✓'} ${marks}  ${s.sentence.slice(0, 24)}…`);
    if (problem) console.log(`    문제: ${problem}${row.raw ? `\n    원문: ${row.raw}` : ''}`);
    if (row.ok) console.log(describe(row));
  }
}

// ── 비교표(T-122): 평가셋 문장으로 제공자별 생성 품질·시간 ──
if (compareN > 0) {
  const evalSet = JSON.parse(fs.readFileSync(new URL('eval-set.json', here)));
  const step = Math.max(1, Math.floor(evalSet.length / compareN));
  const cases = evalSet.filter((_, i) => i % step === 0).slice(0, compareN);
  const gap = 60_000 / compareRpm;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const summary = [];
  console.log(`\n=== 비교 (평가셋 ${cases.length}문장, 제공자별 분당 ${compareRpm}회)`);
  for (const p of runs) {
    console.log(`\n== 비교 ${p.id} / ${p.model}`);
    const rows = [];
    for (const [i, c] of cases.entries()) {
      let row;
      // 분당 한도 429는 기다렸다 두 번까지 다시(비교용). 그래도 실패면 그 문장은 오류로 센다
      for (let tries = 0; ; tries++) {
        const t = Date.now();
        row = await generate(p, { sentence: c.sentence });
        if (row.ok || row.status !== 429 || tries >= 2) { await sleep(Math.max(0, gap * row.calls - (Date.now() - t))); break; }
        console.log(`  429, 30초 뒤 다시 (${tries + 1}/2)`);
        await sleep(30_000);
      }
      row.expect = c.expectNodes || [];
      // 첫 답이 해요체였는지: 다시 부르지 않고 통과했으면 참
      row.firstPolite = row.ok && !!row.ending?.ok && !row.ending.retried;
      rows.push(row);
      const tag = !row.ok ? `✗ ${row.error.slice(0, 60)}` : row.answer.analogy ? `[${row.nodeId}]` : row.hidden ? `(숨김 ${row.grounding?.reason})` : row.rejected ? '(규칙 1 숨김)' : '(비유 없음)';
      console.log(`  ${i + 1}/${cases.length} ${tag} 뜻 ${row.meaningMs ?? '-'}ms 전체 ${row.ms}ms${row.calls > 1 ? ` 호출 ${row.calls}` : ''}  ${c.sentence.slice(0, 30)}…`);
      if (row.ok) console.log(describe(row));
    }
    summary.push({ p, rows });
  }
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const p90 = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null; };
  console.log('\n=== 비교표 (대체 임베더 검색, 같은 후보로 생성)');
  console.log('| 모델 | 문장 | JSON 유효 | 규칙 1 통과 | 비유 냄 | 근거 통과/비유 | 첫 답 해요체 | 최종 해요체 | 뜻까지 중앙값 | 뜻까지 p90 | 전체 중앙값 | 기대 노드 고름/후보에 있음 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { p, rows } of summary) {
    const ok = rows.filter(r => r.ok);
    const made = ok.filter(r => r.answer.analogy || r.hidden);
    const grounded = made.filter(r => r.grounding?.ok);
    const expectable = ok.filter(r => r.expect.some(e => r.candidates.includes(e)));
    const hit = expectable.filter(r => r.expect.includes(r.nodeId));
    console.log(`| ${p.id}/${p.model} | ${rows.length} | ${ok.length}/${rows.length} | ${ok.filter(r => r.rule1).length}/${ok.length} | ${made.length}/${ok.length} | ${grounded.length}/${made.length} | ${ok.filter(r => r.firstPolite).length}/${ok.length} | ${ok.filter(r => r.ending?.ok).length}/${ok.length} | ${median(ok.map(r => r.meaningMs))}ms | ${p90(ok.map(r => r.meaningMs))}ms | ${median(ok.map(r => r.ms))}ms | ${hit.length}/${expectable.length} |`);
  }
}

console.log(`\n${failed ? `실패 ${failed}건` : '모두 통과'}`);
process.exit(failed ? 1 : 0);
