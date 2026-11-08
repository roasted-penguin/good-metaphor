import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeForBlock, findBlocked, activeTerms, applyBlocklist, BLOCKED_REJECTED_TEXT } from '../../extension/lib/blocklist.js';

const CASES = JSON.parse(readFileSync(new URL('../fixtures/blocklist-cases.json', import.meta.url), 'utf8'));
const BLOCKLIST = JSON.parse(readFileSync(new URL('../../extension/data/common/blocklist.json', import.meta.url), 'utf8'));

test('숨김 문구는 계획서 문구 그대로', () => {
  assert.equal(BLOCKED_REJECTED_TEXT, '부적절한 표현이 섞여 있어서 비유를 숨겼어요.');
});

test('blocklist.json: 용어 카드 형식(ADR 0007)', () => {
  assert.equal(BLOCKLIST.version, '2026.11.08-1');
  assert.ok(Array.isArray(BLOCKLIST.terms) && BLOCKLIST.terms.length > 0);
  const keys = ['term', 'variants', 'meaning', 'category', 'links', 'first_seen', 'sources', 'status'];
  for (const c of BLOCKLIST.terms) {
    assert.deepEqual(Object.keys(c).sort(), [...keys].sort(), c.term);
    assert.equal(typeof c.term, 'string');
    assert.ok(c.term.length > 0 && normalizeForBlock(c.term).length > 0, c.term);
    assert.ok(Array.isArray(c.variants) && c.variants.every(v => typeof v === 'string' && normalizeForBlock(v).length > 0), c.term);
    assert.ok(typeof c.meaning === 'string' && c.meaning.length > 0, c.term);
    assert.ok(['C', 'D'].includes(c.category), c.term);
    assert.ok(Array.isArray(c.links) && Array.isArray(c.sources), c.term);
    assert.equal(c.first_seen, '2026-10-11');
    assert.ok(['승인', '제안', '폐기'].includes(c.status), c.term);
  }
  // 일반 낱말과 겹치는 항목은 제안으로 두어 필터에서 빠진다
  const byTerm = Object.fromEntries(BLOCKLIST.terms.map(c => [c.term, c]));
  assert.equal(byTerm['매미'].status, '제안');
  assert.equal(byTerm['먹자'].status, '제안');
});

test('normalizeForBlock: 공유 사례', () => {
  for (const { input, output } of CASES.normalize) assert.equal(normalizeForBlock(input), output, JSON.stringify(input));
});

test('findBlocked: 공유 사례(실제 blocklist.json, 우회 표기·제안 무시)', () => {
  for (const { text, expect } of CASES.find) assert.equal(findBlocked(text, BLOCKLIST.terms), expect, JSON.stringify(text));
});

test('findBlocked: 승인만 쓴다(제안·폐기·상태 없음은 무시)', () => {
  const card = status => ({ term: '가나다라', variants: ['가나 우회'], status });
  assert.equal(findBlocked('가나다라', [card('승인')]), '가나다라');
  assert.equal(findBlocked('가나우회', [card('승인')]), '가나다라');
  assert.equal(findBlocked('가나다라', [card('제안')]), null);
  assert.equal(findBlocked('가나다라', [card('폐기')]), null);
  assert.equal(findBlocked('가나다라', [{ term: '가나다라', variants: [] }]), null);
});

test('findBlocked: 빈 term·문장부호뿐인 variant는 모든 글에 걸리지 않는다', () => {
  const terms = [{ term: '', variants: ['...', ' '], status: '승인' }];
  assert.equal(findBlocked('아무 문장이에요.', terms), null);
});

test('findBlocked: 입력이 비었거나 목록이 없으면 null', () => {
  assert.equal(findBlocked('', BLOCKLIST.terms), null);
  assert.equal(findBlocked(null, BLOCKLIST.terms), null);
  assert.equal(findBlocked('리선족', []), null);
  assert.equal(findBlocked('리선족', undefined), null);
});

test('activeTerms: 배열이나 { terms } 모두 받아 승인만 돌려준다', () => {
  const list = [{ term: '가', variants: [], status: '승인' }, { term: '나', variants: [], status: '제안' }];
  assert.deepEqual(activeTerms(list).map(c => c.term), ['가']);
  assert.deepEqual(activeTerms({ terms: list }).map(c => c.term), ['가']);
  assert.deepEqual(activeTerms(null), []);
});

test('번들 blocklist.json: 파싱되고 승인 카드가 하나 이상 있다', () => {
  const raw = readFileSync(new URL('../../extension/data/common/blocklist.json', import.meta.url), 'utf8');
  assert.ok(activeTerms(JSON.parse(raw)).length >= 1);
});

// applyBlocklist: runAnalogy와 서버 결과 재검사(background)가 같이 쓴다. 테스트용 가짜 낱말로 확인
const TBL = [{ term: '금칙테스트말', variants: [], status: '승인' }];
const SERVER_RESULT = {
  meaning: '서버 뜻 풀이예요.', analogy: '서버 비유예요.', mapping: '원문 ↔ 스타포스', rejected: null,
  evidence: { nodeId: 'starforce', nodeLabel: '스타포스 강화', source: 'common', tagLabel: null },
  domain: '메이플스토리', theme: 'maple', debug: { candidates: [{ id: 'starforce' }] }
};

test('applyBlocklist: 서버 결과 analogy에 금칙어가 있으면 비유·대응·근거를 숨기고 문구', () => {
  const { answer, blocked } = applyBlocklist({ ...SERVER_RESULT, analogy: '서버 비유 금.칙.테스트말' }, TBL);
  assert.equal(answer.analogy, '');
  assert.equal(answer.mapping, '');
  assert.equal(answer.meaning, '서버 뜻 풀이예요.');
  assert.equal(answer.evidence, null);
  assert.equal(answer.rejected, BLOCKED_REJECTED_TEXT);
  assert.deepEqual(blocked, { field: 'analogy', term: '(가림)' });
  assert.equal(answer.domain, '메이플스토리'); // 다른 필드는 그대로
  assert.ok(!JSON.stringify({ answer, blocked }).includes('테스트말'));
});

test('applyBlocklist: meaning이면 뜻도 지우고, 첫 필드만 기록', () => {
  const { answer, blocked } = applyBlocklist({ ...SERVER_RESULT, meaning: '금칙테스트말', mapping: '금칙테스트말' }, TBL);
  assert.equal(answer.meaning, '');
  assert.equal(answer.analogy, '');
  assert.equal(answer.mapping, '');
  assert.deepEqual(blocked, { field: 'meaning', term: '(가림)' });
});

test('applyBlocklist: 걸리지 않으면 그대로, 원본은 바꾸지 않는다', () => {
  const input = { ...SERVER_RESULT };
  const { answer, blocked } = applyBlocklist(input, TBL);
  assert.equal(blocked, null);
  assert.deepEqual(answer, SERVER_RESULT);
  const hit = applyBlocklist({ ...SERVER_RESULT, analogy: '금칙테스트말' }, TBL);
  assert.equal(SERVER_RESULT.analogy, '서버 비유예요.');
  assert.notEqual(hit.answer, SERVER_RESULT);
});
