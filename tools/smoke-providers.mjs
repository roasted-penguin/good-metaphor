// 제공자 스모크: 키가 있는 제공자만 실제 API로 비유 프롬프트를 보내 요청 형식이 맞는지 확인한다.
// 사용법 (프로젝트 루트에서):
//   GEMINI_API_KEY=... GROQ_API_KEY=... npm run smoke:providers
//   OPENAI_API_KEY, ANTHROPIC_API_KEY 도 같은 방식. 모델은 GEMINI_MODEL 처럼 <제공자>_MODEL 로 바꾼다.
//   OpenAI 호환 주소(Ollama, OpenRouter 등): CUSTOM_BASE_URL=http://127.0.0.1:11434/v1 CUSTOM_MODEL=gemma4:12b [CUSTOM_API_KEY=...]
//   -- --all-models : 레지스트리의 모델 목록을 모두 시험 (무료 한도에 주의)
// 검색은 글자 n-gram 대체 임베더로 한다. 여기서 보는 것은 검색 품질이 아니라 요청·응답 형식이다.
import fs from 'node:fs';
import { PROVIDERS, complete, parseJSONLoose } from '../extension/lib/providers.js';
import { buildAbstractPrompt, buildAnalogyPrompt } from '../extension/lib/prompt.js';
import { mergeGraphs, tagText, nodeText } from '../extension/lib/graph.js';
import { retrieve } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const common = JSON.parse(fs.readFileSync(new URL('../extension/data/common/maplestory.json', here)));
const allModels = process.argv.includes('--all-models');

const SENTENCES = [
  { sentence: '레버리지는 이익과 손실을 모두 키워서 작은 가격 하락에도 원금을 잃을 수 있다.', pageTitle: '투자 기초' },
  { sentence: 'Rate limiting caps how many requests a client can make per minute.', pageTitle: 'API docs' }
];

const graph = mergeGraphs(common, null);
const tagMap = new Map(graph.tags.map(t => [t.id, t]));
const vecs = new Map([
  ...graph.tags.map(t => ['tag:' + t.id, hashEmbed(tagText(t))]),
  ...graph.nodes.map(n => ['node:' + n.id, hashEmbed(nodeText(n, tagMap))])
]);

function targets() {
  const out = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (id === 'demo') continue;
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
  catch (e) { return { ok: false, error: e.message, ...tail() }; }
}

function check(answer, candidates) {
  if (!answer) return '응답이 JSON이 아님';
  if (typeof answer.meaning !== 'string' || !answer.meaning) return 'meaning 없음';
  if (typeof answer.analogy !== 'string') return 'analogy가 문자열이 아님';
  if (answer.analogy && !candidates.some(c => c.id === answer.nodeId)) return `후보에 없는 nodeId: ${answer.nodeId}`;
  return null;
}

const list = targets();
const skipped = list.filter(t => t.skip).map(t => t.id);
const runs = list.filter(t => !t.skip);
if (skipped.length) console.log(`건너뜀(키 없음): ${skipped.join(', ')}`);
if (!runs.length) {
  console.log('시험할 제공자가 없어요. GEMINI_API_KEY 나 GROQ_API_KEY 를 넣고 다시 실행해 주세요.');
  process.exit(0);
}

let failed = 0;
for (const p of runs) {
  console.log(`\n== ${p.id} / ${p.model}`);
  // 정밀 모드 1단계(json 아님)
  const ab = buildAbstractPrompt(SENTENCES[0]);
  const r0 = await timed(stats => complete(p, ab.system, ab.user, { json: false, stats }));
  console.log(`  추상화    ${r0.ok ? '✓' : '✗'} ${r0.ms}ms${r0.retry}  ${r0.ok ? r0.value.trim().slice(0, 80) : r0.error}`);
  if (!r0.ok) failed++;
  // 비유 생성(json)
  for (const s of SENTENCES) {
    const candidates = retrieve(hashEmbed(s.sentence), graph, vecs, admin.retrieval);
    const pr = buildAnalogyPrompt({ ...s, domain: graph.domain, analogyPrefix: graph.analogyPrefix, candidates });
    const r = await timed(stats => complete(p, pr.system, pr.user, { json: true, stats }));
    const answer = r.ok ? parseJSONLoose(r.value) : null;
    const problem = r.ok ? check(answer, candidates) : r.error;
    if (problem) failed++;
    console.log(`  비유 생성  ${problem ? '✗' : '✓'} ${r.ms}ms${r.retry}  ${s.sentence.slice(0, 24)}…`);
    if (problem) console.log(`    문제: ${problem}${r.ok ? `\n    원문: ${r.value.slice(0, 200)}` : ''}`);
    else console.log(`    → [${answer.nodeId}] ${answer.analogy || '(비유 없음)'}\n      뜻: ${answer.meaning}`);
  }
}
console.log(`\n${failed ? `실패 ${failed}건` : '모두 통과'}`);
process.exit(failed ? 1 : 0);
