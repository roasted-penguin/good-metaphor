// 대체 임베더(모델 로드 실패 때만 쓰는 글자 n-gram 해시) 단위 테스트 (T-175)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashEmbed, ngramWeights, FALLBACK_ID, FALLBACK_DIM } from '../../extension/lib/fallback-embed.js';
import { mergeGraphs, embedItems } from '../../extension/lib/graph.js';
import { loadInterestGraph } from '../../tools/load-graph.mjs';
import { retrieve, retrievalFor } from '../../extension/lib/retrieval.js';

test('대체 임베더 id는 v2로 바뀌어 예전 512차원 캐시 벡터를 무효화한다', () => {
  assert.equal(FALLBACK_ID, 'fallback:hash-ngram-4096-v2');
  assert.notEqual(FALLBACK_ID, 'fallback:hash-ngram-512');
});

test('차원은 4096이고 정규화돼 있다', () => {
  assert.equal(FALLBACK_DIM, 4096);
  const v = hashEmbed('변동금리는 시장 금리에 따라 이자가 바뀐다.');
  assert.equal(v.length, 4096);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
});

test('같은 입력은 항상 같은 벡터', () => {
  const s = '자격증을 따야 다음 단계의 업무를 맡을 수 있다.';
  assert.deepEqual(hashEmbed(s), hashEmbed(s));
});

test('빈 문자열도 0 벡터(NaN 없음)', () => {
  const v = hashEmbed('');
  assert.equal(v.length, 4096);
  assert.ok(v.every(x => x === 0));
});

test('대소문자·연속 공백·query:/passage: 접두어는 무시한다', () => {
  assert.deepEqual(hashEmbed('passage: Leverage  amplifies'), hashEmbed('leverage amplifies'));
  assert.deepEqual(hashEmbed('query: 스타포스'), hashEmbed('스타포스'));
});

test('단어 첫머리 그램(공백으로 시작)은 0.6배, 나머지는 1배', () => {
  const w = ngramWeights('수 있다');
  // " 수"·" 있"·" 있다"는 단어 첫머리 → 0.6
  assert.equal(w.get(' 수'), 0.6);
  assert.equal(w.get(' 있'), 0.6);
  assert.equal(w.get(' 있다'), 0.6);
  // 단어 안·단어 끝 그램은 1
  assert.equal(w.get('있다'), 1);
  assert.equal(w.get('다 '), 1);
  assert.equal(w.get('수 '), 1);
  // 공백만 있는 그램은 없다
  assert.ok(![...w.keys()].some(g => !g.trim()));
});

test('같은 그램이 여러 번 나오면 가중치가 더해진다', () => {
  const w = ngramWeights('강화 강화');
  assert.equal(w.get('강화'), 2);
  assert.ok(Math.abs(w.get(' 강') - 1.2) < 1e-9);
});

// 실제 공통 그래프로 관문·스타포스 문장 구분 (T-172 보고서의 글자 겹침 사례)
const admin = JSON.parse(readFileSync(new URL('../../extension/config/admin.json', import.meta.url)));
function top1(interest, sentence) {
  const graph = mergeGraphs(loadInterestGraph(interest), null);
  const vecs = new Map(embedItems(graph, admin.retrieval).map(it => [it.key, hashEmbed(it.text)]));
  return retrieve(hashEmbed(sentence), graph, vecs, { ...retrievalFor(admin.retrieval, graph), topK: 3, aliasText: sentence })[0].id;
}
const GATE = ['sixth_job', 'boss_entry', 'arcane_force'];

test('관문 문장을 item_binding에 뺏기지 않는다', () => {
  for (const s of ['운전면허 필기에 합격해야 도로주행 시험을 볼 수 있다.', '팀장이 되어야 결재 권한이 생기고, 그다음에야 예산 회의에 들어갈 수 있다.']) {
    const id = top1('maplestory', s);
    assert.ok(GATE.includes(id), `${s} → ${id}`);
  }
});

test('수확 체감·강화 문장을 equipment_transfer에 뺏기지 않는다', () => {
  assert.equal(top1('maplestory', '마라톤 기록은 상위권으로 갈수록 몇 초 줄이는 것도 점점 힘들어진다.'), 'level_exp');
  assert.equal(top1('maplestory', '강화 몇 번 더 하다 결국 터졌네.'), 'starforce');
});
