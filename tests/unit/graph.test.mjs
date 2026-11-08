import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeGraphs, validateGraph, nodeText, tagText, tagDescText, embedItems } from '../../extension/lib/graph.js';
import { validateOverlay } from '../../extension/lib/stores.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

// 해석된 공통 그래프 = maplestory.json + tags.json (T-304)
const common = loadCommonGraphFromDisk();
// 공통 그래프 노드에 필요한 출처·검수 날짜(T-118). 검증 규칙만 보는 테스트 그래프에 붙인다
const PROV = { sources: ['https://maplestory.nexon.com/News/Update/799'], verifiedAt: '2026-10-11' };

test('공통 그래프는 스키마 검사를 통과한다', () => {
  assert.deepEqual(validateGraph(common), []);
});

test('공통 그래프의 모든 노드 태그와 엣지가 실제로 존재한다', () => {
  const tagIds = new Set(common.tags.map(t => t.id));
  const nodeIds = new Set(common.nodes.map(n => n.id));
  for (const n of common.nodes) for (const t of n.tags) assert.ok(tagIds.has(t), `${n.id}의 태그 ${t}`);
  for (const e of common.edges) assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to), `${e.from}→${e.to}`);
});

test('로그아웃 상태(오버레이 없음)는 공통 그래프 그대로', () => {
  const g = mergeGraphs(common, null);
  assert.equal(g.domain, '메이플스토리');
  assert.equal(g.theme, 'maple');
  assert.equal(g.nodes.length, common.nodes.length);
  assert.equal(g.sources.userNodes, 0);
});

test('오버레이: 숨김·추가·가중치가 합쳐진다', () => {
  const g = mergeGraphs(common, {
    hiddenNodeIds: ['sol_erda'],
    nodeBoosts: { starforce: 0.1 },
    nodes: [{ id: 'u:mine', label: '내 루틴', facts: ['매일 한다'], tags: ['daily_accumulation', 'no_such_tag'] }]
  });
  assert.ok(!g.nodes.some(n => n.id === 'sol_erda'));
  const mine = g.nodes.find(n => n.id === 'u:mine');
  assert.equal(mine.source, 'user');
  assert.deepEqual(mine.tags, ['daily_accumulation'], '없는 태그는 버린다');
  assert.equal(g.boosts.starforce, 0.1);
  assert.ok(!g.edges.some(e => e.from === 'sol_erda' || e.to === 'sol_erda'), '숨긴 노드의 엣지도 빠진다');
});

test('가중치: 손으로 넣은 nodeBoosts와 피드백 feedbackBoosts를 더하고 -0.2~0.2로 자른다 (T-130)', () => {
  const g = mergeGraphs(common, {
    nodeBoosts: { starforce: 0.1, cube: -0.2, meso: 0.15 },
    feedbackBoosts: { starforce: -0.05, cube: -0.1, auction: -0.05, meso: 0.1 }
  });
  assert.equal(g.boosts.starforce, 0.05);
  assert.equal(g.boosts.cube, -0.2, '하한');
  assert.equal(g.boosts.meso, 0.2, '상한');
  assert.equal(g.boosts.auction, -0.05, '피드백만 있으면 그 값');
  assert.equal(mergeGraphs(common, null).boosts.starforce, undefined);
});

test('관심사 변경(useCommon=false): 공통 노드는 빠지고 공통 태그 사전은 재사용', () => {
  const g = mergeGraphs(common, {
    useCommon: false, domain: '축구', theme: 'neutral',
    nodes: [{ id: 'u:offside', label: '오프사이드', facts: ['반칙이다'], tags: ['threshold_req'] }]
  });
  assert.equal(g.domain, '축구');
  assert.equal(g.analogyPrefix, '축구로 치면');
  assert.equal(g.theme, 'neutral');
  assert.deepEqual(g.nodes.map(n => n.id), ['u:offside']);
  assert.deepEqual(g.tags.map(t => t.id), ['threshold_req'], '쓰이는 태그만 검색 대상');
});

test('오버레이 검증: u: 접두어와 domain 규칙', () => {
  assert.match(validateOverlay({ nodes: [{ id: 'x', label: 'a', facts: ['f'], tags: ['t'] }] }).join(), /u:/);
  assert.match(validateOverlay({ useCommon: false }).join(), /domain/);
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'] }] }), []);
});

test('노드 임베딩 텍스트에 태그 라벨이 들어간다', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  const t = nodeText(common.nodes.find(n => n.id === 'starforce'), tagMap);
  assert.match(t, /확률형 강화/);
});

test('노드 임베딩 텍스트: 태그 설명이 모두 facts보다 앞에 온다 (T-113, 구조 비중 ↑)', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  const n = common.nodes.find(n => n.id === 'starforce');
  const t = nodeText(n, tagMap);
  const firstFact = t.indexOf(n.facts[0]);
  assert.ok(firstFact > 0, '사실이 빠졌어요');
  assert.ok(t.includes(n.label));
  for (const id of n.tags) {
    const at = t.indexOf(tagMap.get(id).desc);
    assert.ok(at >= 0 && at < firstFact, `${id} 설명이 사실보다 앞에 있어야 해요`);
  }
});

test('태그 임베딩 텍스트에 예문(examples)이 들어간다 (T-113)', () => {
  const t = tagText({ id: 'x', label: '라벨', desc: '설명', examples: ['첫 예문', '둘째 예문'] });
  assert.match(t, /라벨: 설명/);
  assert.match(t, /첫 예문/);
  assert.match(t, /둘째 예문/);
});

test('태그 examples는 문자열 배열이어야 한다', () => {
  const g = ex => ({ domain: 'd', tags: [{ id: 't', label: 'l', examples: ex }], nodes: [] });
  assert.match(validateGraph(g('x')).join(), /examples/);
  assert.match(validateGraph(g([1])).join(), /examples/);
  assert.deepEqual(validateGraph(g(['문장'])), []);
});

// 글자 3-gram 자카드: 예문이 평가 문장을 베꼈는지 본다
const grams = s => { const t = s.replace(/\s+/g, ' '); const out = new Set(); for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
const jaccard = (a, b) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n); };

test('공통 그래프 태그마다 예문 2개 이상, 평가셋·검증셋·홀드아웃 문장을 베끼지 않는다 (누설 검사)', () => {
  const evalSentences = [
    ...JSON.parse(readFileSync('tools/eval-set.json', 'utf8')),
    ...JSON.parse(readFileSync('tools/eval-holdout.json', 'utf8')),
    ...JSON.parse(readFileSync('tools/eval-unseen.json', 'utf8')) // 홀드아웃(T-150)
  ].map(c => c.sentence);
  for (const t of common.tags) {
    assert.ok(Array.isArray(t.examples) && t.examples.length >= 2, `${t.id} 예문 부족`);
    for (const ex of t.examples) for (const s of evalSentences) {
      assert.ok(jaccard(ex, s) < 0.3, `${t.id} 예문 "${ex}"이 평가 문장 "${s}"과 너무 비슷해요`);
    }
  }
});

test('태그는 통제 어휘 18개 그대로 (규칙 9)', () => {
  assert.deepEqual(common.tags.map(t => t.id).sort(), [
    'cooldown', 'daily_accumulation', 'diminishing_returns', 'efficiency_metric', 'escalating_cost', 'expected_value',
    'inflation', 'loss_risk', 'market_price', 'periodic_cap', 'prob_upgrade', 'progression_gate', 'random_reroll',
    'role_division', 'scarcity_value', 'shared_bonus', 'temporary_multiplier', 'threshold_req'
  ]);
});

// --- T-114 별칭(aliases): 게임 은어로 쓴 문장도 검색되게 ---

test('노드 aliases 검증: 문자열 배열, 각 1~20자 (T-114)', () => {
  const g = aliases => ({ domain: 'd', tags: [{ id: 't', label: 'l' }], nodes: [{ id: 'n', label: '라벨', facts: ['f'], tags: ['t'], aliases, ...PROV }] });
  assert.deepEqual(validateGraph(g(['재획', '스무 글자까지는 괜찮아요 정말로요요'])), []);
  assert.deepEqual(validateGraph(g([])), []);
  assert.match(validateGraph(g('재획')).join(), /aliases/);
  assert.match(validateGraph(g([1])).join(), /aliases/);
  assert.match(validateGraph(g([''])).join(), /aliases/);
  assert.match(validateGraph(g(['   '])).join(), /aliases/);
  assert.match(validateGraph(g(['가'.repeat(21)])).join(), /aliases/);
  assert.deepEqual(validateGraph(g(['가'.repeat(20)])), []);
});

test('노드 weakAliases 검증: aliases와 같은 규칙 (T-149)', () => {
  const g = weakAliases => ({ domain: 'd', tags: [{ id: 't', label: 'l' }], nodes: [{ id: 'n', label: '라벨', facts: ['f'], tags: ['t'], weakAliases, ...PROV }] });
  assert.deepEqual(validateGraph(g(['펑'])), []);
  assert.deepEqual(validateGraph(g(undefined)), []);
  assert.match(validateGraph(g('펑')).join(), /weakAliases/);
  assert.match(validateGraph(g([''])).join(), /weakAliases/);
  assert.match(validateGraph(g(['가'.repeat(21)])).join(), /weakAliases/);
  assert.match(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], weakAliases: [3] }] }).join(), /weakAliases/);
});

test('오버레이 노드의 aliases도 같은 규칙으로 검사한다 (T-114)', () => {
  assert.match(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], aliases: [''] }] }).join(), /aliases/);
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], aliases: ['별칭'] }] }), []);
});

test('nodeText: 별칭은 임베딩 텍스트에 넣지 않는다. 모든 노드가 예전과 바이트 단위로 같다 (벡터 캐시·검색 불변, T-114 재설계)', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  // 예전 구현 그대로(T-113)
  const before = n => `${n.tags.map(id => tagMap.get(id)).filter(Boolean).map(tagText).join(' ')} ${n.label}. ${n.facts.join(' ')}`.trim();
  for (const n of common.nodes) {
    const { aliases, ...plain } = n;
    assert.equal(nodeText(n, tagMap), before(plain), `${n.id}`);
  }
  const n = { id: 'x', label: '스타포스 강화', facts: ['사실.'], tags: [], aliases: ['펑', '프텍'] };
  assert.equal(nodeText(n, tagMap), '스타포스 강화. 사실.');
});

test('공통 그래프 aliases: naming-meme.md A 표의 은어가 대응 노드에 있다 (T-114)', () => {
  const byId = Object.fromEntries(common.nodes.map(n => [n.id, n.aliases || []]));
  const expected = {
    hunting: ['재획'], skill_cooldown: ['극딜'], starforce: ['프텍'], arcane_symbol: [],
    meso: ['쌀먹'], auction: ['쌀먹'], boss_entry: ['데카', '풀데카', '최소컷'], arcane_force: ['최소컷'],
    cube: ['잡옵'], weekly_boss: ['메요일'],
    // 기사·버스는 뉴스·교통 글에 흔한 일상어라 뺐다(최종 리뷰, 부정 평가 문장은 T-149)
    party: []
  };
  for (const [id, aliases] of Object.entries(expected)) assert.deepEqual(byId[id], aliases, id);
  // 펑·세금은 일상어와 겹쳐 약한 별칭으로 옮겼다(T-149). 메이플 단서가 함께 있을 때만 가산
  const weak = Object.fromEntries(common.nodes.filter(n => n.weakAliases).map(n => [n.id, n.weakAliases]));
  assert.deepEqual(weak, { starforce: ['펑'], arcane_symbol: ['세금'] });
  assert.equal(common.version, '2026.11.09-3'); // T-153 sol_erda 희소성 태그 제거
});

test('평가셋에 은어 문장 4개, 대응 노드가 그래프에 있다 (T-114)', () => {
  const evalSet = JSON.parse(readFileSync('tools/eval-set.json', 'utf8'));
  const slang = evalSet.filter(c => c.since === 'T-114');
  assert.equal(slang.length, 4);
  const ids = new Set(common.nodes.map(n => n.id));
  for (const c of slang) {
    assert.equal(c.group, 'slang');
    assert.ok(c.expectNodes.length && c.expectNodes.every(id => ids.has(id)), c.sentence);
  }
  const guard = JSON.parse(readFileSync('tools/eval-guard.json', 'utf8'));
  const guardText = JSON.stringify(guard);
  for (const c of slang) assert.ok(!guardText.includes(c.sentence), '은어 문장은 회귀 가드에 넣지 않는다');
});

// --- T-118 출처(sources)·검수 날짜(verifiedAt) ---

const provGraph = over => ({ domain: 'd', tags: [{ id: 't', label: 'l' }], nodes: [{ id: 'n', label: '라벨', facts: ['f'], tags: ['t'], ...PROV, ...over }] });

test('공통 그래프 노드는 sources(http(s) URL 1개 이상)와 verifiedAt(YYYY-MM-DD)이 있어야 한다 (T-118)', () => {
  assert.deepEqual(validateGraph(provGraph({})), []);
  const { sources, ...noSources } = provGraph({}).nodes[0];
  assert.match(validateGraph({ ...provGraph({}), nodes: [noSources] }).join(), /sources/);
  const { verifiedAt, ...noDate } = provGraph({}).nodes[0];
  assert.match(validateGraph({ ...provGraph({}), nodes: [noDate] }).join(), /verifiedAt/);
  assert.match(validateGraph(provGraph({ sources: [] })).join(), /sources/);
  assert.match(validateGraph(provGraph({ sources: 'https://maplestory.nexon.com' })).join(), /sources/);
  assert.match(validateGraph(provGraph({ sources: ['maplestory.nexon.com/News/Update/799'] })).join(), /sources/, 'URL이 아니면 오류');
  assert.match(validateGraph(provGraph({ sources: ['ftp://maplestory.nexon.com/x'] })).join(), /sources/, 'http(s)만');
  assert.match(validateGraph(provGraph({ sources: ['https://ok.example/a', 'javascript:alert(1)'] })).join(), /sources/);
  assert.match(validateGraph(provGraph({ verifiedAt: '2026-10' })).join(), /verifiedAt/);
  assert.match(validateGraph(provGraph({ verifiedAt: '2026/10/11' })).join(), /verifiedAt/);
  assert.match(validateGraph(provGraph({ verifiedAt: '2026-02-30' })).join(), /verifiedAt/, '없는 날짜');
  assert.match(validateGraph(provGraph({ verifiedAt: '2026-13-01' })).join(), /verifiedAt/);
  assert.deepEqual(validateGraph(provGraph({ sources: ['http://a.example/x', 'https://b.example/y?z=1'], verifiedAt: '2024-02-29' })), []);
});

test('오버레이(사용자 노드)는 sources·verifiedAt이 없어도 통과하고, 있으면 같은 형식을 따른다 (T-118)', () => {
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'] }] }), []);
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], sources: ['https://a.example/'], verifiedAt: '2026-11-08' }] }), []);
  assert.match(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], verifiedAt: '어제' }] }).join(), /verifiedAt/);
  assert.match(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], sources: ['아무거나'] }] }).join(), /sources/);
});

test('실제 공통 그래프: 모든 노드에 공식 출처(maplestory.nexon.com)와 검수 날짜가 있다 (T-118, D-5)', () => {
  for (const n of common.nodes) {
    assert.ok(Array.isArray(n.sources) && n.sources.length >= 1, `${n.id} 출처 없음`);
    for (const u of n.sources) assert.match(u, /^https:\/\/maplestory\.nexon\.com\//, `${n.id} 출처는 공식 사이트만(D-5): ${u}`);
    assert.match(n.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, n.id);
  }
});

test('mergeGraphs: 공통 노드의 sources·verifiedAt이 병합 결과에 남는다 (T-118)', () => {
  const g = mergeGraphs({ ...provGraph({}), id: 'c', version: '1', analogyPrefix: 'p' }, null);
  assert.equal(g.nodes[0].verifiedAt, '2026-10-11');
  assert.deepEqual(g.nodes[0].sources, PROV.sources);
});

/* ───────────── 노드 텍스트·태그 벡터 방식 (T-154, ADR 0013) ───────────── */

test('embedItems 기본값: 키·텍스트가 예전 구성(tag:<id> = tagText, node:<id> = nodeText)과 바이트 단위로 같다', () => {
  const g = mergeGraphs(common, null);
  const tagMap = new Map(g.tags.map(t => [t.id, t]));
  const before = [
    ...g.tags.map(t => ({ key: 'tag:' + t.id, text: tagText(t) })),
    ...g.nodes.map(n => ({ key: 'node:' + n.id, text: nodeText(n, tagMap) }))
  ];
  assert.deepEqual(embedItems(g), before);
  assert.deepEqual(embedItems(g, {}), before);
  assert.deepEqual(embedItems(g, { nodeTextMode: 'full', tagVectorMode: 'joined' }), before);
  // 알 수 없는 값은 기본값으로 친다
  assert.deepEqual(embedItems(g, { nodeTextMode: '?', tagVectorMode: '?' }), before);
});

test('nodeText desc 모드: 태그 라벨·설명 + 이름 + 사실, 예문은 빠진다', () => {
  const tagMap = new Map([['t', { id: 't', label: '라벨', desc: '설명', examples: ['예문 하나', '예문 둘'] }]]);
  const n = { id: 'x', label: '노드', facts: ['사실1.', '사실2.'], tags: ['t'] };
  assert.equal(nodeText(n, tagMap, { mode: 'desc' }), '라벨: 설명 노드. 사실1. 사실2.');
  assert.equal(nodeText(n, tagMap, { mode: 'full' }), nodeText(n, tagMap));
  assert.equal(nodeText(n, tagMap), '라벨: 설명 예문 하나 예문 둘 노드. 사실1. 사실2.');
});

test('tagDescText: 라벨: 설명 (예문 없음)', () => {
  assert.equal(tagDescText({ id: 'x', label: '라벨', desc: '설명', examples: ['예'] }), '라벨: 설명');
  assert.equal(tagDescText({ id: 'x', label: '라벨' }), '라벨:');
});

test('embedItems max 모드: tag:<id>는 설명만, 예문마다 tag:<id>#<n>(1부터), 노드는 nodeTextMode대로', () => {
  const g = {
    tags: [{ id: 'a', label: 'A', desc: '설명A', examples: ['예1', '예2'] }, { id: 'b', label: 'B', desc: '설명B' }],
    nodes: [{ id: 'n', label: '노드', facts: ['사실.'], tags: ['a', 'b'] }]
  };
  assert.deepEqual(embedItems(g, { tagVectorMode: 'max' }), [
    { key: 'tag:a', text: 'A: 설명A' }, { key: 'tag:a#1', text: '예1' }, { key: 'tag:a#2', text: '예2' },
    { key: 'tag:b', text: 'B: 설명B' },
    { key: 'node:n', text: 'A: 설명A 예1 예2 B: 설명B 노드. 사실.' }
  ]);
  assert.deepEqual(embedItems(g, { tagVectorMode: 'max', nodeTextMode: 'desc' }).at(-1), { key: 'node:n', text: 'A: 설명A B: 설명B 노드. 사실.' });
  assert.deepEqual(embedItems(g, { nodeTextMode: 'desc' }).slice(0, 2), [
    { key: 'tag:a', text: 'A: 설명A 예1 예2' }, { key: 'tag:b', text: 'B: 설명B' }
  ]);
});
