// 제외 사이트 판정(T-107). site-filter.js는 콘텐츠 스크립트용 클래식 스크립트라 부수효과 import 뒤 전역을 쓴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/site-filter.js';
import { DEFAULT_SETTINGS } from '../../extension/lib/config.js';

const { normalizeHost, isExcludedHost, toggleHost, isBlockedSender, DEFAULT_EXCLUDED_HOSTS } = globalThis.AnalogySiteFilter;
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
