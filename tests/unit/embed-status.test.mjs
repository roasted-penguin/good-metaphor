import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadErrorReason, embedStatusText, modelSizeText, remoteHostError } from '../../extension/lib/embed-status.js';

// 모델 로드 실패 원인을 짧은 한국어로 (T-102). 원문은 뒤에 붙여 원인을 찾을 수 있게 둔다
test('loadErrorReason: 네트워크 오류는 "모델을 받지 못했어요(네트워크)"', () => {
  for (const raw of ['Failed to fetch', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'net::ERR_NAME_NOT_RESOLVED', 'Load failed']) {
    assert.match(loadErrorReason(raw), /^모델을 받지 못했어요\(네트워크\)/, raw);
  }
});

test('loadErrorReason: 파일이 없거나 서버가 거절하면 "모델 파일을 받지 못했어요"', () => {
  assert.match(loadErrorReason('Could not locate file: "https://huggingface.co/x/resolve/main/config.json".'), /^모델 파일을 받지 못했어요/);
  assert.match(loadErrorReason('Unauthorized access to file: "x" (status 401)'), /^모델 파일을 받지 못했어요/);
});

test('loadErrorReason: 그 밖은 "모델을 불러오지 못했어요"', () => {
  assert.match(loadErrorReason('Aborted(). Build with -sASSERTIONS for more info.'), /^모델을 불러오지 못했어요/);
});

test('loadErrorReason: 원문은 뒤에 붙이고 길면 자른다, 빈 값은 빈 문자열', () => {
  assert.equal(loadErrorReason('Failed to fetch'), '모델을 받지 못했어요(네트워크) · Failed to fetch');
  const long = loadErrorReason('x'.repeat(500));
  assert.ok(long.length < 140, long.length);
  assert.ok(long.endsWith('…'));
  assert.equal(loadErrorReason(''), '');
  assert.equal(loadErrorReason(null), '');
});

test('embedStatusText: 대체 검색이면 "대체 검색 사용 중 · 모델 로드 실패: <한국어 원인>"', () => {
  const t = embedStatusText({ status: 'fallback', embedderId: 'fallback:hash-ngram-512', loadError: 'Failed to fetch' });
  assert.equal(t, '대체 검색 사용 중 (fallback:hash-ngram-512) · 모델 로드 실패: 모델을 받지 못했어요(네트워크) · Failed to fetch');
  // 원인이 없으면(관리자가 일부러 대체 임베더를 고름) 원인 칸 없이
  assert.equal(embedStatusText({ status: 'fallback', embedderId: 'fallback:hash-ngram-512' }), '대체 검색 사용 중 (fallback:hash-ngram-512)');
});

test('embedStatusText: 나머지 상태', () => {
  assert.equal(embedStatusText({ status: 'idle' }), '아직 준비 전이에요.');
  assert.equal(embedStatusText({ status: 'loading', progress: 0.426 }), '모델 받는 중… 43%');
  assert.equal(embedStatusText({ status: 'loading' }), '모델 받는 중… 0%');
  assert.equal(embedStatusText({ status: 'ready', embedderId: 'm@q8' }), '준비 완료 (m@q8)');
  assert.equal(embedStatusText({ status: 'error', loadError: 'Failed to fetch' }), '오류: 모델을 받지 못했어요(네트워크) · Failed to fetch');
  assert.equal(embedStatusText({ status: 'weird' }), 'weird');
});

test('modelSizeText: admin embedding.sizeMB를 "약 NMB"로, 없으면 빈 문자열', () => {
  assert.equal(modelSizeText({ model: 'Xenova/multilingual-e5-base', sizeMB: 266 }), '약 270MB');
  assert.equal(modelSizeText({ sizeMB: 118 }), '약 120MB');
  assert.equal(modelSizeText({ sizeMB: 1300 }), '약 1.3GB');
  assert.equal(modelSizeText({ model: '__fallback__' }), '');
  assert.equal(modelSizeText(undefined), '');
});

test('remoteHostError: 모델 주소는 https만, localhost·127.0.0.1은 http 허용, 비면 기본', () => {
  for (const ok of [undefined, '', 'https://huggingface.co/', 'https://mirror.example.com/models/', 'http://127.0.0.1:8768/', 'http://localhost:8080/']) {
    assert.equal(remoteHostError(ok), '', String(ok));
  }
  for (const bad of ['http://mirror.example.com/', 'ftp://x/', 'not a url', 'http://127.0.0.1.evil.x/']) {
    assert.match(remoteHostError(bad), /https/, bad);
  }
});

test('embedStatusText: 오류 상태는 err로 보일 종류를 함께 고른다(statusKind)', async () => {
  const { statusKind } = await import('../../extension/lib/embed-status.js');
  assert.equal(statusKind('ready'), 'ok');
  assert.equal(statusKind('loading'), '');
  assert.equal(statusKind('idle'), '');
  assert.equal(statusKind('fallback'), 'warn');
  assert.equal(statusKind('error'), 'err');
});
