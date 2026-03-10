import { defineConfig } from '@playwright/test';

const BASE_HOST = process.env.TAILSCALE_IP || 'localhost';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'data/playwright-results.json' }],
  ],
  use: {
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  // Add your projects here. Each entry maps to a tests/e2e/<name>/ directory.
  // Example:
  //   { name: 'my-app', testDir: './tests/e2e/my-app', use: { baseURL: `http://${BASE_HOST}:3000` } },
  projects: [],
});
