// 운영자용 교정 검사(T-131). 설정 "운영자용 교정 내보내기"로 받은 JSON을 평가셋·검증셋·홀드아웃·가드 문장과 대조한다.
//   node tools/check-corrections.mjs <내보낸.json> [--out <결과.json>]
// - 관심사별(T-157): 파일의 interest(없으면 메이플)로 그 관심사의 평가 문장·그래프를 쓴다. 모르는 관심사면 오류.
//   그 관심사 그래프에 없는 노드를 가리키는 후보는 뺀다(두 관심사가 한 파일에 섞이지 않게).
// - 예문 후보 중 평가 문장을 베낀 것(글자 3-gram 자카드 ≥ 0.5)은 rejected(copies-eval)로 옮긴다. 평가 문장을 예문으로 넣으면 평가가 무의미해진다.
// - 지금 금칙어 목록(blocklist.json)으로 한 번 더 거른다(내보낸 뒤 목록이 늘었을 수 있다).
// - 이미 평가 문장과 거의 같은(≥ 0.8) 평가·가드 후보, 지금 공통 예문(tags.json)과 ≥ 0.5인 평가·가드 후보는 뺀다.
// - 예문 후보이기도 한 평가·가드 후보에는 alsoExampleCandidate: true. 한 문장은 한 곳에만 넣는다.
// 확장은 tools/ 파일을 못 읽어서 이 대조는 여기서만 한다. 결과는 사람이 읽고 고른다(.claude/commands/approve-corrections.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filterEvalCopies, EXPORT_KIND } from '../extension/lib/corrections.js';
import { activeTerms } from '../extension/lib/blocklist.js';
import { DEFAULT_INTEREST } from '../extension/lib/graph.js';
import { commonGraphPath, loadInterestGraph } from './load-graph.mjs';
import { interestEvalFiles } from './eval-lib.mjs';

const here = new URL('.', import.meta.url);
const readJson = u => JSON.parse(readFileSync(u, 'utf8'));

// 내보낸 파일의 관심사 id. interest가 없으면(T-157 이전 파일) 메이플, 모르는 id면 던진다
export function interestOf(exported) {
  const id = exported?.interest ?? DEFAULT_INTEREST;
  commonGraphPath(id); // 모르는 id면 "알 수 없는 관심사" 오류
  return id;
}

// 그 관심사의 평가셋 + (메이플만) 검증셋 + 홀드아웃 + 회귀 가드 문장(중복 없이). 파일 이름은 eval-lib interestEvalFiles(T-156)
export function evalSentencesFromDisk(interestId = DEFAULT_INTEREST) {
  commonGraphPath(interestId);
  const f = interestEvalFiles({ id: interestId });
  const caseFiles = interestId === DEFAULT_INTEREST
    ? [f.evalSet, 'eval-holdout.json', f.holdout] // 평가셋·검증셋·홀드아웃(T-150)
    : [f.evalSet, f.holdout];
  const cases = caseFiles.flatMap(n => readJson(new URL('./' + n, here))).map(c => c.sentence);
  return [...new Set([...cases, ...readJson(new URL('./' + f.guard, here))])];
}

/**
 * 그 관심사 그래프에 없는 노드를 가리키는 예문·평가·가드 후보를 뺀다. 받은 객체는 바꾸지 않는다.
 * @returns {{ out: object, dropped: number }}
 */
export function dropUnknownNodes(exported, graph) {
  const ids = new Set((graph?.nodes || []).map(n => n.id));
  let dropped = 0;
  const keep = (list, nodesOf) => (list || []).filter(c => {
    const ok = nodesOf(c).length > 0 && nodesOf(c).every(id => ids.has(id));
    if (!ok) dropped += 1;
    return ok;
  });
  const out = {
    ...exported,
    exampleCandidates: keep(exported.exampleCandidates, c => [c.nodeId].filter(Boolean)),
    evalCandidates: keep(exported.evalCandidates, c => c.expectNodes || []),
    guardCandidates: keep(exported.guardCandidates, c => c.expectNodes || [])
  };
  return { out, dropped };
}

// 지금 공통 태그 예문 전부(tags.json). 이미 예문인 문장을 평가·가드에 쓰지 않게 대조한다
export function commonExamplesFromDisk() {
  return readJson(new URL('../extension/data/common/tags.json', here)).tags.flatMap(t => t.examples || []);
}

export function blockTermsFromDisk() {
  return activeTerms(readJson(new URL('../extension/data/common/blocklist.json', here)));
}

function main(argv) {
  const file = argv.find(a => !a.startsWith('--'));
  const outIdx = argv.indexOf('--out');
  if (!file) {
    console.error('사용법: node tools/check-corrections.mjs <내보낸.json> [--out <결과.json>]');
    process.exit(2);
  }
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  if (exported?.kind !== EXPORT_KIND || exported.version !== 1) {
    console.error(`교정 내보내기 파일이 아니에요(kind=${exported?.kind}, version=${exported?.version}).`);
    process.exit(2);
  }
  let interest;
  try { interest = interestOf(exported); }
  catch (e) { console.error(e.message); process.exit(2); }
  const { out: known, dropped } = dropUnknownNodes(exported, loadInterestGraph(interest));
  // 결과 파일에는 interest를 늘 적는다(예전 파일도 메이플로 표시)
  const out = { ...filterEvalCopies(known, evalSentencesFromDisk(interest), { blockTerms: blockTermsFromDisk(), commonExamples: commonExamplesFromDisk() }), interest };
  console.log(`관심사: ${interest}${exported.interest ? '' : ' (interest 없는 예전 파일이라 메이플로 읽어요)'}`);
  if (dropped) console.log(`  주의: ${interest} 그래프에 없는 노드를 가리키는 후보 ${dropped}개를 뺐어요.`);
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : file.replace(/\.json$/, '') + '.checked.json';
  writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  const n = (a, b) => `${a.length}개${a.length !== b.length ? ` (내보낸 ${b.length}개)` : ''}`;
  console.log(`예문 후보 ${n(out.exampleCandidates, exported.exampleCandidates)}, 평가셋 후보 ${n(out.evalCandidates, exported.evalCandidates)}, 가드 후보 ${n(out.guardCandidates, exported.guardCandidates)}`);
  for (const r of out.rejected) console.log(`  거름 ${r.tagId} ${r.reason} ${r.count}`);
  const both = [...out.evalCandidates, ...out.guardCandidates].filter(c => c.alsoExampleCandidate).length;
  if (both) console.log(`  주의: 예문 후보이기도 한 평가·가드 후보 ${both}개(alsoExampleCandidate). 한 문장은 예문이나 평가셋·가드 중 한 곳에만 넣어요.`);
  console.log(`→ ${outFile}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
