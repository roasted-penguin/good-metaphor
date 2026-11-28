// 판정기 평가 실행 (T-120): 문장마다 "이 문장의 추상 태그는?"을 판정기에 묻고 .tmp에 캐시한다.
// 캐시가 있으면 다시 호출하지 않는다(무료 한도 절약, 결과 고정). 지연 시간도 캐시에 함께 남는다(처음 호출 때 잰 값).
// 키 값은 출력하지 않는다(있음/없음만).
import fs from 'node:fs';
import { judge, judgeFor, tagChoices, TAG_QUESTION, parseAbstractJudge } from '../extension/lib/judges.js';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildAbstractJudgePrompt } from '../extension/lib/prompt.js';

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

// --- 정밀 모드 합침 (T-184): 추상화+태그 판정 한 번의 호출(buildAbstractJudgePrompt)을 문장마다 부르고 캐시한다 ---
// 확장 runAbstract(tagJudge)와 같은 프롬프트·파서를 쓴다. 캐시에는 없음 포함 전체 확률(answers)을 둬서
// 하한(floor)을 바꿔 다시 채점해도 호출하지 않는다. 제공자는 gemini-choice와 같은 키·모델(GEMINI_API_KEY, admin.defaultModels.gemini)

/**
 * @returns {Promise<{results: Map<string, {abstract:string, answers:{id,p}[]|null, ms:number|null, error?:string}>, label:string, cacheFile:URL}>}
 */
export async function loadPreciseJudgeResults({ cases, graph, admin, rpm = 10, offline = false, log = console.log }) {
  const j = judgeFor('gemini-choice', { env: process.env, admin });
  const pdef = PROVIDERS[j.def.provider];
  const provider = { id: j.def.provider, def: pdef, model: j.model, apiKey: j.apiKey, baseUrl: pdef.baseUrl };
  const label = `precise(추상화+판정) ${j.def.provider} ${j.model}`;
  const cacheFile = new URL(`../.tmp/judge-precise-${j.model.replace(/[^\w.-]/g, '_')}.json`, import.meta.url);
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile)) : {};
  const choices = tagChoices(graph);
  const todo = [...new Set(cases.map(c => c.sentence))].filter(s => !cache[s]);
  // --judge-offline: 한도가 찼을 때 캐시에 있는 문장만 쓴다. 없는 문장은 판정 빠짐(추상 구조도 없음 → 원문 질의)으로 채점된다
  if (todo.length && offline) log(`${label}: 캐시에 없는 문장 ${todo.length}개는 판정 없이 채점해요(--judge-offline)`);
  else if (todo.length) {
    log(`${label}: 새로 물을 문장 ${todo.length}개 (캐시 ${Object.keys(cache).length}개) · 키 ${j.apiKey ? '있음' : '없음'} · 분당 ${rpm}회`);
    const gap = Math.ceil(60000 / rpm);
    let last = 0;
    for (const [k, sentence] of todo.entries()) {
      for (let tries = 0, parseFails = 0; ; tries++) {
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const t0 = Date.now();
        try {
          // 확장 정밀 모드처럼 페이지 제목·단어 없이(평가셋에 없음)
          const p = buildAbstractJudgePrompt({ sentence, choices });
          const text = await complete(provider, p.system, p.user, { json: true, timeoutMs: 30000 });
          const r = parseAbstractJudge(text, choices);
          if (!r.answers && parseFails++ < 2) continue; // 판정이 빠진 응답은 두 번까지 다시
          cache[sentence] = { abstract: r.abstractText, answers: r.answers ? r.answers.filter(a => a.p > 0) : null, ms: Date.now() - t0, ...(r.answers ? {} : { error: 'parse' }) };
          break;
        } catch (e) {
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
