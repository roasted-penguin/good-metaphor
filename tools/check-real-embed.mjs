// 실제 임베딩 모델을 확장 안에서 확인 (T-102·T-128, 수동). 새 프로필로 크롬을 띄워 모델을 받는다.
// 사용법: npm run check:embed            HEADED=1 npm run check:embed (화면 보기)
// 보는 것: embedderId, 첫 로드(다운로드 포함)·캐시 로드 시간, 호버 한 번 시간,
// 평가셋·검증셋 전 문장에서 시험해 보기(explain)의 1위가 평가 도구(npm run eval)가 계산한 1위와 같은지
import { readFileSync } from 'node:fs';
import { openBrowserEmbedder } from './browser-embedder.mjs';
import { mergeGraphs, tagText, nodeText } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from './load-graph.mjs';
import { retrieve } from '../extension/lib/retrieval.js';

const admin = JSON.parse(readFileSync('extension/config/admin.json', 'utf8'));
const cases = [...JSON.parse(readFileSync('tools/eval-set.json', 'utf8')), ...JSON.parse(readFileSync('tools/eval-holdout.json', 'utf8'))];
const graph = mergeGraphs(loadCommonGraphFromDisk(), null); // 그래프 + tags.json (T-304)
const tm = new Map(graph.tags.map(t => [t.id, t]));
const items = [...graph.tags.map(t => ['tag:' + t.id, tagText(t)]), ...graph.nodes.map(n => ['node:' + n.id, nodeText(n, tm)])];

async function check(label, fresh) {
  const be = await openBrowserEmbedder({ profile: '.tmp/ext-check-profile', fresh });
  try {
    console.log(`[${label}] warmup ${be.warmupMs}ms · ${be.embedderId}`);
    const pv = await be.embed(items.map(([, t]) => t), 'passage');
    const vecs = new Map(items.map(([k], i) => [k, pv[i]]));
    let same = 0; const ms = []; const diff = [];
    for (const c of cases) {
      const [q] = await be.embed([c.sentence], 'query');
      const evalTop = retrieve(q, graph, vecs, { ...admin.retrieval, aliasText: c.sentence })[0].id;
      const r = await be.send('explain', { sentence: c.sentence, word: '', context: '', pageTitle: 'check', noCache: true });
      if (!r.ok) throw new Error(r.error);
      const d = r.data.debug;
      ms.push(d.ms);
      if (d.embedderId !== be.embedderId) throw new Error(`embedderId ${d.embedderId}`);
      const top = d.candidates[0]?.id;
      if (top === evalTop) same++; else diff.push(`  ≠ 시험해 보기 ${top} · 평가 ${evalTop} · ${c.sentence.slice(0, 30)}`);
    }
    ms.sort((a, b) => a - b);
    console.log(`  1위가 평가와 같음 ${same}/${cases.length} · 호버 한 번 중간 ${ms[ms.length >> 1]}ms · 최대 ${ms[ms.length - 1]}ms`);
    if (diff.length) console.log(diff.join('\n'));
  } finally {
    await be.close();
  }
}

await check('첫 실행(새 프로필, 다운로드 포함)', true);
await check('두 번째 실행(같은 프로필)', false);
