import { expect, Page, test } from '@playwright/test';

const deployedSha = process.env.E2E_BASE_URL ? process.env.GITHUB_SHA : undefined;
const funnelPath = `/form2/bbq/${deployedSha ? `?sha=${deployedSha}` : ''}`;

type DebugEvent = {
  event_id: string;
  event_name: string;
  visitor_id: string;
  session_id: string;
  step_id: string;
  step_index: number;
  step_duration_ms: number | null;
  session_elapsed_ms: number;
  properties: Record<string, unknown>;
};

type DebugSnapshot = {
  visitor_id: string;
  session_id: string;
  attribution: {
    first_touch: Record<string, unknown>;
    latest_touch: Record<string, unknown>;
  };
  events: DebugEvent[];
};

async function snapshot(page: Page): Promise<DebugSnapshot> {
  await page.waitForFunction(() => Boolean(window.__GOURMET_TELEMETRY_DEBUG__));
  return page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__!.getSnapshot()) as Promise<DebugSnapshot>;
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

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium-390x844', 'Telemetry contract runs once; M0B runs on every browser project.');
});

test.beforeEach(async ({ page }) => {
  await page.goto(funnelPath);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(funnelPath);
  await snapshot(page);
});

test('anonymous identity persists correctly and event IDs are unique', async ({ page }) => {
  const initial = await snapshot(page);
  expect(initial.visitor_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(initial.session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(initial.session_id).not.toBe(initial.visitor_id);
  expect(initial.events.slice(0, 2).map((event) => event.event_name)).toEqual([
    'session_started',
    'step_viewed',
  ]);
  expect(initial.events[1]).toMatchObject({ step_id: 'guests', step_index: 1 });
  expect(new Set(initial.events.map((event) => event.event_id)).size).toBe(initial.events.length);

  await page.reload();
  const reloaded = await snapshot(page);
  expect(reloaded.visitor_id).toBe(initial.visitor_id);
  expect(reloaded.session_id).toBe(initial.session_id);
  expect(reloaded.events.filter((event) => event.event_name === 'session_started')).toHaveLength(1);
  expect(reloaded.events.some((event) => event.event_name === 'funnel_resumed')).toBeTruthy();

  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  const newSession = await snapshot(page);
  expect(newSession.visitor_id).toBe(initial.visitor_id);
  expect(newSession.session_id).not.toBe(initial.session_id);
  expect(newSession.events.filter((event) => event.event_name === 'session_started')).toHaveLength(1);
});

test('selection, Continue, Back, validation, and timing events are ordered', async ({ page }) => {
  await page.locator('[data-option-value="26-50"]').click();
  let events = (await snapshot(page)).events;
  expect(events.at(-1)).toMatchObject({
    event_name: 'answer_selected',
    step_id: 'guests',
    properties: { question: 'guests', value: '26-50' },
  });

  await page.getByRole('button', { name: 'Continue' }).click();
  events = (await snapshot(page)).events;
  expect(events.slice(-2).map((event) => [event.event_name, event.step_id])).toEqual([
    ['step_completed', 'guests'],
    ['step_viewed', 'service'],
  ]);
  expect(events.at(-2)?.step_duration_ms).toEqual(expect.any(Number));
  expect(events.at(-2)?.session_elapsed_ms).toEqual(expect.any(Number));

  await page.getByRole('button', { name: 'Back' }).click();
  events = (await snapshot(page)).events;
  expect(events.slice(-2).map((event) => event.event_name)).toEqual(['back_clicked', 'step_viewed']);
  expect(events.at(-2)?.properties).toEqual({ from_step: 'service', to_step: 'guests' });

  await chooseAndContinue(page, '26-50');
  await chooseAndContinue(page, 'full-service');
  await page.getByLabel('Event ZIP code').fill('123');
  await page.getByLabel('Event ZIP code').press('Enter');
  events = (await snapshot(page)).events;
  expect(events.at(-1)).toMatchObject({
    event_name: 'validation_error',
    step_id: 'zip',
    properties: { code: 'zip_invalid' },
  });
});

test('phone and name PII never enter telemetry and completion emits once', async ({ page }) => {
  const rawPhone = '5035550123';
  const formattedPhone = '(503) 555-0123';
  const customerName = 'TelemetrySecretName';

  await reachPhone(page);
  await page.getByLabel('Mobile number').fill(rawPhone);
  await page.getByRole('button', { name: 'Continue' }).click();
  await chooseAndContinue(page, 'Corporate');
  await chooseAndContinue(page, 'still-deciding');
  await page.getByLabel('First name').fill(customerName);
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('STAGING FLOW COMPLETE')).toBeVisible();

  let current = await snapshot(page);
  const phoneEvent = current.events.find((event) => event.event_name === 'phone_captured');
  expect(phoneEvent).toMatchObject({
    step_id: 'phone',
    properties: { valid: true, digit_count: 10 },
  });
  expect(current.events.filter((event) => event.event_name === 'form_completed')).toHaveLength(1);
  const serialized = JSON.stringify(current.events);
  expect(serialized).not.toContain(rawPhone);
  expect(serialized).not.toContain(formattedPhone);
  expect(serialized).not.toContain(customerName);

  await page.reload();
  current = await snapshot(page);
  expect(current.events.filter((event) => event.event_name === 'form_completed')).toHaveLength(1);
  expect(current.events.filter((event) => event.event_name === 'session_started')).toHaveLength(1);
  expect(current.events.some((event) => event.event_name === 'funnel_resumed')).toBeTruthy();
  expect(JSON.stringify(current.events)).not.toContain(customerName);

  const localStorageDump = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(localStorageDump).not.toContain(rawPhone);
  expect(localStorageDump).not.toContain(customerName);
  expect(localStorageDump).not.toContain('event_name');
});

test('attribution is allowlisted, first/latest touch are separated, and hostile values are rejected', async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  const oversized = 'x'.repeat(600);
  const params = new URLSearchParams({
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'bbq_portland',
    utm_term: 'catering',
    utm_content: 'hero-a',
    utm_id: 'campaign-42',
    gclid: 'safe-click-id',
    gbraid: 'safe-gbraid',
    wbraid: 'safe-wbraid',
    gad_source: '1',
    gad_campaignid: 'campaign-id',
    adgroupid: 'adgroup-id',
    network: 'search',
    matchtype: 'exact',
    device: 'mobile',
    geo: 'oregon',
    fbclid: 'safe-fb-click',
    msclkid: 'safe-ms-click',
    ttclid: 'safe-tt-click',
    rogue: 'must-not-be-captured',
  });

  await page.goto(`${funnelPath}${funnelPath.includes('?') ? '&' : '?'}${params}`);
  const first = await snapshot(page);
  expect(first.attribution.first_touch).toMatchObject({
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'bbq_portland',
    utm_term: 'catering',
    utm_content: 'hero-a',
    utm_id: 'campaign-42',
    gclid: 'safe-click-id',
    gbraid: 'safe-gbraid',
    wbraid: 'safe-wbraid',
    gad_source: '1',
    gad_campaignid: 'campaign-id',
    adgroupid: 'adgroup-id',
    network: 'search',
    matchtype: 'exact',
    device: 'mobile',
    geo: 'oregon',
    fbclid: 'safe-fb-click',
    msclkid: 'safe-ms-click',
    ttclid: 'safe-tt-click',
    intent_cluster: 'bbq',
    landing_path: '/form2/bbq/',
  });
  expect(first.attribution.first_touch).not.toHaveProperty('rogue');
  expect(String(first.attribution.first_touch.landing_url_without_pii)).not.toContain('?');

  const latestParams = new URLSearchParams({
    utm_source: 'meta',
    utm_content: oversized,
    fbclid: 'latest-click',
    msclkid: '5035550123',
  });
  await page.goto(`${funnelPath}${funnelPath.includes('?') ? '&' : '?'}${latestParams}`);
  const latest = await snapshot(page);
  expect(latest.attribution.first_touch.utm_source).toBe('google');
  expect(latest.attribution.latest_touch).toMatchObject({ utm_source: 'meta', fbclid: 'latest-click' });
  expect(latest.attribution.latest_touch).not.toHaveProperty('utm_content');
  expect(latest.attribution.latest_touch).not.toHaveProperty('msclkid');
  expect(JSON.stringify(latest.attribution)).not.toContain('must-not-be-captured');
  expect(JSON.stringify(latest.attribution)).not.toContain('5035550123');
});

test('visibility and pagehide are non-blocking deduplicated signals', async ({ page }) => {
  await page.evaluate(() => {
    let visibility: 'hidden' | 'visible' = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });

  const events = (await snapshot(page)).events;
  expect(events.filter((event) => event.event_name === 'visibility_changed' && event.properties.state === 'hidden')).toHaveLength(1);
  expect(events.filter((event) => event.event_name === 'visibility_changed' && event.properties.state === 'visible')).toHaveLength(1);
  expect(events.filter((event) => event.event_name === 'page_exit_signal')).toHaveLength(1);
  expect(events.find((event) => event.event_name === 'page_exit_signal')?.properties).toEqual({
    reason: 'pagehide',
    last_step: 'guests',
  });
  expect(events.some((event) => event.event_name === 'abandoned' || event.event_name === 'lost')).toBeFalsy();
});
