// 판정기 평가 실행 (T-120): 문장마다 "이 문장의 추상 태그는?"을 판정기에 묻고 .tmp에 캐시한다.
// 캐시가 있으면 다시 호출하지 않는다(무료 한도 절약, 결과 고정). 지연 시간도 캐시에 함께 남는다(처음 호출 때 잰 값).
// 키 값은 출력하지 않는다(있음/없음만).
import fs from 'node:fs';
import { judge, judgeFor, tagChoices, TAG_QUESTION } from '../extension/lib/judges.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 503 "high demand"·429·네트워크 오류는 길게 물러서며 다시(providers.js의 짧은 재시도 뒤). 평가 도구 전용
const BACKOFF_MS = [10000, 20000, 40000, 80000];
const retryable = e => e.status === 429 || e.status >= 500 || e.status === 0;

/**
 * @returns {Promise<{results: Map<string, {answers:{id,p}[], ms:number|null, error?:string}>, label:string, cacheFile:URL}>}
 */
export async function loadJudgeResults({ judgeId, cases, graph, admin, rpm = 10, log = console.log }) {
  const j = judgeFor(judgeId, { env: process.env, admin });
  const label = `${judgeId}${j.model ? ' ' + j.model : ''}`;
  const cacheFile = new URL(`../.tmp/judge-${judgeId}${j.model ? '-' + j.model.replace(/[^\w.-]/g, '_') : ''}.json`, import.meta.url);
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile)) : {};
  const choices = tagChoices(graph);
  const todo = [...new Set(cases.map(c => c.sentence))].filter(s => !cache[s]);
  if (todo.length) {
    log(`판정기 ${label}: 새로 물을 문장 ${todo.length}개 (캐시 ${Object.keys(cache).length}개) · 키 ${j.apiKey ? '있음' : '없음'} · 분당 ${rpm}회`);
    const gap = Math.ceil(60000 / rpm);
    let last = 0;
    for (const [k, sentence] of todo.entries()) {
      for (let tries = 0, parseFails = 0; ; tries++) {
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const t0 = Date.now();
        try {
          const answers = await judge(j, { text: sentence, question: TAG_QUESTION, choices, multi: true }, { timeoutMs: 30000 });
          cache[sentence] = { answers: answers.filter(a => a.p > 0), ms: Date.now() - t0 };
          break;
        } catch (e) {
          // 응답 형식이 깨진 것은 두 번까지만 다시 묻고, 그래도 안 되면 "판정 없음"으로 남긴다
          if (/판정 응답을 읽지 못했어요/.test(e.message)) {
            if (++parseFails <= 2) continue;
            cache[sentence] = { answers: [], ms: Date.now() - t0, error: 'parse' };
            break;
          }
          if (!retryable(e) || tries >= BACKOFF_MS.length) throw e;
          log(`  ${e.status || '네트워크'} — ${BACKOFF_MS[tries] / 1000}초 뒤 다시 (${tries + 1}/${BACKOFF_MS.length})`);
          await sleep(BACKOFF_MS[tries]);
        }
      }
      fs.mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      if (process.stdout.isTTY) process.stdout.write(`\r  판정 ${k + 1}/${todo.length}`);
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  }
  const results = new Map(cases.map(c => [c.sentence, cache[c.sentence]]));
  log(`판정기: ${label} (캐시 ${cacheFile.pathname})`);
  return { results, label, cacheFile };
}
