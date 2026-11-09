// 웹스토어 스크린샷(T-303): 1280×800 PNG 를 docs/store/screenshots/ 에 만든다.
// 실행: npm run store:screenshots  (prepare-e2e 로 만든 .tmp/ext-e2e 를 다시 복사해 스토어 변환을 얹어 쓴다)
// 네트워크 없이 돈다: 대체 임베더 + 가짜 LLM(tests/e2e/servers.mjs). 가짜 LLM 의 뜻 풀이("테스트 뜻 풀이예요.")만
// 아래 MEANINGS 로 바꿔 끼우는 작은 중계 서버(:8775)를 둔다. 비유·근거는 가짜 LLM 이 공통 그래프 후보로 만든 그대로다.
// 문장은 테스트 페이지(tests/e2e/page.html) 문장만 쓴다(실제 사이트·실존 인물·멸칭 없음, 규칙 11).
import http from 'node:http';
import { chromium } from '@playwright/test';
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers } from '../tests/e2e/servers.mjs';
import { transformManifest, transformAdmin } from './store-transform.mjs';
import { PROVIDERS } from '../extension/lib/providers.js';

const OUT_DIR = 'docs/store/screenshots';
const EXT = '.tmp/ext-store-shots';
const W = 1280, H = 800;
const PROXY = 8775;

// 테스트 페이지 문장 → 화면에 보일 뜻 풀이(가짜 LLM 응답에 끼워 넣는다)
const SENTENCES = {
  rate: 'API 서버는 분당 요청 수에 상한을 두어 한 사용자가 자원을 독점하지 못하게 한다.',
  rate2: '이를 레이트 리밋이라고 부른다.',
  loan: '변동금리 대출은 기준금리가 오르면 매달 내는 이자도 함께 늘어난다.',
  fixed: '반면 고정금리는 약정 기간 동안 금리가 바뀌지 않는다.'
};
const MEANINGS = [
  ['분당 요청 수', '한 사람이 너무 많이 요청해서 다른 사람이 못 쓰는 일이 없게, 1분에 보낼 수 있는 요청 수를 정해 둔다는 뜻이에요.'],
  ['변동금리 대출', '변동금리로 돈을 빌리면 기준금리가 오를 때 매달 내는 이자도 따라서 많아진다는 뜻이에요.']
];

// 스크린샷용 기사 페이지. 테스트 페이지 문장만 담는다
const ARTICLE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>경제 기초 읽기</title>
<style>body{font:19px/1.75 -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;max-width:720px;margin:56px auto;color:#222;background:#fff}
h1{font-size:30px;margin:0 0 8px}small{color:#888}p{margin:22px 0}</style></head><body>
<h1>변동금리와 고정금리, 무엇이 다를까</h1><small>예시 문서</small>
<p id="loan">${SENTENCES.loan} ${SENTENCES.fixed}</p>
<p id="rate">${SENTENCES.rate} ${SENTENCES.rate2}</p>
<p>펭귄은 날지 못하지만 헤엄을 아주 잘 친다. 남극에 산다.</p>
</body></html>`;

function startProxy() {
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(ARTICLE); }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const j = JSON.parse(body);
      const r = await fetch('http://127.0.0.1:8765' + req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...j, stream: false }) });
      const data = await r.json();
      let content = data.choices?.[0]?.message?.content ?? '';
      const user = j.messages.at(-1).content;
      const hit = MEANINGS.find(([k]) => user.includes(k));
      if (hit) content = content.replace('테스트 뜻 풀이예요.', hit[1]);
      // 가짜 LLM 비유 틀은 받침과 상관없이 "과"를 붙인다. 화면에 보일 문장만 받침에 맞게 고친다
      content = content.replace(/([가-힣])과 같은 구조예요/, (_, ch) => ch + ((ch.charCodeAt(0) - 0xac00) % 28 ? '과' : '와') + ' 같은 구조예요');
      if (!j.stream) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })); }
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise(r => server.listen(PROXY, '127.0.0.1', () => r(() => new Promise(c => { server.closeAllConnections?.(); server.close(c); }))));
}

// e2e 사본(.tmp/ext-e2e: 대체 임베더·가짜 LLM 주소) 위에 스토어 변환(이름·데모·로그인)을 얹고, LLM 주소만 중계 서버로
function prepareExtension() {
  rmSync(EXT, { recursive: true, force: true });
  cpSync('.tmp/ext-e2e', EXT, { recursive: true });
  const mp = path.join(EXT, 'manifest.json');
  const m = transformManifest(JSON.parse(readFileSync(mp, 'utf8')));
  m.content_scripts = m.content_scripts.filter(cs => !cs.js.includes('e2e-hook.js'));
  writeFileSync(mp, JSON.stringify(m, null, 2));
  const ap = path.join(EXT, 'config/admin.json');
  const a = transformAdmin(JSON.parse(readFileSync(ap, 'utf8')), Object.keys(PROVIDERS));
  a.customBaseUrl = `http://127.0.0.1:${PROXY}/v1`;
  a.analogyServer = { url: '', timeoutMs: 800 };
  writeFileSync(ap, JSON.stringify(a, null, 2));
}

async function altHover(page, sel, idx) {
  const { x, y } = await page.evaluate(([s, i]) => {
    const r = document.createRange(); const t = document.querySelector(s).firstChild;
    r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [sel, idx]);
  await page.mouse.move(x, y);
  await page.keyboard.down('Alt');
  await page.mouse.move(x + 1, y);
  await page.keyboard.up('Alt');
}
const inBox = (page, sel) => page.locator('#good-metaphor-host').locator(`.box ${sel}`);

// 작은 화면(팝업)을 1280×800 바탕 가운데에 놓고 설명 한 줄을 붙인다
async function framed(context, png, caption, file) {
  const page = await context.newPage();
  await page.setViewportSize({ width: W, height: H });
  const src = 'data:image/png;base64,' + png.toString('base64');
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:${H}px;display:flex;align-items:center;justify-content:center;gap:72px;background:#f4f1ec;font:600 30px/1.5 -apple-system,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#2a2a2a">
    <div style="max-width:420px">${caption}</div><img src="${src}" style="box-shadow:0 12px 40px rgba(0,0,0,.18);border-radius:10px"></body>`);
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.screenshot({ path: file });
  await page.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  prepareExtension();
  const stopServers = await startServers();
  const stopProxy = await startProxy();
  const ext = path.resolve(EXT);
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`];
  const opts = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
    : { channel: 'chromium', headless: !process.env.HEADED, args };
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'ah-shots-')), { ...opts, viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ko-KR' });
  const made = [];
  const shot = async (page, name, o = {}) => { const f = path.join(OUT_DIR, name); await page.screenshot({ path: f, ...o }); made.push(f); };
  try {
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    const setSettings = patch => opt.evaluate(async p => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ...p }, onboarding: { pending: false, doneAt: Date.now() } });
    }, patch);
    await setSettings({ interest: 'maplestory' });
    for (const p of context.pages()) if (p !== opt) await p.close();

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PROXY}/`);
    // (1) 메이플 말풍선
    await altHover(page, '#rate', 8);
    await inBox(page, '.analogy').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(600);
    await shot(page, '1-maple-bubble.png');
    // (5) 👎 뒤 피드백 칩(다른 개념·이유). 마우스가 말풍선 위에 있으면 칩이 남는다
    await inBox(page, '.fbtn.down').click();
    await inBox(page, '.chip.reason').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(600);
    await shot(page, '5-feedback-chips.png');
    await page.keyboard.press('Escape');

    // (2) 식당 관심사 말풍선
    await setSettings({ interest: 'restaurant' });
    await page.reload();
    await page.mouse.move(5, 5);
    await altHover(page, '#loan', 6);
    await inBox(page, '.analogy').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(600);
    await shot(page, '2-restaurant-bubble.png');
    await setSettings({ interest: 'maplestory' });

    // (3) 팝업: 스토어 기본 제공자(Groq)로 설정을 마친 상태. 탭 주소는 예약 도메인 example.com 으로 보인다
    await setSettings({ provider: 'groq', apiKeys: { groq: 'screenshot-placeholder' } });
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (...a) => { await q(...a).catch(() => []); return [{ url: 'https://news.example.com/economy/rates' }]; };
    });
    await popup.setViewportSize({ width: 300, height: 600 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.locator('#domain').filter({ hasText: '노드' }).waitFor();
    await popup.waitForTimeout(400);
    const popupPng = await popup.locator('body').screenshot();
    await popup.close();
    const pf = path.join(OUT_DIR, '3-popup.png');
    await framed(context, popupPng, 'Alt 키를 누른 채 모르는 문장에 커서를 올리면 내 관심사로 풀어 줘요.<br><br><span style="font-weight:400;font-size:22px">관심사는 메이플스토리와 식당 중에서 골라요.</span>', pf);
    made.push(pf);

    // (4) 설정 화면: 사용 방식·제외 사이트
    await setSettings({ provider: null, apiKeys: {} });
    await opt.reload();
    await opt.setViewportSize({ width: W, height: H });
    await opt.locator('#sec-trigger').scrollIntoViewIfNeeded();
    await opt.evaluate(() => document.getElementById('sec-trigger').scrollIntoView({ block: 'start' }));
    await opt.waitForTimeout(400);
    await shot(opt, '4-options.png');
  } finally {
    await context.close();
    await stopProxy();
    await stopServers();
  }
  made.sort();
  for (const f of made) console.log(`${f}  ${(statSync(f).size / 1024).toFixed(0)}KB`);
}

await main();
