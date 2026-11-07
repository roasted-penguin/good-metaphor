import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// T-115: 앱 표시 이름(좋은비유네용)과 내부 식별자(good-metaphor)가 모든 곳에서 같은지 확인한다
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const NAME = '좋은비유네용';

test('manifest: 이름·짧은 이름·툴바 제목이 새 앱 이름', () => {
  const m = JSON.parse(read('extension/manifest.json'));
  assert.equal(m.name, `${NAME} (PoC)`);
  assert.equal(m.short_name, NAME);
  assert.equal(m.action.default_title, NAME);
});

test('팝업·설정 화면 제목이 새 앱 이름', () => {
  assert.match(read('extension/popup.html'), new RegExp(`<b>${NAME}</b>`));
  const opt = read('extension/options.html');
  assert.match(opt, new RegExp(`<title>${NAME}[^<]*</title>`));
  assert.match(opt, new RegExp(`<h1>${NAME}</h1>`));
});

test('package.json·package-lock.json 이름이 good-metaphor', () => {
  assert.equal(JSON.parse(read('package.json')).name, 'good-metaphor');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'good-metaphor');
  assert.equal(lock.packages[''].name, 'good-metaphor');
});

test('CSS 하이라이트 이름이 content.js와 content.css에서 같다', () => {
  const js = read('extension/content.js');
  assert.match(js, /HL_NAME = 'good-metaphor-hl'/);
  assert.match(read('extension/content.css'), /::highlight\(good-metaphor-hl\)/);
  assert.match(js, /host\.id = 'good-metaphor-host'/);
});
