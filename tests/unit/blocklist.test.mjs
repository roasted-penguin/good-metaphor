import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeForBlock, findBlocked, activeTerms, BLOCKED_REJECTED_TEXT } from '../../extension/lib/blocklist.js';

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
