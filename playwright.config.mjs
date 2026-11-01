import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // 기본 5초는 느린 CI 러너에서 모자란다(T-136): 새 프로필의 첫 임베딩 준비 + 가짜 LLM이 일부러 둔 1.5초 간격(STREAM_GAP_MS)
  // + 자동 모드 머무름 대기. 기다리는 조건은 그대로 두고 시간만 늘린다
  expect: { timeout: 10_000 },
  workers: 1,             // 확장 + 고정 포트 서버를 쓰므로 순차 실행
  reporter: [['list']],
  outputDir: '.tmp/test-results'
});
