import { expect, test } from '@playwright/test';

test('390 web surface is deterministic and excludes device chrome from comparison', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium-390x844', 'Canonical Golden Master comparison viewport only.');
  await page.goto('/form2/bbq/');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.locator('.mobile-app')).toBeVisible();
  await expect(page.locator('.bbq-hero')).toHaveClass(/has-hero-image/);
  await expect(page.locator('.bbq-hero')).toHaveCSS('background-image', /bbq-hero-mobile-v2\.webp/);
  await expect(page.getByText('Your Event', { exact: true })).toBeVisible();
  await expect(page.getByText('Quick form', { exact: true })).toBeVisible();
  await expect(page.locator('.menu-button')).toHaveCount(0);
  await expect(page.locator('.consent-panel')).not.toHaveCSS('position', 'fixed');
  const consentActions = page.locator('.consent-actions button');
  await expect(consentActions).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(consentActions.nth(index)).toHaveCSS('min-height', '44px');
  }
  const first = await page.locator('.mobile-app').screenshot({ animations: 'disabled' });
  const second = await page.locator('.mobile-app').screenshot({ animations: 'disabled' });
  expect(Buffer.compare(first, second)).toBe(0);
  expect(await page.locator('.mobile-app').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.getByText('Step 1 of 7').isVisible()).toBe(true);
});
