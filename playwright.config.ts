import { defineConfig, devices } from '@playwright/test';

const externalBaseURL = process.env.E2E_BASE_URL;
const qaSecret = process.env.E2E_QA_SECRET;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // The live matrix exercises real per-IP API limits. Keep staging serial so
  // the test runner does not manufacture traffic bursts that real users cannot.
  workers: externalBaseURL ? 1 : undefined,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: externalBaseURL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    extraHTTPHeaders: qaSecret
      ? { 'x-gourmet-qa-test': 'true', 'x-gourmet-qa-secret': qaSecret }
      : undefined,
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: 'npm run preview:test',
        url: 'http://127.0.0.1:4173/form2/bbq/',
        reuseExistingServer: false,
        timeout: 60_000,
      },
  projects: [
    {
      name: 'mobile-chromium-360x800',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
      },
    },
    {
      name: 'mobile-chromium-375x812',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: 'mobile-chromium-390x844',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'mobile-chromium-393x852',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 393, height: 852 },
      },
    },
    {
      name: 'mobile-chromium-412x915',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
      },
    },
    {
      name: 'mobile-chromium-430x932',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 430, height: 932 },
      },
    },
    {
      name: 'webkit-safari-390x844',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'android-like-chromium-412x915',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
      },
    },
    {
      name: 'tablet-chromium-768x1024',
      use: {
        ...devices['iPad (gen 7)'],
        browserName: 'chromium',
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: 'desktop-chromium-1440x900',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
    },
  // Local CI keeps every responsive width. The live gate keeps one profile per
  // required browser/device class so QA writes remain below the production API limit.
  ].filter(({ name }) => !externalBaseURL || [
    'mobile-chromium-390x844',
    'webkit-safari-390x844',
    'android-like-chromium-412x915',
    'tablet-chromium-768x1024',
    'desktop-chromium-1440x900',
  ].includes(name)),
});
