import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMeaning, buildAnalogyPrompt, rewriteQueryText } from '../../extension/lib/prompt.js';

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
  assert.match(system, /meaning, analogy, nodeId, tagId, usedFact, mapping 순서로/);
  assert.match(system, /"tagId": string\|null, "usedFact": string, "mapping": string\}/);
});

test('비유 프롬프트: analogy에 쓴 사실을 고른 후보 facts 한 문장 그대로 usedFact에 옮기게 한다 (T-123)', () => {
  const { system } = buildAnalogyPrompt({ sentence: 's', domain: '메이플스토리', analogyPrefix: '메이플로 치면', candidates: [] });
  assert.ok(system.includes('analogy에 쓴 메이플스토리 쪽 사실은 고른 후보의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다.'));
  assert.match(system, /근거에 없는 메이플스토리의 수치, 이름, 규칙을 지어내지 않는다/, '규칙 1 유지');
  assert.ok(system.indexOf('"meaning"') < system.indexOf('"usedFact"'), '뜻 먼저 스트리밍(T-117)');
});

test('rewriteQueryText: 정밀 모드는 추상 + 원문, abstract 모드는 추상만, 추상이 비면 원문 (T-113 (4))', () => {
  assert.equal(rewriteQueryText('구조', '원문'), '구조 원문');
  assert.equal(rewriteQueryText('구조', '원문', 'abstract'), '구조');
  assert.equal(rewriteQueryText('  ', '원문'), '원문');
  assert.equal(rewriteQueryText(null, '원문', 'abstract'), '원문');
});
