// 웹스토어 빌드 확인(T-303): npm run build:store 결과를 별도 사본으로 크롬에 올려,
// 서비스 워커가 뜨고 설정 화면에 데모 제공자·개발용 로그인이 보이지 않는지 본다.
// 스토어 빌드는 실제 제공자(키 없음)라 LLM·모델 다운로드를 부르지 않는 화면만 확인한다
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forbiddenFiles } from '../../scripts/store-transform.mjs';

let ext;
test.beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-store.mjs'], { stdio: 'pipe' });
  ext = mkdtempSync(path.join(tmpdir(), 'ah-store-ext-'));
  cpSync('dist/store', ext, { recursive: true });
});

test('스토어 빌드(T-303): zip 에 테스트 파일이 없고, 확장이 뜨며 설정 화면에 데모 제공자·개발용 로그인이 없다', async () => {
  test.setTimeout(90_000);
  const { version, name } = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  expect(name).toBe('좋은비유네용');
  const listed = execFileSync('unzip', ['-Z1', `dist/good-metaphor-${version}.zip`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  expect(listed).toContain('manifest.json'); // zip 최상위에 manifest
  expect(forbiddenFiles(listed)).toEqual([]);

  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`];
  const opts = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, headless: false, args: ['--headless=new', ...args] }
    : { channel: 'chromium', headless: !process.env.HEADED, args };
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'ah-store-')), { ...opts, locale: 'ko-KR' });
  try {
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    // 제공자 목록: 데모 없음, 기본은 체인 첫 제공자
    await expect(page.locator('#provider option')).not.toHaveCount(0);
    const values = await page.locator('#provider option').evaluateAll(os => os.map(o => o.value));
    expect(values).not.toContain('demo');
    await expect(page.locator('#provider option', { hasText: '데모' })).toHaveCount(0);
    // 로그인: none 어댑터 → 안내 문구, 닉네임 칸 숨김, 로그인 버튼 꺼짐
    await expect(page.locator('#adapterHint')).toHaveText(/로그인이 꺼져 있어요/);
    await expect(page.locator('#nickname')).toBeHidden();
    await expect(page.locator('#login')).toBeDisabled();
    const auth = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'auth:status' }));
    expect(auth.data.adapter).toBe('none');
  } finally {
    await context.close();
  }
});
