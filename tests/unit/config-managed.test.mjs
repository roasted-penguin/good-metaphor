// 정책(chrome.storage.managed)으로 서버 주소를 주는 경로(T-141): 스키마에 analogyServer 가 있고, getAdminConfig 가 admin.json 위에 덮는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../../extension/managed_schema.json', import.meta.url), 'utf8'));
const adminFile = JSON.parse(readFileSync(new URL('../../extension/config/admin.json', import.meta.url), 'utf8'));

test('managed_schema(T-141): analogyServer.url 은 문자열, timeoutMs 는 정수', () => {
  const s = schema.properties.analogyServer;
  assert.ok(s, 'analogyServer 항목이 있어야 해요');
  assert.equal(s.type, 'object');
  assert.equal(s.properties.url.type, 'string');
  assert.equal(s.properties.timeoutMs.type, 'integer');
  assert.ok(s.properties.url.description && s.properties.timeoutMs.description, '관리자용 설명');
});

// 확장 환경을 흉내 낸다: admin.json 은 fetch, 정책은 chrome.storage.managed
function fakeChrome(managed) {
  globalThis.chrome = {
    runtime: { getURL: p => `chrome-extension://x/${p}` },
    storage: { managed: { get: async () => managed } }
  };
  globalThis.fetch = async url => {
    assert.equal(url, 'chrome-extension://x/config/admin.json');
    return { json: async () => structuredClone(adminFile) };
  };
}

test('getAdminConfig(T-141): 정책의 analogyServer 가 admin.json 기본값(빈 주소)을 덮는다', async () => {
  const realFetch = globalThis.fetch;
  try {
    fakeChrome({ analogyServer: { url: 'https://analogy.example.com', timeoutMs: 2500 } });
    const { getAdminConfig } = await import('../../extension/lib/config.js');
    const admin = await getAdminConfig({ fresh: true });
    assert.deepEqual(admin.analogyServer, { ...adminFile.analogyServer, url: 'https://analogy.example.com', timeoutMs: 2500 });
    assert.ok(admin._managedKeys.includes('analogyServer'));

    // 정책이 url 만 주면 나머지는 admin.json 값 그대로
    fakeChrome({ analogyServer: { url: 'https://b.example.com' } });
    const b = await getAdminConfig({ fresh: true });
    assert.equal(b.analogyServer.url, 'https://b.example.com');
    assert.equal(b.analogyServer.timeoutMs, adminFile.analogyServer.timeoutMs);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});
