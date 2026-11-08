// T-304: 추상 태그를 공통 파일(data/common/tags.json)로 분리.
// 합치는 곳은 런타임마다 로더 한 곳(확장 stores.js, Node tools/load-graph.mjs, 서버 load_common_graph)이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeGraphs, nodeText, validateGraph, resolveCommonGraph, validateTagsFile } from '../../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const rawGraph = read('extension/data/common/maplestory.json');
const tagsFile = read('extension/data/common/tags.json');
const PROV = { sources: ['https://maplestory.nexon.com/News/Update/799'], verifiedAt: '2026-10-11' };

// 분리 전 maplestory.json tags의 id 순서. 순서가 바뀌면 nodeText·검색 순위가 바뀐다
const TAG_ORDER = [
  'prob_upgrade', 'escalating_cost', 'loss_risk', 'threshold_req', 'progression_gate', 'market_price',
  'inflation', 'scarcity_value', 'periodic_cap', 'daily_accumulation', 'diminishing_returns', 'temporary_multiplier',
  'cooldown', 'random_reroll', 'expected_value', 'shared_bonus', 'role_division', 'efficiency_metric'
];
const sha1 = s => createHash('sha1').update(s).digest('hex');

test('관심사 그래프 파일에는 tags가 없고, tags.json은 { version, tags } 모양이다', () => {
  assert.equal('tags' in rawGraph, false, 'maplestory.json에 tags가 남아 있어요');
  assert.equal(typeof tagsFile.version, 'string');
  assert.ok(Array.isArray(tagsFile.tags));
  assert.deepEqual(validateTagsFile(tagsFile), []);
});

test('해석된 공통 그래프의 태그는 분리 전과 같은 18개, 같은 순서', () => {
  const g = loadCommonGraphFromDisk();
  assert.deepEqual(g.tags.map(t => t.id), TAG_ORDER);
  assert.deepEqual(validateGraph(g), []);
  // 노드 태그 id 배열은 그대로
  assert.deepEqual(g.nodes, rawGraph.nodes);
});

test('nodeText 스냅숏: 분리 전과 바이트 단위로 같다 (벡터 캐시·검색 불변)', () => {
  const g = mergeGraphs(loadCommonGraphFromDisk(), null);
  const tagMap = new Map(g.tags.map(t => [t.id, t]));
  const text = id => nodeText(g.nodes.find(n => n.id === id), tagMap);
  // T-152: loss_risk 예문 추가로 starforce·전체 해시가 바뀌었다(태그 예문을 바꾸면 여기 값을 새로 잰다)
  // T-153: sol_erda에서 scarcity_value 태그를 빼 sol_erda·전체 해시가 바뀐다
  assert.equal(sha1(text('starforce')), '5303d3c5de5c878933c1db407d87d32f8a07d9ba');
  assert.equal(sha1(text('sol_erda')), '7d32aa20155a45a6f7e367d6412601fdb8222384');
  assert.equal(sha1(g.nodes.map(n => nodeText(n, tagMap)).join('\n')), '1cf28ae805c9be067d763aea3d79da940d5841da');
  assert.equal(g.tags.length, 18);
});

test('resolveCommonGraph: 태그 파일을 합치고, 그래프에 tags가 이미 있으면 그대로 쓴다(하위 호환)', () => {
  const tf = { version: 'v', tags: [{ id: 'a', label: 'A' }] };
  assert.deepEqual(resolveCommonGraph({ domain: 'd', nodes: [] }, tf).tags, tf.tags);
  const own = [{ id: 'b', label: 'B' }];
  assert.deepEqual(resolveCommonGraph({ domain: 'd', tags: own, nodes: [] }, tf).tags, own);
  assert.deepEqual(resolveCommonGraph({ domain: 'd', tags: own, nodes: [] }, null).tags, own);
  assert.deepEqual(resolveCommonGraph({ domain: 'd', nodes: [] }, null).tags, []);
  // 원본 객체는 건드리지 않는다
  const g = { domain: 'd', nodes: [] };
  resolveCommonGraph(g, tf);
  assert.equal('tags' in g, false);
});

test('공통 그래프 검증: 노드가 없는 태그 id를 참조하면 오류, 오버레이(partial)는 아니다', () => {
  const g = {
    domain: 'd', tags: [{ id: 't', label: 'T' }],
    nodes: [{ id: 'n', label: 'N', facts: ['f'], tags: ['t', 'no_such_tag'], ...PROV }]
  };
  assert.match(validateGraph(g).join(), /no_such_tag/);
  assert.deepEqual(validateGraph(g, { partial: true }), []);
});

test('validateTagsFile: 태그 목록 검증(id·label·중복·examples)', () => {
  assert.match(validateTagsFile(null).join(), /객체/);
  assert.match(validateTagsFile({ version: 'v' }).join(), /tags/);
  assert.match(validateTagsFile({ version: 'v', tags: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).join(), /중복/);
  assert.match(validateTagsFile({ version: 'v', tags: [{ id: 'a' }] }).join(), /label/);
  assert.match(validateTagsFile({ version: 'v', tags: [{ id: 'a', label: 'A', examples: 'x' }] }).join(), /examples/);
  assert.match(validateTagsFile({ tags: [{ id: 'a', label: 'A' }] }).join(), /version/);
});

/* ───────────── 확장 로더(stores.js loadCommonGraph) ───────────── */

const EXT = fileURLToPath(new URL('../../extension/', import.meta.url));
function mockChrome(routes = {}) {
  const seen = [];
  globalThis.chrome = {
    runtime: { getURL: p => 'ext://x/' + p },
    storage: { managed: { get: async () => ({}) } }
  };
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (url in routes) {
      const v = routes[url];
      return v === null ? { ok: false, status: 404, json: async () => { throw new Error('404'); } }
        : { ok: true, status: 200, json: async () => structuredClone(v) };
    }
    if (String(url).startsWith('ext://x/')) {
      const body = readFileSync(EXT + String(url).slice('ext://x/'.length), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  return seen;
}

test('확장 로더: 번들 그래프 옆 tags.json을 읽어 합친다', async () => {
  const seen = mockChrome();
  const { loadCommonGraph } = await import('../../extension/lib/stores.js');
  const g = await loadCommonGraph({ fresh: true });
  assert.ok(seen.includes('ext://x/data/common/tags.json'), seen.join());
  assert.deepEqual(g.tags.map(t => t.id), TAG_ORDER);
  assert.deepEqual(g, loadCommonGraphFromDisk());
});

test('확장 로더: 원격 그래프에 tags가 있으면 그대로, 없으면 같은 주소의 tags.json', async () => {
  const { loadCommonGraph } = await import('../../extension/lib/stores.js');
  const { getAdminConfig } = await import('../../extension/lib/config.js');
  const base = 'https://example.test/common/';
  const remote = { ...rawGraph };
  const remoteTags = { version: 'r', tags: tagsFile.tags };

  let seen = mockChrome({ [base + 'maplestory.json']: remote, [base + 'tags.json']: remoteTags });
  const admin = await getAdminConfig();
  const saved = admin.commonStore;
  try {
    admin.commonStore = { ...saved, url: base + 'maplestory.json' };
    let g = await loadCommonGraph({ fresh: true });
    assert.ok(seen.includes(base + 'tags.json'), seen.join());
    assert.deepEqual(g.tags.map(t => t.id), TAG_ORDER);

    const withTags = { ...rawGraph, tags: [tagsFile.tags[0]], nodes: rawGraph.nodes.filter(n => n.tags.every(t => t === tagsFile.tags[0].id)) };
    seen = mockChrome({ [base + 'maplestory.json']: withTags });
    g = await loadCommonGraph({ fresh: true });
    assert.equal(seen.includes(base + 'tags.json'), false, '원격 그래프에 tags가 있으면 태그 파일을 받지 않아요');
    assert.deepEqual(g.tags, [tagsFile.tags[0]]);
  } finally {
    admin.commonStore = saved;
  }
});

test('태그 판본이 해석된 그래프와 병합 결과 sources.common에 실린다(결과 캐시 graphKey, T-304 수정 1)', () => {
  const tf = { version: 'tags-7', tags: [{ id: 'a', label: 'A' }] };
  const g = resolveCommonGraph({ id: 'x', version: 'g-1', domain: 'd', nodes: [] }, tf);
  assert.equal(g.tagsVersion, 'tags-7');
  assert.deepEqual(mergeGraphs(g, null).sources.common, { id: 'x', version: 'g-1', tagsVersion: 'tags-7' });
  // 태그가 그래프에 들어 있으면(하위 호환) 태그 판본 없음
  const inline = resolveCommonGraph({ id: 'x', version: 'g-1', domain: 'd', tags: tf.tags, nodes: [] }, tf);
  assert.equal(inline.tagsVersion, null);
  assert.equal(mergeGraphs(inline, null).sources.common.tagsVersion, null);
  // 실제 공통 그래프
  assert.equal(mergeGraphs(loadCommonGraphFromDisk(), null).sources.common.tagsVersion, tagsFile.version);
});
