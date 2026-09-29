import { expect, Page, test } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(
    process.env.E2E_API_MODE !== 'mock' || testInfo.project.name !== 'mobile-chromium-390x844',
    'The experiment contract runs once with the controlled mock API.',
  );
});

async function openExperiment(page: Page, variant: 'control' | 'compact-first-screen') {
  await page.route('**/v1/events/batch', async (route) => {
    const events = (route.request().postDataJSON() as { events: Array<{ event_id: string }> }).events;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ accepted: events.length, duplicates: 0, rejected: 0, acknowledged_event_ids: events.map((event) => event.event_id), rejections: [] }),
    });
  });
  await page.goto(`/form2/bbq/?experiment_preview=bbq-first-screen-density-v1&experiment_variant=${variant}`);
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__?.getSnapshot().experiment)).toMatchObject({
    experiment_id: 'bbq-first-screen-density-v1', variant_id: variant, assignment_source: 'forced_qa',
  });
}

test('QA preview renders a forced control and compact challenger without contaminating the control', async ({ page }) => {
  await openExperiment(page, 'control');
  const control = await page.locator('.bbq-hero.variant-bbq').boundingBox();
  expect(control?.height).toBeGreaterThan(0);
  await expect(page.locator('.mobile-app')).not.toHaveClass(/experiment-compact-first-screen/);
  await expect(page.getByText('How many guests are you catering for?')).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openExperiment(page, 'compact-first-screen');
  const challenger = await page.locator('.bbq-hero.variant-bbq').boundingBox();
  expect(challenger?.height).toBeLessThan(control?.height ?? Infinity);
  await expect(page.locator('.mobile-app')).toHaveClass(/experiment-compact-first-screen/);
  await expect(page.getByText('How many guests are you catering for?')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('preview parameters never assign an experiment to another intent', async ({ page }) => {
  await page.route('**/v1/events/batch', async (route) => {
    const events = (route.request().postDataJSON() as { events: Array<{ event_id: string }> }).events;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: events.length, duplicates: 0, rejected: 0, acknowledged_event_ids: events.map((event) => event.event_id), rejections: [] }) });
  });
  await page.goto('/form2/corporate/?experiment_preview=bbq-first-screen-density-v1&experiment_variant=compact-first-screen');
  await expect.poll(() => page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__?.getSnapshot().experiment)).toMatchObject({
    experiment_id: null, variant_id: null,
  });
});
