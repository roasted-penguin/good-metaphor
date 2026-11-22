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
  const host = el('good-metaphor-host');
  host.shadowRoot = root(el('box'), host);
  assert.deepEqual(collectShadowRoots({ elementFromPoint: () => host }, 0, 0, { skip: e => e.id === 'good-metaphor-host' }), []);
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

/* ───────── hasPasswordDeep (T-148) ───────── */
// 가짜 요소: children 배열, 열린 shadow 면 shadowRoot(children 을 가진 root), 닫힌 shadow 는 shadowRoot null
const { hasPasswordDeep } = globalThis.AnalogyShadow;
const E = (tag, { type, children = [], shadow = null } = {}) => ({ nodeType: 1, localName: tag, type, children, shadowRoot: shadow ? { nodeType: 11, children: shadow } : null });
const pw = () => E('input', { type: 'password' });

test('hasPasswordDeep: 얕은 light DOM 비밀번호 칸, 없으면 false', () => {
  assert.equal(hasPasswordDeep(E('form', { children: [E('p'), pw()] })), true);
  assert.equal(hasPasswordDeep(E('form', { children: [E('p'), E('input', { type: 'text' })] })), false);
  assert.equal(hasPasswordDeep(null), false);
});

test('hasPasswordDeep: 자손 요소의 열린 shadow 안(중첩 포함) 비밀번호 칸도 찾는다', () => {
  const deep = E('div', { shadow: [E('span', { shadow: [E('div', { children: [pw()] })] })] });
  assert.equal(hasPasswordDeep(E('form', { children: [E('p'), E('div', { children: [deep] })] })), true);
  // shadow root 자체에서 시작해도 된다
  assert.equal(hasPasswordDeep({ nodeType: 11, children: [deep] }), true);
});

test('hasPasswordDeep: 닫힌 shadow(shadowRoot null)는 들어가지 않는다', () => {
  const closed = E('div'); // 닫힌 root 는 바깥에서 shadowRoot 가 null
  closed.__hidden = [pw()];
  assert.equal(hasPasswordDeep(E('form', { children: [closed] })), false);
});

test('hasPasswordDeep: 깊이 상한(기본 10)을 넘는 shadow 는 보지 않는다', () => {
  // shadow 를 n 겹 판 끝에 비밀번호 칸
  const nest = n => (n === 0 ? pw() : E('div', { shadow: [nest(n - 1)] }));
  assert.equal(hasPasswordDeep(E('form', { children: [nest(10)] })), true, '10겹은 찾음');
  assert.equal(hasPasswordDeep(E('form', { children: [nest(11)] })), false, '11겹은 상한 밖');
  assert.equal(hasPasswordDeep(E('form', { children: [nest(3)] }), { maxDepth: 2 }), false);
});

test('hasPasswordDeep: 방문 노드 상한(기본 2,000)을 넘으면 비밀번호 있음으로 보지 않고 멈춘다', () => {
  const many = n => Array.from({ length: n }, () => E('span'));
  let visited = 0;
  const counting = E('form', { children: [...many(5000), pw()] });
  counting.children = new Proxy(counting.children, { get: (t, k) => { if (/^\d+$/.test(String(k))) visited++; return t[k]; } });
  assert.equal(hasPasswordDeep(counting), false, '상한 뒤의 칸은 못 봄');
  assert.ok(visited <= 2001, `방문 ${visited}개`);
  assert.equal(hasPasswordDeep(E('form', { children: [...many(100), pw()] })), true);
  assert.equal(hasPasswordDeep(E('form', { children: [...many(100), pw()] }), { maxNodes: 50 }), false);
});
