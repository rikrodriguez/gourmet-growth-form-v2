import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/external-proposal-durable-browser', testMatch: '*.spec.ts', outputDir: 'test-results/external-proposal-durable', workers: 1, retries: 0, timeout: 45000, forbidOnly: true,
 use: { baseURL: 'http://127.0.0.1:4194', serviceWorkers: 'block', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' } },
 projects: [
  { name: 'durable-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  { name: 'durable-mobile', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
 ],
 webServer: { command: 'node --import tsx tests/external-proposal-durable-browser/server.ts', url: 'http://127.0.0.1:4194/tests/external-proposal-durable-browser/index.html', reuseExistingServer: false, timeout: 30000 },
});
