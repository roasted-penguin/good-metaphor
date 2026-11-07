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

  globalThis.AnalogySiteFilter = Object.freeze({ DEFAULT_EXCLUDED_HOSTS, normalizeHost, isExcludedHost, toggleHost });
})();
