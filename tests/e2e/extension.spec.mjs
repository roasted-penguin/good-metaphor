// 확장 전체 흐름 e2e. 네트워크 없이: 대체 임베더 + 가짜 LLM(servers.mjs)
// 실행: npm run test:e2e   (브라우저 경로 지정: CHROMIUM_PATH=/path/to/chrome)
import { test as base, expect, chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers, calls } from './servers.mjs';

const EXT = path.resolve('.tmp/ext-e2e');

const test = base.extend({
  context: async ({}, use) => {
    const args = [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`];
    const opts = process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
      : { channel: 'chromium', headless: !process.env.HEADED, args };
    const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'ah-')), { ...opts, viewport: { width: 1100, height: 800 }, locale: 'ko-KR' });
    await use(ctx);
    await ctx.close();
  },
  extId: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },
  // 확장 내부 메시지를 보내는 헬퍼 (옵션 페이지를 발판으로 씀)
  ext: async ({ context, extId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    const send = msg => page.evaluate(m => chrome.runtime.sendMessage(m), msg);
    const setSettings = patch => page.evaluate(async p => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ...p } });
    }, patch);
    await use({ page, send, setSettings });
  }
});

let stop;
test.beforeAll(async () => { stop = await startServers(); });
test.afterAll(async () => { await stop?.(); });

const tooltip = page => page.evaluate(() => document.getElementById('analogy-helper-host')?.shadowRoot.querySelector('.box')?.innerText ?? null);
const boxClass = page => page.evaluate(() => document.getElementById('analogy-helper-host')?.shadowRoot.querySelector('.box')?.className ?? '');
async function pointOnChar(page, sel, idx) {
  return page.evaluate(([s, i]) => {
    const r = document.createRange(); const t = document.querySelector(s).firstChild;
    r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [sel, idx]);
}
async function altHover(page, sel, idx = 5) {
  const { x, y } = await pointOnChar(page, sel, idx);
  await page.mouse.move(x, y);
  await page.keyboard.down('Alt');
  await page.mouse.move(x + 1, y);
  await page.keyboard.up('Alt');
}

test('확장 페이지에서 onnxruntime wasm이 로컬 파일로 실행된다', async ({ context, extId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ort-smoke.html`);
  await expect(page).toHaveTitle(/^ORT_OK 2,4,6$/, { timeout: 15_000 });
});

test('설정 화면: 공통 저장소 정보, 연결 테스트, 시험해 보기', async ({ ext }) => {
  const { page } = ext;
  await expect(page.locator('#commonTitle')).toHaveText(/메이플스토리 · /);
  await page.click('#testProvider');
  await expect(page.locator('#providerStatus')).toHaveText(/연결 성공/);
  await page.click('#tryRun');
  await expect(page.locator('#tryStatus')).toHaveText(/ms · custom\/mock-model/);
  await expect(page.locator('#tryOut table tbody tr')).toHaveCount(3);
});

test('Alt+호버: 문장 강조, 메이플 테마 말풍선, Esc 닫기, 캐시', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const { x, y } = await pointOnChar(page, '#p1', 5);
  await page.mouse.move(x, y);
  await page.waitForTimeout(400);
  expect(await tooltip(page), '보조키 없이는 뜨지 않음').toBeNull();

  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('메이플스토리로 보면');
  expect(await boxClass(page)).toContain('t-maple');
  const hl = await page.evaluate(() => [...CSS.highlights.get('analogy-helper-hl')][0].toString());
  expect(hl).toBe('변동금리 대출은 기준금리가 오르면 매달 내는 이자도 함께 늘어난다.');

  await page.keyboard.press('Escape');
  await expect.poll(() => tooltip(page)).toBe('');
  await altHover(page, '#p1', 7);
  await expect.poll(() => tooltip(page)).toContain('캐시');
});

test('자동 모드: 머무르면 뜨고 벗어나면 닫힌다', async ({ context, ext }) => {
  await ext.setSettings({ triggerMode: 'auto', dwellMs: 500 });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const { x, y } = await pointOnChar(page, '#p2', 10);
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y);
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  await page.mouse.move(900, 750);
  await expect.poll(() => tooltip(page), { timeout: 5000 }).toBe('');
});

test('로그인 → 관심사 변경 → 로그아웃: 저장소 두 층', async ({ context, ext }) => {
  const { send } = ext;
  expect((await send({ type: 'graph:info' })).data.merged.usesCommon).toBe(true);
  const login = await send({ type: 'auth:login', nickname: '테스터' });
  expect(login.data.adapter).toBe('local-dev');

  const bad = await send({ type: 'overlay:save', overlay: { nodes: [{ id: 'x', label: 'a', facts: ['f'], tags: ['t'] }] } });
  expect(bad.data.ok).toBe(false);

  const overlay = {
    useCommon: false, domain: '축구', analogyPrefix: '축구로 치면', theme: 'neutral',
    nodes: [
      { id: 'u:offside', label: '오프사이드', facts: ['공격수가 마지막 수비수보다 앞에 있으면 반칙이다.'], tags: ['threshold_req'] },
      { id: 'u:transfer', label: '이적 시장', facts: ['인기 선수는 원하는 구단이 많아 이적료가 오른다.'], tags: ['market_price', 'scarcity_value'] }
    ]
  };
  expect((await send({ type: 'overlay:save', overlay })).data.ok).toBe(true);
  const merged = (await send({ type: 'graph:info' })).data.merged;
  expect(merged).toMatchObject({ domain: '축구', nodes: 2, usesCommon: false });

  const r = await send({ type: 'explain', sentence: '인기 있는 한정판 운동화는 되팔 때 가격이 크게 오른다.', noCache: true });
  expect(r.data.evidence.source).toBe('user');
  expect(r.data.theme).toBe('neutral');

  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('축구로 보면');
  expect(await boxClass(page)).toContain('t-neutral');

  await send({ type: 'auth:logout' });
  expect((await send({ type: 'graph:info' })).data.merged).toMatchObject({ domain: '메이플스토리', usesCommon: true });
});

test('정밀 모드, 데모 제공자, 키 없음 오류', async ({ ext }) => {
  const { send, setSettings } = ext;
  await setSettings({ preciseMode: true });
  const p = await send({ type: 'explain', sentence: '뽑기형 상품은 원하는 결과가 나올 때까지 돈을 내고 다시 뽑게 만든다.', noCache: true });
  expect(p.data.debug.abstractText).toContain('확률');
  expect(calls.some(c => c.system.includes('추상 구조로'))).toBe(true);

  await setSettings({ preciseMode: false, provider: 'demo' });
  const d = await send({ type: 'explain', sentence: '레버리지는 이익과 손실을 모두 키운다.', noCache: true });
  expect(d.data.analogy).toMatch(/^메이플로 치면 /);

  await setSettings({ provider: 'openai' });
  const e = await send({ type: 'explain', sentence: '키 없는 호출은 오류가 나야 한다.', noCache: true });
  expect(e.ok).toBe(false);
  expect(e.error).toContain('API 키가 없어요');
});
