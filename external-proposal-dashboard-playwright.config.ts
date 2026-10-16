import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/external-proposal-dashboard-browser', testMatch: '*.spec.ts', outputDir: 'test-results/external-proposal-dashboard', workers: 1, retries: 0, timeout: 45000, forbidOnly: true,
 use: { baseURL: 'http://127.0.0.1:4194', serviceWorkers: 'block', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' } },
 projects: [
  { name: 'dashboard-proposal-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  { name: 'dashboard-proposal-mobile', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
 ],
 webServer: { command: 'PROPOSAL_DASHBOARD_FIXTURE=1 node --import tsx tests/external-proposal-durable-browser/server.ts', url: 'http://127.0.0.1:4194/office/dashboard', reuseExistingServer: false, timeout: 30000 },
});
