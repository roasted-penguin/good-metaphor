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

// cooldowns: { get(): Promise<{[key]: 풀리는 시각}>, set(obj) }. cooldown: { defaultMs, maxMs }
export async function completeWithFallback(chain, system, user, opts, { cooldowns, cooldown = {}, now = Date.now }) {
  const until = await cooldowns.get();
  const t = now();
  let order = chain.filter(p => !(until[keyOf(p)] > t));
  const fallbacks = chain.filter(p => !order.includes(p)).map(p => ({ provider: keyOf(p), reason: '쿨다운 중' }));
  // 모두 쿨다운이면 가장 먼저 풀리는 것 하나를 시도한다
  if (!order.length) order = [[...chain].sort((a, b) => until[keyOf(a)] - until[keyOf(b)])[0]];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const last = i === order.length - 1;
    try {
      const text = await complete(p, system, user, { ...opts, noRetry429: !last });
      return { text, provider: p, fallbacks };
    } catch (e) {
      if (last || !passes(e)) throw e;
      if (e.status === 429) {
        const ms = Math.min(e.retryAfterMs || cooldown.defaultMs || 60_000, cooldown.maxMs || 600_000);
        await cooldowns.set({ ...(await cooldowns.get()), [keyOf(p)]: now() + ms });
      }
      fallbacks.push({ provider: keyOf(p), reason: e.message.slice(0, 120) });
    }
  }
}
