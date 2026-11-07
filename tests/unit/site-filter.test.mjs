// 제외 사이트 판정(T-107). site-filter.js는 콘텐츠 스크립트용 클래식 스크립트라 부수효과 import 뒤 전역을 쓴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/site-filter.js';
import { DEFAULT_SETTINGS } from '../../extension/lib/config.js';

const { normalizeHost, isExcludedHost, toggleHost, isBlockedSender, validateHostInput, frameHosts, DEFAULT_EXCLUDED_HOSTS } = globalThis.AnalogySiteFilter;
const LIST = ['kbstar.com', 'mail.google.com'];

test('normalizeHost: 소문자·끝 점·www. 제거, 포트·URL 무시, 빈 값은 빈 문자열', () => {
  assert.equal(normalizeHost('WWW.KBStar.com.'), 'kbstar.com');
  assert.equal(normalizeHost('127.0.0.1:8766'), '127.0.0.1');
  assert.equal(normalizeHost('https://www.kbstar.com:443/path?q=1'), 'kbstar.com');
  assert.equal(normalizeHost('http://127.0.0.1:8766/'), '127.0.0.1');
  assert.equal(normalizeHost('file:///Users/a/b.html'), '');
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost(undefined), '');
});

test('isExcludedHost: 같은 호스트와 하위 도메인은 제외', () => {
  assert.equal(isExcludedHost('kbstar.com', LIST), true);
  assert.equal(isExcludedHost('m.kbstar.com', LIST), true);
  assert.equal(isExcludedHost('a.b.kbstar.com', LIST), true);
  assert.equal(isExcludedHost('mail.google.com', LIST), true);
});

test('isExcludedHost: www.·대문자·끝 점·포트를 정규화해서 본다(항목도)', () => {
  assert.equal(isExcludedHost('WWW.KBSTAR.COM.', LIST), true);
  assert.equal(isExcludedHost('kbstar.com:8443', LIST), true);
  assert.equal(isExcludedHost('kbstar.com', ['WWW.KbStar.com.']), true);
});

test('isExcludedHost: 접미사만 같은 다른 도메인은 안 걸린다', () => {
  assert.equal(isExcludedHost('notkbstar.com', LIST), false);
  assert.equal(isExcludedHost('google.com', LIST), false, '상위 도메인은 안 걸림');
  assert.equal(isExcludedHost('drive.google.com', LIST), false);
});

test('isExcludedHost: 빈 호스트(file: 등)는 제외 아님, 빈 항목도 무시', () => {
  assert.equal(isExcludedHost('', LIST), false);
  assert.equal(isExcludedHost('', ['']), false);
  assert.equal(isExcludedHost('example.com', ['', null]), false);
  assert.equal(isExcludedHost('example.com', undefined), false);
});

test('toggleHost: 제외가 아니면 정규화된 호스트를 더하고 원본은 그대로', () => {
  const src = ['kbstar.com'];
  const out = toggleHost(src, 'WWW.Example.com:8080');
  assert.deepEqual(out, ['kbstar.com', 'example.com']);
  assert.deepEqual(src, ['kbstar.com']);
  assert.notEqual(out, src);
});

test('toggleHost: 제외면 그 호스트를 덮는 항목 전부를 빼고 원본은 그대로', () => {
  const src = ['kbstar.com', 'm.kbstar.com', 'notkbstar.com', 'mail.google.com'];
  const out = toggleHost(src, 'm.kbstar.com');
  assert.deepEqual(out, ['notkbstar.com', 'mail.google.com']);
  assert.equal(src.length, 4);
  assert.equal(isExcludedHost('m.kbstar.com', out), false);
});

test('toggleHost: 두 번 누르면 원래 판정으로 돌아온다', () => {
  const once = toggleHost([], '127.0.0.1');
  assert.equal(isExcludedHost('127.0.0.1', once), true);
  assert.equal(isExcludedHost('127.0.0.1', toggleHost(once, '127.0.0.1')), false);
});

test('기본 목록: 판정된 항목 그대로, 설정 기본값과 같고 테스트 페이지 호스트는 없음', () => {
  assert.deepEqual(DEFAULT_EXCLUDED_HOSTS, ['mail.google.com', 'mail.naver.com', 'mail.daum.net', 'outlook.live.com', 'outlook.office.com', 'accounts.google.com', 'nid.naver.com', 'accounts.kakao.com', 'login.microsoftonline.com', 'kbstar.com', 'shinhan.com', 'wooribank.com', 'kebhana.com', 'banking.nonghyup.com', 'ibk.co.kr', 'kakaobank.com', 'toss.im']);
  assert.deepEqual(DEFAULT_SETTINGS.excludedHosts, DEFAULT_EXCLUDED_HOSTS);
  assert.equal(isExcludedHost('127.0.0.1', DEFAULT_SETTINGS.excludedHosts), false);
  assert.equal(isExcludedHost('obank.kbstar.com', DEFAULT_SETTINGS.excludedHosts), true);
});

test('isBlockedSender: 탭에서 온 메시지만 본다, sender.url 먼저 그다음 tab.url', () => {
  const list = ['127.0.0.1'];
  assert.equal(isBlockedSender(undefined, list), false, 'sender 없음');
  assert.equal(isBlockedSender({ url: 'http://127.0.0.1:8766/' }, list), false, '탭이 없으면(확장 페이지 등) 막지 않음');
  assert.equal(isBlockedSender({ tab: {}, url: 'http://127.0.0.1:8766/' }, list), true);
  assert.equal(isBlockedSender({ tab: { url: 'http://127.0.0.1:8766/' } }, list), true, 'sender.url 없으면 tab.url');
  assert.equal(isBlockedSender({ tab: { url: 'http://127.0.0.1/' }, url: 'https://example.com/' }, list), false, 'sender.url 우선');
  assert.equal(isBlockedSender({ tab: {} }, list), false, 'URL을 모르면 막지 않음');
  assert.equal(isBlockedSender({ tab: {}, url: 'https://example.com/' }, list), false);
});

test('isBlockedSender: 프레임이 실어 보낸 최상위 호스트(topHost)가 제외면 막는다 (T-111)', () => {
  const list = ['127.0.0.1'];
  const frame = { tab: {}, url: 'http://localhost:8766/frame.html', frameId: 3 };
  assert.equal(isBlockedSender(frame, list), false, '프레임 호스트만 보면 통과');
  assert.equal(isBlockedSender(frame, list, '127.0.0.1'), true, '최상위가 제외면 막음');
  assert.equal(isBlockedSender(frame, list, 'http://127.0.0.1:8766/'), true, 'URL 꼴도 정규화');
  assert.equal(isBlockedSender(frame, list, 'example.com'), false);
  assert.equal(isBlockedSender(frame, list, ''), false, '빈 topHost 는 무시');
  assert.equal(isBlockedSender({ tab: {}, url: 'http://127.0.0.1:8766/' }, list, 'example.com'), true, '보낸 문서가 제외면 topHost 와 무관하게 막음');
  assert.equal(isBlockedSender({ url: 'http://localhost/' }, list, '127.0.0.1'), false, '탭이 없으면(확장 페이지) 막지 않음');
});

test('frameHosts: 자기 호스트 + 최상위 호스트(ancestorOrigins 마지막), 정규화·중복 제거 (T-111)', () => {
  assert.deepEqual(frameHosts({ selfHost: 'localhost', ancestorOrigins: ['http://127.0.0.1:8766'], referrer: '' }), ['localhost', '127.0.0.1']);
  assert.deepEqual(
    frameHosts({ selfHost: 'ads.example.com', ancestorOrigins: ['https://mid.example.net', 'https://WWW.KBStar.com'], referrer: 'https://mid.example.net/x' }),
    ['ads.example.com', 'kbstar.com'], '중첩이면 마지막(최상위)만, referrer 보다 ancestorOrigins 가 먼저');
  assert.deepEqual(frameHosts({ selfHost: '127.0.0.1', ancestorOrigins: ['http://127.0.0.1:8766'], referrer: '' }), ['127.0.0.1'], '같은 출처면 하나');
});

test('frameHosts: ancestorOrigins 가 없으면 referrer, 둘 다 없으면 자기 호스트만 (T-111)', () => {
  assert.deepEqual(frameHosts({ selfHost: 'localhost', ancestorOrigins: [], referrer: 'https://kbstar.com/login' }), ['localhost', 'kbstar.com']);
  assert.deepEqual(frameHosts({ selfHost: 'localhost', referrer: 'https://kbstar.com/' }), ['localhost', 'kbstar.com'], 'ancestorOrigins 미지원');
  assert.deepEqual(frameHosts({ selfHost: 'localhost', ancestorOrigins: [], referrer: '' }), ['localhost']);
  assert.deepEqual(frameHosts({ selfHost: 'localhost' }), ['localhost']);
});

test('frameHosts: about:blank 처럼 자기 호스트가 비면 최상위만, ancestorOrigins 가 "null"이면 referrer (T-111)', () => {
  assert.deepEqual(frameHosts({ selfHost: '', ancestorOrigins: ['https://kbstar.com'], referrer: '' }), ['kbstar.com']);
  assert.deepEqual(frameHosts({ selfHost: 'a.com', ancestorOrigins: ['null'], referrer: 'https://kbstar.com/' }), ['a.com', 'kbstar.com']);
  assert.deepEqual(frameHosts({ selfHost: '', ancestorOrigins: [], referrer: '' }), []);
});

test('validateHostInput: URL이든 호스트든 정규화해서 받는다 (T-144)', () => {
  assert.deepEqual(validateHostInput('https://WWW.Mail.Example.com/inbox?x=1', []), { ok: true, host: 'mail.example.com' });
  assert.deepEqual(validateHostInput('  shop.example.co.kr:8443 ', []), { ok: true, host: 'shop.example.co.kr' });
  assert.deepEqual(validateHostInput('localhost', []), { ok: true, host: 'localhost' });
  assert.deepEqual(validateHostInput('127.0.0.1', []), { ok: true, host: '127.0.0.1' });
  assert.deepEqual(validateHostInput('http://127.0.0.1:8766/', []), { ok: true, host: '127.0.0.1' });
});

test('validateHostInput: 빈 값·공백·점 없는 단어·이상한 글자는 invalid', () => {
  for (const bad of ['', '   ', undefined, null, 'abc', 'a b.com', 'exa mple', 'foo..com', '.com', 'bad_host!.com', 'file:///a/b.html']) {
    assert.deepEqual(validateHostInput(bad, []), { ok: false, error: 'invalid' }, String(bad));
  }
});

test('validateHostInput: 같거나 상위 도메인이 이미 있으면 duplicate', () => {
  assert.deepEqual(validateHostInput('kbstar.com', DEFAULT_EXCLUDED_HOSTS), { ok: false, error: 'duplicate' });
  assert.deepEqual(validateHostInput('https://m.kbstar.com/x', DEFAULT_EXCLUDED_HOSTS), { ok: false, error: 'duplicate' });
  assert.deepEqual(validateHostInput('WWW.TOSS.IM', DEFAULT_EXCLUDED_HOSTS), { ok: false, error: 'duplicate' });
  assert.deepEqual(validateHostInput('notkbstar.com', DEFAULT_EXCLUDED_HOSTS), { ok: true, host: 'notkbstar.com' });
  assert.deepEqual(validateHostInput('google.com', DEFAULT_EXCLUDED_HOSTS), { ok: true, host: 'google.com' }, '하위 도메인만 있으면 상위는 새로 넣을 수 있음');
});
