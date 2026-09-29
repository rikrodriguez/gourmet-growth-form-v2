import { expect, test } from '@playwright/test';

const expectedGtmId = process.env.E2E_EXPECTED_GTM_ID;
const expectedClarityId = process.env.E2E_EXPECTED_CLARITY_ID;

test.beforeEach(() => {
  test.skip(!expectedGtmId || !expectedClarityId, 'This contract runs only with an explicit production artifact configuration.');
});

test('production vendors load only after explicit consent and expose no debug inspector', async ({ page }) => {
  await page.route('https://www.googletagmanager.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://www.clarity.ms/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  await page.goto('/form2/bbq/');
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await page.reload();

  expect(await page.locator('#gourmet-growth-gtm').count()).toBe(0);
  expect(await page.locator('#gourmet-growth-clarity').count()).toBe(0);
  expect(await page.evaluate(() => window.__GOURMET_MEASUREMENT_DEBUG__)).toBeUndefined();

  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Analytics').check();
  await page.getByRole('button', { name: 'Save choices' }).click();

  await expect(page.locator('#gourmet-growth-gtm')).toHaveAttribute('src', new RegExp(expectedGtmId));
  await expect(page.locator('#gourmet-growth-clarity')).toHaveAttribute('src', new RegExp(expectedClarityId));
});
