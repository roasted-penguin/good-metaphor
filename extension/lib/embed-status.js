// 검색 모델(임베딩) 상태 문구 (T-102). 설정 화면이 쓰고, 단위 테스트로 고정한다

const RAW_MAX = 80;

// 모델 로드 실패 원문(대개 영어)을 짧은 한국어 원인 + 원문으로. 원문은 원인을 찾을 수 있게 뒤에 남긴다
export function loadErrorReason(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let head = '모델을 불러오지 못했어요';
  if (/failed to fetch|networkerror|network error|net::err_|load failed|err_name_not_resolved|err_connection|timed? ?out/i.test(s)) {
    head = '모델을 받지 못했어요(네트워크)';
  } else if (/could not locate file|unauthorized|forbidden|status (4|5)\d\d|\b(401|403|404)\b/i.test(s)) {
    head = '모델 파일을 받지 못했어요';
  }
  const short = s.length > RAW_MAX ? s.slice(0, RAW_MAX - 1) + '…' : s;
  return `${head} · ${short}`;
}

// 오프스크린 상태({ status, embedderId, progress, loadError }) → 설정 화면 한 줄
export function embedStatusText(st = {}) {
  const reason = loadErrorReason(st.loadError);
  switch (st.status) {
    case 'idle': return '아직 준비 전이에요.';
    case 'loading': return `모델 받는 중… ${Math.round((st.progress || 0) * 100)}%`;
    case 'ready': return `준비 완료 (${st.embedderId})`;
    case 'fallback': return `대체 검색 사용 중 (${st.embedderId})${reason ? ' · 모델 로드 실패: ' + reason : ''}`;
    case 'error': return '오류: ' + (reason || '알 수 없는 오류');
    default: return String(st.status ?? '');
  }
}

// admin embedding.sizeMB(처음 받는 용량) → "약 270MB". 10MB 단위로 반올림, 1GB부터는 GB
export function modelSizeText(embedding) {
  const mb = Number(embedding?.sizeMB);
  if (!Number.isFinite(mb) || mb <= 0) return '';
  if (mb >= 1000) return `약 ${Math.round(mb / 100) / 10}GB`;
  return `약 ${Math.max(10, Math.round(mb / 10) * 10)}MB`;
}
