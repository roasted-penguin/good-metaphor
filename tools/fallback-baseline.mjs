// 대체 임베더 기준선 (T-179). eval.mjs가 --fallback --baseline / --write-baseline일 때 부른다.
// 메이플 평가셋·검증셋·홀드아웃, 식당 평가셋·홀드아웃을 한 번에 혼합 기본값으로 채점해
// 문장별 1위·상위 3개를 tools/eval-fallback-baseline.json과 비교하거나(--baseline) 새로 쓴다(--write-baseline).
// 실패(종료 코드 1): 기준선에서 1위가 맞던 문장(음성 문장은 통과하던 문장)이 지금 틀리면. 나머지는 정보로만 보인다.
// 새로 맞힌 문장이 있거나 잃은 것을 받아들이면 --write-baseline으로 파일을 다시 쓰고 같은 PR에 커밋한다(차이가 기록이 된다).
import fs from 'node:fs';
import { mergeGraphs, embedItems, COMMON_INTERESTS } from '../extension/lib/graph.js';
import { retrieve } from '../extension/lib/retrieval.js';
import { hashEmbed, FALLBACK_ID } from '../extension/lib/fallback-embed.js';
import { loadInterestGraph } from './load-graph.mjs';
import { mixedSetting, interestEvalFiles, baselineRows, compareBaseline, baselineFailCount, baselineMetaWarnings, baselineReportLines } from './eval-lib.mjs';

const here = new URL('.', import.meta.url);
export const BASELINE_FILE = 'eval-fallback-baseline.json';
const readJson = f => JSON.parse(fs.readFileSync(new URL(f, here), 'utf8'));

// 관심사별 셋 목록: [셋 이름, 파일]. 셋 이름이 기준선 파일의 열쇠다
function setsFor(interest) {
  const f = interestEvalFiles(interest);
  if (interest.id === 'maplestory') return [['maplestory/eval', f.evalSet], ['maplestory/validation', 'eval-holdout.json'], ['maplestory/holdout', f.holdout]];
  return [[`${interest.id}/eval`, f.evalSet], [`${interest.id}/holdout`, f.holdout]];
}

// 지금 코드로 모든 셋을 채점한다 → { meta, sets }
export function computeFallbackBaseline(admin) {
  const meta = { embedderId: FALLBACK_ID, tagsVersion: null, graphs: {} };
  const sets = {};
  for (const interest of COMMON_INTERESTS) {
    const common = loadInterestGraph(interest.id);
    meta.graphs[interest.id] = common.version;
    meta.tagsVersion = common.tagsVersion ?? meta.tagsVersion;
    const graph = mergeGraphs(common, null);
    const items = embedItems(graph, admin.retrieval);
    const vecs = new Map(items.map(it => [it.key, hashEmbed(it.text)]));
    const { name, topK, ...opts } = mixedSetting(admin, graph);
    for (const [setName, file] of setsFor(interest)) {
      if (!fs.existsSync(new URL(file, here))) continue;
      const cases = readJson(file);
      const rank = c => retrieve(hashEmbed(c.sentence), graph, vecs, { ...opts, topK: 3, aliasText: c.sentence });
      sets[setName] = baselineRows(cases, rank);
    }
  }
  if (!meta.tagsVersion) meta.tagsVersion = readJson('../extension/data/common/tags.json').version;
  return { meta, sets };
}

// 셋별 hit@1 요약 (사람이 파일을 읽기 쉽게)
function summaryOf(sets) {
  const out = {};
  for (const [name, rows] of Object.entries(sets)) {
    const hits = rows.filter(r => r.kind === 'hit');
    out[name] = { n: hits.length, hit1: hits.filter(r => r.hit1).length, hit3: hits.filter(r => r.hit3).length };
    const neg = rows.filter(r => r.kind === 'negative');
    if (neg.length) out[name].negativePass = `${neg.filter(r => r.hit1).length}/${neg.length}`;
  }
  return out;
}

// 문장 한 줄 = JSON 한 줄. PR 차이에서 바뀐 문장만 보이게 한다
export function formatBaseline(body) {
  const { sets, ...head } = body;
  const headJson = JSON.stringify(head, null, 2).slice(0, -2); // 마지막 "\n}" 떼기
  const setJson = Object.entries(sets).map(([k, rows]) =>
    `    ${JSON.stringify(k)}: [\n${rows.map(r => '      ' + JSON.stringify(r)).join(',\n')}\n    ]`).join(',\n');
  return `${headJson},\n  "sets": {\n${setJson}\n  }\n}\n`;
}

// argv: --baseline(비교) 또는 --write-baseline(다시 쓰기). 종료 코드를 돌려준다
export function runFallbackBaseline(argv, admin, { retrievalOverridden = false } = {}) {
  const fileUrl = new URL(BASELINE_FILE, here);
  const { meta, sets } = computeFallbackBaseline(admin);
  if (argv.includes('--write-baseline')) {
    if (retrievalOverridden) throw new Error('--retrieval 덮어쓰기와 --write-baseline은 같이 못 써요(기준선은 admin.json 기본값 기준)');
    const body = {
      note: '대체 임베더(fallback-embed.js) 기준선(T-179). 혼합 기본값 문장별 1위·상위 3개. 다시 쓰기: npm run eval:fallback -- --write-baseline',
      ...meta,
      summary: summaryOf(sets),
      sets
    };
    fs.writeFileSync(fileUrl, formatBaseline(body));
    console.log(`기준선을 썼어요: tools/${BASELINE_FILE}`);
    for (const [k, v] of Object.entries(body.summary)) console.log(`  ${k.padEnd(22)} hit@1 ${v.hit1}/${v.n}  hit@3 ${v.hit3}/${v.n}${v.negativePass ? '  음성 ' + v.negativePass : ''}`);
    return 0;
  }
  if (!fs.existsSync(fileUrl)) throw new Error(`기준선 파일이 없어요: tools/${BASELINE_FILE} (npm run eval:fallback -- --write-baseline)`);
  const base = JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
  console.log(`대체 임베더 기준선 비교 (${meta.embedderId}, 혼합 기본값)`);
  if (retrievalOverridden) console.log('  ⚠ --retrieval 덮어쓰기 중: 기준선은 admin.json 기본값으로 썼어요');
  for (const w of baselineMetaWarnings(base, meta)) console.log(`  ⚠ ${w}`);
  const cur = summaryOf(sets);
  for (const [k, v] of Object.entries(cur)) {
    const b = base.summary?.[k];
    console.log(`  ${k.padEnd(22)} hit@1 ${b ? b.hit1 + '→' : ''}${v.hit1}/${v.n}  hit@3 ${b ? b.hit3 + '→' : ''}${v.hit3}/${v.n}${v.negativePass ? '  음성 ' + v.negativePass : ''}`);
  }
  const cmp = compareBaseline(base.sets, sets);
  console.log('\n' + baselineReportLines(cmp).join('\n'));
  const fails = baselineFailCount(cmp);
  const gained = Object.values(cmp).reduce((n, d) => n + d.newlyRight.length + d.added.length + d.removed.length, 0);
  if (fails) {
    console.log(`\n기준선 회귀 ${fails}건: 기준선에서 맞던 문장이 1위에서 틀렸어요.`);
    console.log('받아들이면(순이익이 크면) npm run eval:fallback -- --write-baseline 으로 다시 쓰고 PR 본문에 잃은 문장을 적어요.');
    return 1;
  }
  if (gained) console.log('\n회귀 없음. 새로 맞힌 문장·바뀐 셋이 있어요: npm run eval:fallback -- --write-baseline 으로 기준선을 갱신해 주세요.');
  else console.log('\n회귀 없음.');
  return 0;
}
