import { expect, test } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(
    process.env.E2E_MEASUREMENT_MODE !== 'mock' || testInfo.project.name !== 'mobile-chromium-390x844',
    'Configured vendor loading contract runs once in its dedicated CI build.',
  );
});

test('configured GTM and Clarity load only after consent with staging Ads suppression', async ({ page }) => {
  const vendorRequests: string[] = [];
  await page.route('https://www.googletagmanager.com/**', async (route) => {
    vendorRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  await page.route('https://www.clarity.ms/**', async (route) => {
    vendorRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });

  await page.goto('/form2/bbq/');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__GOURMET_MEASUREMENT_DEBUG__));
  expect(vendorRequests).toEqual([]);
  expect(await page.locator('#gourmet-growth-gtm').count()).toBe(0);
  expect(await page.locator('#gourmet-growth-clarity').count()).toBe(0);

  await page.getByRole('button', { name: 'Reject all' }).click();
  await page.waitForTimeout(50);
  expect(vendorRequests).toEqual([]);

  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByLabel('Analytics').check();
  await page.getByRole('button', { name: 'Save choices' }).click();
  await expect(page.locator('#gourmet-growth-gtm')).toHaveAttribute('src', /GTM-QATEST/);
  await expect(page.locator('#gourmet-growth-clarity')).toHaveAttribute('src', /clarityqa/);
  await expect.poll(() => vendorRequests.length).toBe(2);

  const state = await page.evaluate(() => ({
    debug: window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot(),
    clarityQueue: window.clarity?.q,
  }));
  expect(state.debug?.configuration).toMatchObject({
    environment: 'staging',
    gtm_configured: true,
    ga4_configured: true,
    google_ads_configured: true,
    clarity_configured: true,
  });
  expect(state.debug?.emitted_events.every((event) => event.ads_eligible === false)).toBeTruthy();
  expect(state.debug?.emitted_events.every((event) => event.analytics_eligible === true)).toBeTruthy();
  expect(state.clarityQueue).toContainEqual([
    'consentv2',
    { ad_Storage: 'denied', analytics_Storage: 'granted' },
  ]);
});
