// 제외 사이트 판정(T-107). 메일·은행·로그인 페이지 문장이 LLM 제공자로 가지 않게 한다.
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 export 없는 클래식 스크립트로 두고 전역에 단다.
// background·popup·단위 테스트는 `import './lib/site-filter.js'`(부수효과) 뒤 globalThis.AnalogySiteFilter 를 쓴다.
(() => {
  // 기본 제외 목록. 항목과 같은 호스트이거나 그 하위 도메인이면 제외
  const DEFAULT_EXCLUDED_HOSTS = Object.freeze([
    'mail.google.com', 'mail.naver.com', 'mail.daum.net', 'outlook.live.com', 'outlook.office.com',
    'accounts.google.com', 'nid.naver.com', 'accounts.kakao.com', 'login.microsoftonline.com',
    'kbstar.com', 'shinhan.com', 'wooribank.com', 'kebhana.com', 'banking.nonghyup.com', 'ibk.co.kr',
    'kakaobank.com', 'toss.im'
  ]);

  // 호스트나 URL → 소문자, 포트·끝 점·www. 를 뗀 호스트. 호스트가 없으면(file: 등) 빈 문자열
  function normalizeHost(hostOrUrl) {
    let h = String(hostOrUrl ?? '').trim().toLowerCase();
    if (!h) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) {
      try { h = new URL(h).hostname; } catch { return ''; }
    }
    h = h.split('/')[0];
    if (h.startsWith('[')) h = h.slice(0, h.indexOf(']') + 1);   // IPv6 [::1]:8080
    else h = h.replace(/:\d*$/, '');
    h = h.replace(/\.+$/, '');
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  }

  // 항목과 같거나 '.항목'으로 끝나야 하위 도메인이다(notkbstar.com 은 kbstar.com 에 안 걸림)
  function covers(entry, host) {
    return !!entry && (host === entry || host.endsWith('.' + entry));
  }

  function isExcludedHost(host, list) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(list)) return false;
    return list.some(e => covers(normalizeHost(e), h));
  }

  // 제외면 그 호스트를 덮는 항목 전부를 뺀 새 배열, 아니면 정규화된 호스트를 더한 새 배열(원본 불변)
  function toggleHost(list, host) {
    const arr = Array.isArray(list) ? list : [];
    const h = normalizeHost(host);
    if (!h) return [...arr];
    if (isExcludedHost(h, arr)) return arr.filter(e => !covers(normalizeHost(e), h));
    return [...arr, h];
  }

  // background 이중 방어: 메시지를 보낸 쪽이 제외 사이트의 탭인가.
  // 탭에서 온 게 아니거나(확장 페이지 등) URL을 모르면 막지 않는다.
  // sender.url은 권한 없이도 오는 보낸 문서 주소, tab.url은 tabs·호스트 권한이 있을 때만 온다
  function isBlockedSender(sender, list) {
    if (!sender?.tab) return false;
    const url = sender.url || sender.tab.url;
    return !!url && isExcludedHost(url, list);
  }

  // 설정 화면 "추가" 입력 검증(T-144). URL이든 호스트든 정규화한다.
  // 점 없는 단어는 거부(localhost만 예외, IPv4는 점이 있어 통과). 같거나 상위 도메인이 이미 있으면 duplicate
  const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
  function validateHostInput(input, list) {
    const raw = String(input ?? '').trim();
    if (!raw || /\s/.test(raw)) return { ok: false, error: 'invalid' };
    let host = normalizeHost(raw);
    if (!host) return { ok: false, error: 'invalid' };
    // 한글 도메인 등은 브라우저 location.hostname과 같은 퓨니코드로 바꾼다
    try { host = new URL('http://' + host).hostname; } catch { return { ok: false, error: 'invalid' }; }
    if (host !== 'localhost' && !HOST_RE.test(host)) return { ok: false, error: 'invalid' };
    if (isExcludedHost(host, list)) return { ok: false, error: 'duplicate' };
    return { ok: true, host };
  }

  globalThis.AnalogySiteFilter = Object.freeze({ DEFAULT_EXCLUDED_HOSTS, normalizeHost, isExcludedHost, toggleHost, isBlockedSender, validateHostInput });
})();
