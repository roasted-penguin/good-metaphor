// T-302: 두 번째 공통 관심사 "식당". 그래프 데이터 규칙·관심사별 로더·식당 평가셋
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateGraph, mergeGraphs, COMMON_INTERESTS, DEFAULT_INTEREST, commonInterest
} from '../../extension/lib/graph.js';
import { loadCommonGraphFromDisk, commonGraphPath, loadInterestGraph, interestFromArgv } from '../../tools/load-graph.mjs';
import { pickSets } from '../../tools/eval-lib.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const rawRestaurant = read('extension/data/common/restaurant.json');
const rawMaple = read('extension/data/common/maplestory.json');
const tagsFile = read('extension/data/common/tags.json');
const blocklist = read('extension/data/common/blocklist.json');
const restaurant = loadInterestGraph('restaurant');
const evalSet = read('tools/eval-set-restaurant.json');

/* ───────────── 관심사 목록 ───────────── */

test('공통 관심사 목록: 메이플(기본)과 식당, 파일 이름이 정해져 있다', () => {
  assert.equal(DEFAULT_INTEREST, 'maplestory');
  assert.deepEqual(COMMON_INTERESTS.map(i => [i.id, i.label, i.file]), [
    ['maplestory', '메이플', 'maplestory.json'],
    ['restaurant', '식당', 'restaurant.json']
  ]);
  assert.equal(commonInterest('restaurant').file, 'restaurant.json');
  assert.equal(commonInterest('nope'), null);
  assert.equal(commonInterest(undefined), null);
});

/* ───────────── 그래프 파일 ───────────── */

test('restaurant.json 머리: id·domain·analogyPrefix·theme·noMatchText·version, tags 없음(tags.json 공유)', () => {
  assert.equal(rawRestaurant.id, 'restaurant');
  assert.equal(rawRestaurant.domain, '식당');
  assert.equal(rawRestaurant.analogyPrefix, '식당으로 비유하자면');
  assert.equal(rawRestaurant.theme, 'neutral');
  assert.equal(rawRestaurant.noMatchText, '이건 식당으로도 비유가 안 되네요.');
  assert.match(rawRestaurant.version, /^\d{4}\.\d{2}\.\d{2}-\d+$/);
  assert.equal('tags' in rawRestaurant, false);
});

test('maplestory.json도 noMatchText를 갖는다(지금 말풍선 문구 그대로)', () => {
  assert.equal(rawMaple.noMatchText, '메이플스토리에서 딱 맞는 비유를 찾지 못했어요. 억지로 만들지 않았어요.');
});

test('식당 그래프는 검증을 통과하고 태그는 공통 18개 그대로(새 태그 없음, 규칙 9·T-304)', () => {
  assert.deepEqual(validateGraph(restaurant), []);
  assert.deepEqual(restaurant.tags.map(t => t.id), tagsFile.tags.map(t => t.id));
  assert.equal(restaurant.tagsVersion, tagsFile.version);
});

test('식당 노드: 15개 안팎, facts 2~3개(숫자·영문 없음, "다."로 끝), tags 1~3개, aliases 없음', () => {
  const n = restaurant.nodes.length;
  assert.ok(n >= 12 && n <= 18, `노드 ${n}개`);
  for (const node of restaurant.nodes) {
    assert.match(node.id, /^[a-z][a-z0-9_]*$/, node.id);
    assert.ok(node.facts.length >= 2 && node.facts.length <= 3, `${node.id} facts ${node.facts.length}개`);
    for (const f of node.facts) {
      assert.ok(f.endsWith('다.'), `${node.id} "${f}"`);
      // 규칙 2: 수치·가격·날짜 금지. 숫자가 아예 없게
      assert.doesNotMatch(f, /[0-9０-９%]/, `${node.id} 숫자: "${f}"`);
      assert.doesNotMatch(f, /[A-Za-z]/, `${node.id} 영문(브랜드?): "${f}"`);
    }
    assert.doesNotMatch(node.label, /[0-9]/, node.id);
    assert.ok(node.tags.length >= 1 && node.tags.length <= 3, `${node.id} tags ${node.tags.length}개`);
    assert.equal(node.aliases, undefined, `${node.id} aliases`);
    assert.equal(node.weakAliases, undefined, `${node.id} weakAliases`);
  }
});

test('식당 노드 출처: 공공·공식 자료만(go.kr·정책브리핑·소진공), 위키·블로그 없음, 검수 날짜 있음 (T-118, D-5)', () => {
  const official = h => h.endsWith('.go.kr') || h === 'www.korea.kr' || h === 'www.sbiz.or.kr';
  for (const node of restaurant.nodes) {
    assert.ok(node.sources.length >= 1, node.id);
    for (const u of node.sources) {
      const url = new URL(u);
      assert.equal(url.protocol, 'https:', `${node.id} ${u}`);
      assert.ok(official(url.hostname), `${node.id} 공식 출처가 아님: ${u}`);
      assert.doesNotMatch(u, /namu\.wiki|wikipedia|blog|tistory|inven|cafe\.naver/, u);
    }
    assert.match(node.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, node.id);
  }
});

test('식당 그래프에 금칙어(멸칭·실존 인물·밈 원문) 없음 (규칙 11)', () => {
  const text = JSON.stringify(rawRestaurant);
  const banned = blocklist.terms.flatMap(t => [t.term, ...(t.variants || [])]).filter(Boolean);
  for (const w of [...banned, '쌀숭이', '신창섭', '김창섭', '이해가쏙쏙', '우우우']) {
    assert.equal(text.includes(w), false, `금칙어 "${w}"`);
  }
});

test('식당 그래프 엣지는 있는 노드끼리', () => {
  const ids = new Set(restaurant.nodes.map(n => n.id));
  for (const e of restaurant.edges || []) assert.ok(ids.has(e.from) && ids.has(e.to) && e.rel, `${e.from}→${e.to}`);
});

test('식당 그래프 노드 id는 메이플 노드 id와 겹치지 않는다(피드백 기록이 엉뚱하게 적용되지 않게)', () => {
  const maple = new Set(loadCommonGraphFromDisk().nodes.map(n => n.id));
  for (const n of restaurant.nodes) assert.equal(maple.has(n.id), false, n.id);
});

test('mergeGraphs: 공통 그래프의 noMatchText를 싣는다, 내 관심사(useCommon=false)면 빈 문자열', () => {
  const r = mergeGraphs(restaurant, null);
  assert.equal(r.domain, '식당');
  assert.equal(r.theme, 'neutral');
  assert.equal(r.analogyPrefix, '식당으로 비유하자면');
  assert.equal(r.noMatchText, '이건 식당으로도 비유가 안 되네요.');
  assert.deepEqual(r.sources.common, { id: 'restaurant', version: rawRestaurant.version, tagsVersion: tagsFile.version });
  assert.equal(mergeGraphs(restaurant, { useCommon: false, domain: '원신' }).noMatchText, '');
  assert.equal(mergeGraphs(loadCommonGraphFromDisk(), null).noMatchText, rawMaple.noMatchText);
});

test('validateGraph: noMatchText가 있으면 빈 문자열이 아닌 문자열', () => {
  const g = { domain: 'd', tags: [], nodes: [] };
  assert.deepEqual(validateGraph({ ...g, noMatchText: '없어요.' }), []);
  assert.match(validateGraph({ ...g, noMatchText: '' }).join(), /noMatchText/);
  assert.match(validateGraph({ ...g, noMatchText: 3 }).join(), /noMatchText/);
});

/* ───────────── Node 로더 ───────────── */

test('Node 로더: 관심사 id → 그래프 경로, 모르는 id는 오류', () => {
  assert.equal(commonGraphPath(), fileURLToPath(new URL('../../extension/data/common/maplestory.json', import.meta.url)));
  assert.equal(commonGraphPath('restaurant'), fileURLToPath(new URL('../../extension/data/common/restaurant.json', import.meta.url)));
  assert.throws(() => commonGraphPath('nope'), /nope/);
  assert.deepEqual(loadInterestGraph('maplestory'), loadCommonGraphFromDisk());
  assert.equal(loadInterestGraph().id, 'maplestory');
});

test('interestFromArgv: --interest <id>, 없으면 기본, 모르는 id·값 없음은 오류', () => {
  assert.equal(interestFromArgv([]), 'maplestory');
  assert.equal(interestFromArgv(['--interest', 'restaurant', '-v']), 'restaurant');
  assert.throws(() => interestFromArgv(['--interest', 'nope']), /nope/);
  assert.throws(() => interestFromArgv(['--interest']), /interest/);
});

test('pickSets: --interest restaurant면 식당 평가셋 하나(가드 대상 아님), 메이플이면 기존 그대로', () => {
  const e = [{ sentence: 'e' }], v = [{ sentence: 'v' }], h = [{ sentence: 'h' }], r = [{ sentence: 'r' }];
  const rest = pickSets(['--interest', 'restaurant'], { evalSet: e, validation: v, holdout: h, interestSet: r }, commonInterest('restaurant'));
  assert.deepEqual(rest.map(s => [s.name, s.cases, s.guarded]), [['식당 평가셋', r, false]]);
  const maple = pickSets([], { evalSet: e, validation: v, holdout: h }, commonInterest('maplestory'));
  assert.deepEqual(maple.map(s => s.name), ['평가셋', '검증셋']);
});

/* ───────────── 확장 로더(stores.js) ───────────── */

const EXT = fileURLToPath(new URL('../../extension/', import.meta.url));
function mockChrome() {
  const seen = [];
  globalThis.chrome = { runtime: { getURL: p => 'ext://x/' + p }, storage: { managed: { get: async () => ({}) } } };
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('ext://x/')) {
      const body = readFileSync(EXT + String(url).slice('ext://x/'.length), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  return seen;
}

test('확장 로더: loadCommonGraph("restaurant")는 번들 restaurant.json + tags.json, 관심사마다 따로 캐시', async () => {
  const seen = mockChrome();
  const { loadCommonGraph } = await import('../../extension/lib/stores.js');
  const r = await loadCommonGraph('restaurant', { fresh: true });
  assert.ok(seen.includes('ext://x/data/common/restaurant.json'), seen.join());
  assert.deepEqual(r, restaurant);
  const m = await loadCommonGraph('maplestory', { fresh: true });
  assert.equal(m.id, 'maplestory');
  // 캐시가 관심사별: 다시 불러도 섞이지 않는다
  assert.equal((await loadCommonGraph('restaurant')).id, 'restaurant');
  assert.equal((await loadCommonGraph()).id, 'maplestory');
  // 예전 호출 모양({ fresh })도 기본 관심사
  assert.equal((await loadCommonGraph({ fresh: true })).id, 'maplestory');
  // 모르는 id(오래된 설정 값 등)는 기본 관심사로
  assert.equal((await loadCommonGraph('nope')).id, 'maplestory');
});

/* ───────────── 식당 평가셋 ───────────── */

const isEnglish = s => !/[가-힣]/.test(s);
const grams = s => { const t = s.replace(/\s+/g, ' '); const out = new Set(); for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
const jaccard = (a, b) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n); };

test('식당 평가셋: 12문장 이상, 메이플 문장 3개 이상, 영어 2개 이상, 기대 노드·태그가 식당 그래프에 있다', () => {
  const ids = new Set(restaurant.nodes.map(n => n.id));
  const tagIds = new Set(restaurant.tags.map(t => t.id));
  assert.ok(evalSet.length >= 12, `${evalSet.length}문장`);
  assert.ok(evalSet.filter(c => c.group === 'maple').length >= 3, '메이플 문장 부족');
  assert.ok(evalSet.filter(c => isEnglish(c.sentence)).length >= 2, '영어 부족');
  assert.equal(new Set(evalSet.map(c => c.sentence)).size, evalSet.length, '중복');
  for (const c of evalSet) {
    assert.ok(Array.isArray(c.expectNodes) && c.expectNodes.length >= 1, c.sentence);
    for (const id of c.expectNodes) assert.ok(ids.has(id), `${c.sentence} → 없는 노드 ${id}`);
    if (c.expectTag) assert.ok(tagIds.has(c.expectTag), `${c.sentence} → 없는 태그 ${c.expectTag}`);
  }
});

test('식당 평가셋: 기존 평가 문장과 3-gram < 0.5, 태그 설명·예문과 < 0.3, 식당 facts와 < 0.3(베끼기 금지)', () => {
  const others = [
    ...read('tools/eval-set.json'), ...read('tools/eval-holdout.json'), ...read('tools/eval-unseen.json')
  ].map(c => c.sentence);
  const tagTexts = tagsFile.tags.flatMap(t => [t.desc, ...(t.examples || [])]);
  const facts = restaurant.nodes.flatMap(n => n.facts);
  for (const c of evalSet) {
    for (const s of others) assert.ok(jaccard(c.sentence, s) < 0.5, `"${c.sentence}" ↔ "${s}"`);
    for (const t of tagTexts) assert.ok(jaccard(c.sentence, t) < 0.3, `"${c.sentence}" ↔ 예문 "${t}"`);
    for (const f of facts) assert.ok(jaccard(c.sentence, f) < 0.3, `"${c.sentence}" ↔ 사실 "${f}"`);
  }
});
