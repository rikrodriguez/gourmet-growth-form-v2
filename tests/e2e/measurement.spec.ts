import { expect, Page, test } from '@playwright/test';

const funnelPath = '/form2/bbq/';

type MeasurementEvent = {
  event: string;
  [key: string]: unknown;
};

type MeasurementSnapshot = {
  consent: Record<string, unknown> | null;
  pending_events: MeasurementEvent[];
  emitted_events: MeasurementEvent[];
  configuration: Record<string, unknown>;
};

async function snapshot(page: Page): Promise<MeasurementSnapshot> {
  await page.waitForFunction(() => Boolean(window.__GOURMET_MEASUREMENT_DEBUG__));
  return page.evaluate(() => window.__GOURMET_MEASUREMENT_DEBUG__!.getSnapshot()) as Promise<MeasurementSnapshot>;
}

async function openClean(page: Page) {
  await page.goto(funnelPath);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await snapshot(page);
}

async function chooseAndContinue(page: Page, value: string) {
  await page.locator(`[data-option-value="${value}"]`).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium-390x844', 'Measurement contracts run once; regressions run on every project.');
});

test.beforeEach(async ({ page }) => {
  await openClean(page);
});

test('default is denied, Reject loads no vendors, and the quote still works', async ({ page }) => {
  const initial = await snapshot(page);
  expect(initial.consent).toBeNull();
  expect(initial.pending_events.map((event) => event.event)).toEqual(['form_start']);

  const defaultConsent = await page.evaluate(() => window.dataLayer?.find((entry) => (
    Array.isArray(entry) && entry[0] === 'consent' && entry[1] === 'default'
  )));
  expect(defaultConsent?.[2]).toMatchObject({
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });

  await page.getByRole('button', { name: 'Reject all' }).click();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  const rejected = await snapshot(page);
  expect(rejected.consent).toMatchObject({
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  expect(rejected.pending_events).toEqual([]);
  expect(rejected.emitted_events).toEqual([]);
  expect(await page.locator('#gourmet-growth-gtm').count()).toBe(0);
  expect(await page.locator('#gourmet-growth-clarity').count()).toBe(0);

  await chooseAndContinue(page, '26-50');
  await expect(page.getByText('Step 2 of 7')).toBeVisible();
  expect((await snapshot(page)).emitted_events).toEqual([]);
});

test('Manage, consent updates, revocation, and refresh persistence work', async ({ page }) => {
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Analytics').check();
  await page.getByRole('button', { name: 'Save choices' }).click();

  let current = await snapshot(page);
  expect(current.consent).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' });
  expect(current.emitted_events.filter((event) => event.event === 'form_start')).toHaveLength(1);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  current = await snapshot(page);
  expect(current.consent).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' });
  expect(current.emitted_events.filter((event) => event.event === 'form_start')).toHaveLength(0);

  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByLabel('Analytics').uncheck();
  await page.getByRole('button', { name: 'Save choices' }).click();
  current = await snapshot(page);
  expect(current.consent).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied' });

  const updates = await page.evaluate(() => (window.dataLayer ?? []).filter((entry) => (
    Array.isArray(entry) && entry[0] === 'consent' && entry[1] === 'update'
  )));
  expect(updates.at(-1)?.[2]).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied' });
});

test('safe funnel events are concise, deduplicated, and PII-free', async ({ page }) => {
  const configuredApiBuild = Boolean(process.env.E2E_BASE_URL);
  if (configuredApiBuild) {
    const leadId = '41f4fd4d-09a4-42cf-80ce-c405a6fd0fa4';
    await page.route('**/v1/leads/**', async (route) => {
      if (route.request().url().endsWith('/capture-phone')) {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ lead_id: leadId, status: 'created' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ lead_id: leadId, status: 'updated' }),
      });
    });
  }

  await page.getByRole('button', { name: 'Accept all' }).click();
  await chooseAndContinue(page, '26-50');
  await chooseAndContinue(page, 'full-service');
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Mobile number')).toHaveAttribute('data-clarity-mask', 'true');
  await page.getByLabel('Mobile number').fill('5035550199');
  await page.getByRole('button', { name: 'Continue' }).click();
  await chooseAndContinue(page, 'Corporate');
  await chooseAndContinue(page, 'still-deciding');
  await expect(page.getByLabel('First name')).toHaveAttribute('data-clarity-mask', 'true');
  await page.getByLabel('First name').fill('QA Privacy');
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('STAGING FLOW COMPLETE')).toBeVisible();

  let current = await snapshot(page);
  expect(current.emitted_events.filter((event) => event.event === 'form_start')).toHaveLength(1);
  expect(current.emitted_events.filter((event) => event.event === 'phone_capture')).toHaveLength(1);
  expect(current.emitted_events.filter((event) => event.event === 'form_complete')).toHaveLength(1);
  expect(current.emitted_events.filter((event) => event.event === 'form_step_complete')).toHaveLength(7);
  expect(current.emitted_events.filter((event) => event.event === 'generate_lead'))
    .toHaveLength(configuredApiBuild ? 1 : 0);

  const serialized = await page.evaluate(() => JSON.stringify({
    dataLayer: window.dataLayer,
    measurement: window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot(),
    localStorage: { ...window.localStorage },
    measurementSessionStorage: Object.fromEntries(
      Object.entries(window.sessionStorage).filter(([key]) => key.includes('measurement')),
    ),
    url: window.location.href,
    clarityQueue: window.clarity?.q,
  }));
  expect(serialized).not.toContain('5035550199');
  expect(serialized).not.toContain('(503) 555-0199');
  expect(serialized).not.toContain('QA Privacy');
  expect(serialized).not.toContain('lead_id');
  expect(serialized).not.toContain('visitor_id');
  expect(serialized).not.toContain('session_id');
  expect(await page.locator('section.quote-panel[data-clarity-mask="true"]').count()).toBe(1);

  await page.reload();
  current = await snapshot(page);
  expect(current.emitted_events.filter((event) => event.event === 'form_complete')).toHaveLength(0);
});

test('staging events are marked QA and cannot be Ads-eligible', async ({ page }) => {
  await page.getByRole('button', { name: 'Accept all' }).click();
  const current = await snapshot(page);
  expect(current.configuration).toMatchObject({ environment: 'staging', google_ads_configured: false });
  expect(current.emitted_events.every((event) => event.traffic_type === 'qa')).toBeTruthy();
  expect(current.emitted_events.every((event) => event.ads_eligible === false)).toBeTruthy();
});
