import { expect, Page, test } from '@playwright/test';

const funnelPath = '/form2/bbq/';

test.beforeEach(({}, testInfo) => {
  test.skip(
    process.env.E2E_API_MODE !== 'mock' || testInfo.project.name !== 'mobile-chromium-390x844',
    'Configured client/API contracts run once in their dedicated CI build.',
  );
});

async function openClean(page: Page) {
  await page.goto(funnelPath);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
}

async function chooseAndContinue(page: Page, value: string) {
  await page.locator(`[data-option-value="${value}"]`).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function reachPhone(page: Page) {
  await chooseAndContinue(page, '26-50');
  await chooseAndContinue(page, 'full-service');
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('telemetry network failure never blocks the funnel and retains queued events', async ({ page }) => {
  await page.route('**/v1/events/batch', (route) => route.abort('failed'));
  await openClean(page);
  await chooseAndContinue(page, '26-50');
  await expect(page.getByText('Step 2 of 7')).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => window.__GOURMET_TELEMETRY_DEBUG__?.getPendingEvents().length ?? 0,
  )).toBeGreaterThan(0);
});

test('acknowledged telemetry leaves the session queue', async ({ page }) => {
  const acknowledged = new Set<string>();
  await page.route('**/v1/events/batch', async (route) => {
    const body = route.request().postDataJSON() as { events: Array<{ event_id: string }> };
    const ids = body.events.map((event) => event.event_id);
    ids.forEach((id) => acknowledged.add(id));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accepted: ids.length, duplicates: 0, rejected: 0, acknowledged_event_ids: ids, rejections: [],
      }),
    });
  });
  await openClean(page);
  await expect.poll(() => acknowledged.size).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(
    () => window.__GOURMET_TELEMETRY_DEBUG__?.getPendingEvents().length ?? -1,
  )).toBe(0);
});

test('lead capture failure is visible and retry completes one progressive lead', async ({ page }) => {
  const telemetryBodies: unknown[] = [];
  const captureBodies: Array<Record<string, unknown>> = [];
  const patchBodies: Array<Record<string, unknown>> = [];
  const leadId = 'd2d9ee0c-006d-4e68-90d8-79f7b8b9489d';
  let failFirstCapture = true;

  await page.route('**/v1/events/batch', async (route) => {
    const body = route.request().postDataJSON() as { events: Array<{ event_id: string }> };
    telemetryBodies.push(body);
    const ids = body.events.map((event) => event.event_id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: ids.length, duplicates: 0, rejected: 0, acknowledged_event_ids: ids, rejections: [] }),
    });
  });
  await page.route('**/v1/leads/capture-phone', async (route) => {
    captureBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (failFirstCapture) {
      failFirstCapture = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"database_unavailable"}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ lead_id: leadId, conversion_id: 'b'.repeat(64), status: 'created' }),
    });
  });
  await page.route(`**/v1/leads/${leadId}`, async (route) => {
    patchBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    expect(route.request().headers()['x-gourmet-session-id']).toBeTruthy();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ lead_id: leadId, status: 'updated' }),
    });
  });

  await openClean(page);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await reachPhone(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('could not securely save');
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  expect((await page.evaluate(() => window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot().emitted_events ?? []))
    .filter((event) => event.event === 'generate_lead')).toHaveLength(0);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5 of 7')).toBeVisible();
  await chooseAndContinue(page, 'Corporate');
  await chooseAndContinue(page, 'still-deciding');
  await page.getByLabel('First name').fill('Secure QA Name');
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('STAGING FLOW COMPLETE')).toBeVisible();

  expect(captureBodies).toHaveLength(2);
  expect(captureBodies[0].phone).toBe('5035550123');
  expect(captureBodies[1].idempotency_key).toBe(captureBodies[0].idempotency_key);
  expect(captureBodies[1].answers).toEqual({
    guest_range: '26-50', service_style: 'full-service', zip_code: '97205',
  });
  expect(captureBodies[1].measurement_consent).toMatchObject({
    version: 1,
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
  });
  expect(patchBodies).toEqual([
    { event_type: 'Corporate' },
    { date_window: 'still-deciding', exact_date: null },
    { first_name: 'Secure QA Name' },
  ]);
  expect(page.url()).not.toContain(leadId);
  expect(await page.evaluate(() => window.sessionStorage.getItem('gourmet_growth_lead_id_v1'))).toBe(leadId);

  const telemetry = JSON.stringify(telemetryBodies);
  expect(telemetry).not.toContain('5035550123');
  expect(telemetry).not.toContain('Secure QA Name');
  const phoneEvents = telemetryBodies.flatMap((body) => (body as { events: Array<{ event_name: string }> }).events)
    .filter((event) => event.event_name === 'phone_captured');
  expect(phoneEvents).toHaveLength(1);
  const measurementEvents = await page.evaluate(
    () => window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot().emitted_events ?? [],
  );
  expect(measurementEvents.filter((event) => event.event === 'generate_lead')).toHaveLength(1);
  expect(measurementEvents.find((event) => event.event === 'generate_lead')).toMatchObject({
    transaction_id: 'b'.repeat(64),
  });
  expect(JSON.stringify(measurementEvents)).not.toContain('5035550123');
  expect(JSON.stringify(measurementEvents)).not.toContain('Secure QA Name');

  await page.reload();
  const afterReload = await page.evaluate(
    () => window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot().emitted_events ?? [],
  );
  expect(afterReload.filter((event) => event.event === 'generate_lead')).toHaveLength(0);
});

test('legacy capture API is retried once without unsupported consent evidence', async ({ page }) => {
  const captureBodies: Array<Record<string, unknown>> = [];
  const leadId = 'f450369a-0629-4d58-bc6a-5f47d8c08b90';

  await page.route('**/v1/events/batch', async (route) => {
    const body = route.request().postDataJSON() as { events: Array<{ event_id: string }> };
    const ids = body.events.map((event) => event.event_id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: ids.length, duplicates: 0, rejected: 0, acknowledged_event_ids: ids, rejections: [] }),
    });
  });
  await page.route('**/v1/leads/capture-phone', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    captureBodies.push(body);
    if ('measurement_consent' in body) {
      await route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"invalid_shape"}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ lead_id: leadId, status: 'created' }),
    });
  });

  await openClean(page);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await reachPhone(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5 of 7')).toBeVisible();

  expect(captureBodies).toHaveLength(2);
  expect(captureBodies[0].measurement_consent).toMatchObject({
    version: 1,
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
  });
  expect(captureBodies[1]).not.toHaveProperty('measurement_consent');
  expect(captureBodies[1].idempotency_key).toBe(captureBodies[0].idempotency_key);

  const measurementEvents = await page.evaluate(
    () => window.__GOURMET_MEASUREMENT_DEBUG__?.getSnapshot().emitted_events ?? [],
  );
  expect(measurementEvents.filter((event) => event.event === 'generate_lead')).toHaveLength(1);
  expect(measurementEvents.find((event) => event.event === 'generate_lead')).toMatchObject({
    transaction_id: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(measurementEvents)).not.toContain('5035550123');
});

test('no consent choice omits consent evidence instead of sending a nullable field', async ({ page }) => {
  const captureBodies: Array<Record<string, unknown>> = [];
  const leadId = '388e68ce-f0e3-4c86-8b04-94d593978eaf';

  await page.route('**/v1/leads/capture-phone', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    captureBodies.push(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ lead_id: leadId, status: 'created' }),
    });
  });

  await openClean(page);
  await reachPhone(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5 of 7')).toBeVisible();

  expect(captureBodies).toHaveLength(1);
  expect(captureBodies[0]).not.toHaveProperty('measurement_consent');
});
