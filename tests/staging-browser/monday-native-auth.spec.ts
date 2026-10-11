import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createStagingOfficeApp } from '../../src/office/backend/staging-app';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { createMondayRuntime } from '../../src/office/backend/monday-runtime';
import { MondayOwnerSessions, MONDAY_OWNER_SESSION_TTL_MS, parseMondayOwnerConfiguration } from '../../src/office/backend/monday-owner';
import type { OfficeStore } from '../../src/office/backend/state';

// Public deterministic fixtures only. These credentials and key are never
// provisioned; the store/pool are memory doubles and provider fetch is blocked.
const ENV = {
  OFFICE_RUNTIME_MODE: 'staging', OFFICE_STAGING_ORIGIN: 'https://office-staging.gourmet-corporation.com',
  OFFICE_STAGING_USERNAME: 'synthetic_basic', OFFICE_STAGING_PASSWORD: 'SYNTHETIC_BASIC_PASSWORD_ONLY_12345',
  OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', OFFICE_STAGING_ROLE: 'viewer',
  OFFICE_STAGING_DB_HOST: 'office-db', OFFICE_STAGING_DB_PORT: '5432', OFFICE_STAGING_DB_USER: 'office_stage',
  OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo', OFFICE_STAGING_DB_PASSWORD: 'SYNTHETIC_DB_PASSWORD_ONLY_12345678',
  MONDAY_OAUTH_ENABLED: 'true', MONDAY_OWNER_USERNAME: 'synthetic_owner', MONDAY_OWNER_PASSWORD: 'SYNTHETIC_OWNER_PASSWORD_ONLY_9876',
  MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'SYNTHETIC_CLIENT_SECRET_ONLY',
  MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64'),
  MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com', MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909',
};
const LOGIN_ERROR = 'No se pudo confirmar el acceso del propietario. Vuelve a intentarlo.';
type Exchange = { phase: 'native-browser' | 'anonymous-boundary'; method: string; path: string; authHeaderPresent: boolean; basicAccepted: boolean; status: number; wwwAuthenticatePresent: boolean };
type Harness = {
  page: Page; context: BrowserContext; origin: string; exchanges: Exchange[];
  expireOwner: () => void; markAnonymousBoundary: () => void;
};

const test = base.extend<{ nativeMonday: Harness }>({
  nativeMonday: [async ({ browser }, use, testInfo) => {
    let now = Date.now(); let externalRequests = 0; let providerRequests = 0; let pageErrors = 0; let bridgeErrors = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { providerRequests++; throw new Error('Synthetic provider request forbidden'); };
    const staging = parseOfficeStagingEnvironment(ENV);
    const state = createOfficeFixtureState(now);
    const store: OfficeStore = { async snapshot() { return structuredClone(state); }, async transact() { throw new Error('Synthetic DEMO transaction forbidden'); } };
    const pool = { async query() { return { rows: [], rowCount: 0 }; } } as unknown as Pool;
    const runtime = createMondayRuntime(ENV, staging.access.origin, pool);
    expect(runtime.configured).toBe(true);
    const monday = { ...runtime, ownerSessions: new MondayOwnerSessions(parseMondayOwnerConfiguration(ENV), () => now) };
    const app = createStagingOfficeApp(staging, store, { staticRoot: resolve(process.cwd(), 'dist-office'), monday });
    const exchanges: Exchange[] = [];
    let origin = ''; let context: BrowserContext | undefined; let server: Server | undefined;
    let phase: Exchange['phase'] = 'native-browser';
    try {
      await app.ready();
      // This is a real loopback transport, not route.fulfill or forced browser
      // Authorization. Chromium must manage its native HTTP Basic cache itself.
      // The local bridge supplies the trusted proxy host/TLS/origin metadata.
      server = createServer(async (request, reply) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = { ...request.headers, host: staging.access.host, 'x-forwarded-proto': 'https' };
          if (headers.origin === origin) headers.origin = staging.access.origin;
          delete headers['content-length'];
          const response = await app.inject({ method: request.method as 'GET' | 'POST', url: request.url, headers,
            remoteAddress: '127.0.0.1', payload: chunks.length ? Buffer.concat(chunks) : undefined });
          exchanges.push({ phase, method: request.method ?? 'GET', path: new URL(request.url ?? '/', 'http://localhost').pathname,
            authHeaderPresent: typeof request.headers.authorization === 'string', basicAccepted: staging.access.authenticated(request.headers.authorization),
            status: response.statusCode, wwwAuthenticatePresent: response.headers['www-authenticate'] !== undefined });
          reply.statusCode = response.statusCode;
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined && !['content-length', 'transfer-encoding', 'connection'].includes(key)) reply.setHeader(key, value);
          }
          reply.end(response.rawPayload);
        } catch { bridgeErrors++; reply.statusCode = 500; reply.end('Synthetic loopback bridge unavailable'); }
      });
      await new Promise<void>(resolveListening => server!.listen(0, '127.0.0.1', resolveListening));
      const address = server.address(); expect(address && typeof address === 'object').toBeTruthy();
      if (!address || typeof address === 'string') throw new Error('Synthetic loopback listener unavailable');
      origin = `http://127.0.0.1:${address.port}`;
      const mobile = testInfo.project.name.includes('mobile');
      context = await browser.newContext({ httpCredentials: { username: ENV.OFFICE_STAGING_USERNAME, password: ENV.OFFICE_STAGING_PASSWORD },
        viewport: mobile ? { width: 320, height: 720 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
      await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/, async route => { externalRequests++; await route.abort('blockedbyclient'); });
      await context.routeWebSocket('**/*', socket => { externalRequests++; socket.close(); });
      const page = await context.newPage(); page.on('pageerror', () => pageErrors++);
      await use({ page, context, origin, exchanges, expireOwner: () => { now += MONDAY_OWNER_SESSION_TTL_MS + 1; }, markAnonymousBoundary: () => { phase = 'anonymous-boundary'; } });
      await testInfo.attach('native-basic-exchanges', { body: JSON.stringify({ localOnly: true, syntheticOnly: true, exchanges }), contentType: 'application/json' });
    } finally {
      if (context) await context.close();
      if (server) await new Promise<void>((resolveClosed, reject) => server!.close(error => error ? reject(error) : resolveClosed()));
      await app.close(); globalThis.fetch = previousFetch;
      expect(bridgeErrors).toBe(0); expect(pageErrors).toBe(0); expect(externalRequests).toBe(0); expect(providerRequests).toBe(0);
    }
  }, { auto: true }],
});

async function openOwner(harness: Harness) {
  const response = await harness.page.goto(`${harness.origin}/office/monday`);
  expect(response?.status()).toBe(200);
  await expect(harness.page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  // Chromium permits Secure cookies on loopback. A real stored challenge proves
  // these cases exercise owner credential validation, rather than failing CSRF.
  expect((await harness.context.cookies()).some(cookie => cookie.name === '__Secure-gourmet-monday-owner-login')).toBe(true);
}

async function submitOwner(harness: Harness, correct: boolean) {
  await harness.page.getByLabel('Usuario del propietario', { exact: true }).fill(ENV.MONDAY_OWNER_USERNAME);
  await harness.page.getByLabel('Contraseña del propietario', { exact: true }).fill(correct ? ENV.MONDAY_OWNER_PASSWORD : 'SYNTHETIC_WRONG_OWNER_PASSWORD_12345');
  const response = harness.page.waitForResponse(item => new URL(item.url()).pathname === '/office-api/monday/owner/login' && item.request().method() === 'POST');
  await harness.page.getByRole('button', { name: 'Entrar como propietario', exact: true }).click();
  return response;
}

test('wrong owner logins stay inline, retain Basic, refresh CSRF and recover before owner expiry', async ({ nativeMonday: h }, testInfo) => {
  await openOwner(h);
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = h.exchanges.length;
    const response = await submitOwner(h, false);
    expect(response.status()).toBe(403); expect(response.headers()['www-authenticate']).toBeUndefined();
    expect(await response.json()).toEqual({ error: 'MONDAY_OWNER_UNAUTHORIZED' });
    await expect(h.page.getByRole('alert')).toHaveText(LOGIN_ERROR);
    await expect(h.page.getByLabel('Contraseña del propietario', { exact: true })).toHaveValue('');
    await expect(h.page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
    const subsequent = h.exchanges.slice(start);
    expect(subsequent.filter(item => item.method === 'POST' && item.path === '/office-api/monday/owner/login')).toHaveLength(1);
    expect(subsequent.some(item => item.method === 'GET' && item.path === '/office-api/monday/owner/login' && item.status === 200)).toBe(true);
    expect(subsequent.every(item => item.basicAccepted && !item.wwwAuthenticatePresent)).toBe(true);
  }
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await h.page.screenshot({ path: testInfo.outputPath('owner-inline-error-native-basic.png'), fullPage: true });
  const response = await submitOwner(h, true);
  expect(response.status()).toBe(200);
  await expect(h.page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
  await expect(h.page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toHaveCount(0);
  h.expireOwner();
  const start = h.exchanges.length;
  const expired = await h.page.evaluate(async () => {
    const response = await fetch('/office-api/monday/status', { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, wwwAuthenticatePresent: response.headers.has('www-authenticate'), body: await response.json() };
  });
  expect(expired).toEqual({ status: 403, wwwAuthenticatePresent: false, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } });
  expect(h.exchanges.slice(start).every(item => item.basicAccepted && !item.wwwAuthenticatePresent)).toBe(true);
  await h.page.getByRole('button', { name: 'Actualizar estado', exact: true }).click();
  await expect(h.page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  expect(await h.page.evaluate(password => [document.cookie, ...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(password)), ENV.MONDAY_OWNER_PASSWORD)).toBe(false);
});

test('correct owner login works fresh while missing or wrong Basic still challenges UI, API and assets', async ({ nativeMonday: h, browser }, testInfo) => {
  await openOwner(h);
  const response = await submitOwner(h, true);
  expect(response.status()).toBe(200); expect(response.headers()['www-authenticate']).toBeUndefined();
  await expect(h.page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
  await expect(h.page.getByRole('alert')).toHaveCount(0);
  await h.page.screenshot({ path: testInfo.outputPath('owner-correct-native-basic.png'), fullPage: true });
  const asset = h.exchanges.find(item => item.path.endsWith('.js')); expect(asset).toBeTruthy();
  h.markAnonymousBoundary();
  const anonymous = await browser.newContext({ serviceWorkers: 'block' });
  try {
    for (const path of ['/office/monday', '/office-api/monday/owner/session', asset!.path]) {
      for (const wrongBasic of [false, true]) {
        const response = await anonymous.request.get(`${h.origin}${path}`, { headers: wrongBasic ? { authorization: 'Basic U1lOVEhFVElDX0JBRF9CQVNJQw==' } : {} });
        expect(response.status()).toBe(401); expect(response.headers()['www-authenticate']).toContain('Basic');
        expect(await response.json()).toEqual({ error: 'STAGING_AUTHENTICATION_REQUIRED' });
      }
    }
  } finally { await anonymous.close(); }
});
