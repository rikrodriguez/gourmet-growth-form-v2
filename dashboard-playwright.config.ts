import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/dashboard-e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 1,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dashboard:preview',
    url: 'http://127.0.0.1:4174/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop-1440x900', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'tablet-1024x768', use: { browserName: 'chromium', viewport: { width: 1024, height: 768 } } },
    { name: 'mobile-390x844', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});

