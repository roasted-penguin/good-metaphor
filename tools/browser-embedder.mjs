// 평가용 임베더: 실제 확장(오프스크린, onnxruntime-web wasm)에서 벡터를 받는다 (T-128).
// Node(onnxruntime-node)와 브라우저는 q8 계산 결과가 달라 1위 개념이 54문장 중 16개 달랐다.
// 그래서 평가 수치는 사용자가 실제로 받는 브라우저 쪽으로 잰다. 계약은 e2e "평가 도구 계약" 테스트.
import { chromium } from '@playwright/test';
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 프로필을 다시 쓰면 크롬이 서비스 워커 등록과 스크립트를 프로필 캐시(Service Worker/ScriptCache·Database)에서
// 그대로 돌린다. 확장 판본이 같으면 바뀐 background.js·lib/*.js를 다시 읽지 않아, 예전 코드로 평가하게 된다(T-304 수정 1).
// 등록·스크립트 캐시만 지우고 모델 가중치가 든 CacheStorage는 남긴다(다운로드를 다시 하지 않게)
export function dropStaleServiceWorker(profileDir) {
  for (const sub of ['ScriptCache', 'Database']) {
    rmSync(path.join(profileDir, 'Default', 'Service Worker', sub), { recursive: true, force: true });
  }
}

/**
 * @param {{ profile?: string, fresh?: boolean, src?: string, out?: string, requireReady?: boolean, launchOptions?: object }} opts
 *   profile을 남겨 두면 모델 다운로드를 다시 하지 않는다. src·out·requireReady·launchOptions는 e2e(대체 임베더 사본)용
 * @returns {Promise<{ embed(texts: string[], kind: 'query'|'passage'): Promise<number[][]>, embedderId: string, status: string, warmupMs: number, send: Function, sw: object, close(): Promise<void> }>}
 */
export async function openBrowserEmbedder({ profile = '.tmp/ext-eval-profile', fresh = false, src = 'extension', out: outDir = '.tmp/ext-eval', requireReady = true, launchOptions } = {}) {
  const out = path.resolve(outDir);
  const prof = path.resolve(profile);
  rmSync(out, { recursive: true, force: true });
  if (fresh) rmSync(prof, { recursive: true, force: true });
  mkdirSync(prof, { recursive: true });
  dropStaleServiceWorker(prof);
  cpSync(src, out, { recursive: true });
  // LLM은 부르지 않는다 (데모)
  const adminPath = `${out}/config/admin.json`;
  const admin = JSON.parse(readFileSync(adminPath, 'utf8'));
  admin.defaultProvider = 'demo';
  writeFileSync(adminPath, JSON.stringify(admin, null, 2));

  const args = [`--disable-extensions-except=${out}`, `--load-extension=${out}`];
  const opts = launchOptions ? { ...launchOptions, args: [...(launchOptions.args || []), ...args] } : { channel: 'chromium', headless: !process.env.HEADED, args };
  const ctx = await chromium.launchPersistentContext(prof, opts);
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  const send = (type, extra = {}) => page.evaluate(m => chrome.runtime.sendMessage(m), { type, ...extra });

  const t = Date.now();
  const w = await send('embed:warmup'); // 오프스크린 문서를 띄우고 모델을 받는다
  if (!w.ok) throw new Error(w.error);
  const warmupMs = Date.now() - t;
  if (requireReady && w.data.status !== 'ready') throw new Error(`브라우저 임베더가 준비되지 않았어요: ${w.data.status} (${w.data.embedderId})`);

  async function embed(texts, kind) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += 32) {
      const r = await page.evaluate(m => chrome.runtime.sendMessage(m), { target: 'offscreen', type: 'embed', texts: texts.slice(i, i + 32), kind, config: admin.embedding });
      if (r?.error) throw new Error(r.error);
      vectors.push(...r.vectors);
    }
    return vectors;
  }
  return { embed, embedderId: w.data.embedderId, status: w.data.status, warmupMs, send, sw, close: () => ctx.close() };
}
