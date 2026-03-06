import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for CamBot E2E tests.
 *
 * These tests run against a live CamBot instance. Set environment variables
 * before running:
 *
 *   CAMBOT_BASE_URL  - Base URL of the web channel (default: http://127.0.0.1:3100)
 *   CAMBOT_AUTH_TOKEN - Auth token for the web channel (default: test-token)
 *   CAMBOT_WS_URL    - WebSocket URL (default: ws://127.0.0.1:3100/ws)
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000, // 2 minutes per test — agent responses can be slow
  retries: 0,
  workers: 1, // serial execution — tests share server state
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.CAMBOT_BASE_URL || 'http://127.0.0.1:3100',
    extraHTTPHeaders: {
      Authorization: `Bearer ${process.env.CAMBOT_AUTH_TOKEN || 'test-token'}`,
    },
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'api',
      testMatch: '**/*.spec.ts',
    },
  ],
});
