import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/external-proposal-browser', testMatch: '*.spec.ts', outputDir: 'test-results/external-proposal', workers: 1, retries: 0, timeout: 30_000, forbidOnly: true,
 use: { baseURL: 'http://127.0.0.1:4196', serviceWorkers: 'block', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' } },
 projects: [
  { name: 'proposal-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  { name: 'proposal-mobile', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
 ],
 webServer: { command: 'node --import tsx tests/external-proposal-browser/server.ts', url: 'http://127.0.0.1:4196/tests/external-proposal-browser/index.html', reuseExistingServer: false },
});
