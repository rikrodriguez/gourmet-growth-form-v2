import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:test',
    url: 'http://127.0.0.1:4173/form2/bbq/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'mobile-390',
      use: {
        ...devices['iPhone 13'],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'desktop-1440',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
