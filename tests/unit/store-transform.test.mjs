import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformAdmin, transformManifest, forbiddenFiles, zipName, serverUrlErrors, trackedExtensionFiles } from '../../scripts/store-transform.mjs';
import { PROVIDERS } from '../../extension/lib/providers.js';

// T-303: 웹스토어 빌드 변환(순수 함수). 원본 extension/ 은 바꾸지 않는다
const read = p => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const IDS = Object.keys(PROVIDERS);

test('admin: local-dev 어댑터는 none 으로, 다른 어댑터는 그대로', () => {
  assert.equal(transformAdmin({ userStore: { adapter: 'local-dev', baseUrl: '' } }, IDS).userStore.adapter, 'none');
  assert.deepEqual(transformAdmin({ userStore: { adapter: 'remote', baseUrl: 'https://x' } }, IDS).userStore, { adapter: 'remote', baseUrl: 'https://x' });
  assert.equal(transformAdmin({ userStore: { adapter: 'none' } }, IDS).userStore.adapter, 'none');
});

test('admin: allowedProviders 에서 demo 를 뺀다(없으면 PROVIDERS 키에서 demo 뺀 목록)', () => {
  assert.deepEqual(transformAdmin({ allowedProviders: ['groq', 'demo', 'gemini'] }, IDS).allowedProviders, ['groq', 'gemini']);
  const out = transformAdmin({}, IDS).allowedProviders;
  assert.ok(!out.includes('demo'));
  assert.deepEqual(out, IDS.filter(id => id !== 'demo'));
});

test('admin: defaultProvider 가 demo 면 fallbackChain 첫 실제 제공자로, 체인이 없으면 허용 목록 첫 항목', () => {
  const a = transformAdmin({ defaultProvider: 'demo', fallbackChain: [{ provider: 'demo', model: 'template' }, { provider: 'gemini', model: 'g' }], allowedProviders: ['groq', 'gemini', 'demo'] }, IDS);
  assert.equal(a.defaultProvider, 'gemini');
  assert.equal(transformAdmin({ defaultProvider: 'demo', allowedProviders: ['nvidia', 'demo'] }, IDS).defaultProvider, 'nvidia');
  assert.equal(transformAdmin({ defaultProvider: 'groq' }, IDS).defaultProvider, 'groq');
});

test('admin: fallbackChain 의 demo 항목은 빼고, 나머지 순서·길이는 그대로(순위는 늘어난다)', () => {
  const chain = [{ provider: 'groq', model: 'a' }, { provider: 'demo', model: 'template' }, { provider: 'gemini', model: 'b' }, { provider: 'ollama', model: 'c' }, { provider: 'x5', model: 'd' }];
  assert.deepEqual(transformAdmin({ fallbackChain: chain }, [...IDS, 'x5']).fallbackChain.map(e => e.provider), ['groq', 'gemini', 'ollama', 'x5']);
});

test('admin: 원본 객체를 바꾸지 않는다', () => {
  const src = { userStore: { adapter: 'local-dev' }, allowedProviders: ['demo', 'groq'], defaultProvider: 'demo' };
  const copy = structuredClone(src);
  transformAdmin(src, IDS);
  assert.deepEqual(src, copy);
});

test('admin: 지금 config/admin.json 변환 결과에 demo·local-dev 가 없다', () => {
  const a = transformAdmin(read('extension/config/admin.json'), IDS);
  assert.equal(a.userStore.adapter, 'none');
  assert.ok(!a.allowedProviders.includes('demo'));
  assert.notEqual(a.defaultProvider, 'demo');
  assert.ok(!JSON.stringify(a.fallbackChain).includes('"demo"'));
});

test('manifest: 이름에서 " (PoC)" 를 빼고, 로그인이 꺼지면(none) identity 를 빼며, 나머지는 그대로', () => {
  const m = read('extension/manifest.json');
  const out = transformManifest(m, { userStore: { adapter: 'none' } });
  assert.equal(out.name, '좋은비유네용');
  assert.ok(!out.permissions.includes('identity'));
  assert.deepEqual({ ...out, name: m.name, permissions: m.permissions }, m);
  assert.deepEqual(out.permissions, m.permissions.filter(p => p !== 'identity'));
  assert.equal(m.name, '좋은비유네용 (PoC)'); // 원본은 그대로
  assert.ok(m.permissions.includes('identity'));
  assert.equal(transformManifest({ name: '좋은비유네용' }, { userStore: { adapter: 'none' } }).name, '좋은비유네용');
});

test('manifest: 서버 계정(remote) 로그인이 켜져 있으면 identity 를 남긴다', () => {
  const out = transformManifest({ name: 'x', permissions: ['storage', 'identity'] }, { userStore: { adapter: 'remote', baseUrl: 'https://a' } });
  assert.deepEqual(out.permissions, ['storage', 'identity']);
});

test('manifest: 지금 admin.json 을 변환한 결과(none)로 만든 스토어 manifest 에 identity 가 없다', () => {
  const admin = transformAdmin(read('extension/config/admin.json'), IDS);
  assert.ok(!transformManifest(read('extension/manifest.json'), admin).permissions.includes('identity'));
});

test('serverUrlErrors: 서버 주소(analogyServer.url·commonStore.url·userStore.baseUrl)가 비어 있지 않으면 한국어 오류', () => {
  assert.deepEqual(serverUrlErrors(read('extension/config/admin.json')), []);
  assert.deepEqual(serverUrlErrors({}), []);
  assert.deepEqual(serverUrlErrors({ analogyServer: { url: '  ' }, commonStore: { url: '' }, userStore: { baseUrl: '' } }), []);
  const errs = serverUrlErrors({ analogyServer: { url: 'https://api.x' }, commonStore: { url: 'https://c.x/g.json' }, userStore: { adapter: 'remote', baseUrl: 'https://u.x' } });
  assert.equal(errs.length, 3);
  for (const [e, key] of errs.map((e, i) => [e, ['analogyServer.url', 'commonStore.url', 'userStore.baseUrl'][i]])) {
    assert.ok(e.includes(key), e);
    assert.match(e, /처리방침/);
  }
});

test('trackedExtensionFiles: git ls-files extension 출력 → extension/ 아래 상대 경로, 빌드 산출물이 빠지면 오류', () => {
  const out = ['extension/manifest.json', 'extension/offscreen.js', 'extension/vendor/ort-wasm-simd-threaded.asyncify.wasm', 'extension/vendor/ort-wasm-simd-threaded.asyncify.mjs', ''].join('\n');
  assert.deepEqual(trackedExtensionFiles(out), ['manifest.json', 'offscreen.js', 'vendor/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort-wasm-simd-threaded.asyncify.mjs']);
  assert.throws(() => trackedExtensionFiles('extension/manifest.json\nextension/offscreen.js\n'), /vendor\/ort-wasm-simd-threaded\.asyncify\.wasm/);
  assert.throws(() => trackedExtensionFiles(''), /manifest\.json/);
});

test('forbiddenFiles: 테스트·e2e 전용 파일·소스맵을 찾는다', () => {
  const files = ['background.js', 'lib/config.js', 'e2e-hook.js', 'ort-smoke.html', 'ort-smoke.js', 'add.onnx', 'offscreen.js.map', 'tests/x.js', 'lib/foo.test.mjs', '.DS_Store', 'vendor/ort-wasm-simd-threaded.asyncify.wasm'];
  assert.deepEqual(forbiddenFiles(files), ['e2e-hook.js', 'ort-smoke.html', 'ort-smoke.js', 'add.onnx', 'offscreen.js.map', 'tests/x.js', 'lib/foo.test.mjs', '.DS_Store']);
  assert.deepEqual(forbiddenFiles(['background.js', 'options.html']), []);
});

test('zipName: 판 번호를 넣은 파일 이름', () => {
  assert.equal(zipName('0.1.0'), 'good-metaphor-0.1.0.zip');
});
