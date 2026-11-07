// 확장 전체 흐름 e2e. 네트워크 없이: 대체 임베더 + 가짜 LLM(servers.mjs)
// 실행: npm run test:e2e   (브라우저 경로 지정: CHROMIUM_PATH=/path/to/chrome)
import { test as base, expect, chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers, calls, analogyCalls, SERVER_ANALOGY } from './servers.mjs';

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

test('평가 도구 계약: 옵션 페이지에서 오프스크린 embed를 직접 불러 한 문장씩 같은 벡터를 받는다 (T-128)', async ({ ext }) => {
  const r = await ext.send({ type: 'embed:warmup' });
  expect(r.ok).toBe(true);
  const embed = texts => ext.page.evaluate(t => chrome.runtime.sendMessage({ target: 'offscreen', type: 'embed', texts: t, kind: 'passage' }), texts);
  const both = await embed(['첫 문장', '두 번째 문장']);
  const alone = await embed(['두 번째 문장']);
  expect(both.vectors).toHaveLength(2);
  expect(both.embedderId).toBe(r.data.embedderId);
  expect(alone.vectors[0]).toEqual(both.vectors[1]); // 묶어 보내도 한 문장씩과 같은 벡터
});

test('벡터 캐시 정리(T-110): 다른 임베더 키는 지워지고, 바뀐 것이 없으면 다시 저장하지 않는다', async ({ ext }) => {
  const getCache = () => ext.page.evaluate(async () => (await chrome.storage.local.get('vecCache')).vecCache || {});
  // 서비스 워커가 캐시를 읽기 전에 다른 임베더 키를 심는다
  await ext.page.evaluate(() => chrome.storage.local.set({ vecCache: { 'old-embedder|deadbeef': [0.1, 0.2] } }));
  const r = await ext.send({ type: 'embed:warmup' });
  expect(r.ok).toBe(true);
  const id = r.data.embedderId;
  await expect.poll(async () => Object.keys(await getCache()).includes('old-embedder|deadbeef')).toBe(false);
  const keys = Object.keys(await getCache());
  expect(keys.length).toBe(r.data.vectors);
  expect(keys.every(k => k.startsWith(id + '|'))).toBe(true);

  // 같은 그래프로 다시: 추가·삭제가 없으면 vecCache를 쓰지 않는다(호버마다 저장 금지)
  await ext.page.evaluate(() => {
    window.__vecWrites = 0;
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.vecCache) window.__vecWrites++; });
  });
  const r2 = await ext.send({ type: 'embed:warmup' });
  expect(r2.data.vectors).toBe(r.data.vectors);
  await ext.page.waitForTimeout(300);
  expect(await ext.page.evaluate(() => window.__vecWrites)).toBe(0);
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

// 말풍선 텍스트를 done(text) 이 참이 될 때까지 50ms마다 기록한다
async function recordTooltip(page, done, timeout = 15_000) {
  const seen = [];
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = (await tooltip(page)) || '';
    seen.push(t);
    if (done(t)) return seen;
    await page.waitForTimeout(50);
  }
  throw new Error('말풍선이 끝나지 않았어요: ' + seen.at(-1));
}

test('스트리밍: 뜻이 비유보다 먼저 보인다', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  const seen = await recordTooltip(page, t => t.includes('같은 구조예요'));
  const first = seen.findIndex(t => t.includes('테스트 뜻 풀이예요.'));
  expect(first, '뜻이 보인 순간이 있어야 함').toBeGreaterThanOrEqual(0);
  expect(seen[first], '뜻이 처음 보일 때 비유는 아직 없음').not.toContain('같은 구조예요');
});

test('스트리밍: 후보 밖 nodeId 면 비유가 끝까지 안 보인다 (규칙 1)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p3');
  const seen = await recordTooltip(page, t => t.includes('근거 목록에 없는 개념'));
  expect(seen.filter(t => t.includes('같은 구조예요')), '비유 문구가 한 번도 보이면 안 됨').toEqual([]);
  expect(seen.some(t => t.includes('테스트 뜻 풀이예요.') && !t.includes('근거 목록에 없는')), '검증 전에 뜻은 먼저 보임').toBe(true);
  expect(seen.at(-1)).toContain('테스트 뜻 풀이예요.');
});

// 근거 검사(T-123): 가짜 LLM은 "입장횟수테스트"면 facts 밖 숫자를, "사실조작테스트"면 facts에 없는 usedFact를 댄다
const GROUNDING_REJECTED = '근거에 없는 내용이 섞여 있어서 비유를 숨겼어요.';

test('근거 검사(T-123): facts 밖 숫자를 쓴 비유는 끝까지 안 보이고 근거 문구, 뜻은 먼저', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p6');
  const seen = await recordTooltip(page, t => t.includes(GROUNDING_REJECTED));
  expect(seen.filter(t => t.includes('7번만')), '지어낸 비유가 한 번도 보이면 안 됨').toEqual([]);
  expect(seen.some(t => t.includes('테스트 뜻 풀이예요.') && !t.includes(GROUNDING_REJECTED)), '검사 전에 뜻은 먼저 보임').toBe(true);
  expect(seen.at(-1)).toContain('테스트 뜻 풀이예요.');
});

test('근거 검사(T-123): 프롬프트에 usedFact, 정상은 통과, 숫자·usedFact 불일치는 숨김', async ({ ext }) => {
  const ok = await ext.send({ type: 'explain', sentence: '변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', noCache: true });
  expect(calls.at(-1).system).toContain('usedFact에 글자 그대로 옮긴다');
  expect(ok.data.analogy).toContain('같은 구조예요');
  expect(ok.data.evidence).not.toBeNull();
  expect(ok.data.rejected).toBeNull();
  expect(ok.data.debug.grounding).toEqual({ ok: true });

  const num = await ext.send({ type: 'explain', sentence: '입장횟수테스트 이 적금은 한 달에 한 번만 넣을 수 있다.', noCache: true });
  expect(num.data.meaning).toBe('테스트 뜻 풀이예요.');
  expect(num.data.analogy).toBe('');
  expect(num.data.rejected).toBe(GROUNDING_REJECTED);
  expect(num.data.evidence).toBeNull();
  expect(num.data.debug.grounding).toEqual({ ok: false, reason: 'number-outside' });

  const fact = await ext.send({ type: 'explain', sentence: '사실조작테스트 이 적금은 한 달에 한 번만 넣을 수 있다.', noCache: true });
  expect(fact.data.analogy).toBe('');
  expect(fact.data.rejected).toBe(GROUNDING_REJECTED);
  expect(fact.data.evidence).toBeNull();
  expect(fact.data.debug.grounding).toEqual({ ok: false, reason: 'fact-mismatch' });
});

test('피드백(T-129): 👎 → 다른 근거로 다시, 다시 물어도 반영, 되돌리기', async ({ ext }) => {
  const q = { sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...q });
  const first = r1.data.evidence.nodeId;
  expect(r1.data.feedbackApplied).toBe(false);
  const fb = await ext.send({ type: 'feedback', record: { sentence: q.sentence, nodeId: first, tagId: null, vote: 'down', provider: r1.data.debug.provider }, rerun: q });
  expect(fb.ok).toBe(true);
  expect(fb.data.result.evidence.nodeId).not.toBe(first);
  expect(fb.data.result.feedbackApplied).toBe(true);
  const r2 = await ext.send({ type: 'explain', ...q });
  expect(r2.data.evidence.nodeId).not.toBe(first);
  expect(r2.data.feedbackApplied).toBe(true);
  const u = await ext.send({ type: 'feedback-undo', id: fb.data.id, rerun: q });
  expect(u.data.result.evidence.nodeId).toBe(first);
  expect(u.data.result.feedbackApplied).toBe(false);
});

test('피드백(T-129): 다른 개념을 고르면 그 개념이 근거, 후보 밖 nodeId면 여전히 비유 숨김(규칙 1)', async ({ ext }) => {
  const q = { sentence: '근력 운동은 초보 때는 빨리 늘지만 숙련될수록 같은 노력 대비 성장이 더뎌진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...q });
  const pick = r1.data.debug.candidates[2].id;
  const fb = await ext.send({ type: 'feedback', record: { sentence: q.sentence, nodeId: r1.data.evidence.nodeId, vote: 'pick', pickedNodeId: pick }, rerun: q });
  expect(fb.data.result.evidence.nodeId).toBe(pick);
  expect(fb.data.result.debug.candidates.map(c => c.id)).toEqual([pick]);
  // 가짜 LLM은 "Leverage"가 있으면 후보에 없는 nodeId로 답한다
  const lev = { sentence: 'Leverage amplifies both gains and losses.', word: '', context: '', pageTitle: 't' };
  const l1 = await ext.send({ type: 'explain', ...lev });
  const lf = await ext.send({ type: 'feedback', record: { sentence: lev.sentence, nodeId: l1.data.debug.candidates[0].id, vote: 'pick', pickedNodeId: l1.data.debug.candidates[1].id }, rerun: lev });
  expect(lf.data.result.analogy).toBe('');
  expect(lf.data.result.rejected).toMatch(/근거 목록에 없는/);
});

test('비슷한 문장(T-130): 👎 기록에 벡터 저장(목록엔 없음) → 거의 같은 문장은 감점, 무관한 문장은 그대로', async ({ ext }) => {
  const a = { sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...a });
  const x = r1.data.evidence.nodeId;
  await ext.send({ type: 'feedback', record: { sentence: a.sentence, nodeId: x, tagId: null, vote: 'down', provider: r1.data.debug.provider } });
  // 기록에는 벡터가 붙지만 설정 화면·내보내기용 목록에는 싣지 않는다
  const stored = await ext.page.evaluate(async () => (await chrome.storage.local.get('feedback')).feedback);
  expect(Array.isArray(stored[0].vec) && stored[0].vec.length > 0).toBe(true);
  const l = await ext.send({ type: 'feedback:list' });
  expect(Object.keys(l.data.items[0])).not.toContain('vec');
  // 끝 마침표만 다른 문장: 대체 임베더 코사인 ≥ 임계값 → X 감점
  const a2 = { ...a, sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다' };
  const r2 = await ext.send({ type: 'explain', ...a2 });
  const sim = r2.data.debug.feedback.similar;
  expect(sim.find(s => s.nodeId === x)?.delta).toBeLessThan(0);
  expect(r2.data.feedbackApplied).toBe(true);
  // 무관한 문장은 가감 없음
  const b = { ...a, sentence: '근력 운동은 초보 때는 빨리 늘지만 숙련될수록 같은 노력 대비 성장이 더뎌진다.' };
  const r3 = await ext.send({ type: 'explain', ...b });
  expect(r3.data.debug.feedback.similar).toEqual([]);
  expect(r3.data.feedbackApplied).toBe(false);
  // 정밀 모드가 꺼져 있으면 검색 벡터를 그대로 쓰고 추가 임베딩이 없다(T-138)
  for (const r of [r1, r2, r3]) {
    expect(r.data.debug.feedback.queryVec).toBe('query');
    expect(r.data.debug.feedback.extraEmbedMs).toBe(0);
  }
});

test('정밀 모드 비슷한 문장(T-138): 검색은 추상 구조 + 원문, 비슷한 문장 판정은 원문 벡터로', async ({ ext }) => {
  await ext.setSettings({ preciseMode: true });
  const a = { sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...a });
  // 가짜 LLM의 추상화 응답이 원문과 달라 검색 질의가 바뀐다
  expect(r1.data.debug.abstractText).toBeTruthy();
  expect(r1.data.debug.abstractText).not.toBe(a.sentence);
  // 메모리가 비면 비슷한 문장 판정이 없으니 추가 임베딩도 건너뛴다
  expect(r1.data.debug.feedback.queryVec).toBe('query');
  expect(r1.data.debug.feedback.extraEmbedMs).toBe(0);
  const x = r1.data.evidence.nodeId;
  await ext.send({ type: 'feedback', record: { sentence: a.sentence, nodeId: x, tagId: null, vote: 'down', provider: r1.data.debug.provider } });
  const a2 = { ...a, sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다' };
  const r2 = await ext.send({ type: 'explain', ...a2 });
  expect(r2.data.debug.abstractText).toBeTruthy();
  expect(r2.data.debug.feedback.queryVec).toBe('sentence');
  expect(r2.data.debug.feedback.extraEmbedMs).toBeGreaterThanOrEqual(0);
  expect(r2.data.debug.feedback.similar.find(s => s.nodeId === x)?.delta).toBeLessThan(0);
  expect(r2.data.feedbackApplied).toBe(true);
});

test('내 피드백(T-132): 목록·공유 설정·7일 통계·지운 노드 라벨·전부 지우기 메시지', async ({ ext }) => {
  const q = { sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...q });
  const nodeId = r1.data.evidence.nodeId;
  await ext.send({ type: 'feedback', record: { sentence: q.sentence, nodeId, tagId: null, vote: 'down', provider: r1.data.debug.provider } });
  const l1 = await ext.send({ type: 'feedback:list' });
  expect(l1.ok).toBe(true);
  expect(l1.data.items).toHaveLength(1);
  expect(l1.data.items[0].vote).toBe('down');
  expect(l1.data.items[0].nodeId).toBe(nodeId);
  expect(l1.data.items[0].nodeLabel).toMatch(/[가-힣]/);
  expect(l1.data.items[0].masked).toBe(q.sentence);
  expect(l1.data.share).toBe(false);
  await ext.setSettings({ feedbackShare: true });
  expect((await ext.send({ type: 'feedback:list' })).data.share).toBe(true);
  // 호버 집계는 기다리지 않고 쓰므로 poll로 읽는다
  const hovers = async () => (await ext.send({ type: 'feedback:stats' })).data.hovers;
  await expect.poll(hovers).toBeGreaterThanOrEqual(1);
  const st = await ext.send({ type: 'feedback:stats' });
  expect(st.data.down).toBe(1);
  // 피드백 뒤 다시 비유(rerun)는 호버로 세지 않는다
  const before = st.data.hovers;
  const rr = await ext.send({ type: 'feedback', record: { sentence: q.sentence, nodeId, tagId: null, vote: 'down' }, rerun: q });
  expect(rr.data.result).toBeTruthy();
  await new Promise(r => setTimeout(r, 300));
  expect(await hovers()).toBe(before);
  // 그 down 기록은 지워 아래 개수 검사를 그대로 둔다
  await ext.send({ type: 'feedback-undo', id: rr.data.id });
  expect(await hovers()).toBe(before);
  // 그래프에 없는 노드면 라벨 대신 id 그대로
  await ext.send({ type: 'feedback', record: { sentence: '연락처 010-1234-5678', nodeId: 'gone-node', vote: 'down' } });
  const l2 = await ext.send({ type: 'feedback:list' });
  expect(l2.data.items).toHaveLength(2);
  const gone = l2.data.items.find(i => i.nodeId === 'gone-node');
  expect(gone.nodeLabel).toBe('gone-node');
  expect(gone.masked).toBe('연락처 [숫자]');
  expect(l2.data.items[0].nodeId, '최신순').toBe('gone-node');
  const c = await ext.send({ type: 'feedback:clear' });
  expect(c.data).toBe(true);
  expect((await ext.send({ type: 'feedback:list' })).data.items).toHaveLength(0);
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

/* ───────── 말풍선 원클릭 피드백 (T-106, ADR 0010) ───────── */
const box = page => page.locator('#analogy-helper-host .box');
const evidence = async page => (await tooltip(page)).match(/근거: (.+)/)?.[1]?.trim();

test('피드백 UI: 👎 한 번 → 글자 입력 없이 다른 근거로 다시, 반영 칩, 되돌리기 (T-106)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  const first = await evidence(page);
  await expect(box(page).getByRole('button', { name: '잘 맞아요' })).toBeVisible();
  await box(page).getByRole('button', { name: '안 맞아요' }).click();
  await expect.poll(() => tooltip(page)).toContain(`이 문장엔 '${first}'`);
  await expect.poll(() => evidence(page)).not.toBe(first);
  await expect.poll(() => tooltip(page)).toContain('내 피드백 반영');
  expect(await box(page).locator('input, textarea, [contenteditable]').count(), '입력칸 없음').toBe(0);
  const now = await evidence(page);
  expect(await box(page).locator('button.alt').allInnerTexts(), '지금 근거와 뺀 개념은 칩에 없음').not.toContain(now);
  expect(await box(page).locator('button.alt').allInnerTexts()).not.toContain(first);
  const undo = await box(page).getByRole('button', { name: '되돌리기' }).boundingBox();
  const close = await box(page).locator('button.close').boundingBox();
  expect(undo.x + undo.width <= close.x || undo.y >= close.y + close.height, '되돌리기와 닫기 버튼이 겹치지 않음').toBe(true);
  await box(page).getByRole('button', { name: '되돌리기' }).click();
  await expect.poll(() => evidence(page)).toBe(first);
  expect(await tooltip(page)).not.toContain('내 피드백 반영');
});

test('피드백 UI: 다른 개념 칩 → 그 개념이 근거, 다시 호버해도 반영 칩 (T-106)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p2');
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  await box(page).getByRole('button', { name: '안 맞아요' }).click();
  const alt = box(page).locator('button.alt').first();
  await expect(alt).toBeVisible();
  const label = (await alt.innerText()).trim();
  await alt.click();
  await expect.poll(() => evidence(page)).toBe(label);
  await page.keyboard.press('Escape');
  await altHover(page, '#p2', 9);
  await expect.poll(() => tooltip(page)).toContain('내 피드백 반영');
  expect(await evidence(page)).toBe(label);
});

test('피드백 UI: 비유 없음 화면의 후보 칩 → 비유, 후보 밖 nodeId면 골라도 숨김(규칙 1) (T-106)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p4');
  await expect.poll(() => tooltip(page)).toContain('혹시 이 중에 있나요?');
  const chip = box(page).locator('button.alt').first();
  const label = (await chip.innerText()).trim();
  await chip.click();
  await expect.poll(() => evidence(page)).toBe(label);
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');

  await page.keyboard.press('Escape');
  await altHover(page, '#p3');
  await expect.poll(() => tooltip(page)).toContain('혹시 이 중에 있나요?');
  await box(page).locator('button.alt').first().click();
  await expect.poll(() => tooltip(page)).toContain('근거 목록에 없는');
  expect(await tooltip(page)).not.toContain('메이플로 치면');
});

test('피드백 UI: 👍은 "고마워요"만, 이유 칩은 기록에 남는다 (T-106)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  const before = await evidence(page);
  await box(page).getByRole('button', { name: '잘 맞아요' }).click();
  await expect.poll(() => tooltip(page)).toContain('고마워요');
  expect(await evidence(page)).toBe(before);
  await page.keyboard.press('Escape');
  await altHover(page, '#p2');
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  await box(page).getByRole('button', { name: '안 맞아요' }).click();
  await box(page).getByRole('button', { name: '비유가 억지예요' }).click();
  await expect.poll(() => ext.page.evaluate(async () => (await chrome.storage.local.get('feedback')).feedback.map(r => `${r.vote}:${r.reason || ''}`))).toEqual(['up:', 'down:forced']);
});

test('피드백 UI: 자동 모드에서 말풍선으로 옮겨 가도 닫히지 않고 👎를 누를 수 있다 (T-106)', async ({ context, ext }) => {
  await ext.setSettings({ triggerMode: 'auto', dwellMs: 300 });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const { x, y } = await pointOnChar(page, '#p1', 10);
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y);
  await expect.poll(() => tooltip(page), { timeout: 10000 }).toContain('메이플로 치면');
  const first = await evidence(page);
  const b = await box(page).getByRole('button', { name: '안 맞아요' }).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => evidence(page), { timeout: 10000 }).not.toBe(first);
});

/* ───────── 설정 화면 "내 피드백" 칸 (T-132) ───────── */
const P1 = '변동금리 대출은 기준금리가 오르면 매달 내는 이자도 함께 늘어난다.';
const DAY_RE = /\d{4}-\d{2}-\d{2}/;
const EMPTY_FB = '아직 남긴 피드백이 없어요.';

test('내 피드백 칸(T-132): 말풍선 👎 → 목록·7일 통계 → 되돌리기면 다시 물어도 원래 근거', async ({ context, ext }) => {
  const r0 = await ext.send({ type: 'explain', sentence: P1, word: '', context: '', pageTitle: 't', noCache: true });
  const original = r0.data.evidence.nodeId;
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('메이플로 치면');
  await box(page).getByRole('button', { name: '안 맞아요' }).click();
  await expect.poll(() => tooltip(page)).toContain('내 피드백 반영');

  const op = ext.page;
  await op.reload();
  await expect(op.locator('#sec-feedback h2')).toHaveText('내 피드백');
  const items = op.locator('#fbList li');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('👎');
  await expect(items.first()).toContainText(DAY_RE);
  await expect(items.first()).toContainText(P1); // 40자 이하면 줄이지 않음
  await expect(op.locator('#fbStats')).toContainText('지난 7일');
  await expect(op.locator('#fbStats')).toContainText('👎 1');

  await items.first().getByRole('button', { name: '되돌리기' }).click();
  await expect(op.locator('#fbEmpty')).toHaveText(EMPTY_FB);
  await expect(op.locator('#fbList li')).toHaveCount(0);
  const r1 = await ext.send({ type: 'explain', sentence: P1, word: '', context: '', pageTitle: 't', noCache: true });
  expect(r1.data.feedbackApplied).toBe(false);
  expect(r1.data.evidence.nodeId).toBe(original);
});

test('내 피드백 칸(T-132): JSON 내보내기, 보내기 설정과 미리보기, 전부 지우기', async ({ ext }) => {
  const op = ext.page;
  // 기본(설정 없음)은 보내지 않음
  await expect(op.locator('#fbShare')).not.toBeChecked();
  await expect(op.locator('#fbSharePreview')).toBeHidden();
  await expect(op.locator('#fbEmpty')).toHaveText(EMPTY_FB);

  const LONG = '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어지며, 그 결과 저축한 돈의 실제 구매력도 함께 줄어든다.';
  await ext.send({ type: 'feedback', record: { sentence: LONG, nodeId: 'meso', vote: 'down' } });
  await ext.send({ type: 'feedback', record: { sentence: '연락처 010-1234-5678', nodeId: 'meso', vote: 'up' } });
  await op.reload();
  await expect(op.locator('#fbList li')).toHaveCount(2);
  await expect(op.locator('#fbList li').nth(0)).toContainText('👍');
  await expect(op.locator('#fbList li').nth(0)).toContainText('메소');
  await expect(op.locator('#fbList li').nth(1)).toContainText([...LONG].slice(0, 40).join('') + '…');

  const [download] = await Promise.all([op.waitForEvent('download'), op.click('#fbExport')]);
  expect(download.suggestedFilename()).toMatch(/^good-metaphor-feedback-\d{4}-\d{2}-\d{2}\.json$/);
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(data).toHaveLength(2);
  for (const it of data) { expect(it.vote).toBeTruthy(); expect(it.sentence).toBeTruthy(); }

  await ext.setSettings({ feedbackShare: true });
  await op.reload();
  await expect(op.locator('#fbShare')).toBeChecked();
  await expect(op.locator('#fbSharePreview')).toBeVisible();
  await expect(op.locator('#fbSharePreview')).toContainText('이렇게 가려서 보내요: 연락처 [숫자]');
  await op.locator('#fbShare').uncheck();
  await expect(op.locator('#fbSharePreview')).toBeHidden();
  await expect.poll(() => op.evaluate(async () => (await chrome.storage.local.get('settings')).settings.feedbackShare)).toBe(false);

  op.once('dialog', d => d.accept());
  await op.click('#fbClear');
  await expect(op.locator('#fbEmpty')).toHaveText(EMPTY_FB);
  expect((await ext.send({ type: 'feedback:list' })).data.items).toHaveLength(0);
  await op.locator('#fbShare').check();
  await expect(op.locator('#fbSharePreview')).toContainText('보낼 피드백이 아직 없어요.');
});

/* ───────── "내 피드백" 다듬기 (T-137) ───────── */
const storageGetFb = (page, key) => page.evaluate(async k => (await chrome.storage.local.get(k))[k], key);
// 설정 화면의 chrome.runtime.sendMessage를 바꿔, 고른 메시지 종류만 실패 응답을 돌려준다
async function failMessages(op, types) {
  await op.evaluate(ts => {
    if (!window.__origSend) window.__origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__failTypes = new Set(ts);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (window.__failTypes.has(msg?.type)) {
        const res = { ok: false, error: '테스트 실패' };
        return cb ? setTimeout(() => cb(res)) : Promise.resolve(res);
      }
      return cb ? window.__origSend(msg, cb) : window.__origSend(msg);
    };
  }, types);
}

test('내 피드백 칸(T-137): 빈 목록 문구는 목록 밖 문단, 피드백이 생기면 숨김', async ({ ext }) => {
  const op = ext.page;
  await expect(op.locator('#fbEmpty')).toBeVisible();
  await expect(op.locator('#fbEmpty')).toHaveText(EMPTY_FB);
  expect(await op.evaluate(() => document.getElementById('fbEmpty').tagName)).toBe('P');
  expect(await op.evaluate(() => !!document.getElementById('fbEmpty').closest('ul,ol'))).toBe(false);
  await expect(op.locator('#fbList li')).toHaveCount(0);
  await ext.send({ type: 'feedback', record: { sentence: P1, nodeId: 'meso', vote: 'down' } });
  await op.reload();
  await expect(op.locator('#fbList li')).toHaveCount(1);
  await expect(op.locator('#fbEmpty')).toBeHidden();
});

test('내 피드백 칸(T-137): 열린 설정 화면은 다른 페이지의 피드백·호버를 새로고침 없이 반영, 통계에 호버 대비 %', async ({ context, ext, extId }) => {
  const op = ext.page;
  await expect(op.locator('#fbEmpty')).toBeVisible();
  // 다른 탭에서 호버(비유)와 👎
  const other = await context.newPage();
  await other.goto(`chrome-extension://${extId}/popup.html`);
  const sendOther = m => other.evaluate(x => chrome.runtime.sendMessage(x), m);
  await sendOther({ type: 'explain', sentence: P1, word: '', context: '', pageTitle: 't', noCache: true });
  const r = await sendOther({ type: 'feedback', record: { sentence: P1, nodeId: 'meso', vote: 'down' } });
  await expect(op.locator('#fbList li')).toHaveCount(1);
  await expect(op.locator('#fbEmpty')).toBeHidden();
  await expect(op.locator('#fbStats')).toContainText(/👎 1 \(\d+%\)/);
  await expect(op.locator('#fbExport')).toBeEnabled();
  const [download] = await Promise.all([op.waitForEvent('download'), op.click('#fbExport')]);
  const { readFileSync } = await import('node:fs');
  expect(JSON.parse(readFileSync(await download.path(), 'utf8'))).toHaveLength(1);
  // 다른 탭에서 되돌리면 목록도 빈다
  await sendOther({ type: 'feedback-undo', id: r.data.id });
  await expect(op.locator('#fbList li')).toHaveCount(0);
  await expect(op.locator('#fbEmpty')).toBeVisible();
  await expect(op.locator('#fbExport')).toBeDisabled();
});

test('내 피드백 칸(T-137): 라벨 없는 항목은 날짜만, 구분점이 홀로 남지 않는다', async ({ ext }) => {
  const op = ext.page;
  await ext.send({ type: 'feedback', record: { sentence: P1, nodeId: 'meso', vote: 'pick' } }); // pickedNodeId 없음 → 라벨 없음
  await op.reload();
  const hint = op.locator('#fbList li .fb-text .hint');
  await expect(hint).toHaveCount(1);
  expect((await hint.textContent()).trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('내 피드백 칸(T-137): 보내기 설정 저장이 실패하면 체크를 되돌리고 오류 문구', async ({ ext }) => {
  const op = ext.page;
  await expect(op.locator('#fbShare')).not.toBeChecked();
  await failMessages(op, ['settings:save']);
  await op.locator('#fbShare').click();
  await expect(op.locator('#fbStatus')).toHaveText('저장하지 못했어요. 다시 시도해 주세요.');
  await expect(op.locator('#fbShare')).not.toBeChecked();
  await expect(op.locator('#fbSharePreview')).toBeHidden();
  expect((await storageGetFb(op, 'settings'))?.feedbackShare).not.toBe(true);
});

test('내 피드백 칸(T-137): 보내기 저장 중에 다른 탭 변경으로 목록을 다시 읽어도 체크가 덮이지 않는다', async ({ ext }) => {
  const op = ext.page;
  await expect(op.locator('#fbShare')).not.toBeChecked();
  // settings:save 응답을 붙잡아 저장이 끝나지 않은 상태를 만든다
  await op.evaluate(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg?.type === 'settings:save') { window.__releaseSave = () => orig(msg, cb); return; }
      return cb ? orig(msg, cb) : orig(msg);
    };
  });
  await op.locator('#fbShare').click();
  await expect.poll(() => op.evaluate(() => typeof window.__releaseSave)).toBe('function');
  // 저장 중 피드백 변경 → onChanged로 목록을 다시 읽음(저장된 share는 아직 false)
  await ext.send({ type: 'feedback', record: { sentence: P1, nodeId: 'meso', vote: 'down' } });
  await expect(op.locator('#fbList li')).toHaveCount(1);
  await expect(op.locator('#fbShare')).toBeChecked();
  await op.evaluate(() => window.__releaseSave());
  await expect.poll(async () => (await storageGetFb(op, 'settings'))?.feedbackShare).toBe(true);
  await expect(op.locator('#fbShare')).toBeChecked();
});

test('내 피드백 칸(T-137): 되돌리기·지우기 뒤 목록 다시 읽기가 실패하면 이전 목록을 두고 오류 문구', async ({ ext }) => {
  const op = ext.page;
  await ext.send({ type: 'feedback', record: { sentence: P1, nodeId: 'meso', vote: 'down' } });
  await ext.send({ type: 'feedback', record: { sentence: '연락처 010-1234-5678', nodeId: 'meso', vote: 'up' } });
  await op.reload();
  await expect(op.locator('#fbList li')).toHaveCount(2);
  await failMessages(op, ['feedback:list']);
  await op.locator('#fbList li').first().getByRole('button', { name: '되돌리기' }).click();
  await expect(op.locator('#fbStatus')).toHaveText('목록을 다시 읽지 못했어요.');
  await expect(op.locator('#fbList li')).toHaveCount(2);
  await expect(op.locator('#fbEmpty')).toBeHidden();
  expect(await storageGetFb(op, 'feedback')).toHaveLength(1); // 되돌리기 자체는 저장됨

  await op.evaluate(() => { document.getElementById('fbStatus').textContent = ''; });
  op.once('dialog', d => d.accept());
  await op.click('#fbClear');
  await expect(op.locator('#fbStatus')).toHaveText('목록을 다시 읽지 못했어요.');
  await expect(op.locator('#fbList li')).toHaveCount(2);
  expect(await storageGetFb(op, 'feedback')).toHaveLength(0);
});

/* ───────── 첫 실행 안내 (T-116) ───────── */
const storageGet = (page, key) => page.evaluate(async k => (await chrome.storage.local.get(k))[k], key);
// 설치 이벤트가 onboarding을 비동기로 쓰므로, 써질 때까지 기다린 뒤 설정 화면을 새로 연다
async function openFirstRun(ext) {
  await expect.poll(() => storageGet(ext.page, 'onboarding')).toEqual({ pending: true });
  await ext.page.reload();
  return ext.page;
}

test('첫 실행 안내(T-116): 자동 + 보내기 → 시작하기면 저장되고 아래 칸도 같은 값, 새로고침해도 안 뜸', async ({ ext }) => {
  const op = await openFirstRun(ext);
  await expect(op.locator('#onboarding')).toBeVisible();
  await expect(op.locator('#onboarding h2')).toHaveText('처음 오셨네요. 두 가지만 골라 주세요');
  await expect(op.locator('input[name=obTrigger][value=modifier]')).toBeChecked();
  await expect(op.locator('#obAutoWarn')).toBeHidden();
  // 동의는 미리 선택된 값 없음
  await expect(op.locator('#obShareYes')).toHaveAttribute('aria-pressed', 'false');
  await expect(op.locator('#obShareNo')).toHaveAttribute('aria-pressed', 'false');

  await op.locator('input[name=obTrigger][value=auto]').check();
  await expect(op.locator('#obAutoWarn')).toBeVisible();
  await expect(op.locator('#obAutoWarn')).toHaveText('호출이 많아져 무료 한도를 빨리 써요.');
  await op.click('#obShareNo');
  await expect(op.locator('#obShareNo')).toHaveAttribute('aria-pressed', 'true');
  await op.click('#obShareYes');
  await expect(op.locator('#obShareYes')).toHaveAttribute('aria-pressed', 'true');
  await expect(op.locator('#obShareNo')).toHaveAttribute('aria-pressed', 'false');
  await expect(op.locator('#obShareInfo')).toContainText('서버가 생기기 전까지는 이 기기에만 쌓아 둬요.');

  await op.click('#obStart');
  await expect(op.locator('#onboarding')).toBeHidden();
  await expect.poll(async () => (await storageGet(op, 'onboarding'))?.pending).toBe(false);
  expect(typeof (await storageGet(op, 'onboarding')).doneAt).toBe('number');
  const s = await storageGet(op, 'settings');
  expect(s.triggerMode).toBe('auto');
  expect(s.feedbackShare).toBe(true);
  await expect(op.locator('input[name=triggerMode][value=auto]')).toBeChecked();
  await expect(op.locator('#fbShare')).toBeChecked();

  await op.reload();
  await expect(op.locator('#onboarding[data-ready="1"]')).toHaveCount(1); // 안내 상태를 읽은 뒤에
  await expect(op.locator('#onboarding')).toBeHidden();
  await expect(op.locator('input[name=triggerMode][value=auto]')).toBeChecked();
});

test('첫 실행 안내(T-116): 아무것도 안 고르고 넘기기 → 설정은 그대로(Alt·보내지 않음), 기존 사용자(onboarding 없음)에겐 안 뜸', async ({ ext }) => {
  const op = await openFirstRun(ext);
  await expect(op.locator('#onboarding')).toBeVisible();
  await op.click('#obSkip');
  await expect(op.locator('#onboarding')).toBeHidden();
  await expect.poll(async () => (await storageGet(op, 'onboarding'))?.pending).toBe(false);
  expect(typeof (await storageGet(op, 'onboarding')).doneAt).toBe('number');
  const s = await storageGet(op, 'settings');
  expect(s?.triggerMode ?? 'modifier').toBe('modifier');
  expect(s?.feedbackShare).not.toBe(true);
  await expect(op.locator('input[name=triggerMode][value=modifier]')).toBeChecked();
  await expect(op.locator('#fbShare')).not.toBeChecked();

  // 기존 사용자: onboarding 키 자체가 없다
  await op.evaluate(() => chrome.storage.local.remove('onboarding'));
  await op.reload();
  await expect(op.locator('#onboarding[data-ready="1"]')).toHaveCount(1);
  await expect(op.locator('#onboarding')).toBeHidden();
});

test('첫 실행 안내(T-137): 보내기 동의 버튼은 이름 붙은 group으로 묶인다', async ({ ext }) => {
  const op = await openFirstRun(ext);
  const group = op.getByRole('group', { name: '서버로 보내기 동의' });
  await expect(group).toBeVisible();
  await expect(group.locator('#obShareYes')).toHaveCount(1);
  await expect(group.locator('#obShareNo')).toHaveCount(1);
});

test('첫 실행 안내(T-116): 넘기기는 이미 저장된 설정을 바꾸지 않는다', async ({ ext }) => {
  const op = await openFirstRun(ext);
  await ext.setSettings({ triggerMode: 'auto' });
  await op.click('#obSkip');
  await expect(op.locator('#onboarding')).toBeHidden();
  await expect.poll(async () => (await storageGet(op, 'onboarding'))?.pending).toBe(false);
  expect((await storageGet(op, 'settings')).triggerMode).toBe('auto');
  await expect(op.locator('input[name=triggerMode][value=auto]')).toBeChecked(); // 아래 칸도 저장된 값
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

// 같은 개념 👎 누적 → 로그인 사용자 오버레이 가중치 (T-130)
const DOWN_SENTENCES = ['예금 금리가 오르면 이자가 늘어난다.', '환율이 오르면 수입품 값이 비싸진다.', '물가가 오르면 같은 돈으로 살 수 있는 것이 줄어든다.'];

test('로그인 시 같은 노드에 서로 다른 문장 👎 3건 → 오버레이 feedbackBoosts -0.05, 같은 문장 반복은 세지 않음 (T-130)', async ({ ext }) => {
  const { send } = ext;
  expect((await send({ type: 'auth:login', nickname: '테스터' })).data.adapter).toBe('local-dev');
  const boost = async () => (await send({ type: 'overlay:get' })).data.feedbackBoosts.meso;
  for (const [i, sentence] of DOWN_SENTENCES.entries()) {
    expect(await boost()).toBeUndefined();
    expect((await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } })).ok).toBe(true);
    if (i < 2) expect(await boost()).toBeUndefined();
  }
  expect(await boost()).toBe(-0.05);
  // 이미 센 문장을 다시 👎해도 그대로
  await send({ type: 'feedback', record: { sentence: DOWN_SENTENCES[0], nodeId: 'meso', tagId: null, vote: 'down' } });
  expect(await boost()).toBe(-0.05);
  // 다른 노드에는 번지지 않는다
  expect((await send({ type: 'overlay:get' })).data.feedbackBoosts.auction).toBeUndefined();
});

test('로그인 시 👎 되돌리기는 가중치도 되돌리고, 다시 👎해도 더 내려가지 않는다 (T-130)', async ({ ext }) => {
  const { send } = ext;
  await send({ type: 'auth:login', nickname: '테스터' });
  const boosts = async () => (await send({ type: 'overlay:get' })).data.feedbackBoosts;
  const downMeso = async sentence => (await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } })).data.id;
  await downMeso(DOWN_SENTENCES[0]);
  await downMeso(DOWN_SENTENCES[1]);
  let id = await downMeso(DOWN_SENTENCES[2]);
  expect((await boosts()).meso).toBe(-0.05);
  for (let i = 0; i < 3; i++) {
    expect((await send({ type: 'feedback-undo', id })).ok).toBe(true);
    expect('meso' in (await boosts())).toBe(false); // 키를 지운다
    id = await downMeso(DOWN_SENTENCES[2]);
    expect((await boosts()).meso).toBe(-0.05);
  }
});

test('로그인 시 👎 누적은 손으로 넣은 nodeBoosts를 건드리지 않고 feedbackBoosts에만 쓴다 (T-130)', async ({ ext }) => {
  const { send } = ext;
  await send({ type: 'auth:login', nickname: '테스터' });
  expect((await send({ type: 'overlay:save', overlay: { nodeBoosts: { meso: 0.1 } } })).data.ok).toBe(true);
  for (const sentence of DOWN_SENTENCES) await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } });
  const ov = (await send({ type: 'overlay:get' })).data;
  expect(ov.nodeBoosts.meso).toBe(0.1);
  expect(ov.feedbackBoosts.meso).toBe(-0.05);
});

test('로그인 시 피드백 전부 지우기 → feedbackBoosts도 비워진다(가중치는 기록으로만 정해짐) (T-130)', async ({ ext }) => {
  const { send } = ext;
  await send({ type: 'auth:login', nickname: '테스터' });
  expect((await send({ type: 'overlay:save', overlay: { nodeBoosts: { meso: 0.1 } } })).data.ok).toBe(true);
  for (const sentence of DOWN_SENTENCES) await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } });
  expect((await send({ type: 'overlay:get' })).data.feedbackBoosts).toEqual({ meso: -0.05 });
  expect((await send({ type: 'feedback:clear' })).ok).toBe(true);
  const ov = (await send({ type: 'overlay:get' })).data;
  expect(ov.feedbackBoosts).toEqual({});
  expect(ov.nodeBoosts).toEqual({ meso: 0.1 }); // 손으로 넣은 값은 그대로
});

test('로그인 시 500건 상한으로 오래된 👎가 밀려나면 feedbackBoosts도 풀린다 (T-130)', async ({ ext }) => {
  const { send, page } = ext;
  await send({ type: 'auth:login', nickname: '테스터' });
  for (const sentence of DOWN_SENTENCES) await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } });
  expect((await send({ type: 'overlay:get' })).data.feedbackBoosts).toEqual({ meso: -0.05 });
  // 👍 497건 뒤에는 👎 3건이 남고(3 + 497 = 500), 498번째 👍에서 가장 오래된 👎가 밀려난다
  await page.evaluate(async () => {
    for (let i = 0; i < 497; i++) await chrome.runtime.sendMessage({ type: 'feedback', record: { sentence: `문장 ${i}`, nodeId: 'auction', vote: 'up' } });
  });
  expect((await send({ type: 'overlay:get' })).data.feedbackBoosts).toEqual({ meso: -0.05 });
  await send({ type: 'feedback', record: { sentence: '마지막 문장', nodeId: 'auction', vote: 'up' } });
  expect((await send({ type: 'overlay:get' })).data.feedbackBoosts).toEqual({});
});

test('로그아웃 상태의 같은 노드 👎 3건은 오버레이를 바꾸지 않는다 (T-130)', async ({ ext }) => {
  const { send } = ext;
  for (const sentence of DOWN_SENTENCES) {
    expect((await send({ type: 'feedback', record: { sentence, nodeId: 'meso', tagId: null, vote: 'down' } })).ok).toBe(true);
  }
  expect((await send({ type: 'feedback:list' })).data.items).toHaveLength(3); // 피드백 기록은 남는다
  await send({ type: 'auth:login', nickname: '테스터' });
  const ov = (await send({ type: 'overlay:get' })).data;
  expect(ov.nodeBoosts).toEqual({});
  expect(ov.feedbackBoosts).toEqual({});
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

test('fallback 체인: 429 모델은 다음 순서로 넘기고 쿨다운 동안 다시 부르지 않는다 (T-124)', async ({ ext }) => {
  const { send, setSettings } = ext;
  await setSettings({ models: { custom: 'mock-busy' } });
  const busyCalls = () => calls.filter(c => c.model === 'mock-busy').length;
  const before = busyCalls();
  const a = await send({ type: 'explain', sentence: '변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', noCache: true });
  expect(a.ok).toBe(true);
  expect(a.data.debug.provider).toBe('custom/mock-model');
  expect(a.data.debug.fallbacks[0]).toMatchObject({ provider: 'custom/mock-busy' });
  expect(a.data.analogy).toContain('같은 구조예요');
  expect(busyCalls() - before, '429는 같은 모델을 재시도하지 않음').toBe(1);

  const b = await send({ type: 'explain', sentence: 'API 서버는 분당 요청 수에 상한을 둔다.', noCache: true });
  expect(b.data.debug.provider).toBe('custom/mock-model');
  expect(b.data.debug.fallbacks[0]).toMatchObject({ provider: 'custom/mock-busy', reason: '쿨다운 중' });
  expect(busyCalls() - before, '쿨다운 중에는 부르지 않음').toBe(1);
});

/* ───────────── 서버 모드(T-404): 가짜 analogy-api(:8767), timeoutMs 800 ───────────── */

const REJECTED = '모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요.';
const footText = page => page.evaluate(() => document.getElementById('analogy-helper-host')?.shadowRoot.querySelector('.foot span')?.innerText ?? '');

test('서버 모드(T-404): 서버 결과를 말풍선에 보이고 foot에 서버, 요청마다 같은 설치 토큰', async ({ context, ext }) => {
  const before = analogyCalls.length;
  const llmBefore = calls.length;
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p5');
  await expect.poll(() => tooltip(page)).toContain(SERVER_ANALOGY);
  expect(await footText(page)).toBe('server/mock-analogy · 서버');
  expect(await tooltip(page)).toContain('근거: 스타포스 강화');

  const r = await ext.send({ type: 'explain', sentence: '서버정상 두 번째 문장이에요.', word: '', context: '', pageTitle: 't', noCache: true });
  expect(r.data.source).toBe('server');
  expect(r.data.analogy).toBe(SERVER_ANALOGY);
  expect(r.data.feedbackApplied).toBe(false);
  expect(r.data.debug.server).toMatchObject({ used: true });
  expect(typeof r.data.debug.server.ms).toBe('number');
  expect(calls.length - llmBefore, '서버가 답하면 LLM을 부르지 않음').toBe(0);

  const mine = analogyCalls.slice(before);
  expect(mine).toHaveLength(2);
  expect(mine[0].path).toBe('/v1/analogy');
  expect(mine[0].body).toMatchObject({ sentence: '서버정상 확률형 강화는 실패하면 들인 비용만 날아간다.' });
  expect(Object.keys(mine[0].body).sort()).toEqual(['context', 'pageTitle', 'sentence', 'word']);
  const token = mine[0].headers['x-install-token'];
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  expect(mine[1].headers['x-install-token']).toBe(token);
  const stored = await ext.page.evaluate(async () => (await chrome.storage.local.get('installToken')).installToken);
  expect(stored).toBe(token);

  // 서버 결과도 세션 캐시에 남는다
  const c = await ext.send({ type: 'explain', sentence: '서버정상 두 번째 문장이에요.', word: '', context: '', pageTitle: 't' });
  expect(c.data.cached).toBe(true);
  expect(c.data.source).toBe('server');
  expect(analogyCalls.length - before).toBe(2);
});

test('서버 모드(T-404): 서버 500이면 로컬 결과, foot에 로컬', async ({ context, ext }) => {
  const r = await ext.send({ type: 'explain', sentence: '서버오류 금리가 오르면 이자가 늘어난다.', noCache: true });
  expect(r.data.source).toBe('local');
  expect(r.data.debug.server).toEqual({ used: false, reason: 'http-500' });
  expect(r.data.analogy).toContain('같은 구조예요');
  expect(r.data.debug.provider).toBe('custom/mock-model');

  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('메이플스토리로 보면');
  await expect.poll(() => footText(page)).toBe('custom/mock-model · 로컬');
});

test('서버 모드(T-404): 서버가 느리면 timeoutMs에서 끊고 로컬로', async ({ ext }) => {
  await ext.send({ type: 'embed:warmup' }); // 모델 준비 시간을 재지 않게
  const t0 = Date.now();
  const r = await ext.send({ type: 'explain', sentence: '서버지연 환율이 오르면 수입품 값이 비싸진다.', noCache: true });
  const ms = Date.now() - t0;
  expect(r.data.source).toBe('local');
  expect(r.data.debug.server).toEqual({ used: false, reason: 'timeout' });
  expect(r.data.analogy).toContain('같은 구조예요');
  expect(ms, '서버 지연(5초)을 기다리지 않음').toBeLessThan(3000);
});

test('서버 모드(T-404): 서버가 후보 밖 nodeId를 대면 비유를 숨긴다(규칙 1)', async ({ ext }) => {
  const r = await ext.send({ type: 'explain', sentence: '서버후보밖 레버리지는 손익을 키운다.', noCache: true });
  expect(r.data.source).toBe('server');
  expect(r.data.analogy).toBe('');
  expect(r.data.rejected).toBe(REJECTED);
  expect(r.data.evidence).toBeNull();
  expect(r.data.meaning).toBe('서버 뜻 풀이예요.');
});

test('서버 모드(T-404): 그 문장에 👎 기록이 있으면 서버를 부르지 않는다', async ({ ext }) => {
  const q = { sentence: '서버정상 물가가 오르면 화폐 가치가 떨어진다.', word: '', context: '', pageTitle: 't' };
  const r1 = await ext.send({ type: 'explain', ...q });
  expect(r1.data.source).toBe('server');
  const before = analogyCalls.length;
  const fb = await ext.send({ type: 'feedback', record: { sentence: q.sentence, nodeId: r1.data.evidence.nodeId, tagId: null, vote: 'down', provider: r1.data.debug.provider }, rerun: q });
  expect(fb.ok).toBe(true);
  expect(fb.data.result.source).toBe('local');
  expect(fb.data.result.debug.server).toEqual({ used: false, reason: 'feedback' });
  const r2 = await ext.send({ type: 'explain', ...q, noCache: true });
  expect(r2.data.source).toBe('local');
  expect(analogyCalls.length - before, '가짜 서버 요청 수 그대로').toBe(0);
});

test('서버 모드(T-404): 로그인 세션이면 서버를 부르지 않는다', async ({ ext }) => {
  const { send } = ext;
  await send({ type: 'auth:login', nickname: '테스터' });
  const before = analogyCalls.length;
  const r = await send({ type: 'explain', sentence: '서버정상 예금 금리가 오르면 이자가 늘어난다.', noCache: true });
  expect(r.data.source).toBe('local');
  expect(r.data.debug.server).toEqual({ used: false, reason: 'session' });
  expect(analogyCalls.length - before).toBe(0);
  await send({ type: 'auth:logout' });
});

/* ───────── 제외 사이트 (T-107) ───────── */
// 가짜 LLM·가짜 analogy-api 요청 수 합계. 제외면 둘 다 그대로여야 한다
const sentCount = () => calls.length + analogyCalls.length;

test('제외 사이트(T-107): 목록에 넣으면 떠 있던 말풍선이 닫히고 Alt+호버해도 안 보냄, 빼면 새로고침 없이 다시 동작', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('같은 구조예요');

  await ext.setSettings({ excludedHosts: ['kbstar.com', '127.0.0.1'] });
  await expect.poll(() => tooltip(page), { message: '제외되면 떠 있던 말풍선을 숨김' }).toBe('');

  const before = sentCount();
  await altHover(page, '#p2');
  await page.waitForTimeout(1500);
  expect(await tooltip(page), '제외 사이트에서는 말풍선 없음').toBeFalsy();
  expect(await page.evaluate(() => CSS.highlights.has('analogy-helper-hl')), '강조도 없음').toBe(false);
  expect(sentCount() - before, '제외 사이트에서는 요청을 보내지 않음').toBe(0);

  await ext.setSettings({ excludedHosts: ['kbstar.com'] });
  await page.waitForTimeout(300);
  await altHover(page, '#p2');
  await expect.poll(() => tooltip(page)).toContain('같은 구조예요');
  expect(sentCount() - before).toBeGreaterThan(0);
});

test('비밀번호 폼(T-107): 폼 안 문장은 안 보내고, 같은 페이지 폼 밖 문장은 정상', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const before = sentCount();
  await altHover(page, '#p7');
  await page.waitForTimeout(1500);
  expect(await tooltip(page), '비밀번호 폼 안에서는 말풍선 없음').toBeFalsy();
  expect(sentCount() - before, '비밀번호 폼 안 문장은 보내지 않음').toBe(0);
  expect(calls.some(c => c.user.includes('비밀번호폼테스트'))).toBe(false);

  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('같은 구조예요');
  expect(sentCount() - before).toBeGreaterThan(0);
});

test('팝업(T-107): 탭 주소를 못 읽으면(확장 페이지로 연 팝업, activeTab 없음) "이 사이트에서 끄기"를 끄고 안내 문구', async ({ context, extId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`); // 현재 탭이 확장 페이지
  await expect(page.locator('#siteOff')).toBeDisabled();
  await expect(page.locator('label[for="siteOff"]')).toHaveText('이 사이트에서 끄기');
  await expect(page.locator('#siteHost')).toHaveText('이 페이지에서는 쓸 수 없어요.');
});

test('비밀번호 폼(T-107): 같은 블록 안 비밀번호 폼 글자는 문장·앞 문장으로 새지 않는다', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const before = calls.length, serverBefore = analogyCalls.length;
  await altHover(page, '#p8i');
  await expect.poll(() => tooltip(page)).toContain('같은 구조예요');
  const mine = calls.slice(before);
  expect(mine.some(c => c.user.includes('도입문장테스트'))).toBe(true);
  expect(mine.filter(c => c.user.includes('폼라벨비밀문구')), 'LLM에 폼 글자가 가면 안 됨').toEqual([]);
  expect(analogyCalls.slice(serverBefore).filter(c => JSON.stringify(c.body).includes('폼라벨비밀문구')), '서버에도 안 감').toEqual([]);
});

/* ───────── 제외 사이트 다듬기 (T-144) ───────── */
const siteItems = p => p.locator('#siteList li');

test('설정 화면 제외 사이트(T-144): 기본 17개, 추가하면 열린 탭이 바로 꺼지고 지우면 다시 동작', async ({ context, ext }) => {
  const opt = ext.page;
  await expect(siteItems(opt)).toHaveCount(17);
  await expect(opt.locator('#sec-sites h2')).toHaveText('제외 사이트');
  await expect(opt.locator('#sec-sites .desc')).toHaveText('이 사이트에서는 문장을 읽지 않아요. 메일·은행·로그인 페이지는 기본으로 들어 있어요.');
  await expect(opt.locator('#siteInput')).toHaveAttribute('placeholder', '예: mail.example.com');
  await expect(siteItems(opt).first()).toContainText('mail.google.com');

  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');

  await opt.fill('#siteInput', 'http://127.0.0.1:8766/');
  await opt.click('#siteAdd');
  await expect(siteItems(opt)).toHaveCount(18);
  await expect(siteItems(opt).last()).toContainText('127.0.0.1');
  await expect(opt.locator('#siteInput')).toHaveValue('');

  await page.waitForTimeout(300);
  const before = sentCount();
  await altHover(page, '#p1');
  await page.waitForTimeout(1500);
  expect(await tooltip(page), '제외 사이트에서는 말풍선 없음').toBeFalsy();
  expect(sentCount() - before, '요청 0').toBe(0);

  await opt.getByRole('button', { name: '127.0.0.1 지우기' }).click();
  await expect(siteItems(opt)).toHaveCount(17);
  await page.waitForTimeout(300);
  await altHover(page, '#p1');
  await expect.poll(() => tooltip(page)).toContain('같은 구조예요');
});

test('설정 화면 제외 사이트(T-144): 잘못된 입력·중복 오류, 기본 목록으로 되돌리기, 다른 곳에서 바뀌면 다시 그림', async ({ ext }) => {
  const opt = ext.page;
  await expect(siteItems(opt)).toHaveCount(17);
  await opt.fill('#siteInput', 'abc');
  await opt.click('#siteAdd');
  await expect(opt.locator('#siteStatus')).toHaveText('주소를 확인해 주세요.');
  await expect(opt.locator('#siteInput')).toHaveValue('abc');
  await opt.fill('#siteInput', 'https://m.kbstar.com/x');
  await opt.press('#siteInput', 'Enter');
  await expect(opt.locator('#siteStatus')).toHaveText('이미 들어 있어요.');
  await expect(siteItems(opt)).toHaveCount(17);

  await opt.getByRole('button', { name: 'kbstar.com 지우기', exact: true }).click();
  await opt.getByRole('button', { name: 'toss.im 지우기' }).click();
  await expect(siteItems(opt)).toHaveCount(15);
  const saved = async () => (await ext.page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.excludedHosts));
  expect(await saved()).not.toContain('kbstar.com');

  await opt.click('#siteReset');
  await expect(siteItems(opt)).toHaveCount(17);
  expect((await saved()).length).toBe(17);

  // 팝업 토글처럼 다른 곳에서 저장해도 다시 그린다. 빈 목록 안내는 목록 밖 문단
  await ext.setSettings({ excludedHosts: [] });
  await expect(opt.locator('#siteEmpty')).toBeVisible();
  await expect(opt.locator('#siteEmpty')).toHaveText('제외한 사이트가 없어요.');
  await expect(opt.locator('#siteList')).toBeHidden();
  await ext.setSettings({ excludedHosts: ['example.com'] });
  await expect(siteItems(opt)).toHaveCount(1);
  await expect(opt.locator('#siteEmpty')).toBeHidden();
});

// 테스트 전용 훅(hook-content.js)으로 content.js를 거치지 않고 background에 바로 보낸다
const hook = (page, kind, payload) => page.evaluate(([k, p]) => new Promise((resolve, reject) => {
  const id = Math.random().toString(36).slice(2);
  const t = setTimeout(() => reject(new Error('훅 응답 없음: ' + k)), 20000);
  window.addEventListener('message', function on(e) {
    if (e.source !== window || e.data?.__e2eHookResult?.id !== id) return;
    window.removeEventListener('message', on);
    clearTimeout(t);
    resolve(e.data.__e2eHookResult);
  });
  window.postMessage({ __e2eHook: k, id, payload: p }, '*');
}), [kind, payload]);

test('이중 방어(T-144): content.js를 건너뛰어도 background가 port·sendMessage·피드백 rerun 모두 막고, 빼면 정상', async ({ context, ext }) => {
  await ext.setSettings({ excludedHosts: ['127.0.0.1'] });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const q = { sentence: '이중방어테스트 변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', word: '', context: '', pageTitle: 't', noCache: true };
  const before = sentCount();
  const fbBefore = (await ext.page.evaluate(async () => (await chrome.storage.local.get('feedback')).feedback || [])).length;

  const port = await hook(page, 'explain-port', q);
  expect(port).toMatchObject({ ok: false, type: 'error', error: '이 사이트에서는 꺼져 있어요.' });
  expect(port.stages, '임베딩·검색 단계도 없음').toEqual([]);
  const msg = await hook(page, 'explain-msg', q);
  expect(msg).toMatchObject({ ok: false, error: '이 사이트에서는 꺼져 있어요.' });
  const fb = await hook(page, 'feedback', q);
  expect(fb).toMatchObject({ ok: false, error: '이 사이트에서는 꺼져 있어요.' });

  expect(sentCount() - before, '가짜 LLM·가짜 analogy-api 요청 0').toBe(0);
  expect(calls.some(c => c.user.includes('이중방어테스트'))).toBe(false);
  const fbAfter = (await ext.page.evaluate(async () => (await chrome.storage.local.get('feedback')).feedback || [])).length;
  expect(fbAfter, '막힌 피드백은 기록도 안 남김').toBe(fbBefore);

  await ext.setSettings({ excludedHosts: [] });
  const okRes = await hook(page, 'explain-port', q);
  expect(okRes.type).toBe('result');
  expect(okRes.result.analogy).toContain('같은 구조예요');
  expect(sentCount() - before).toBeGreaterThan(0);
});

/* ───────── 첫 결과 전 테마 깜빡임 (T-108) ───────── */
// 말풍선 .box 클래스가 바뀔 때마다 기록한다(처음 그려질 때 포함). 로딩 중인지(spin)도 함께
async function recordBoxClasses(page) {
  await page.evaluate(() => {
    window.__boxLog = [];
    const log = box => window.__boxLog.push({ cls: box.className, loading: !!box.querySelector('.spin') });
    const watch = host => {
      const box = host.shadowRoot.querySelector('.box');
      log(box);
      new MutationObserver(() => log(box)).observe(box, { attributes: true, attributeFilter: ['class'], childList: true });
    };
    const host = document.getElementById('analogy-helper-host');
    if (host) return watch(host);
    new MutationObserver((_, obs) => {
      const h = document.getElementById('analogy-helper-host');
      if (h) { obs.disconnect(); watch(h); }
    }).observe(document.documentElement, { childList: true });
  });
}
const boxLog = page => page.evaluate(() => window.__boxLog);
// content.js가 미리 받은 테마를 적용할 때까지 기다린다(고정 대기 대신, T-136 교훈)
const contentTheme = async page => (await hook(page, 'content-theme')).data;
const waitTheme = (page, theme) => expect.poll(() => contentTheme(page), { message: `content.js 테마 ${theme}` }).toEqual({ theme, ready: true });
const NEUTRAL_OVERLAY = {
  useCommon: false, domain: '축구', analogyPrefix: '축구로 치면', theme: 'neutral',
  nodes: [
    { id: 'u:offside', label: '오프사이드', facts: ['공격수가 마지막 수비수보다 앞에 있으면 반칙이다.'], tags: ['threshold_req'] },
    { id: 'u:transfer', label: '이적 시장', facts: ['인기 선수는 원하는 구단이 많아 이적료가 오른다.'], tags: ['market_price', 'scarcity_value'] }
  ]
};

test('테마(T-108): 중립 관심사면 로딩 말풍선부터 t-neutral, t-maple은 한 번도 없음', async ({ context, ext }) => {
  await ext.send({ type: 'auth:login', nickname: '테스터' });
  expect((await ext.send({ type: 'overlay:save', overlay: NEUTRAL_OVERLAY })).data.ok).toBe(true);
  expect((await ext.send({ type: 'graph:info' })).data.merged.theme, 'graph:info에 테마').toBe('neutral');

  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await waitTheme(page, 'neutral');
  await recordBoxClasses(page);
  await altHover(page, '#p9');
  await expect.poll(async () => (await boxLog(page)).some(e => e.loading && e.cls.includes('show')), { message: '로딩 말풍선이 보임' }).toBe(true);
  await expect.poll(() => tooltip(page), { timeout: 15_000 }).toContain('축구로 보면');
  const log = await boxLog(page);
  expect(log.filter(e => e.loading).length).toBeGreaterThan(0);
  expect(log.filter(e => e.cls.includes('t-maple')), '메이플 테마가 한 번도 보이면 안 됨').toEqual([]);
  expect(log.every(e => e.cls.includes('t-neutral'))).toBe(true);
});

test('테마(T-108): content.js를 거치지 않아도 explain 포트의 stage 메시지마다 theme(중립)이 실린다', async ({ context, ext }) => {
  await ext.send({ type: 'auth:login', nickname: '테스터' });
  await ext.send({ type: 'overlay:save', overlay: NEUTRAL_OVERLAY });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const r = await hook(page, 'explain-port', { sentence: '로딩지연테스트 테마 확인용 문장이에요.', word: '', context: '', pageTitle: 't', noCache: true });
  expect(r.type).toBe('result');
  expect(r.stageThemes.length).toBeGreaterThan(0);
  expect(r.stageThemes.every(t => t === 'neutral'), JSON.stringify(r.stageThemes)).toBe(true);
  expect(r.result.theme).toBe('neutral');
});

test('테마(T-108): 메이플 기본이면 로딩 말풍선도 t-maple (바뀌지 않음)', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await waitTheme(page, 'maple');
  await recordBoxClasses(page);
  await altHover(page, '#p9');
  await expect.poll(async () => (await boxLog(page)).some(e => e.loading), { message: '로딩 말풍선' }).toBe(true);
  await expect.poll(() => tooltip(page), { timeout: 15_000 }).toContain('메이플스토리로 보면');
  const log = await boxLog(page);
  expect(log.every(e => e.cls.includes('t-maple')), JSON.stringify(log)).toBe(true);
});

test('테마(T-108): 페이지를 연 뒤 로그인해 중립 관심사로 바꿔도 새로고침 없이 로딩부터 t-neutral', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await waitTheme(page, 'maple'); // 메이플 테마를 먼저 받아 둔 상태
  await ext.send({ type: 'auth:login', nickname: '테스터' });
  await ext.send({ type: 'overlay:save', overlay: NEUTRAL_OVERLAY });
  await waitTheme(page, 'neutral'); // 세션·오버레이 키 변경으로 다시 받음
  await recordBoxClasses(page);
  await altHover(page, '#p9');
  await expect.poll(() => tooltip(page), { timeout: 15_000 }).toContain('축구로 보면');
  const log = await boxLog(page);
  expect(log.some(e => e.loading)).toBe(true);
  expect(log.filter(e => e.cls.includes('t-maple')), JSON.stringify(log)).toEqual([]);
});

/* ───────── 여러 줄 문장 말풍선 위치 (T-109) ───────── */
// #p10(좁은 칸, 여러 줄)의 줄 rect들과, 줄마다 가운데 글자 index
const lineInfo = (page, sel = '#p10') => page.evaluate(s => {
  const t = document.querySelector(s).firstChild;
  const r = document.createRange();
  const lines = [];
  for (let i = 0; i < t.nodeValue.length; i++) {
    r.setStart(t, i); r.setEnd(t, i + 1);
    const b = r.getBoundingClientRect();
    if (!b.width) continue;
    let line = lines.find(l => Math.abs(l.top - b.top) < 4);
    if (!line) lines.push(line = { top: b.top, bottom: b.bottom, idx: [] });
    line.idx.push(i);
  }
  return lines.map(l => ({ top: l.top, bottom: l.bottom, mid: l.idx[Math.floor(l.idx.length / 2)] }));
}, sel);
// 말풍선 위치. 나타날 때 transform 애니메이션이 있어 style 값(배치 결과)을 읽는다
const boxPos = page => page.evaluate(() => {
  const box = document.getElementById('analogy-helper-host')?.shadowRoot.querySelector('.box');
  if (!box || !box.style.top) return null;
  const top = parseFloat(box.style.top);
  return { top, bottom: top + box.offsetHeight, text: box.innerText };
});
// #p10의 2번째 줄이 뷰포트 y에 오도록 스크롤
async function scrollLine2To(page, y, sel = '#p10') {
  await page.evaluate(([target, s]) => {
    const t = document.querySelector(s).firstChild;
    const rects = (() => { const r = document.createRange(); r.selectNodeContents(t); return [...r.getClientRects()]; })();
    window.scrollBy(0, rects[1].top - target);
  }, [y, sel]);
}

test('말풍선 위치(T-109): 여러 줄 문장 2번째 줄에서 호버하면 그 줄 바로 아래, 결과 뒤에도 같은 줄 기준', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await scrollLine2To(page, 200);
  const lines = await lineInfo(page);
  expect(lines.length, '3줄 이상으로 감김').toBeGreaterThanOrEqual(3);
  await altHover(page, '#p10', lines[1].mid);
  // 로딩 중에도 2번째 줄 아래
  await expect.poll(async () => { const p = await boxPos(page); return p && Math.abs(p.top - (lines[1].bottom + 8)) <= 3; }, { message: '로딩 말풍선이 2번째 줄 아래' }).toBe(true);
  // 커서를 (보조키 없이) 다른 줄로 옮겨도 결과 뒤 재배치는 처음 줄 기준
  const far = await pointOnChar(page, '#p10', lines.at(-1).mid);
  await page.mouse.move(far.x, far.y);
  await expect.poll(async () => (await boxPos(page))?.text ?? '').toContain('같은 구조예요');
  const p = await boxPos(page);
  expect(Math.abs(p.top - (lines[1].bottom + 8)), JSON.stringify({ p, lines })).toBeLessThanOrEqual(3);
  expect(p.top).toBeLessThan(lines.at(-1).bottom);
});

test('말풍선 위치(T-109): 화면 아래쪽 줄에서 호버하면 그 줄 위로 뒤집는다', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await scrollLine2To(page, 800 - 70); // 뷰포트 높이 800, 2번째 줄이 맨 아래 근처
  const lines = await lineInfo(page);
  await altHover(page, '#p10', lines[1].mid);
  await expect.poll(async () => (await boxPos(page))?.text ?? '').toContain('같은 구조예요');
  await expect.poll(async () => {
    const p = await boxPos(page);
    return p && Math.abs(p.bottom - (lines[1].top - 8)) <= 3;
  }, { message: '말풍선 bottom이 2번째 줄 top - 8' }).toBe(true);
});

test('말풍선 위치(T-109): 로딩 중 조금(40px) 스크롤해도 결과 뒤 재배치는 호버한 2번째 줄의 지금 위치 기준', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await scrollLine2To(page, 200, '#p11');
  const lines = await lineInfo(page, '#p11');
  expect(lines.length).toBeGreaterThanOrEqual(3);
  // 줄 아래쪽 가장자리 근처를 호버해, 40px 스크롤 뒤 같은 y가 다음 줄에 걸리게 한다
  const { x } = await pointOnChar(page, '#p11', lines[1].mid);
  const y = lines[1].bottom - 2;
  await page.mouse.move(x, y);
  await page.keyboard.down('Alt');
  await page.mouse.move(x + 1, y);
  await page.keyboard.up('Alt');
  await expect.poll(async () => { const p = await boxPos(page); return p && Math.abs(p.top - (lines[1].bottom + 8)) <= 3; }, { message: '로딩 말풍선이 2번째 줄 아래' }).toBe(true);
  // 가짜 LLM이 이 문장은 늦게 답한다(로딩지연테스트). 그 사이 40px 스크롤(닫히는 80px보다 적게)
  await page.evaluate(() => window.scrollBy(0, 40));
  await expect.poll(async () => (await boxPos(page))?.text ?? '', { timeout: 15_000 }).toContain('같은 구조예요');
  const live = await lineInfo(page, '#p11');
  expect(Math.abs(live[1].top - (lines[1].top - 40)), '스크롤이 실제로 됨').toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const p = await boxPos(page);
    return p && Math.abs(p.top - (live[1].bottom + 8));
  }, { message: '결과 뒤 말풍선 top ≈ 지금 2번째 줄 bottom + 8' }).toBeLessThanOrEqual(3);
});

/* ───────── iframe (T-111) ───────── */
// page.html 맨 아래의 iframe. 마우스 좌표 = iframe 위치(테두리 0) + 프레임 안 글자 위치
async function frameOf(page, frameSel) {
  const el = page.locator(frameSel);
  await el.scrollIntoViewIfNeeded();
  const frame = await (await el.elementHandle()).contentFrame();
  await frame.waitForSelector('p');
  return { el, frame };
}
async function altHoverFrame(page, frameSel, sel, idx = 5) {
  const { el, frame } = await frameOf(page, frameSel);
  const box = await el.boundingBox();
  const p = await pointOnChar(frame, sel, idx);
  const x = box.x + p.x, y = box.y + p.y;
  await page.mouse.move(x, y);
  await page.keyboard.down('Alt');
  await page.mouse.move(x + 1, y);
  await page.keyboard.up('Alt');
  return frame;
}

test('iframe(T-111): 같은 출처 iframe 안 문장도 Alt+호버로 그 프레임 안에 말풍선, 최상위 문서에는 안 뜸', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const frame = await altHoverFrame(page, '#fr-same', '#fa');
  await expect.poll(() => tooltip(frame)).toContain('같은 구조예요');
  expect(calls.some(c => c.user.includes('같은출처프레임테스트 변동금리 대출은'))).toBe(true);
  const hl = await frame.evaluate(() => [...CSS.highlights.get('analogy-helper-hl')][0].toString());
  expect(hl).toContain('같은출처프레임테스트');
  expect(await tooltip(page), '최상위 문서에는 말풍선 없음').toBeFalsy();
});

test('iframe(T-111): 다른 출처 iframe 안 문장도 동작, 최상위 호스트가 제외면 iframe 문장도 요청 0', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  let frame = await altHoverFrame(page, '#fr-cross', '#fb');
  expect(new URL(frame.url()).hostname).toBe('localhost');
  await expect.poll(() => tooltip(frame)).toContain('같은 구조예요');
  expect(calls.some(c => c.user.includes('다른출처프레임테스트 API 서버는'))).toBe(true);

  // 최상위(127.0.0.1)만 제외. iframe 호스트(localhost)는 목록에 없다
  await ext.setSettings({ excludedHosts: ['127.0.0.1'] });
  await expect.poll(() => tooltip(frame), { message: '최상위가 제외되면 iframe 말풍선도 닫힘' }).toBe('');
  await page.reload();
  const before = sentCount();
  frame = await altHoverFrame(page, '#fr-cross', '#fb', 8);
  await page.waitForTimeout(1500);
  expect(await tooltip(frame), 'iframe 말풍선 없음').toBeFalsy();
  expect(await frame.evaluate(() => CSS.highlights.has('analogy-helper-hl')), '강조도 없음').toBe(false);
  expect(sentCount() - before, '최상위가 제외면 iframe 문장도 보내지 않음').toBe(0);
});

test('iframe 이중 방어(T-111): content.js를 건너뛴 iframe 요청도 payload.topHost 가 제외면 background가 막는다', async ({ context, ext }) => {
  await ext.setSettings({ excludedHosts: ['127.0.0.1'] });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  const { frame } = await frameOf(page, '#fr-cross');
  const q = { sentence: '프레임이중방어테스트 변동금리 대출은 기준금리가 오르면 이자도 늘어난다.', word: '', context: '', pageTitle: 't', noCache: true, topHost: '127.0.0.1' };
  const before = sentCount();
  expect(await hook(frame, 'explain-port', q)).toMatchObject({ ok: false, type: 'error', error: '이 사이트에서는 꺼져 있어요.' });
  expect(await hook(frame, 'explain-msg', q)).toMatchObject({ ok: false, error: '이 사이트에서는 꺼져 있어요.' });
  expect(await hook(frame, 'feedback', q)).toMatchObject({ ok: false, error: '이 사이트에서는 꺼져 있어요.' });
  expect(sentCount() - before, '요청 0').toBe(0);

  // topHost 가 제외 목록 밖이면 같은 프레임에서 정상
  const okRes = await hook(frame, 'explain-port', { ...q, topHost: 'example.com' });
  expect(okRes.type).toBe('result');
  expect(sentCount() - before).toBeGreaterThan(0);
});

test('iframe(T-111): 서브프레임은 시작 시 테마를 미리 받지 않고, 처음 보조키 호버 때 받는다', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8766/');
  await waitTheme(page, 'maple'); // 최상위는 지금처럼 시작 시 받음
  const { frame } = await frameOf(page, '#fr-cross');
  expect(await contentTheme(frame), '서브프레임은 아직 graph:info 를 보내지 않음').toBeNull();
  await altHoverFrame(page, '#fr-cross', '#fb');
  await expect.poll(() => tooltip(frame)).toContain('같은 구조예요');
  await waitTheme(frame, 'maple');
});
