// Playwright 없이 크롬을 띄우고 CDP로 페이지 하나에만 붙는다 (T-102).
// Playwright는 서비스 워커에도 자동으로 붙는데, DevTools가 붙은 서비스 워커는 30초 유휴 종료가 꺼진다.
// 그래서 "서비스 워커가 잠들지 않는가"는 서비스 워커에 붙지 않은 채로 봐야 한다.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

export async function launchRaw({ ext, args = [] }) {
  const b = { proc: null, profile: null, onExit: null };
  try { return await start(ext, args, b); }
  catch (e) { await cleanup(b); throw e; } // 준비 중에 실패하면 크롬·프로필을 남기지 않는다
}

// 크롬을 끝내고(5초 안에 안 끝나면 강제) 프로필을 지운다. 여러 번 불러도 된다
async function cleanup(b) {
  const { proc } = b;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise(r => {
      const kill = setTimeout(() => { proc.kill('SIGKILL'); r(); }, 5000);
      proc.once('exit', () => { clearTimeout(kill); r(); });
      proc.kill('SIGTERM');
    });
  }
  if (b.onExit) { process.off('exit', b.onExit); b.onExit = null; }
  if (b.profile) { rmSync(b.profile, { recursive: true, force: true }); b.profile = null; }
}

async function start(ext, args, b) {
  const profile = mkdtempSync(path.join(tmpdir(), 'ah-raw-'));
  b.profile = profile;
  const exe = process.env.CHROMIUM_PATH || chromium.executablePath();
  const headless = process.env.HEADED ? [] : ['--headless=new'];
  const proc = spawn(exe, [
    ...headless, `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...args, 'about:blank'
  ], { stdio: 'ignore' });
  b.proc = proc;
  // 테스트 프로세스가 어떻게 끝나든 크롬을 남기지 않는다
  b.onExit = () => { try { proc.kill('SIGKILL'); } catch { /* 이미 끝남 */ } };
  process.once('exit', b.onExit);
  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Date.now() + 30_000;
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (Date.now() > until) throw new Error('크롬 디버깅 포트를 못 찾았어요');
    await new Promise(r => setTimeout(r, 100));
  }
  const [port, wsPath] = readFileSync(portFile, 'utf8').split('\n');
  let seq = 0;
  const pending = new Map();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // 연결이 끊기면 기다리던 호출을 모두 실패로(테스트가 끝없이 기다리지 않게)
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('CDP 연결이 끊겼어요'));
    pending.clear();
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP 연결이 닫혀 있어요'));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  // 압축해제 확장 id = 절대 경로 sha256 앞 32자(0-f → a-p). 크롬 내장 확장도 서비스 워커가 있어 id로 고른다
  const extId = [...createHash('sha256').update(realpathSync(ext)).digest('hex').slice(0, 32)].map(h => String.fromCharCode(97 + parseInt(h, 16))).join('');
  // 서비스 워커 대상은 목록으로만 본다(붙지 않는다)
  const workers = async () => (await cdp('Target.getTargets')).targetInfos.filter(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  let sw;
  const swUntil = Date.now() + 30_000;
  while (!(sw = (await workers())[0])) {
    if (Date.now() > swUntil) throw new Error('확장 서비스 워커가 안 떠요');
    await new Promise(r => setTimeout(r, 100));
  }

  // 설정 화면 하나에만 붙어 그 안에서 코드를 돌린다
  async function openPage(url) {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId); // 이게 없으면 "Cannot find default execution context"
    await cdp('Page.enable', {}, sessionId);
    const nav = await cdp('Page.navigate', { url }, sessionId);
    if (nav.errorText) throw new Error(`${url}: ${nav.errorText}`);
    // 기본 90초: 테스트 시간 제한(120초)보다 짧게 둬서 teardown이 돌 시간을 남긴다
    const evaluate = async (expression, timeoutMs = 90_000) => {
      let timer;
      const r = await Promise.race([
        cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId),
        new Promise((_, j) => { timer = setTimeout(() => j(new Error('evaluate 시간 초과')), timeoutMs); })
      ]).finally(() => clearTimeout(timer));
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // 페이지가 chrome.runtime을 쓸 수 있을 때까지
    const until2 = Date.now() + 15_000;
    while (!(await evaluate('document.readyState === "complete" && !!globalThis.chrome?.runtime?.id').catch(() => false))) {
      if (Date.now() > until2) throw new Error('페이지가 안 열려요: ' + url);
      await new Promise(r => setTimeout(r, 100));
    }
    return { evaluate };
  }

  async function close() {
    // 닫히면서 응답 없이 연결이 끊길 수 있어 잠깐만 기다린다
    let timer;
    await Promise.race([cdp('Browser.close').catch(() => {}), new Promise(r => { timer = setTimeout(r, 3000); })]);
    clearTimeout(timer);
    ws.close();
    await cleanup(b);
  }
  return { extId, swTargetId: sw.targetId, workers, openPage, close };
}
