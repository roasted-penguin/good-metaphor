// 말풍선 위치(T-109). place.js는 콘텐츠 스크립트용 클래식 스크립트라 부수효과 import 뒤 전역을 쓴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/place.js';

const { pickLineRect, placeBox } = globalThis.AnalogyPlace;
const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
// 줄 세 개: 100~120, 130~150, 160~180 (줄 사이 10px 틈)
const LINES = [R(10, 100, 200, 120), R(10, 130, 200, 150), R(10, 160, 120, 180)];

test('pickLineRect: y가 줄 안이면 그 줄', () => {
  assert.equal(pickLineRect(LINES, 110), LINES[0]);
  assert.equal(pickLineRect(LINES, 140), LINES[1]);
  assert.equal(pickLineRect(LINES, 150), LINES[1], '경계(bottom)도 포함');
  assert.equal(pickLineRect(LINES, 175), LINES[2]);
});

test('pickLineRect: 줄 사이면 세로로 가장 가까운 줄', () => {
  assert.equal(pickLineRect(LINES, 123), LINES[0]);
  assert.equal(pickLineRect(LINES, 128), LINES[1]);
});

test('pickLineRect: 첫 줄 위·마지막 줄 아래면 그 끝 줄', () => {
  assert.equal(pickLineRect(LINES, 50), LINES[0]);
  assert.equal(pickLineRect(LINES, 400), LINES[2]);
});

test('pickLineRect: 너비·높이 0인 rect는 무시, 비면 null', () => {
  const zeroW = R(50, 100, 50, 120), zeroH = R(10, 140, 200, 140);
  assert.equal(pickLineRect([zeroW, zeroH, LINES[1]], 110), LINES[1]);
  assert.equal(pickLineRect([zeroW, zeroH], 110), null);
  assert.equal(pickLineRect([], 110), null);
  assert.equal(pickLineRect(null, 110), null);
});

test('pickLineRect: DOMRectList처럼 배열이 아닌 반복 가능한 목록도 받는다', () => {
  const list = { length: 2, 0: LINES[0], 1: LINES[1], [Symbol.iterator]: function* () { yield this[0]; yield this[1]; } };
  assert.equal(pickLineRect(list, 140), LINES[1]);
});

test('placeBox: 줄 아래 gap만큼, 가로는 커서 중심', () => {
  assert.deepEqual(placeBox({ rect: LINES[1], mouseX: 300, bw: 200, bh: 100, vw: 1000, vh: 800 }), { left: 200, top: 158, flipped: false });
});

test('placeBox: 아래로 넘치면 줄 위로 뒤집는다', () => {
  const rect = R(10, 700, 200, 720);
  assert.deepEqual(placeBox({ rect, mouseX: 300, bw: 200, bh: 100, vw: 1000, vh: 800 }), { left: 200, top: 592, flipped: true });
});

test('placeBox: 위도 모자라면 pad', () => {
  const rect = R(10, 50, 200, 70);
  assert.deepEqual(placeBox({ rect, mouseX: 300, bw: 200, bh: 300, vw: 1000, vh: 320 }), { left: 200, top: 10, flipped: true });
  assert.deepEqual(placeBox({ rect, mouseX: 300, bw: 200, bh: 300, vw: 1000, vh: 320, pad: 4 }), { left: 200, top: 4, flipped: true });
});

test('placeBox: 좌우는 pad 안으로 clamp', () => {
  assert.equal(placeBox({ rect: LINES[0], mouseX: 20, bw: 200, bh: 50, vw: 1000, vh: 800 }).left, 10);
  assert.equal(placeBox({ rect: LINES[0], mouseX: 990, bw: 200, bh: 50, vw: 1000, vh: 800 }).left, 790);
  assert.equal(placeBox({ rect: LINES[0], mouseX: 990, bw: 200, bh: 50, vw: 1000, vh: 800, gap: 4 }).top, 124);
});
