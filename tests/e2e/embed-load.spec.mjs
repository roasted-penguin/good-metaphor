// 실제 임베딩 모델 로드 경로 e2e (T-102). 다른 e2e는 대체 임베더 사본(.tmp/ext-e2e)을 쓰지만,
// 여기서는 그 사본의 admin.json만 실제 모델로 바꿔 "실제 모델을 받으려다 → 실패 → 대체 검색" 경로를 지난다.
// 진짜 266MB는 받지 않는다: Hugging Face는 크롬 DNS 단계에서 막고(차단 환경), 느린 네트워크는 가짜 모델 서버(admin embedding.remoteHost)로 흉내 낸다.
import { test as base, expect, chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { startServers } from './servers.mjs';
import { launchRaw } from './raw-cdp.mjs';

const EXT = path.resolve('.tmp/ext-e2e');
const REAL = JSON.parse(readFileSync('extension/config/admin.json', 'utf8')).embedding;
const FALLBACK = 'fallback:hash-ngram-512';
// 가짜 모델 서버(느린 네트워크). 응답을 서비스 워커 유휴 종료(30초)보다 오래 붙잡는다
const SLOW_PORT = 8768;
const SLOW_MS = 40_000;

// 사본을 하나 더 만들어 embedding만 바꾼다(실제 모델 + 필요하면 모델 주소)
function makeExt(embeddingPatch = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-real-'));
  cpSync(EXT, dir, { recursive: true });
  const p = path.join(dir, 'config/admin.json');
  const admin = JSON.parse(readFileSync(p, 'utf8'));
  admin.embedding = { ...REAL, ...embeddingPatch };
  writeFileSync(p, JSON.stringify(admin, null, 2));
  return dir;
}

async function launch(ext, extraArgs = [], profile) {
  const rules = ['MAP localhost 127.0.0.1', ...extraArgs].join(', ');
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=${rules}`];
  const opts = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
    : { channel: 'chromium', headless: !process.env.HEADED, args };
  const ctx = await chromium.launchPersistentContext(profile, { ...opts, viewport: { width: 1100, height: 800 }, locale: 'ko-KR' });
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  return { ctx, sw, page };
}

const rm = dir => rmSync(dir, { recursive: true, force: true });

const test = base.extend({
  // 크롬 DNS 규칙·embedding 덮어쓰기는 describe마다 test.use로 정한다
  hostRules: [[], { option: true }],
  embedding: [{}, { option: true }],
  env: async ({ hostRules, embedding }, use) => {
    const ext = makeExt(embedding);
    const profile = mkdtempSync(path.join(tmpdir(), 'ah-'));
    try {
      const e = await launch(ext, hostRules, profile);
      try { await use(e); } finally { await e.ctx.close(); }
    } finally {
      rm(ext); rm(profile);
    }
  },
  // Playwright 없이 띄운 크롬(raw-cdp). 테스트가 시간 초과로 끝나도 teardown에서 닫고 사본을 지운다
  raw: async ({}, use) => {
    const opened = [], dirs = [];
    await use(async embeddingPatch => {
      const ext = makeExt(embeddingPatch);
      dirs.push(ext);
      const b = await launchRaw({ ext });
      opened.push(b);
      return b;
    });
    for (const b of opened) await b.close().catch(() => {});
    dirs.forEach(rm);
  }
});

let stop;
test.beforeAll(async () => { stop = await startServers(); });
test.afterAll(async () => { await stop?.(); });

test.describe('Hugging Face 차단', () => {
  // 회사망처럼 Hugging Face 이름 풀이가 안 되는 환경
  test.use({ hostRules: ['MAP huggingface.co ~NOTFOUND', 'MAP *.huggingface.co ~NOTFOUND', 'MAP hf.co ~NOTFOUND', 'MAP *.hf.co ~NOTFOUND'] });

  test('설정 화면에 "대체 검색 사용 중 · 모델 로드 실패: 한국어 원인", 시험해 보기·호버는 대체 임베더로 (T-102)', async ({ env }) => {
    const { page, ctx } = env;
    // 이 사본은 실제 모델을 받으려 한다(우연히 대체 임베더라 통과하는 게 아님)
    const admin = await page.evaluate(async () => (await fetch(chrome.runtime.getURL('config/admin.json')).then(r => r.json())).embedding);
    expect(admin.model).toBe(REAL.model);
    expect(admin.fallbackOnError).not.toBe(false);

    await page.click('#warmup');
    const status = page.locator('#embedStatus');
    await expect(status).toHaveText(new RegExp(`^대체 검색 사용 중 \\(${FALLBACK}\\) · 모델 로드 실패: 모델을 받지 못했어요\\(네트워크\\)`), { timeout: 30_000 });
    // 오프스크린 상태에 원문 오류가 남아 있다 = 실제 모델 로드를 시도했다가 실패했다
    const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'embed:status' }));
    expect(st.data.status).toBe('fallback');
    expect(st.data.loadError).toBeTruthy();
    // 새로고침해도 같은 문구(준비 완료 문구로 덮이지 않음)
    await page.reload();
    await expect(status).toHaveText(/^대체 검색 사용 중 .* · 모델 로드 실패: 모델을 받지 못했어요\(네트워크\)/);

    await page.click('#tryRun');
    await expect(page.locator('#tryStatus')).toHaveText(new RegExp(`ms · custom/mock-model · ${FALLBACK}`));

    // 실제 페이지 호버도 대체 검색으로 말풍선이 뜬다
    const web = await ctx.newPage();
    await web.goto('http://127.0.0.1:8766/');
    const { x, y } = await web.evaluate(() => {
      const r = document.createRange(); const t = document.querySelector('#p1').firstChild;
      r.setStart(t, 5); r.setEnd(t, 6); const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await web.mouse.move(x, y);
    await web.keyboard.down('Alt');
    await web.mouse.move(x + 1, y);
    await web.keyboard.up('Alt');
    await expect.poll(() => web.evaluate(() => document.getElementById('good-metaphor-host')?.shadowRoot.querySelector('.box')?.innerText ?? ''))
      .toContain('메이플스토리로 보면');
    const r = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'explain', sentence: '변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', word: '', context: '', pageTitle: 't', noCache: true }));
    expect(r.data.debug.embedderId).toBe(FALLBACK);
  });
});

test.describe('Hugging Face 차단 + fallbackOnError false', () => {
  test.use({ hostRules: ['MAP huggingface.co ~NOTFOUND', 'MAP *.huggingface.co ~NOTFOUND', 'MAP hf.co ~NOTFOUND', 'MAP *.hf.co ~NOTFOUND'], embedding: { fallbackOnError: false } });

  test('대체 검색 없이 오류 문구(err), 오프스크린 embed도 대체 벡터 대신 오류 (T-102)', async ({ env }) => {
    const { page } = env;
    await page.click('#warmup');
    const status = page.locator('#embedStatus');
    await expect(status).toHaveText(/검색 모델을 준비하지 못했어요: 모델을 받지 못했어요\(네트워크\)/, { timeout: 30_000 });
    await expect(status).toHaveClass(/\berr\b/);
    const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'embed:status' }));
    expect(st.data.status).toBe('error');
    await page.reload();
    await expect(status).toHaveText(/^오류: 모델을 받지 못했어요\(네트워크\)/);
    await expect(status).toHaveClass(/\berr\b/);
    const r = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'embed', texts: ['문장'], kind: 'query' }));
    expect(r.vectors).toBeUndefined();
    expect(r.error).toMatch(/검색 모델을 준비하지 못했어요/);
  });
});

test.describe('느린 네트워크', () => {
  // 모델 파일 요청을 SLOW_MS 동안 붙잡았다가 끊는 가짜 모델 서버
  let server, requests = [];
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url);
      const t = setTimeout(() => res.destroy(), SLOW_MS);
      req.on('close', () => clearTimeout(t));
    }).listen(SLOW_PORT, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
  });
  test.afterAll(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); });

  test('첫 호버에 모델 응답이 30초 넘게 늦어도 서비스 워커가 살아 있어 대체 검색으로 결과를 돌려준다 (T-102)', async ({ raw }) => {
    test.setTimeout(120_000);
    // Playwright가 붙은 서비스 워커는 유휴 종료가 꺼져 keepAlive가 없어도 통과한다. 그래서 CDP로 설정 화면에만 붙는다.
    // 호버 경로(포트)를 쓴다. 포트 메시지 처리는 리스너가 돌아오면 끝난 것으로 쳐서, 그냥 기다리기만 하면 약 30초에 잠든다(직접 확인).
    // 지금 크롬은 오프스크린 응답을 기다리는 동안에도 살려 두어 keepAlive를 빼도 통과한다 — keepAlive는 방어용(보고서 참고)
    const b = await raw({ remoteHost: `http://127.0.0.1:${SLOW_PORT}/` });
    const page = await b.openPage(`chrome-extension://${b.extId}/options.html`);
    const t0 = Date.now();
    const r = await page.evaluate(`new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'explain' });
      const stages = [];
      port.onMessage.addListener(m => {
        if (m.type === 'stage') stages.push(m.stage);
        if (m.type === 'result' || m.type === 'error') resolve({ ...m, stages });
      });
      port.onDisconnect.addListener(() => resolve({ type: 'disconnected', stages }));
      port.postMessage({ type: 'explain', id: 1, payload: { sentence: '변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', word: '', context: '', pageTitle: 't', noCache: true } });
    })`);
    const ms = Date.now() - t0;
    expect(requests.length, '가짜 모델 서버로 요청이 와야 해요').toBeGreaterThan(0);
    expect(r.type, '서비스 워커가 잠들면 포트가 끊겨요: ' + JSON.stringify(r)).toBe('result');
    expect(ms, '서비스 워커 유휴 종료(30초)를 넘겨야 해요').toBeGreaterThanOrEqual(SLOW_MS - 1000);
    expect(r.result.debug.embedderId).toBe(FALLBACK);
    expect(r.result.analogy).toBeTruthy();
    expect((await b.workers()).map(w => w.targetId), '같은 서비스 워커가 끝까지 살아 있어야 해요').toEqual([b.swTargetId]);
    // 설정 화면을 새로 열면 대체 검색 문구와 원인이 보인다(상태가 오프스크린에 남아 있다)
    const opt = await b.openPage(`chrome-extension://${b.extId}/options.html`);
    await expect.poll(() => opt.evaluate(`document.querySelector('#embedStatus').textContent`)).toMatch(/^대체 검색 사용 중 .* · 모델 로드 실패: /);
  });
});
