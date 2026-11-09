// analogy-api 서버 호출·결과 검증·서버 사용 조건·설치 토큰 (T-404).
// 서버는 JSON만 주고받는다(규칙 4). 실패하면 이유만 돌려주고, 로컬 대체는 부르는 쪽(background.js)이 한다.

// 규칙 1 문구. background.js 의 로컬 검증 문구와 같아야 한다
export const REJECTED_TEXT = '모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요.';

function badShape(why) {
  const e = new Error(`서버 응답 모양이 틀려요: ${why}`);
  e.code = 'bad-shape';
  return e;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 서버 결과 모양을 확인하고 규칙 1(후보 밖 근거면 비유 숨김)을 한 번 더 적용한다.
// localNodeIds(Set, T-141): 주면 근거 노드가 확장의 로컬 병합 그래프에도 있어야 한다(서버 후보 목록만 믿지 않는다).
// 원본은 바꾸지 않고 새 객체를 돌려준다. 모양이 틀리면 code 'bad-shape' 오류를 던진다.
export function checkServerResult(result, localNodeIds = null) {
  if (!isObj(result)) throw badShape('객체가 아님');
  for (const k of ['meaning', 'analogy', 'domain', 'theme']) {
    if (!(k in result)) throw badShape(`${k} 없음`);
  }
  if (typeof result.meaning !== 'string' || typeof result.analogy !== 'string') throw badShape('meaning·analogy 가 문자열이 아님');
  if (!('evidence' in result)) throw badShape('evidence 없음');
  if (result.evidence !== null && !isObj(result.evidence)) throw badShape('evidence 가 객체·null 이 아님');
  if (!isObj(result.debug) || !Array.isArray(result.debug.candidates)) throw badShape('debug.candidates 배열 없음');

  const out = { ...result, debug: { ...result.debug } };
  const ids = new Set(result.debug.candidates.map(c => c?.id));
  const nodeId = result.evidence?.nodeId;
  const chosen = nodeId != null && ids.has(nodeId) && (!localNodeIds || localNodeIds.has(nodeId));
  if (!chosen) {
    // 후보에 없는 근거는 근거로 보이지 않는다
    out.evidence = null;
    if (out.analogy) {
      out.analogy = '';
      out.rejected = REJECTED_TEXT;
    }
  } else {
    out.evidence = { ...result.evidence };
  }
  return out;
}

// POST {url}/v1/analogy. 성공이면 { ok: true, result, ms }, 실패면 { ok: false, reason }.
// reason: 'network' | 'timeout' | 'http-<status>' | 'bad-json' | 'bad-shape'
// localNodeIds: checkServerResult 로 넘기는 로컬 그래프 노드 id 집합(T-141)
export async function callAnalogyServer({ url, token, payload, timeoutMs = 4000, localNodeIds = null, fetchImpl = fetch }) {
  const endpoint = `${String(url).replace(/\/$/, '')}/v1/analogy`;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const t0 = Date.now();
  try {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Install-Token': token },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'network' };
    }
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    let body;
    try {
      body = await res.json();
    } catch {
      // 본문을 읽다가 시간이 다 된 경우도 timeout 으로 본다
      return { ok: false, reason: timedOut ? 'timeout' : 'bad-json' };
    }
    let result;
    try {
      result = checkServerResult(body, localNodeIds);
    } catch {
      return { ok: false, reason: 'bad-shape' };
    }
    return { ok: true, result, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// 서버를 건너뛰는 이유. 하나라도 걸리면 로컬, 서버를 쓰면 null:
// 'off' 서버 주소 없음 / 'session' 로그인 세션(오버레이를 서버가 모름, 규칙 3)
// 'interest' 공통 관심사가 메이플이 아님(서버는 메이플 그래프만 안다, T-302)
// 'feedback' 그 문장에 👎·pick 기록(서버가 내 피드백을 모름, ADR 0010) / 'demo' 데모 제공자
// 'no-permission' 서버 출처 권한이 없음(T-141, 설정 화면에서 허용). 다른 이유가 먼저다
// commonId: 병합 그래프의 공통 그래프 id(graph.sources.common.id). 생략하면 메이플(예전 호출 모양)
// hasPermission: 서버 출처 권한(chrome.permissions.contains). 생략하면 있음(예전 호출 모양)
export function serverSkipReason({ admin, session, sentenceRecords, providerKind, commonId = 'maplestory', hasPermission = true }) {
  if (!admin?.analogyServer?.url) return 'off';
  if (session) return 'session';
  if (commonId !== 'maplestory') return 'interest';
  if ((sentenceRecords || []).some(r => r?.vote === 'down' || r?.vote === 'pick')) return 'feedback';
  if (providerKind === 'demo') return 'demo';
  if (!hasPermission) return 'no-permission';
  return null;
}

// 서버 주소 → 권한 요청·확인용 출처 패턴(https://host:port/*). http(s)가 아니거나 틀린 주소면 null(T-141)
export function serverOriginPattern(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

// 서버를 일부러 건너뛴 이유(T-141). 이때 만든 로컬 결과는 캐시한다.
// 'no-permission' 은 권한 여부가 결과 캐시 키에 들어가 허용하면 저절로 갈린다. 'reported' 는 제보 목록이 키에 있다
const INTENTIONAL_SKIPS = new Set(['off', 'session', 'interest', 'feedback', 'demo', 'no-permission', 'reported']);

// 로컬 결과를 결과 캐시에 넣을지. 서버를 시도했다가 실패해서(network·timeout·http-*·bad-*) 만든 결과는
// 넣지 않는다 — 서버가 살아나면 다음 호버에서 다시 서버를 부르게(T-141). serverInfo 가 없으면(서버 모드 꺼짐) 넣는다
export function shouldCacheLocal(serverInfo) {
  if (!serverInfo || serverInfo.used) return true;
  return INTENTIONAL_SKIPS.has(serverInfo.reason);
}

// 서버를 쓸지 판정한다
export function shouldUseServer(args) {
  return serverSkipReason(args) === null;
}

// 설치 토큰: storage.installToken. 없으면 만들어 저장한다. 사용자 식별 정보가 아니다.
// storage 는 { get(key), set(obj) } 모양(chrome.storage.local 과 같음)
export async function getInstallToken(storage) {
  const got = await storage.get('installToken');
  if (got?.installToken) return got.installToken;
  const installToken = crypto.randomUUID();
  await storage.set({ installToken });
  return installToken;
}
