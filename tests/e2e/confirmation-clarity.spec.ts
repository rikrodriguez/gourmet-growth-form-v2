import { expect, test as base, type Page, type TestInfo } from '@playwright/test';

// Run against an explicitly configured, local artifact only. No real vendor SDK
// is downloaded: the stub leaves the production command queue intact to inspect.
const CONFIRMATION_PATH = '/form2/request-received/';
const CONSENT_KEY = 'gourmet_growth_measurement_consent_v1';
const PENDING_KEY = 'gourmet_growth_measurement_pending_v1';
const MILESTONES_KEY = 'gourmet_growth_measurement_milestones_v1';
const COMPLETION_KEY = 'gourmet_growth_v2_completion_v1';
const DOCUMENT_HISTORY_KEY = 'confirmation_clarity_test_document_history';
const EXPECTED_CLARITY_ID = process.env.E2E_EXPECTED_CLARITY_ID ?? 'clarityqa';
const LEAD_ID = 'fa50f08a-6bd6-40d4-8103-70349df8ba9d';
const CONVERSION_ID = 'c'.repeat(64);
const SYNTHETIC_NAME = 'Clarity QA Guest';
const SYNTHETIC_PHONE = '5035550123';

interface VendorRequest {
  url: string;
  documentPath: string;
  documentUrl: string;
}

interface ApiRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

interface Isolation {
  vendors: VendorRequest[];
  api: ApiRequest[];
  errors: string[];
  delayClarity: () => void;
  releaseClarity: () => void;
}

interface DocumentRecord {
  id: string;
  path: string;
  dataLayer: unknown[];
  pending: string | null;
  milestones: string | null;
}

declare global {
  interface Window {
    __CONFIRMATION_TEST_DOCUMENT_ID__?: string;
    __CONFIRMATION_TEST_CLARITY_LOADED__?: boolean;
  }
}

const test = base.extend<{ isolation: Isolation }>({
  isolation: async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
      throw new Error('Confirmation Clarity contracts require a local artifact; live targets are prohibited.');
    }
    const vendors: VendorRequest[] = [];
    const api: ApiRequest[] = [];
    const errors: string[] = [];
    let delayed = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    page.on('pageerror', (error) => errors.push(error.message));

    // Deny all non-local traffic, including unexpected SDK collection domains,
    // pixels, fonts and API hosts. Routes below are the only synthetic responses.
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const vendor = /(^|\.)(clarity\.ms|googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net)$/.test(url.hostname);
      if (vendor) {
        const documentUrl = request.frame().url();
        vendors.push({ url: url.toString(), documentPath: new URL(documentUrl).pathname, documentUrl });
        if (url.hostname === 'www.clarity.ms' && url.pathname.startsWith('/tag/')) {
          if (delayed) await gate;
          await route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: 'window.__CONFIRMATION_TEST_CLARITY_LOADED__ = true;',
          });
        } else {
          await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
        }
        return;
      }
      if (url.pathname.startsWith('/v1/')) {
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,PATCH,OPTIONS' };
        if (request.method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: cors });
          return;
        }
        const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        api.push({ path: url.pathname, method: request.method(), body });
        let response: Record<string, unknown>;
        if (url.pathname === '/v1/events/batch') {
          const ids = (body.events as Array<{ event_id: string }> ?? []).map((event) => event.event_id);
          response = { accepted: ids.length, duplicates: 0, rejected: 0, acknowledged_event_ids: ids, rejections: [] };
        } else if (url.pathname === '/v1/leads/capture-phone') {
          response = { lead_id: LEAD_ID, conversion_id: CONVERSION_ID, status: 'created' };
        } else if (url.pathname === `/v1/leads/${LEAD_ID}`) {
          response = { lead_id: LEAD_ID, status: 'updated' };
        } else {
          await route.fulfill({ status: 501, headers: cors, contentType: 'application/json', body: '{"error":"unexpected_mock_endpoint"}' });
          return;
        }
        await route.fulfill({
          status: url.pathname === '/v1/leads/capture-phone' ? 201 : 200,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
        return;
      }
      if (url.origin === origin) await route.continue();
      else await route.abort('blockedbyclient');
    });
    await page.addInitScript(({ historyKey }) => {
      window.__CONFIRMATION_TEST_DOCUMENT_ID__ = crypto.randomUUID();
      window.addEventListener('pagehide', () => {
        const history = JSON.parse(sessionStorage.getItem(historyKey) ?? '[]');
        history.push({
          id: window.__CONFIRMATION_TEST_DOCUMENT_ID__,
          path: location.pathname,
          dataLayer: window.dataLayer ?? [],
          pending: sessionStorage.getItem('gourmet_growth_measurement_pending_v1'),
          milestones: sessionStorage.getItem('gourmet_growth_measurement_milestones_v1'),
        });
        sessionStorage.setItem(historyKey, JSON.stringify(history));
      });
    }, { historyKey: DOCUMENT_HISTORY_KEY });
    try {
      await use({ vendors, api, errors, delayClarity: () => { delayed = true; }, releaseClarity: release });
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  },
});

test.use({ serviceWorkers: 'block' });

test.beforeEach(({}, testInfo) => {
  test.skip(
    process.env.E2E_MEASUREMENT_MODE !== 'mock'
      || !['mobile-chromium-390x844', 'desktop-chromium-1440x900'].includes(testInfo.project.name),
    'Local mocked vendor contract runs on representative mobile and desktop profiles.',
  );
});

function consent(analytics: boolean, ads = false) {
  return {
    version: 1,
    updated_at: '2026-10-15T12:00:00.000Z',
    analytics_storage: analytics ? 'granted' : 'denied',
    ad_storage: ads ? 'granted' : 'denied',
    ad_user_data: ads ? 'granted' : 'denied',
    ad_personalization: ads ? 'granted' : 'denied',
  };
}

async function seed(page: Page, options: {
  rawConsent?: string;
  pending?: string;
  milestones?: string;
  snapshot?: boolean;
  failLocalStorage?: boolean;
} = {}) {
  await page.addInitScript(({ options, keys, name }) => {
    // Seed once per tab, so reload and full document navigation test real
    // persistence rather than silently overwriting a choice on every page load.
    if (!sessionStorage.getItem('confirmation_clarity_test_seeded')) {
      sessionStorage.setItem('confirmation_clarity_test_seeded', 'true');
      if (options.rawConsent !== undefined) localStorage.setItem(keys.consent, options.rawConsent);
      if (options.pending !== undefined) sessionStorage.setItem(keys.pending, options.pending);
      if (options.milestones !== undefined) sessionStorage.setItem(keys.milestones, options.milestones);
      if (options.snapshot) {
        sessionStorage.setItem(keys.completion, JSON.stringify({
          version: 1, completedAt: Date.now(), variant: 'bbq', firstName: name,
          eventType: 'Corporate', guests: '26-50', service: 'full-service', timing: 'still-deciding',
        }));
      }
    }
    if (options.failLocalStorage) {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => { throw new DOMException('Storage is unavailable for this test', 'SecurityError'); },
      });
    }
  }, {
    options,
    keys: { consent: CONSENT_KEY, pending: PENDING_KEY, milestones: MILESTONES_KEY, completion: COMPLETION_KEY },
    name: SYNTHETIC_NAME,
  });
}

async function openConfirmation(page: Page, path = CONFIRMATION_PATH) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Thank you');
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page).toHaveTitle('Request received | Gourmet Corp');
}

async function chooseAnalytics(page: Page, analytics: boolean, ads = false) {
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByRole('checkbox', { name: /^Analytics/ }).setChecked(analytics);
  await page.getByRole('checkbox', { name: /^Advertising/ }).setChecked(ads);
  await page.getByRole('button', { name: 'Save choices' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function queue(page: Page) {
  return page.evaluate(() => window.clarity?.q ?? []);
}

function clarityRequests(isolation: Isolation, path?: string) {
  return isolation.vendors.filter((request) => new URL(request.url).hostname.endsWith('clarity.ms')
    && (!path || request.documentPath === path));
}

async function expectClarityOnly(page: Page, isolation: Isolation) {
  await expect(page.locator('#gourmet-growth-gtm')).toHaveCount(0);
  expect(await page.evaluate(() => window.dataLayer)).toBeUndefined();
  expect(await page.evaluate(() => window.__GOURMET_MEASUREMENT_DEBUG__)).toBeUndefined();
  expect(isolation.vendors.filter((request) => request.documentPath === CONFIRMATION_PATH
    && !new URL(request.url).hostname.endsWith('clarity.ms'))).toEqual([]);
  expect(isolation.errors).toEqual([]);
}

async function expectClarityLoaded(page: Page) {
  await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(1);
  await expect(page.locator('#gourmet-growth-clarity')).toHaveAttribute('src', `https://www.clarity.ms/tag/${EXPECTED_CLARITY_ID}`);
  await expect.poll(() => page.evaluate(() => window.__CONFIRMATION_TEST_CLARITY_LOADED__)).toBe(true);
}

async function measurementStorage(page: Page) {
  return page.evaluate(({ pending, milestones }) => ({
    pending: sessionStorage.getItem(pending), milestones: sessionStorage.getItem(milestones),
  }), { pending: PENDING_KEY, milestones: MILESTONES_KEY });
}

test('persisted analytics consent starts only one configured Clarity script', async ({ page, isolation }) => {
  await seed(page, { rawConsent: JSON.stringify(consent(true)) });
  await openConfirmation(page);
  await expectClarityLoaded(page);
  expect(clarityRequests(isolation)).toHaveLength(1);
  expect(await queue(page)).toEqual([['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }]]);
  await expectClarityOnly(page, isolation);
  expect(isolation.api).toEqual([]);
});

const deniedCases = [
  { name: 'no saved choice', rawConsent: undefined },
  { name: 'rejected consent', rawConsent: JSON.stringify(consent(false)) },
  { name: 'advertising-only consent', rawConsent: JSON.stringify(consent(false, true)) },
  { name: 'corrupt JSON', rawConsent: '{broken' },
  { name: 'unsupported consent version', rawConsent: JSON.stringify({ ...consent(true), version: 2 }) },
  { name: 'invalid consent values', rawConsent: JSON.stringify({ ...consent(true), analytics_storage: 'yes' }) },
];

for (const example of deniedCases) {
  test(`${example.name} keeps Clarity off and the confirmation usable`, async ({ page, isolation }) => {
    await seed(page, { rawConsent: example.rawConsent });
    await openConfirmation(page);
    await page.getByRole('button', { name: 'Privacy choices' }).click();
    await expect(page.getByRole('checkbox', { name: /^Analytics/ })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Save choices' })).toBeEnabled();
    await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
    expect(clarityRequests(isolation)).toEqual([]);
    expect(await queue(page)).toEqual([]);
    await expectClarityOnly(page, isolation);
    expect(isolation.api).toEqual([]);
  });
}

test('unavailable localStorage fails closed, but an explicit in-page choice still works', async ({ page, isolation }) => {
  await seed(page, { rawConsent: JSON.stringify(consent(true)), failLocalStorage: true });
  await openConfirmation(page);
  await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
  expect(clarityRequests(isolation)).toEqual([]);
  await chooseAnalytics(page, true);
  await expectClarityLoaded(page);
  await chooseAnalytics(page, false);
  expect((await queue(page)).slice(-2)).toEqual([
    ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }], ['consent', false],
  ]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
  expect(clarityRequests(isolation)).toHaveLength(1);
  await expectClarityOnly(page, isolation);
});

test('accept, revoke, cancel and reaccept preserve the script and ordered consent commands', async ({ page, isolation }) => {
  await seed(page);
  await openConfirmation(page);
  await chooseAnalytics(page, true);
  await expectClarityLoaded(page);
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await page.getByRole('checkbox', { name: /^Analytics/ }).uncheck();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await queue(page)).toHaveLength(1);
  await chooseAnalytics(page, false, true);
  await chooseAnalytics(page, true, true);
  expect(await queue(page)).toEqual([
    ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
    ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'denied' }],
    ['consent', false],
    ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
  ]);
  await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(1);
  expect(clarityRequests(isolation)).toHaveLength(1);
  await expectClarityOnly(page, isolation);
});

test('revocation while the SDK is delayed stays ordered before script completion', async ({ page, isolation }) => {
  isolation.delayClarity();
  await seed(page, { rawConsent: JSON.stringify(consent(true)) });
  await openConfirmation(page);
  await expect.poll(() => clarityRequests(isolation).length).toBe(1);
  expect(await page.evaluate(() => window.__CONFIRMATION_TEST_CLARITY_LOADED__)).toBeUndefined();
  await chooseAnalytics(page, false);
  const beforeCompletion = await queue(page);
  expect(beforeCompletion).toEqual([
    ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
    ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }],
    ['consent', false],
  ]);
  isolation.releaseClarity();
  await expectClarityLoaded(page);
  expect(await queue(page)).toEqual(beforeCompletion);
  expect(clarityRequests(isolation)).toHaveLength(1);
  await expectClarityOnly(page, isolation);
});

test('reload preserves acceptance and rejection without replaying Google measurement', async ({ page, isolation }) => {
  await seed(page);
  await openConfirmation(page);
  await chooseAnalytics(page, true);
  await expectClarityLoaded(page);
  const firstDocument = await page.evaluate(() => window.__CONFIRMATION_TEST_DOCUMENT_ID__);
  await page.reload();
  await expectClarityLoaded(page);
  expect(await page.evaluate(() => window.__CONFIRMATION_TEST_DOCUMENT_ID__)).not.toBe(firstDocument);
  expect(clarityRequests(isolation)).toHaveLength(2);
  expect(await queue(page)).toHaveLength(1);
  await chooseAnalytics(page, false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Privacy choices' })).toBeVisible();
  await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
  expect(clarityRequests(isolation)).toHaveLength(2);
  expect(await queue(page)).toEqual([]);
  await expectClarityOnly(page, isolation);
});

test('confirmation and preference changes never consume pending events or rewrite milestones', async ({ page, isolation }) => {
  const pending = JSON.stringify(['form_start', 'form_complete', 'generate_lead'].map((event) => ({
    event, schema_version: '1.0', intent_cluster: 'bbq', measurement_environment: 'staging',
    traffic_type: 'qa', analytics_eligible: true, ads_eligible: false,
    ...(event === 'generate_lead' ? { transaction_id: CONVERSION_ID } : {}),
  })));
  const milestones = JSON.stringify(['form_start', 'generate_lead', 'form_complete']);
  await seed(page, { pending, milestones, rawConsent: JSON.stringify(consent(true)) });
  await openConfirmation(page);
  await expectClarityLoaded(page);
  expect(await measurementStorage(page)).toEqual({ pending, milestones });
  await chooseAnalytics(page, false);
  expect(await measurementStorage(page)).toEqual({ pending, milestones });
  await chooseAnalytics(page, true);
  expect(await measurementStorage(page)).toEqual({ pending, milestones });
  await page.reload();
  await expectClarityLoaded(page);
  expect(await measurementStorage(page)).toEqual({ pending, milestones });
  await expectClarityOnly(page, isolation);
  expect(isolation.api).toEqual([]);
});

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('personalized confirmation and preferences stay masked and usable at both viewport sizes', async ({ page, isolation }, testInfo) => {
  await seed(page, { rawConsent: JSON.stringify(consent(true)), snapshot: true });
  await openConfirmation(page);
  await expectClarityLoaded(page);
  await expect(page.getByRole('heading', { name: `Thank you, ${SYNTHETIC_NAME}` })).toBeVisible();
  await expect(page.getByRole('main')).toHaveAttribute('data-clarity-mask', 'true');
  await expect(page.locator('[data-clarity-mask="true"] .thank-you-summary')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'confirmation');
  await page.getByRole('button', { name: 'Privacy choices' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Analytics/ })).toBeChecked();
  await page.getByRole('button', { name: 'Save choices' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Save choices' })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'confirmation-preferences');
  const commands = JSON.stringify(await queue(page));
  for (const value of [SYNTHETIC_NAME, SYNTHETIC_PHONE, 'Corporate', '26-50', 'full-service', LEAD_ID, CONVERSION_ID]) {
    expect(page.url()).not.toContain(value);
    expect(commands).not.toContain(value);
    expect(JSON.stringify(isolation.vendors)).not.toContain(value);
  }
  expect(new URL(page.url()).search).toBe('');
  await expectClarityOnly(page, isolation);
});

test('direct confirmation strips query and fragment before the first vendor request', async ({ page, isolation }) => {
  await seed(page, { rawConsent: JSON.stringify(consent(true)) });
  const privateUrl = `${CONFIRMATION_PATH}?first_name=${encodeURIComponent(SYNTHETIC_NAME)}&phone=${SYNTHETIC_PHONE}&lead_id=${LEAD_ID}#${CONVERSION_ID}`;
  await openConfirmation(page, privateUrl);
  await expect(page).toHaveURL(new RegExp(`${CONFIRMATION_PATH}$`));
  await expectClarityLoaded(page);
  expect(isolation.vendors).toHaveLength(1);
  expect(isolation.vendors[0].documentUrl).toBe(page.url());
  for (const request of isolation.vendors) {
    expect(new URL(request.documentUrl).search).toBe('');
    expect(new URL(request.documentUrl).hash).toBe('');
  }
  const commands = JSON.stringify(await queue(page));
  for (const value of [SYNTHETIC_NAME, encodeURIComponent(SYNTHETIC_NAME), SYNTHETIC_PHONE, LEAD_ID, CONVERSION_ID]) {
    expect(page.url()).not.toContain(value);
    expect(JSON.stringify(isolation.vendors)).not.toContain(value);
    expect(commands).not.toContain(value);
  }
  await expectClarityOnly(page, isolation);
  expect(isolation.api).toEqual([]);
});

for (const failure of ['throw', 'noop'] as const) {
  test(`history.replaceState ${failure} keeps Clarity disconnected despite later consent`, async ({ page, isolation }) => {
    await seed(page, { rawConsent: JSON.stringify(consent(true)) });
    await page.addInitScript((failure) => {
      window.history.replaceState = () => {
        if (failure === 'throw') throw new DOMException('History is blocked for this test', 'SecurityError');
      };
    }, failure);
    const privateUrl = `${CONFIRMATION_PATH}?first_name=SyntheticBlockedName#private-confirmation`;
    await openConfirmation(page, privateUrl);
    expect(new URL(page.url()).search).toBe('?first_name=SyntheticBlockedName');
    expect(new URL(page.url()).hash).toBe('#private-confirmation');
    await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
    expect(isolation.vendors).toEqual([]);
    expect(await queue(page)).toEqual([]);
    // Even real, persisted preference changes must not register a listener or
    // bypass the failed URL privacy gate for the rest of this document.
    await chooseAnalytics(page, false);
    await chooseAnalytics(page, true);
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').analytics_storage, CONSENT_KEY)).toBe('granted');
    await expect(page.locator('#gourmet-growth-clarity')).toHaveCount(0);
    expect(isolation.vendors).toEqual([]);
    expect(await queue(page)).toEqual([]);
    await expectClarityOnly(page, isolation);
    expect(isolation.api).toEqual([]);
  });
}

test('retired thank-you route redirects without vendors in the intermediate document', async ({ page, isolation }) => {
  await seed(page, { rawConsent: JSON.stringify(consent(true)) });
  await page.goto('/form2/thank-you/?first_name=SyntheticLegacyName');
  await expect(page).toHaveURL(new RegExp(`${CONFIRMATION_PATH}$`));
  await expectClarityLoaded(page);
  expect(isolation.vendors.filter((request) => request.documentPath === '/form2/thank-you/')).toEqual([]);
  expect(clarityRequests(isolation, CONFIRMATION_PATH)).toHaveLength(1);
  expect(JSON.stringify(await queue(page))).not.toContain('SyntheticLegacyName');
  await expectClarityOnly(page, isolation);
});

async function chooseAndContinue(page: Page, value: string) {
  await page.locator(`[data-option-value="${value}"]`).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('mocked submission navigates to a fresh Clarity document without repeating conversions on reload', async ({ page, isolation }) => {
  test.skip(process.env.E2E_API_MODE !== 'mock', 'Full navigation also requires a build with a configured, mocked API URL.');
  await seed(page, { rawConsent: JSON.stringify(consent(true)) });
  await page.goto('/form2/bbq/');
  await expectClarityLoaded(page);
  const formDocument = await page.evaluate(() => window.__CONFIRMATION_TEST_DOCUMENT_ID__);
  await chooseAndContinue(page, '26-50');
  await chooseAndContinue(page, 'full-service');
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Mobile number').fill(SYNTHETIC_PHONE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await chooseAndContinue(page, 'Corporate');
  await chooseAndContinue(page, 'still-deciding');
  await page.getByLabel('First name').fill(SYNTHETIC_NAME);
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(new RegExp(`${CONFIRMATION_PATH}$`));
  await expect(page.getByRole('heading', { name: `Thank you, ${SYNTHETIC_NAME}` })).toBeVisible();
  await expectClarityLoaded(page);
  expect(await page.evaluate(() => window.__CONFIRMATION_TEST_DOCUMENT_ID__)).not.toBe(formDocument);
  expect(clarityRequests(isolation, '/form2/bbq/')).toHaveLength(1);
  expect(clarityRequests(isolation, CONFIRMATION_PATH)).toHaveLength(1);
  const history = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as DocumentRecord[], DOCUMENT_HISTORY_KEY);
  const previous = history.find((document) => document.id === formDocument);
  expect(previous).toBeDefined();
  const events = previous!.dataLayer.filter((entry): entry is { event: string } => entry !== null
    && typeof entry === 'object' && 'event' in entry);
  for (const event of ['form_start', 'generate_lead', 'form_complete']) {
    expect(events.filter((entry) => entry.event === event)).toHaveLength(1);
  }
  expect(await measurementStorage(page)).toEqual({ pending: previous!.pending, milestones: previous!.milestones });
  await expectClarityOnly(page, isolation);
  const commands = JSON.stringify(await queue(page));
  for (const value of [SYNTHETIC_NAME, SYNTHETIC_PHONE, '97205', LEAD_ID, CONVERSION_ID]) {
    expect(page.url()).not.toContain(value);
    expect(commands).not.toContain(value);
    expect(JSON.stringify(isolation.vendors)).not.toContain(value);
  }
  expect(isolation.api.filter((request) => request.path === '/v1/leads/capture-phone')).toHaveLength(1);
  expect(isolation.api.filter((request) => request.method === 'PATCH').map((request) => request.body)).toEqual([
    { event_type: 'Corporate' }, { date_window: 'still-deciding', exact_date: null }, { first_name: SYNTHETIC_NAME },
  ]);
  const storageBeforeReload = await measurementStorage(page);
  const leadWritesBeforeReload = isolation.api.filter((request) => request.path.startsWith('/v1/leads/')).length;
  await page.reload();
  await expectClarityLoaded(page);
  expect(clarityRequests(isolation, CONFIRMATION_PATH)).toHaveLength(2);
  expect(await measurementStorage(page)).toEqual(storageBeforeReload);
  expect(isolation.api.filter((request) => request.path.startsWith('/v1/leads/'))).toHaveLength(leadWritesBeforeReload);
  await expectClarityOnly(page, isolation);
});
