// 비슷한 문장 피드백 임계값 측정 (T-130): 바꿔 말한 문장 쌍과 다른 문장 쌍의 코사인 분포를 실제 확장 안의 모델로 잰다.
// 사용법: npm run sim:feedback   (첫 실행은 모델 다운로드)
// 같은 뜻으로 볼 기준: cos >= 임계값. 결과는 admin.json retrieval.feedbackSim에 사람이 옮긴다
import fs from 'node:fs';
import { cosine } from '../extension/lib/retrieval.js';
import { openBrowserEmbedder } from './browser-embedder.mjs';

const here = new URL('.', import.meta.url);
const pairs = JSON.parse(fs.readFileSync(new URL('./paraphrase-pairs.json', here)));

const be = await openBrowserEmbedder();
let rows;
try {
  // 문장마다 한 번씩만 임베딩 (embed가 안에서 한 문장씩 보낸다)
  const texts = [...new Set(pairs.flatMap(p => [p.a, p.b]))];
  const vecs = await be.embed(texts, 'query');
  const vec = new Map(texts.map((t, i) => [t, vecs[i]]));
  rows = pairs.map(p => ({ ...p, cos: cosine(vec.get(p.a), vec.get(p.b)) }));
  console.log(`임베더: ${be.embedderId} · 브라우저, 쌍 ${pairs.length}개\n`);
} finally {
  await be.close();
}

const short = s => (s.length > 34 ? s.slice(0, 33) + '…' : s);
for (const r of rows) console.log(`${r.same ? '같음' : '다름'}  ${r.cos.toFixed(4)}  ${short(r.a)}  ↔  ${short(r.b)}`);

const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return { min: s[0], max: s[s.length - 1], median: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 };
};
const same = stats(rows.filter(r => r.same).map(r => r.cos));
const diff = stats(rows.filter(r => !r.same).map(r => r.cos));
const f = x => x.toFixed(3);
console.log(`\n같음  최소 ${f(same.min)} · 중간 ${f(same.median)} · 최대 ${f(same.max)}`);
console.log(`다름  최소 ${f(diff.min)} · 중간 ${f(diff.median)} · 최대 ${f(diff.max)}`);

// 추천 임계값: 다름 최댓값과 같음 최솟값 사이(소수 둘째 자리)에서 틀린 개수(같음인데 미만 + 다름인데 이상)가 최소인 값.
// 동률이면 다름 최댓값 + 0.01에 가까운 쪽
const target = Math.round((diff.max + 0.01) * 100) / 100;
const lo = Math.floor(Math.min(diff.max, same.min) * 100);
const hi = Math.ceil(Math.max(diff.max + 0.01, same.min) * 100);
let best = null;
for (let k = lo; k <= hi; k++) {
  const t = k / 100;
  const errors = rows.filter(r => (r.same ? r.cos < t : r.cos >= t)).length;
  if (!best || errors < best.errors || (errors === best.errors && Math.abs(t - target) < Math.abs(best.t - target))) best = { t, errors };
}
console.log(`\n요약: 쌍 ${rows.length}개, 같음 ${f(same.min)}~${f(same.max)}(중간 ${f(same.median)}), 다름 ${f(diff.min)}~${f(diff.max)}(중간 ${f(diff.median)}), 추천 임계값 ${best.t.toFixed(2)}(틀림 ${best.errors})`);
