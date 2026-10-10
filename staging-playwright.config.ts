import { defineConfig } from '@playwright/test';

// No webServer: all browser HTTPS requests are fulfilled by Fastify inject.
// This suite checks the compiled UI and authentication boundary with a test
// store. It does not verify a deployed proxy or durable staging PostgreSQL.
export default defineConfig({
  testDir: './tests/staging-browser',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'test-results/staging',
  use: {
    baseURL: 'https://office.example.test',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
    },
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'staging-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'staging-mobile-320', use: { browserName: 'chromium', viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true } },
  ],
});
