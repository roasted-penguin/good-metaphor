import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeVector, decodeVector, buildVectorFile, precomputedIndex, vectorFileProblems,
  vectorFileStaleness, precomputedPath, VECTOR_FILE_FORMAT
} from '../../extension/lib/precomputed-vectors.js';

// float32로 정확히 표현되는 값과 그렇지 않은 값(0.1)을 섞는다. 런타임 벡터는 Float32Array.tolist()라 늘 float32 값이다
const f32 = arr => Array.from(new Float32Array(arr));
const V1 = f32([0.1, -0.25, 1 / 3, 0, -0]);
const V2 = f32([0.5, 0.5, -0.125, 1e-7, 0.9999]);
const META = { interest: 'maplestory', embedderId: 'Xenova/multilingual-e5-base@q8', passagePrefix: 'passage: ', graphVersion: '2026.10.11-1' };

test('encode/decode: float32 벡터가 비트 그대로 돌아온다(점수 동일 보장)', () => {
  for (const v of [V1, V2]) {
    const back = decodeVector(encodeVector(v), v.length);
    assert.equal(back.length, v.length);
    for (let i = 0; i < v.length; i++) assert.ok(Object.is(back[i], v[i]), `i=${i} ${back[i]} vs ${v[i]}`);
  }
});

test('decode: 길이가 dim과 다르면 null(깨진 항목은 쓰지 않는다)', () => {
  assert.equal(decodeVector(encodeVector(V1), 4), null);
  assert.equal(decodeVector('!!!', 5), null);
  assert.equal(decodeVector(42, 5), null);
});

test('buildVectorFile: 해시 순으로 정렬하고 같은 해시는 한 번만', () => {
  const f = buildVectorFile({ ...META, entries: [{ hash: 'bb', vector: V2 }, { hash: 'aa', vector: V1 }, { hash: 'bb', vector: V2 }] });
  assert.equal(f.format, VECTOR_FILE_FORMAT);
  assert.equal(f.encoding, 'f32le-base64');
  assert.equal(f.dim, 5);
  assert.equal(f.count, 2);
  assert.deepEqual(Object.keys(f.vectors), ['aa', 'bb']);
  assert.equal(f.embedderId, META.embedderId);
  assert.equal(f.passagePrefix, 'passage: ');
});

test('buildVectorFile: 차원이 섞이면 던진다', () => {
  assert.throws(() => buildVectorFile({ ...META, entries: [{ hash: 'a', vector: V1 }, { hash: 'b', vector: [1, 2] }] }), /차원/);
});

test('precomputedIndex: embedderId·passagePrefix가 맞을 때만 해시 → 벡터', () => {
  const f = buildVectorFile({ ...META, entries: [{ hash: 'aa', vector: V1 }] });
  const idx = precomputedIndex(f, { embedderId: META.embedderId, passagePrefix: 'passage: ' });
  assert.equal(idx.size, 1);
  assert.deepEqual(idx.get('aa'), V1);
  // 대체 임베더·다른 모델·다른 접두어면 비어 있다(지금처럼 런타임 임베딩)
  assert.equal(precomputedIndex(f, { embedderId: 'fallback-hash-ngram', passagePrefix: 'passage: ' }).size, 0);
  assert.equal(precomputedIndex(f, { embedderId: META.embedderId, passagePrefix: '' }).size, 0);
  assert.equal(precomputedIndex(null, { embedderId: META.embedderId, passagePrefix: 'passage: ' }).size, 0);
  assert.equal(precomputedIndex({ ...f, format: 99 }, { embedderId: META.embedderId, passagePrefix: 'passage: ' }).size, 0);
});

test('precomputedIndex: 깨진 항목만 빼고 나머지는 쓴다', () => {
  const f = buildVectorFile({ ...META, entries: [{ hash: 'aa', vector: V1 }, { hash: 'bb', vector: V2 }] });
  f.vectors.bb = 'AAAA';
  const idx = precomputedIndex(f, { embedderId: META.embedderId, passagePrefix: 'passage: ' });
  assert.deepEqual([...idx.keys()], ['aa']);
});

test('vectorFileProblems: 형식 오류를 한국어로', () => {
  assert.deepEqual(vectorFileProblems(buildVectorFile({ ...META, entries: [{ hash: 'aa', vector: V1 }] })), []);
  assert.ok(vectorFileProblems({}).length > 0);
  const bad = buildVectorFile({ ...META, entries: [{ hash: 'aa', vector: V1 }] });
  bad.count = 3;
  assert.match(vectorFileProblems(bad).join(' '), /count/);
});

test('vectorFileStaleness: 그래프 해시와 비교해 빠진 것·남는 것', () => {
  const f = buildVectorFile({ ...META, entries: [{ hash: 'aa', vector: V1 }, { hash: 'zz', vector: V2 }] });
  const s = vectorFileStaleness(f, ['aa', 'bb']);
  assert.deepEqual(s.missing, ['bb']);
  assert.deepEqual(s.extra, ['zz']);
  assert.equal(s.fresh, false);
  assert.equal(vectorFileStaleness(f, ['aa', 'zz']).fresh, true);
});

test('precomputedPath: 관심사별 파일', () => {
  assert.equal(precomputedPath('maplestory'), 'data/vectors/maplestory.json');
  assert.equal(precomputedPath('restaurant'), 'data/vectors/restaurant.json');
});
