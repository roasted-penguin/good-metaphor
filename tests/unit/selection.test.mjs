// 고른 범위 비유(T-182). selection.js는 콘텐츠 스크립트용 클래식 스크립트라 부수효과 import 뒤 전역을 쓴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/selection.js';
import '../../extension/lib/place.js';

const { MAX_CHARS, normalizeText, usableText, clampText, pointInRects, rawIndexFor } = globalThis.AnalogySelection;
const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

test('normalizeText: 줄바꿈·탭·연속 공백을 한 칸으로, 앞뒤 공백 제거', () => {
  assert.equal(normalizeText('  변동금리는\n\n  오른다.\t고정금리는  그대로다.  '), '변동금리는 오른다. 고정금리는 그대로다.');
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
});

test('usableText: 보이는 글자 2자 미만이나 글자·숫자가 없으면 쓰지 않는다(문장 모드로)', () => {
  assert.equal(usableText(''), false);
  assert.equal(usableText('가'), false);
  assert.equal(usableText(' 가 '), false);
  assert.equal(usableText('…!'), false, '문장부호만');
  assert.equal(usableText('금리'), true);
  assert.equal(usableText('A1'), true);
});

test('clampText: 상한 이하면 그대로, truncated false', () => {
  const t = '변동금리는 오른다. 고정금리는 그대로다.';
  assert.deepEqual(clampText(t, 400), { text: t, truncated: false });
  assert.equal(MAX_CHARS, 400);
});

test('clampText: 넘치면 상한 안 마지막 문장 경계에서 자른다', () => {
  const s = '가나다라마바사아자차. '; // 12자(뒤 공백 포함)
  const t = s.repeat(10).trim(); // 119자
  const r = clampText(t, 50);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 50, r.text.length);
  assert.ok(r.text.endsWith('.'), '문장 끝에서 잘림: ' + r.text);
  assert.equal(r.text, s.repeat(4).trim());
});

test('clampText: 첫 문장이 상한보다 길면 상한 안 마지막 공백에서, 공백도 없으면 상한에서 자른다', () => {
  const long = '아주 긴 문장 '.repeat(20).trim() + '.'; // 마침표 하나뿐
  const r = clampText(long, 30);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 30);
  assert.ok(long.startsWith(r.text));
  assert.ok(!/\s$/.test(r.text), '뒤 공백 없음');
  assert.ok(r.text.length >= 18, '공백 경계는 상한의 60% 뒤에서만');
  const noSpace = '가'.repeat(100);
  assert.deepEqual(clampText(noSpace, 30), { text: '가'.repeat(30), truncated: true });
});

test('pointInRects: 선택 rect 안(경계 여유 2px)이면 참, 밖이면 거짓', () => {
  const rects = [R(10, 100, 200, 120), R(10, 130, 90, 150)];
  assert.equal(pointInRects(rects, 50, 110), true);
  assert.equal(pointInRects(rects, 80, 140), true, '둘째 줄');
  assert.equal(pointInRects(rects, 150, 140), false, '둘째 줄 오른쪽 빈자리');
  assert.equal(pointInRects(rects, 201, 110), true, '여유 안');
  assert.equal(pointInRects(rects, 205, 110), false);
  assert.equal(pointInRects([], 50, 110), false);
  assert.equal(pointInRects(null, 50, 110), false);
  assert.equal(pointInRects([R(50, 50, 50, 70)], 50, 60), false, '너비 0 rect는 무시');
});

test('rawIndexFor: 공백을 접은 글 n자가 원문 어디서 끝나는지', () => {
  const raw = '  가나\n\n  다라.  마바';
  const norm = normalizeText(raw); // '가나 다라. 마바'
  for (let n = 1; n <= norm.length; n++) {
    if (norm[n - 1] === ' ') continue; // 자른 글은 공백으로 끝나지 않는다
    const i = rawIndexFor(raw, n);
    assert.equal(normalizeText(raw.slice(0, i)), norm.slice(0, n), `n=${n}`);
  }
  assert.equal(rawIndexFor(raw, 999), raw.length);
});

test('placeBoxSpan: 마지막 줄 아래, 넘치면 첫 줄 위, 둘 다 모자라면 마지막 줄 기준 원래 방식', () => {
  const { placeBoxSpan, placeBox } = globalThis.AnalogyPlace;
  const first = R(10, 300, 400, 320), last = R(10, 360, 200, 380);
  const base = { mouseX: 100, bw: 200, bh: 100, vw: 1000, pad: 10, gap: 8 };
  assert.deepEqual(placeBoxSpan({ ...base, first, last, vh: 800 }), { left: 10, top: 388, flipped: false });
  assert.deepEqual(placeBoxSpan({ ...base, first, last, vh: 450 }), { left: 10, top: 192, flipped: true }, '첫 줄 위로');
  const tallFirst = R(10, 50, 400, 70);
  assert.deepEqual(placeBoxSpan({ ...base, first: tallFirst, last, vh: 450 }), placeBox({ ...base, rect: last, vh: 450 }));
});
