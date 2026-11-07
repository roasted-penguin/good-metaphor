// 열린 Shadow DOM 도우미(T-111). shadow.js는 콘텐츠 스크립트용 클래식 스크립트라 부수효과 import 뒤 전역을 쓴다.
// DOM 없이 elementFromPoint·shadowRoot·parentNode 만 흉내 낸 가짜 노드로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/shadow.js';

const { collectShadowRoots, blockFor, composedParent } = globalThis.AnalogyShadow;

// 가짜 shadow root: elementFromPoint 가 정해진 요소를 돌려준다
const root = (inner, host) => ({ nodeType: 11, host, elementFromPoint: () => inner });
const el = (id, extra = {}) => ({ nodeType: 1, id, ...extra });

test('collectShadowRoots: 커서 아래 열린 shadow root 를 바깥부터 차례로 모은다', () => {
  const p = el('p');
  const innerHost = el('inner');
  innerHost.shadowRoot = root(p, innerHost);
  const outer = el('outer');
  outer.shadowRoot = root(innerHost, outer);
  const doc = { elementFromPoint: () => outer };
  assert.deepEqual(collectShadowRoots(doc, 1, 2), [outer.shadowRoot, innerHost.shadowRoot]);
});

test('collectShadowRoots: shadow 가 없거나(닫힘 포함) 커서 아래 요소가 없으면 빈 배열', () => {
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => el('p') }, 0, 0), []);
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => el('closed', { shadowRoot: null }) }, 0, 0), [], '닫힌 root 는 shadowRoot 가 null');
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => null }, 0, 0), []);
  assert.deepEqual(collectShadowRoots(null, 0, 0), []);
});

test('collectShadowRoots: skip 이 참인 호스트(우리 말풍선)는 들어가지 않는다', () => {
  const host = el('analogy-helper-host');
  host.shadowRoot = root(el('box'), host);
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => host }, 0, 0, { skip: e => e.id === 'analogy-helper-host' }), []);
});

test('collectShadowRoots: 깊이 상한(기본 10), 자기 자신을 돌려주는 root 에서 멈춘다', () => {
  // 끝없이 새 호스트를 돌려주는 사슬
  const chain = () => { const h = el('h'); Object.defineProperty(h, 'shadowRoot', { get: () => root(chain(), h) }); return h; };
  assert.equal(collectShadowRoots({ elementFromPoint: chain }, 0, 0).length, 10);
  assert.equal(collectShadowRoots({ elementFromPoint: chain }, 0, 0, { max: 3 }).length, 3);
  const self = el('self');
  self.shadowRoot = root(self, self); // retarget 으로 호스트 자신이 나오는 경우
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => self }, 0, 0), [self.shadowRoot]);
});

test('composedParent: 부모 요소, shadow root 직속이면 그 호스트, 문서 끝이면 null', () => {
  const host = el('host');
  const sr = { nodeType: 11, host };
  const parent = el('parent');
  assert.equal(composedParent({ parentElement: parent, parentNode: parent }), parent);
  assert.equal(composedParent({ parentElement: null, parentNode: sr }), host);
  assert.equal(composedParent({ parentElement: null, parentNode: { nodeType: 9 } }), null, '문서');
  assert.equal(composedParent({ parentElement: null, parentNode: null }), null);
});

test('blockFor: 블록 요소를 찾되 shadow 경계를 넘지 않는다(블록이 없으면 shadow root 자체)', () => {
  const body = el('body');
  const isBlock = e => !!e.block;
  const sr = { nodeType: 11, host: el('host', { block: true }) };
  const span = el('span', { parentElement: null, parentNode: sr });
  const p = el('p', { block: true, parentElement: null, parentNode: sr });
  const inP = el('b', { parentElement: p, parentNode: p });
  assert.equal(blockFor({ parentElement: inP, parentNode: inP }, { isBlock, stopAt: body }), p, 'shadow 안 블록');
  assert.equal(blockFor({ parentElement: span, parentNode: span }, { isBlock, stopAt: body }), sr, '블록 없으면 shadow root(호스트로 안 나감)');
  assert.equal(blockFor({ parentElement: null, parentNode: sr }, { isBlock, stopAt: body }), sr, 'shadow root 직속 텍스트');
});

test('blockFor: 보통 문서에서는 지금처럼 가장 가까운 블록, 없으면 body', () => {
  const body = el('body', { block: true });
  const div = el('div', { block: true, parentElement: body, parentNode: body });
  const span = el('span', { parentElement: div, parentNode: div });
  const isBlock = e => !!e.block;
  assert.equal(blockFor({ parentElement: span, parentNode: span }, { isBlock, stopAt: body }), div);
  const loose = el('span', { parentElement: body, parentNode: body });
  assert.equal(blockFor({ parentElement: loose, parentNode: loose }, { isBlock, stopAt: body }), body, 'body 는 블록 판정 없이 마지막');
  assert.equal(blockFor({ parentElement: null, parentNode: null }, { isBlock, stopAt: body }), body, '떨어진 노드');
});
