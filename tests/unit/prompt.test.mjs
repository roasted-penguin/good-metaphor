import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMeaning, buildAnalogyPrompt } from '../../extension/lib/prompt.js';

test('extractMeaning: 따옴표가 닫히기 전에는 null', () => {
  assert.equal(extractMeaning(''), null);
  assert.equal(extractMeaning('```json\n{"meaning": "뜻이에'), null);
  assert.equal(extractMeaning('{"mean'), null);
});

test('extractMeaning: 닫히면 값을 돌려준다 (코드블록 머리말이 있어도)', () => {
  assert.equal(extractMeaning('{"meaning": "뜻이에요.", "ana'), '뜻이에요.');
  assert.equal(extractMeaning('```json\n{\n  "meaning":"뜻이에요.",'), '뜻이에요.');
});

test('extractMeaning: 이스케이프를 풀고, 이스케이프된 따옴표에서 끊지 않는다', () => {
  assert.equal(extractMeaning('{"meaning": "\\"이자\\"가 늘어요.'), null);
  assert.equal(extractMeaning('{"meaning": "\\"이자\\"가\\n늘어요.", "analogy": ""'), '"이자"가\n늘어요.');
});

test('extractMeaning: meaning이 없거나 비어 있으면 null', () => {
  assert.equal(extractMeaning('{"analogy": "메이플로 치면", "meaning'), null);
  assert.equal(extractMeaning('{"meaning": "", "analogy": "'), null);
});

test('비유 프롬프트: 필드 순서를 meaning → analogy → nodeId 로 고정한다', () => {
  const { system } = buildAnalogyPrompt({ sentence: 's', domain: '메이플스토리', analogyPrefix: '메이플로 치면', candidates: [] });
  assert.match(system, /meaning, analogy, nodeId, tagId, mapping 순서로/);
});
