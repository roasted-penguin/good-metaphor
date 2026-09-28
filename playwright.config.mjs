import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,             // 확장 + 고정 포트 서버를 쓰므로 순차 실행
  reporter: [['list']],
  outputDir: '.tmp/test-results'
});
