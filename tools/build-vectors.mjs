// 미리 계산한 그래프 벡터 만들기·검사 (T-193, ADR 0015)
//   npm run build:vectors                       # 실제 확장(크롬, admin.embedding 모델, 한 문장씩)으로 모든 공통 관심사의
//                                               # 노드·태그 텍스트를 임베딩해 extension/data/vectors/<관심사>.json 에 쓴다
//        [--interest restaurant]                # 한 관심사만
//        [--verify]                             # 쓰지 않고, 브라우저로 다시 임베딩해 파일과 비트 단위로 같은지만 본다
//   npm run check:vectors                       # 크롬 없이(CI): 형식·embedderId·접두어가 admin.json과 맞는지(틀리면 실패),
//                                               # 그래프 텍스트와 어긋난 항목(stale)은 경고만(런타임은 그 항목만 임베딩한다)
//        [--strict]                             # stale도 실패로
// 텍스트는 확장과 같은 함수(embedItems(mergeGraphs(공통), admin.retrieval))로 만든다. 키는 sha1(텍스트), 접두어 없이(vecCache와 같은 규칙)
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mergeGraphs, embedItems, COMMON_INTERESTS } from '../extension/lib/graph.js';
import { loadInterestGraph, interestFromArgv } from './load-graph.mjs';
import { buildVectorFile, vectorFileProblems, vectorFileStaleness, precomputedPath, decodeVector } from '../extension/lib/precomputed-vectors.js';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const sha1 = s => createHash('sha1').update(s, 'utf8').digest('hex');
const expectedEmbedderId = `${admin.embedding.model}@${admin.embedding.dtype || 'q8'}`;
const passagePrefix = admin.embedding.passagePrefix ?? '';

// 관심사 → 임베딩할 고유 텍스트 [{ text, hash }]
export function graphTexts(interestId, retrieval = admin.retrieval) {
  const graph = mergeGraphs(loadInterestGraph(interestId), null);
  const seen = new Map();
  for (const it of embedItems(graph, retrieval)) if (!seen.has(it.text)) seen.set(it.text, { text: it.text, hash: sha1(it.text) });
  return { graph, texts: [...seen.values()] };
}

const fileUrl = id => new URL(`../extension/${precomputedPath(id)}`, here);
const readFile = id => fs.existsSync(fileUrl(id)) ? JSON.parse(fs.readFileSync(fileUrl(id))) : null;

const argv = process.argv;
const interests = argv.includes('--interest') ? [interestFromArgv(argv)] : COMMON_INTERESTS.map(i => i.id);

if (argv.includes('--check')) {
  // CI 판정(ADR 0015): 못 쓰는 파일(형식·임베더·접두어)은 실패, 어긋난 항목은 경고. --strict면 어긋남도 실패
  const strict = argv.includes('--strict');
  let fail = 0;
  for (const id of interests) {
    const f = readFile(id);
    if (!f) { console.log(`::warning::${id}: 미리 계산 벡터 파일이 없어요(${precomputedPath(id)}). 첫 로드에 모든 텍스트를 임베딩해요`); if (strict) fail++; continue; }
    const probs = vectorFileProblems(f);
    if (f.embedderId !== expectedEmbedderId) probs.push(`embedderId ${f.embedderId} ≠ admin.json ${expectedEmbedderId}`);
    if ((f.passagePrefix ?? '') !== passagePrefix) probs.push(`passagePrefix "${f.passagePrefix}" ≠ admin.json "${passagePrefix}"`);
    if (f.interest !== id) probs.push(`interest ${f.interest} ≠ ${id}`);
    if (probs.length) { console.log(`::error::${id}: ${probs.join(' / ')} → npm run build:vectors`); fail++; continue; }
    const { texts } = graphTexts(id);
    const s = vectorFileStaleness(f, texts.map(t => t.hash));
    const line = `${id}: 그래프 텍스트 ${texts.length}개 중 파일에 있음 ${texts.length - s.missing.length}, 빠짐 ${s.missing.length}, 남는 항목 ${s.extra.length}`;
    if (s.fresh) console.log(`${line} — 최신`);
    else {
      console.log(`::warning::${line} — npm run build:vectors 로 다시 만들어 같은 PR에 커밋하세요(빠진 항목은 런타임에 임베딩)`);
      if (strict) fail++;
    }
  }
  process.exit(fail ? 1 : 0);
}

const { openBrowserEmbedder } = await import('./browser-embedder.mjs');
const be = await openBrowserEmbedder();
let failed = 0;
try {
  if (be.embedderId !== expectedEmbedderId) throw new Error(`브라우저 임베더가 ${be.embedderId}예요(기대 ${expectedEmbedderId}). 대체 임베더로는 만들지 않아요`);
  console.log(`임베더 ${be.embedderId}, 준비 ${be.warmupMs}ms`);
  for (const id of interests) {
    const { graph, texts } = graphTexts(id);
    const t0 = Date.now();
    const vectors = await be.embed(texts.map(t => t.text), 'passage'); // 오프스크린이 한 문장씩(embedEach)
    const ms = Date.now() - t0;
    if (argv.includes('--verify')) {
      const f = readFile(id);
      if (!f) { console.log(`${id}: 파일 없음`); failed++; continue; }
      let same = 0, diff = 0, absent = 0, maxAbs = 0;
      texts.forEach((t, i) => {
        const b = f.vectors[t.hash];
        if (!b) { absent++; return; }
        const v = decodeVector(b, f.dim);
        let d = 0;
        for (let k = 0; k < v.length; k++) d = Math.max(d, Math.abs(v[k] - vectors[i][k]));
        maxAbs = Math.max(maxAbs, d);
        if (d === 0) same++; else diff++;
      });
      console.log(`${id}: 비트 동일 ${same}, 다름 ${diff}(최대 절대차 ${maxAbs}), 파일에 없음 ${absent} · 임베딩 ${ms}ms`);
      if (diff || absent) failed++;
      continue;
    }
    const file = buildVectorFile({ interest: id, embedderId: be.embedderId, passagePrefix, graphVersion: graph.version ?? null, entries: texts.map((t, i) => ({ hash: t.hash, vector: vectors[i] })) });
    fs.mkdirSync(new URL('../extension/data/vectors/', here), { recursive: true });
    fs.writeFileSync(fileUrl(id), JSON.stringify(file, null, 1) + '\n');
    console.log(`${id}: ${file.count}개 → ${precomputedPath(id)} (${(fs.statSync(fileUrl(id)).size / 1024).toFixed(0)}KB, 임베딩 ${ms}ms)`);
  }
} finally {
  await be.close();
}
process.exit(failed ? 1 : 0);
