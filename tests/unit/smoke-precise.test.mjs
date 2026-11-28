// 정밀 모드 합친 호출 스모크(T-186): 가짜 fetch로 Groq(openai-compat) 응답을 흉내 내 집계를 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, complete } from '../../extension/lib/providers.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';
import { PRECISE_SENTENCES, checkPreciseJudge, summarizePrecise, preciseSummaryLine, preciseRowLine, outOfListIds } from '../../tools/smoke-precise.mjs';
import { tagChoices } from '../../extension/lib/judges.js';

const tags = loadCommonGraphFromDisk().tags;
const groq = { id: 'groq', def: PROVIDERS.groq, model: PROVIDERS.groq.defaultModel, apiKey: 'test-key', baseUrl: PROVIDERS.groq.baseUrl };

// 가짜 fetch: 문장마다 정한 content를 돌려준다. 받은 요청 본문을 남긴다
function fakeFetch(contentFor) {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body });
    const user = body.messages.find(m => m.role === 'user').content;
    const content = contentFor(user);
    if (content instanceof Error) return new Response(JSON.stringify({ error: { message: content.message } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, seen };
}

async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('고정 문장: 6~8개, 구조 문장의 기대 태그는 tags.json 안, 일상 문장(기대 없음) 2개', () => {
  assert.ok(PRECISE_SENTENCES.length >= 6 && PRECISE_SENTENCES.length <= 8);
  const ids = new Set(tags.map(t => t.id));
  for (const s of PRECISE_SENTENCES) if (s.expectTag) assert.ok(ids.has(s.expectTag), s.expectTag);
  assert.equal(PRECISE_SENTENCES.filter(s => !s.expectTag).length, 2);
});

test('outOfListIds: 선택지·none 밖 id만 센다, JSON 아니면 0', () => {
  const choices = tagChoices(tags);
  assert.equal(outOfListIds('{"abstract":"a","tags":[{"id":"market_price","p":0.9},{"id":"none","p":0.1},{"id":"supply_shock","p":0.5}]}', choices), 1);
  assert.equal(outOfListIds('{"abstract":"a","tags":{"made_up":0.4,"cooldown":0.9}}', choices), 1);
  assert.equal(outOfListIds('그냥 글', choices), 0);
});

test('checkPreciseJudge: 가짜 Groq 응답으로 JSON·목록 밖 id·없음 우세·실패를 센다', async () => {
  const { f, seen } = fakeFetch(user => {
    if (user.includes('김치찌개')) return '{"abstract":"일상의 식사","tags":[{"id":"none","p":0.9}]}';
    if (user.includes('영화를')) return '구조가 없는 일상이에요.'; // JSON 아님 → 판정 없음
    if (user.includes('호가')) return '```json\n{"abstract":"수요가 몰리면 값이 오른다","tags":[{"id":"market_price","p":0.95},{"id":"demand_spike","p":0.6}]}\n```';
    if (user.includes('인증번호')) return new Error('bad request');
    return '{"abstract":"구조","tags":[{"id":"loss_risk","p":0.8}]}';
  });
  const rows = await withFetch(f, async () => {
    const out = [];
    for (const s of PRECISE_SENTENCES) out.push(await checkPreciseJudge((sys, user, opts) => complete(groq, sys, user, opts), s, tags, { floor: 0.7 }));
    return out;
  });
  // 확장과 같은 합친 프롬프트(시스템에 tags·none 선택지)를 Groq 기본 모델로 보낸다. 키 값은 행에 남기지 않는다
  assert.equal(seen.length, PRECISE_SENTENCES.length);
  assert.ok(seen.every(x => x.url.startsWith(PROVIDERS.groq.baseUrl) && x.body.model === PROVIDERS.groq.defaultModel));
  assert.ok(seen.every(x => { const all = x.body.messages.map(m => m.content).join('\n'); return all.includes('"tags"') && all.includes('none') && all.includes('market_price'); }));
  assert.ok(!JSON.stringify(rows).includes('test-key'));
  const s = summarizePrecise(rows);
  assert.equal(s.n, 8);
  assert.equal(s.errors, 1);                 // 인증번호 400
  assert.equal(s.json, 6);                   // 영화(글)·인증번호(실패) 빼고
  assert.equal(s.outOfList, 1);              // demand_spike
  assert.equal(s.noneDaily, 1);              // 김치찌개만(영화는 JSON 아님)
  assert.equal(s.dailyN, 2);
  assert.equal(s.noneStructured, 0);
  // 1위가 기대와 같은 구조 문장: 레버리지(loss_risk), 호가(market_price)
  assert.equal(s.tagHit, 2);
  assert.equal(s.structuredN, 6);
  assert.ok(s.median >= 0 && s.p90 >= s.median);
  const hoga = rows.find(r => r.sentence.includes('호가'));
  assert.equal(hoga.top, 'market_price');
  assert.equal(hoga.structureless, false);
  const kimchi = rows.find(r => r.sentence.includes('김치찌개'));
  assert.equal(kimchi.none, true);
  assert.equal(kimchi.structureless, true);
  // 출력 줄
  assert.match(preciseSummaryLine('groq/x', s), /JSON 6\/8 · .*목록 밖 id 1 · 없음 우세 1 \(일상 1\/2, 구조 문장 0\/6\) · 기대 태그 1위 2\/6 .*호출 실패 1/);
  assert.match(preciseRowLine(rows.find(r => r.sentence.includes('영화를'))), /✗ .*JSON 아님/);
  assert.match(preciseRowLine(rows.find(r => r.sentence.includes('인증번호'))), /호출 실패/);
  assert.match(preciseRowLine(hoga), /✓ .*1위 market_price .*목록 밖 id 1/);
});

test('summarizePrecise: 빈 목록이면 지연은 null', () => {
  const s = summarizePrecise([]);
  assert.equal(s.n, 0);
  assert.equal(s.median, null);
});
