// 운영자용 교정 검사(T-131). 설정 "운영자용 교정 내보내기"로 받은 JSON을 평가셋·검증셋·홀드아웃·가드 문장과 대조한다.
//   node tools/check-corrections.mjs <내보낸.json> [--out <결과.json>]
// - 예문 후보 중 평가 문장을 베낀 것(글자 3-gram 자카드 ≥ 0.5)은 rejected(copies-eval)로 옮긴다. 평가 문장을 예문으로 넣으면 평가가 무의미해진다.
// - 지금 금칙어 목록(blocklist.json)으로 한 번 더 거른다(내보낸 뒤 목록이 늘었을 수 있다).
// - 이미 평가 문장과 거의 같은(≥ 0.8) 평가·가드 후보, 지금 공통 예문(tags.json)과 ≥ 0.5인 평가·가드 후보는 뺀다.
// - 예문 후보이기도 한 평가·가드 후보에는 alsoExampleCandidate: true. 한 문장은 한 곳에만 넣는다.
// 확장은 tools/ 파일을 못 읽어서 이 대조는 여기서만 한다. 결과는 사람이 읽고 고른다(.claude/commands/approve-corrections.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filterEvalCopies, EXPORT_KIND } from '../extension/lib/corrections.js';
import { activeTerms } from '../extension/lib/blocklist.js';

const here = new URL('.', import.meta.url);
const readJson = u => JSON.parse(readFileSync(u, 'utf8'));

// 평가셋 + 검증셋 + 홀드아웃 + 회귀 가드 문장(중복 없이)
export function evalSentencesFromDisk() {
  const cases = ['./eval-set.json', './eval-holdout.json', './eval-unseen.json'] // 평가셋·검증셋·홀드아웃(T-150)
    .flatMap(f => readJson(new URL(f, here))).map(c => c.sentence);
  return [...new Set([...cases, ...readJson(new URL('./eval-guard.json', here))])];
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
  const out = filterEvalCopies(exported, evalSentencesFromDisk(), { blockTerms: blockTermsFromDisk(), commonExamples: commonExamplesFromDisk() });
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
