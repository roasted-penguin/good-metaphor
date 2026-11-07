// 서버 평가 모드 (T-405): 평가 문장을 analogy-api `POST /v1/analogy`에 보내 debug.candidates 순위를 얻는다.
// fetch·sleep을 주입받아 단위 테스트에서 실제로 기다리지 않는다

// 503: 서버에 LLM 키나 인덱스가 없다 → 관문을 잴 수 없으니 바로 멈춘다
export class ServerUnavailable extends Error {
  constructor(reason) {
    super(`서버를 쓸 수 없어요(503).${reason ? ' 서버 응답: ' + reason : ''} LLM 키나 검색 인덱스가 없으면 관문을 잴 수 없어요.`);
    this.name = 'ServerUnavailable';
    this.status = 503;
  }
}

// 그 밖의 실패 (429 재시도 소진, 502 두 번, 400, 네트워크 등)
export class ServerError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
  }
}

const RETRY_AFTER_DEFAULT_MS = 5000;
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

async function errorText(res) {
  try { const b = await res.json(); return typeof b?.error === 'string' ? b.error : ''; } catch { return ''; }
}

function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  const v = Number(h);
  return h != null && h !== '' && Number.isFinite(v) && v >= 0 ? v * 1000 : RETRY_AFTER_DEFAULT_MS;
}

/**
 * 문장 하나의 서버 순위 (앞이 1위). analogy가 비어도 후보 순위를 쓴다(검색 품질 평가).
 * 429 → Retry-After(없으면 5초) 기다렸다 같은 문장 다시, 최대 maxRetries번. 502 → 한 번 다시. 503 → 즉시 ServerUnavailable.
 */
export async function rankViaServer({ url, token, sentence, fetchImpl = fetch, sleep = defaultSleep, maxRetries = 3 }) {
  const endpoint = url.replace(/\/+$/, '') + '/v1/analogy';
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Install-Token': token },
    body: JSON.stringify({ sentence, word: '', context: '', pageTitle: '' })
  };
  let retries429 = 0, retried502 = false;
  for (;;) {
    let res;
    try { res = await fetchImpl(endpoint, init); }
    catch (e) { throw new ServerError(`서버에 연결하지 못했어요(${endpoint}): ${e.message}`); }
    if (res.ok) {
      const body = await res.json();
      const cands = body?.debug?.candidates;
      return Array.isArray(cands) ? cands.map(c => c.id) : [];
    }
    if (res.status === 503) throw new ServerUnavailable(await errorText(res));
    if (res.status === 429 && retries429 < maxRetries) {
      retries429++;
      await sleep(retryAfterMs(res));
      continue;
    }
    if (res.status === 502 && !retried502) {
      retried502 = true;
      continue;
    }
    const why = await errorText(res);
    throw new ServerError(`서버 오류 ${res.status}${why ? ': ' + why : ''}`, res.status);
  }
}

/** 여러 문장을 순서대로. 요청 한도를 넘지 않게 요청 사이를 60000/rpm ms 띄운다 */
export async function rankAllViaServer({ url, token, cases, rpm = 20, fetchImpl = fetch, sleep = defaultSleep, onProgress }) {
  const gap = 60000 / rpm;
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) await sleep(gap);
    out.push(await rankViaServer({ url, token, sentence: cases[i].sentence, fetchImpl, sleep }));
    onProgress?.(i + 1, cases.length);
  }
  return out;
}

/** 관문 한 줄: 서버 hit@1 ≥ 브라우저 hit@1이면 통과 (T-142). 브라우저 수치가 없으면 비교 생략 */
export function gateLine(serverHit1, browserHit1, n) {
  if (browserHit1 == null) return `관문: 서버 hit@1 ${serverHit1}/${n} · 브라우저 비교 생략`;
  return `관문: 서버 hit@1 ${serverHit1}/${n} vs 브라우저 ${browserHit1}/${n} → ${serverHit1 >= browserHit1 ? '통과' : '미달'}`;
}
