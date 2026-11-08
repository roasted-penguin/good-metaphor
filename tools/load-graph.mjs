// Node 도구·테스트용 공통 그래프 로더(T-304). 확장 stores.js loadCommonGraph와 같은 규칙:
// 관심사 그래프 파일 + 같은 폴더의 tags.json → 해석된 그래프({ ...graph, tags }), 검증 오류면 던진다.
// 공통 그래프를 디스크에서 읽는 곳은 모두 이 함수를 쓴다(maplestory.json을 직접 읽지 않는다)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommonGraph, validateGraph, validateTagsFile } from '../extension/lib/graph.js';

export const DEFAULT_COMMON_GRAPH_PATH = fileURLToPath(new URL('../extension/data/common/maplestory.json', import.meta.url));

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
