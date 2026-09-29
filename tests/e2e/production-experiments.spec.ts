import { expect, test } from '@playwright/test';

test.beforeEach(() => {
  test.skip(process.env.E2E_PRODUCTION_BUILD !== 'true', 'This contract runs only against a locally built production artifact.');
});

test('production ignores QA experiment previews and does not expose telemetry inspection', async ({ page }) => {
  await page.goto('/form2/bbq/?experiment_preview=bbq-first-screen-density-v1&experiment_variant=compact-first-screen');

  await expect(page.locator('.mobile-app')).not.toHaveClass(/experiment-compact-first-screen/);
  await expect.poll(() => page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__)).toBeUndefined();
});
