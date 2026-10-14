import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/dashboard-browser', testMatch: '**/*.spec.ts', forbidOnly: true,
  workers: 1, retries: 0, timeout: 45_000, reporter: 'list', outputDir: 'test-results/dashboard',
  use: { baseURL: 'http://127.0.0.1:4175', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' } },
  projects: [
    { name: 'dashboard-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'dashboard-mobile', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    { command: 'npm run office:communications:fixture', url: 'http://127.0.0.1:4180/office-api/health', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npm run office:dev', url: 'http://127.0.0.1:4175/office/dashboard', reuseExistingServer: false, timeout: 30_000 },
  ],
});
