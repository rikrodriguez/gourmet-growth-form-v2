import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4175';
const apiURL = 'http://127.0.0.1:4180';

export default defineConfig({
  testDir: './tests/office-e2e',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: 'list',
  outputDir: 'test-results/office',
  use: {
    baseURL,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
    },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'office-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'office-mobile-320', use: { browserName: 'chromium', viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: 'node scripts/office-db.mjs start && node scripts/office-db.mjs migrate && npm run office:api',
      url: `${apiURL}/office-api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run office:dev',
      url: `${baseURL}/office/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
