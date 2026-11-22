// Node 도구·테스트용 공통 그래프 로더(T-304). 확장 stores.js loadCommonGraph와 같은 규칙:
// 관심사 그래프 파일 + 같은 폴더의 tags.json → 해석된 그래프({ ...graph, tags }), 검증 오류면 던진다.
// 공통 그래프를 디스크에서 읽는 곳은 모두 이 함수를 쓴다(maplestory.json을 직접 읽지 않는다)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommonGraph, validateGraph, validateTagsFile, commonInterest, DEFAULT_INTEREST, COMMON_INTERESTS } from '../extension/lib/graph.js';

export const DEFAULT_COMMON_GRAPH_PATH = fileURLToPath(new URL('../extension/data/common/maplestory.json', import.meta.url));

// 공통 관심사 id → 그래프 파일 경로(T-302). 모르는 id는 오류(도구에서 조용히 메이플로 바뀌면 결과를 잘못 읽는다)
export function commonGraphPath(interestId = DEFAULT_INTEREST) {
  const it = commonInterest(interestId);
  if (!it) throw new Error(`알 수 없는 관심사: ${interestId} (가능: ${COMMON_INTERESTS.map(i => i.id).join(', ')})`);
  return fileURLToPath(new URL(`../extension/data/common/${it.file}`, import.meta.url));
}

// 관심사 id로 해석된 공통 그래프
export function loadInterestGraph(interestId = DEFAULT_INTEREST) {
  return loadCommonGraphFromDisk(commonGraphPath(interestId));
}

// 명령줄 --interest <id>. 없으면 기본 관심사, 값이 없거나 모르는 id면 오류
export function interestFromArgv(argv) {
  const i = argv.indexOf('--interest');
  if (i < 0) return DEFAULT_INTEREST;
  const id = argv[i + 1];
  if (!id || id.startsWith('-')) throw new Error('--interest 뒤에 관심사 id가 필요해요 (예: --interest restaurant)');
  commonGraphPath(id); // 모르는 id면 여기서 던진다
  return id;
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

export function loadCommonGraphFromDisk(graphPath = DEFAULT_COMMON_GRAPH_PATH, { tagsPath } = {}) {
  const graph = readJson(graphPath);
  let tagsFile = null;
  if (!Array.isArray(graph.tags)) {
    tagsFile = readJson(tagsPath || join(dirname(graphPath), 'tags.json'));
    const errors = validateTagsFile(tagsFile);
    if (errors.length) throw new Error('태그 파일 오류: ' + errors.join(' / '));
  }
  const resolved = resolveCommonGraph(graph, tagsFile);
  const errors = validateGraph(resolved);
  if (errors.length) throw new Error('공통 그래프 오류: ' + errors.join(' / '));
  return resolved;
}
