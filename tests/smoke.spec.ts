import { test as base, expect } from '@playwright/test';

type NetworkBoundary = {
  submissions: Array<{ url: string; data: unknown }>;
};

const mockOrigin = 'https://submissions.gourmet.invalid';
const test = base.extend<{ networkBoundary: NetworkBoundary }>({
  networkBoundary: [async ({ page, context, baseURL }, use) => {
    const localOrigin = new URL(baseURL!).origin;
    const blocked: string[] = [];
    const browserErrors: string[] = [];
    const submissions: NetworkBoundary['submissions'] = [];

    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await context.routeWebSocket('**/*', socket => {
      blocked.push(`WebSocket ${socket.url()}`);
      socket.close();
    });

    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === localOrigin) return route.continue();

      if (url.origin === mockOrigin && request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': localOrigin,
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      if (url.origin === mockOrigin && request.method() === 'POST') {
        submissions.push({ url: url.href, data: request.postDataJSON() });
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': localOrigin },
          body: JSON.stringify({ ok: true, mocked: true }),
        });
      }

      blocked.push(`${request.method()} ${url.href}`);
      await route.abort('blockedbyclient');
    });

    await use({ submissions });
    expect(blocked, 'Unexpected external requests are blocked').toEqual([]);
    expect(browserErrors, 'Browser runtime and console errors').toEqual([]);
  }, { auto: true }],
});

test('mounts the foundation and serves assets without horizontal overflow', async ({ page, request, baseURL }, testInfo) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Gourmet Growth Form V2 — Staging');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Growth Form V2', level: 1 })).toBeVisible();
  await expect(page.getByText('Foundation ready', { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');

  const assets = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('src') || element.getAttribute('href')!),
  );
  expect(assets.some(asset => asset.endsWith('.js'))).toBe(true);
  expect(assets.some(asset => asset.endsWith('.css'))).toBe(true);
  for (const asset of assets) {
    const url = new URL(asset, baseURL);
    expect(url.origin).toBe(new URL(baseURL!).origin);
    const assetResponse = await request.get(`${url.pathname}${url.search}`);
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()['content-type']).toContain(
      asset.endsWith('.css') ? 'text/css' : 'javascript',
    );
  }

  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.width);
  await page.screenshot({ path: testInfo.outputPath('foundation.png'), fullPage: true });
});

test('opens and reloads a synthetic deep link through the SPA fallback', async ({ page }) => {
  const response = await page.goto('/smoke/synthetic-session-001');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Growth Form V2' })).toBeVisible();
  const reloaded = await page.reload();
  expect(reloaded?.status()).toBe(200);
  await expect(page.getByText('Foundation ready', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/smoke\/synthetic-session-001$/);
});

test('returns health and JSON 404 responses for synthetic requests', async ({ request }) => {
  const health = await request.get('/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['content-type']).toContain('application/json');
  expect(await health.json()).toEqual({ ok: true, service: 'gourmet-growth-form-v2' });

  const missing = await request.get('/api/smoke-missing', {
    headers: { Accept: 'application/json' },
  });
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Not found' });

  const submission = await request.post('/smoke/synthetic-submission', {
    headers: { Accept: 'text/html' },
    data: { name: 'Synthetic Test', email: 'smoke@example.invalid' },
  });
  expect(submission.status()).toBe(404);
  expect(submission.headers()['content-type']).toContain('application/json');
  expect(await submission.json()).toEqual({ error: 'Not found' });
});

test('mocks an external submission with synthetic data inside the browser', async ({ page, networkBoundary }) => {
  const syntheticLead = { name: 'Synthetic Test', email: 'smoke@example.invalid' };
  await page.goto('/');
  const result = await page.evaluate(async ({ endpoint, data }) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }, { endpoint: `${mockOrigin}/leads`, data: syntheticLead });

  expect(result).toEqual({ status: 202, body: { ok: true, mocked: true } });
  expect(networkBoundary.submissions).toEqual([
    { url: `${mockOrigin}/leads`, data: syntheticLead },
  ]);
});
