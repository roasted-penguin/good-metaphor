// 제공자 fallback 체인(T-124). 순서 = 사용자가 고른 것 → config/admin.json 의 fallbackChain.
// 429·503·네트워크·시간 초과면 다음 순서로 넘기고, 429를 받은 모델은 쿨다운 동안 건너뛴다.
// 로컬 제공자(def.local, 맥 Ollama)는 어디에 있든 맨 뒤로 보낸다: 다른 무료 모델이 무조건 먼저(T-127).
import { PROVIDERS, complete } from './providers.js';
import { providerFor } from './config.js';

const keyOf = p => `${p.id}/${p.model}`;
const usable = p => p.def.keyOptional || !!p.apiKey;

export function buildChain(primary, admin, settings) {
  if (primary.def.kind === 'demo') return [primary];
  const allowed = admin.allowedProviders || Object.keys(PROVIDERS);
  const chain = [primary];
  for (const { provider, model } of admin.fallbackChain || []) {
    if (!PROVIDERS[provider] || !allowed.includes(provider) || PROVIDERS[provider].kind === 'demo') continue;
    const p = providerFor(provider, model, admin, settings);
    if (!usable(p) || chain.some(c => keyOf(c) === keyOf(p))) continue;
    chain.push(p);
  }
  return [...chain.filter(p => !p.def.local), ...chain.filter(p => p.def.local)];
}

// 다음 순서로 넘길 오류인가: 일시 오류만. 키 오류(400·401·403)는 그대로 던진다
const passes = e => e.status === 429 || e.status === 503 || e.network || /시간이 초과/.test(e.message);

// ── 429 쿨다운 기간(T-126) ──
// 하루 한도인지는 제공자 id가 아니라 본문 모양으로 판정한다(규칙 7: 제공자별 분기 금지, 표 하나).
// 표에 없는 모양(분당 TPM·RPM·PerMinute, 모르는 429)은 분당으로 본다.
const GEMINI_PER_DAY = /PerDay/; // Gemini quotaId 모양 (…PerDayPerProjectPerModel…), 판정·기간이 같이 쓴다
const DAILY_PATTERNS = [
  /on (?:tokens|requests) per day \((?:TPD|RPD)\)/i, // Groq 모양
  GEMINI_PER_DAY
];
const errText = e => `${e?.message || ''}\n${e?.body || ''}`;

export const isDailyLimit = e => DAILY_PATTERNS.some(re => re.test(errText(e)));

// "Please try again in 1h12m3s" / "820ms" → ms(올림). 없으면 null. 분(m) 뒤에 s가 오면 ms 단위다
function tryAgainMs(text) {
  const m = /try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(text);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const sec = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0) + (parseFloat(m[4]) || 0) / 1000;
  return Math.ceil(Math.round(sec * 1e6) / 1e3); // 부동소수 오차(21.6*1000 등)를 지운 뒤 올림
}

// t 시각의 America/Los_Angeles 벽시계와 UTC 의 차이(ms)
const laFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
});
const laParts = t => Object.fromEntries(laFmt.formatToParts(t).map(x => [x.type, +x.value]));
function laOffset(t) {
  const p = laParts(t);
  const s = Math.floor(t / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}
// now 보다 엄격히 뒤인 다음 LA 자정(epoch ms). 자정은 서머타임 전환 시각(02:00)과 겹치지 않는다
function nextLaMidnight(now) {
  const p = laParts(now);
  const wall = Date.UTC(p.year, p.month - 1, p.day + 1); // 다음 날 00:00 벽시계(UTC로 읽은 값)
  let t = wall - laOffset(now);
  t = wall - laOffset(t); // 전환일이면 그 시각의 오프셋으로 한 번 더 맞춘다
  return t;
}

// 하루 한도 기간을 정하는 규칙 표. 앞에서부터 처음 값이 나오는 것을 쓴다
const DAILY_RULES = [
  (text) => tryAgainMs(text),                                 // Groq: 본문의 남은 시간
  (text, now) => (GEMINI_PER_DAY.test(text) ? nextLaMidnight(now) - now : null) // Gemini 무료: LA 자정 리셋(retryDelay 는 짧아서 안 씀)
];

// 429 하나에 대해 쿨다운할 시간(ms). 분당은 예전 그대로, 하루 한도는 리셋까지(최소 defaultMs, 상한 dailyMaxMs)
export function cooldownMsFor(e, cooldown = {}, now = Date.now()) {
  const minute = Math.min(e?.retryAfterMs || cooldown.defaultMs || 60_000, cooldown.maxMs || 600_000);
  if (!isDailyLimit(e)) return minute;
  const text = errText(e);
  let ms = null;
  for (const rule of DAILY_RULES) { ms = rule(text, now); if (ms != null) break; }
  if (ms == null) ms = cooldown.dailyDefaultMs || 3_600_000;
  return Math.max(Math.min(ms, cooldown.dailyMaxMs || 86_400_000), cooldown.defaultMs || 60_000);
}

// cooldowns: { get(): Promise<{[key]: 풀리는 시각}>, set(obj) }. cooldown: { defaultMs, maxMs, dailyDefaultMs, dailyMaxMs }
// opts.deadline(선택, epoch ms): 체인 전체 마감(AI 초안, T-301). 순서마다 시간 제한을 남은 시간으로 줄이고,
// 다음 순서로 넘기기 전에 마감이 지났으면 e.deadline = true 오류를 던진다. 없으면 예전 그대로
const deadlineError = () => Object.assign(new Error('정해진 시간 안에 답을 받지 못했어요.'), { deadline: true });
export async function completeWithFallback(chain, system, user, opts, { cooldowns, cooldown = {}, now = Date.now }) {
  const { deadline, ...callOpts } = opts || {};
  const until = await cooldowns.get();
  const t = now();
  let order = chain.filter(p => !(until[keyOf(p)] > t));
  const fallbacks = chain.filter(p => !order.includes(p)).map(p => ({ provider: keyOf(p), reason: '쿨다운 중' }));
  // 모두 쿨다운이면 가장 먼저 풀리는 것 하나를 시도한다
  if (!order.length) order = [[...chain].sort((a, b) => until[keyOf(a)] - until[keyOf(b)])[0]];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const last = i === order.length - 1;
    let linkOpts = callOpts;
    if (deadline != null) {
      const left = deadline - now();
      if (left <= 0) throw deadlineError();
      linkOpts = { ...callOpts, timeoutMs: Math.min(callOpts.timeoutMs ?? Infinity, left) };
    }
    try {
      const text = await complete(p, system, user, { ...linkOpts, noRetry429: !last });
      return { text, provider: p, fallbacks };
    } catch (e) {
      if (last || !passes(e)) throw e;
      if (e.status === 429) {
        const t429 = now();
        await cooldowns.set({ ...(await cooldowns.get()), [keyOf(p)]: t429 + cooldownMsFor(e, cooldown, t429) });
      }
      fallbacks.push({ provider: keyOf(p), reason: e.message.slice(0, 120) });
    }
  }
}
