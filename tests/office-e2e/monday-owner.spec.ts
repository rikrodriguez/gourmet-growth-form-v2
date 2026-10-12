import { test as base, expect, type Page, type Route } from '@playwright/test';
import { MONDAY_CALLBACK_QUERY_REASONS, parseMondayOAuthReturn } from '../../src/office/monday-oauth-return';
import { getMondayBoardCapabilities } from '../../src/office/monday-board-catalog';
import type { MondayColumnAllowlist } from '../../src/office/backend/monday-read';

type MockResponse = { status?: number; body: unknown };
type MockHandler = (route: Route) => MockResponse | undefined | Promise<MockResponse | undefined>;
type MondayHarness = {
  calls: Array<{ method: string; path: string }>;
  respond: (method: string, path: string, handler: MockResponse | MockHandler) => void;
};

const api = '/office-api/monday';
const boardIds = ['18403945258', '18411103560', '18398057136', '18396813878', '18377848804'];
const csrfToken = 'a'.repeat(64);
const readAt = '2026-10-11T12:00:00.000Z';
const expiresAt = '2099-10-11T12:00:00.000Z';
const ownerSession = { available: true, authenticated: true, principal: 'ricardo', csrfToken, expiresAt };
const fixtureMapping: MondayColumnAllowlist = { '18403945258': [
  { id: 'stage_fixture', field: 'stage', type: 'status' },
  { id: 'count_fixture', field: 'guest_count', type: 'numbers' },
], '18377848804': [{ id: 'amount_fixture', field: 'amount', type: 'numbers' }] };
type ConnectionState = 'disabled' | 'connected' | 'disconnected' | 'error' | 'expired';

function connection(state: ConnectionState = 'connected', code: string | null = null) {
  return {
    state, code, actorId: state === 'connected' ? '78158865' : null,
    accountId: null, accountVerified: false, configuredAccountId: '29907909',
    boardAccessVerified: state === 'connected', boardAccessReadAt: state === 'connected' ? readAt : null,
    scopes: state === 'connected' ? ['boards:read', 'updates:read', 'me:read'] : [],
    expiresAt: state === 'connected' ? expiresAt : null,
    connectedAt: state === 'connected' ? readAt : null,
    identityReadAt: state === 'connected' ? readAt : null,
    lastReadAt: null, updatedAt: readAt, pending: false, configured: true,
    allowedBoards: boardIds,
    boardCapabilities: getMondayBoardCapabilities(fixtureMapping, 'fixture-commercial-v1', true),
  };
}

function expectOwnerCsrf(route: Route) {
  expect(route.request().headers()['x-monday-owner-csrf'] === csrfToken, 'Owner mutation uses its session CSRF token').toBe(true);
}

// These browser fixtures never use OAuth, the Monday provider or the DEMO API.
// Request evidence deliberately excludes passwords, bodies and query values.
const test = base.extend<{ monday: MondayHarness }>({
  monday: [async ({ context, page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const responses = new Map<string, MockResponse | MockHandler>();
    const calls: MondayHarness['calls'] = [];
    const external: string[] = [];
    const unexpected: string[] = [];
    const runtimeErrors: string[] = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        external.push(`${request.method()} ${url.hostname}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (!url.pathname.startsWith('/office-api/')) {
        await route.continue();
        return;
      }
      const key = `${request.method()} ${url.pathname}`;
      calls.push({ method: request.method(), path: url.pathname });
      const handler = responses.get(key);
      if (!url.pathname.startsWith('/office-api/monday/') || !handler) {
        unexpected.push(key);
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected_test_route' }) });
        return;
      }
      const response = typeof handler === 'function' ? await handler(route) : handler;
      if (!response) return;
      await route.fulfill({ status: response.status ?? 200, contentType: 'application/json', body: response.status === 204 ? '' : JSON.stringify(response.body) });
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.hostname === new URL(origin).hostname && url.port === new URL(origin).port) socket.connectToServer();
      else { external.push(`WebSocket ${url.hostname}`); socket.close(); }
    });
    try {
      await use({ calls, respond(method, path, handler) { responses.set(`${method} ${path}`, handler); } });
    } finally {
      expect(external, 'Every owner-page browser request stays on the test loopback origin').toEqual([]);
      expect(unexpected, 'The owner page uses only its explicitly mocked Monday API').toEqual([]);
      expect(runtimeErrors, 'The owner page renders without runtime errors').toEqual([]);
    }
  }, { auto: true }],
});

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function expectNoPersistedPassword(page: Page, syntheticPassword: string) {
  const persisted = await page.evaluate(password => {
    const values = [document.cookie, ...Object.values(localStorage), ...Object.values(sessionStorage)];
    return values.some(value => String(value).includes(password));
  }, syntheticPassword);
  expect(persisted, 'The owner password never enters browser storage').toBe(false);
}

async function submitSyntheticOwner(page: Page, password: string) {
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await page.getByLabel('Usuario del propietario', { exact: true }).fill('synthetic_owner_fixture');
  await page.getByLabel('Contraseña del propietario', { exact: true }).fill(password);
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `${api}/owner/login` && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Entrar como propietario', exact: true }).click();
  return response;
}

async function expectOnePrivateLogin(page: Page, monday: MondayHarness, password: string) {
  expect(monday.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `${api}/owner/login` }]);
  await expect(page.getByLabel('Contraseña del propietario', { exact: true })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(password);
  await expect(page.locator('body')).not.toContainText(csrfToken);
  await expectNoPersistedPassword(page, password);
  await expectFits(page);
}

test('disabled Monday exposes no owner password or real-data requests', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: { available: false, authenticated: false } });
  await page.goto('/office/monday');
  await expect(page.getByRole('heading', { name: 'Monday · acceso del propietario', exact: true })).toBeVisible();
  await expect(page.getByText('Monday desactivado. La configuración y el consentimiento están pendientes.', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toHaveCount(0);
  expect(monday.calls.length).toBeGreaterThan(0);
  expect(monday.calls.every(call => call.method === 'GET' && call.path === `${api}/owner/session`)).toBe(true);
  await expectFits(page);
});

test('an unauthenticated owner gate rejects another user and clears its transient password', async ({ page, monday }) => {
  const syntheticPassword = 'synthetic-owner-browser-password-only-2026';
  monday.respond('GET', `${api}/owner/session`, { body: { available: true, authenticated: false } });
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, route => {
    expectOwnerCsrf(route);
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['password', 'username']);
    expect(payload.username === 'otro_propietario_fixture', 'Only the explicitly supplied username is submitted').toBe(true);
    expect(payload.password === syntheticPassword, 'Only the transient synthetic password is submitted').toBe(true);
    return { status: 403, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } };
  });
  await page.goto('/office/monday');
  const password = page.getByLabel('Contraseña del propietario', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeVisible();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toHaveCount(0);
  await page.getByLabel('Usuario del propietario', { exact: true }).fill('otro_propietario_fixture');
  await password.fill(syntheticPassword);
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `${api}/owner/login` && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Entrar como propietario', exact: true }).click();
  expect((await response).status()).toBe(403);
  await expect(page.getByRole('alert')).toHaveText('No se pudo confirmar el acceso del propietario. Vuelve a intentarlo.');
  await expect(page.getByTestId('monday-owner-login-diagnostic')).toHaveText('post=unconfirmed | stage=owner_login | http=403 | code=MONDAY_OWNER_UNAUTHORIZED');
  await expect(password).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeVisible();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  expect(monday.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `${api}/owner/login` }]);
  expect(monday.calls.every(call => call.path.startsWith(`${api}/owner/`))).toBe(true);
  expect(monday.calls.filter(call => call.method === 'GET' && call.path === `${api}/owner/login`)).toHaveLength(2);
  await expectNoPersistedPassword(page, syntheticPassword);
  await expectFits(page);
});

test('an owner CSRF rejection stays forbidden without retrying login or refreshing its challenge', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: { available: true, authenticated: false } });
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, { status: 403, body: { error: 'MONDAY_OWNER_CSRF_REQUIRED' } });
  await page.goto('/office/monday');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await page.getByLabel('Usuario del propietario', { exact: true }).fill('synthetic_owner_fixture');
  await page.getByLabel('Contraseña del propietario', { exact: true }).fill('SYNTHETIC_OWNER_PASSWORD_FOR_CSRF_TEST');
  await page.getByRole('button', { name: 'Entrar como propietario', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('El acceso del propietario o la acción fueron rechazados.');
  await expect(page.getByTestId('monday-owner-login-diagnostic')).toHaveText('post=unconfirmed | stage=owner_login | http=403 | code=MONDAY_OWNER_CSRF_REQUIRED');
  await expect(page.getByLabel('Contraseña del propietario', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  expect(monday.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `${api}/owner/login` }]);
  expect(monday.calls.filter(call => call.method === 'GET' && call.path === `${api}/owner/login`)).toHaveLength(1);
});

test('an accepted owner POST identifies an unconfirmed owner session instead of silently showing the form', async ({ page, monday }) => {
  const password = 'SYNTHETIC_ACCEPTED_OWNER_PASSWORD_ONLY';
  monday.respond('GET', `${api}/owner/session`, { body: { available: true, authenticated: false } });
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, route => {
    expectOwnerCsrf(route);
    return { body: { principal: 'ricardo', csrfToken, expiresAt } };
  });
  await page.goto('/office/monday');
  expect((await submitSyntheticOwner(page, password)).status()).toBe(200);
  await expect(page.getByTestId('monday-owner-login-diagnostic')).toHaveText('post=accepted | stage=owner_session | http=200 | code=OWNER_SESSION_NOT_CONFIRMED');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  expect(monday.calls.every(call => call.path.startsWith(`${api}/owner/`))).toBe(true);
  await expectOnePrivateLogin(page, monday, password);
});

test('an accepted owner POST identifies a later status rejection while restoring the owner form', async ({ page, monday }) => {
  const password = 'SYNTHETIC_STATUS_REJECTION_PASSWORD_ONLY';
  let accepted = false; let statusRejected = false;
  monday.respond('GET', `${api}/owner/session`, () => ({ body: accepted && !statusRejected ? ownerSession : { available: true, authenticated: false } }));
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, route => {
    expectOwnerCsrf(route); accepted = true;
    return { body: { principal: 'ricardo', csrfToken, expiresAt } };
  });
  monday.respond('GET', `${api}/status`, () => {
    statusRejected = true;
    return { status: 403, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } };
  });
  await page.goto('/office/monday');
  expect((await submitSyntheticOwner(page, password)).status()).toBe(200);
  await expect(page.getByTestId('monday-owner-login-diagnostic')).toHaveText('post=accepted | stage=monday_status | http=403 | code=MONDAY_OWNER_UNAUTHORIZED');
  await expect(page.getByRole('alert')).toHaveText('No se pudo confirmar el acceso del propietario. Vuelve a intentarlo.');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  expect(monday.calls.filter(call => call.method === 'GET' && call.path === `${api}/status`)).toHaveLength(1);
  await expectOnePrivateLogin(page, monday, password);
});

for (const malformed of [false, true]) test(`owner diagnostics discard ${malformed ? 'extra private response fields' : 'unknown response codes'}`, async ({ page, monday }) => {
  const password = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_PASSWORD_ONLY';
  const marker = 'SYNTHETIC_PRIVATE_RESPONSE_MUST_NOT_APPEAR';
  monday.respond('GET', `${api}/owner/session`, { body: { available: true, authenticated: false } });
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, { status: 403, body: malformed
    ? { error: 'MONDAY_OWNER_UNAUTHORIZED', value: marker, cookie: marker, password: marker }
    : { error: marker } });
  await page.goto('/office/monday');
  expect((await submitSyntheticOwner(page, password)).status()).toBe(403);
  await expect(page.getByTestId('monday-owner-login-diagnostic')).toHaveText('post=unconfirmed | stage=owner_login | http=403 | code=HTTP_FORBIDDEN');
  await expect(page.getByRole('alert')).toHaveText('El acceso del propietario o la acción fueron rechazados.');
  await expect(page.locator('body')).not.toContainText(marker);
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  await expectOnePrivateLogin(page, monday, password);
});

test('the authorized Info integration shows only confirmed state and bounded readings', async ({ page, monday }, testInfo) => {
  let authenticated = true;
  let confirmed = connection();
  monday.respond('GET', `${api}/owner/session`, () => ({ body: authenticated ? ownerSession : { available: true, authenticated: false } }));
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('GET', `${api}/status`, () => ({ body: confirmed }));
  monday.respond('POST', `${api}/read-board`, route => {
    expectOwnerCsrf(route);
    expect(route.request().postDataJSON()).toEqual({ boardId: boardIds[0] });
    return { body: {
      status: 'partial', boardId: boardIds[0], mappingVersion: 'fixture-commercial-v1', readAt, pages: 4, reason: 'page_limit',
      paging: { nextBatch: null, expiresAt: null, pagesRead: 4, itemsRead: 1 },
      items: [{ id: '990001', boardId: boardIds[0], sourceUpdatedAt: readAt, readAt, columns: [
        { id: 'stage_fixture', field: 'stage', type: 'status', text: 'Confirmado', redacted: false },
        { id: 'count_fixture', field: 'guest_count', type: 'numbers', text: '10', redacted: false },
      ] }],
    } };
  });
  monday.respond('POST', `${api}/read-updates`, route => {
    expectOwnerCsrf(route);
    expect(route.request().postDataJSON()).toEqual({ boardId: boardIds[0] });
    return { body: { status: 'complete', boardId: boardIds[0], mappingVersion: 'fixture-commercial-v1', readAt, pages: 1, paging: { nextBatch: null, expiresAt: null, pagesRead: 1, itemsRead: 1 }, items: [
      { id: '990001', boardId: boardIds[0], sourceUpdatedAt: readAt, readAt, updates: [
        { id: '990002', createdAt: readAt, sourceUpdatedAt: readAt, readAt },
      ] },
    ] } };
  });
  monday.respond('POST', `${api}/refresh`, route => { expectOwnerCsrf(route); confirmed = connection(); return { body: {} }; });
  monday.respond('POST', `${api}/disconnect`, route => { expectOwnerCsrf(route); confirmed = connection('disconnected'); return { body: {} }; });
  monday.respond('POST', `${api}/oauth/start`, route => {
    expectOwnerCsrf(route);
    return { body: { authorizationUrl: 'https://untrusted.invalid/oauth2/authorize', expiresAt } };
  });
  monday.respond('POST', `${api}/owner/logout`, route => { expectOwnerCsrf(route); authenticated = false; return { status: 204, body: null }; });
  await page.goto('/office/monday/');
  await expect(page.getByText('Acceso de integración autorizado por Ricardo · identidad Info.', { exact: true })).toBeVisible();
  const state = page.getByTestId('monday-connection-state');
  await expect(state).toHaveText('Conectado');
  await expect(page.getByText('29907909 · Sin verificar por OAuth', { exact: true })).toBeVisible();
  await expect(page.getByText('Sin cuenta acreditada', { exact: true })).toBeVisible();
  await expect(page.getByText('78158865', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tablero autorizado', { exact: true }).locator('option')).toHaveCount(5);
  await expectFits(page);
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  const result = page.getByTestId('monday-reading');
  await expect(result).toContainText('Lectura parcial');
  await expect(result).toContainText('4 páginas');
  await expect(result).toContainText('page_limit');
  await expect(result).toContainText('Confirmado');
  await expect(result).toContainText('fixture-commercial-v1');
  await expectFits(page);
  await page.getByRole('button', { name: 'Leer actualizaciones', exact: true }).click();
  await expect(result).toContainText('Metadatos de actualizaciones');
  await expect(result).toContainText('Actualización 990002');
  await expect(result).not.toContainText('Confirmado');
  await expectFits(page);
  confirmed = connection('error', 'read_unavailable');
  await page.getByRole('button', { name: 'Actualizar estado', exact: true }).click();
  await expect(state).toHaveText('Error de conexión');
  await expect(result).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  confirmed = connection('expired', 'expired');
  await page.getByRole('button', { name: 'Actualizar estado', exact: true }).click();
  await expect(state).toHaveText('Conexión expirada');
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Renovar conexión', exact: true }).click();
  await expect(state).toHaveText('Conectado');
  await page.getByRole('button', { name: 'Desconectar Monday', exact: true }).click();
  await expect(state).toHaveText('Desconectado');
  await page.getByRole('button', { name: 'Conectar Monday', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('La respuesta no cumple el contrato de Monday');
  expect(new URL(page.url()).pathname).toBe('/office/monday/');
  await expect(state).toHaveText('Desconectado');
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath('monday-owner-synthetic.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cerrar sesión del propietario', exact: true }).click();
  await expect(page.getByLabel('Contraseña del propietario', { exact: true })).toBeVisible();
  await expect(state).toHaveCount(0);
  await expect(result).toHaveCount(0);
  expect(monday.calls.filter(call => call.path === `${api}/read-board`)).toHaveLength(1);
  expect(monday.calls.filter(call => call.path === `${api}/read-updates`)).toHaveLength(1);
});

function syntheticCallbackOwner(monday: MondayHarness, confirmed: ReturnType<typeof connection>) {
  let authenticated = false;
  monday.respond('GET', `${api}/owner/session`, () => ({ body: authenticated ? ownerSession : { available: true, authenticated: false } }));
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('POST', `${api}/owner/login`, route => {
    expectOwnerCsrf(route);
    authenticated = true;
    return { body: { principal: 'ricardo', csrfToken, expiresAt } };
  });
  monday.respond('GET', `${api}/status`, { body: confirmed });
}

async function expectPrivateCallbackLogin(page: Page, monday: MondayHarness, password: string) {
  expect(monday.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `${api}/owner/login` }]);
  await expect(page.getByLabel('Contraseña del propietario', { exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(password);
  await expect(page.locator('body')).not.toContainText(csrfToken);
  await expectNoPersistedPassword(page, password);
  await expectFits(page);
}

test('callback phase marker remains informational after synthetic owner login', async ({ page, monday }) => {
  const password = 'SYNTHETIC_CALLBACK_OWNER_PASSWORD_ONLY';
  syntheticCallbackOwner(monday, { ...connection('disconnected'), pending: true });
  await page.goto('/office/monday?oauth=error&stage=token_response&reason=scope_mismatch');
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveCount(0);
  await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
  expect((await submitSyntheticOwner(page, password)).status()).toBe(200);
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
  await expect(page.getByText('Operación de integración pendiente. Consulta el estado guardado.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  const marker = page.getByTestId('monday-oauth-return-diagnostic');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveText('Diagnóstico del retorno OAuth anterior (informativo). stage=token_response | code=scope_mismatch Actualizar estado consulta el estado guardado de la conexión.');
  await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  expect(monday.calls.filter(call => call.path === `${api}/status`).length).toBeGreaterThan(0);
  await expectPrivateCallbackLogin(page, monday, password);
});

test('a valid callback error marker keeps the connection confirmed by the API', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, { body: connection() });
  await page.goto('/office/monday?oauth=error&stage=token_response&reason=scope_mismatch');
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Conectado');
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveText('Diagnóstico del retorno OAuth anterior (informativo). stage=token_response | code=scope_mismatch Actualizar estado consulta el estado guardado de la conexión.');
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/status`].includes(call.path))).toBe(true);
  await expectFits(page);
});

test('closed callback query reasons render informational markers without granting connection or data access', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, { body: { ...connection('disconnected'), pending: true } });
  expect(MONDAY_CALLBACK_QUERY_REASONS).toEqual([
    'query_duplicate_state', 'query_duplicate_code', 'query_duplicate_error',
    'query_duplicate_status', 'query_duplicate_description', 'query_duplicate_scope',
    'query_scope_too_long', 'query_scope_control', 'query_description_too_long',
    'query_state_missing', 'query_state_empty',
  ]);
  for (const reason of MONDAY_CALLBACK_QUERY_REASONS) {
    await test.step(reason, async () => {
      const search = `?oauth=error&stage=callback_query&reason=${reason}`;
      expect(parseMondayOAuthReturn(search)).toEqual({ stage: 'callback_query', reason });
      const callsBefore = monday.calls.length;
      await page.goto(`/office/monday${search}`);
      await expect(page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
      await expect(page.getByRole('button', { name: 'Conectar Monday', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
      await expect(page.getByTestId('monday-reading')).toHaveCount(0);
      await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
      const calls = monday.calls.slice(callsBefore);
      expect(calls).toContainEqual({ method: 'GET', path: `${api}/owner/session` });
      expect(calls).toContainEqual({ method: 'GET', path: `${api}/status` });
      expect(calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/status`].includes(call.path))).toBe(true);
      const marker = page.getByTestId('monday-oauth-return-diagnostic');
      await expect(marker).toContainText('Diagnóstico del retorno OAuth anterior (informativo).');
      await expect(marker.locator('code')).toHaveText(`stage=callback_query | code=${reason}`);
      await expectFits(page);
    });
  }
});

const callbackPendingCaption = /(?:Consentimiento|Operación de integración) pendiente\./;

test('a successful explicit stored-status refresh preserves a clearly historical callback diagnostic', async ({ page, monday }, testInfo) => {
  let refreshed = false;
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, () => ({ body: {
    ...connection('error', 'oauth_state_invalid'), pending: !refreshed,
  } }));
  await page.goto('/office/monday?oauth=error&stage=callback_query&reason=oauth_state_invalid');
  const marker = page.getByTestId('monday-oauth-return-diagnostic');
  await expect(marker).toContainText('stage=callback_query | code=oauth_state_invalid');
  await expect(page.getByText(callbackPendingCaption)).toBeVisible();
  await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: 'Actualizar estado', exact: true });
  await expect(refresh).toBeEnabled();
  refreshed = true;
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `${api}/status` && item.request().method() === 'GET');
  await refresh.click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText(callbackPendingCaption)).toHaveCount(0);
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Error de conexión');
  await expect(page.getByText('Código del servicio: oauth_state_invalid', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conectar Monday', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await expect(marker).toContainText('stage=callback_query | code=oauth_state_invalid');
  expect(new URL(page.url()).searchParams.get('stage')).toBe('callback_query');
  expect(new URL(page.url()).searchParams.get('reason')).toBe('oauth_state_invalid');
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/status`].includes(call.path))).toBe(true);
  await testInfo.attach('stored-status-refresh-observation', { contentType: 'application/json', body: JSON.stringify({
    synthetic: true, statusHttp: 200, connectionState: 'error', connectionCode: 'oauth_state_invalid', pending: false,
    callbackMarkerVisible: await marker.isVisible(), callbackStage: 'callback_query', callbackCode: 'oauth_state_invalid', queryMarkerPreserved: true,
    boardReadEnabled: false, statusFeedbackVisible: await page.getByTestId('monday-status-update-result').isVisible(), externalRequests: 0,
  }) });
  await expect(page.getByTestId('monday-status-update-result')).toHaveText(/^Estado guardado consultado: .+ UTC$/);
  await expect(marker).toContainText('Diagnóstico del retorno OAuth anterior (informativo).');
  await expect(page.locator('body')).toContainText('Actualizar estado consulta el estado guardado de la conexión.');
  await expectFits(page);
});

test('a failed explicit stored-status refresh preserves the snapshot, service error and historical callback diagnostic', async ({ page, monday }, testInfo) => {
  let failStatus = false;
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, () => failStatus
    ? { status: 503, body: { error: 'storage_unavailable' } }
    : { body: { ...connection('error', 'oauth_state_invalid'), pending: true } });
  await page.goto('/office/monday?oauth=error&stage=callback_query&reason=oauth_state_invalid');
  const marker = page.getByTestId('monday-oauth-return-diagnostic');
  await expect(marker).toContainText('stage=callback_query | code=oauth_state_invalid');
  await expect(page.getByText(callbackPendingCaption)).toBeVisible();
  await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: 'Actualizar estado', exact: true });
  await expect(refresh).toBeEnabled();
  failStatus = true;
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `${api}/status` && item.request().method() === 'GET');
  await refresh.click();
  expect((await response).status()).toBe(503);
  await expect(page.getByRole('alert')).toHaveText('Monday no está disponible para esta acción. La configuración o el consentimiento siguen pendientes.');
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Error de conexión');
  await expect(page.getByText('Código del servicio: oauth_state_invalid', { exact: true })).toBeVisible();
  await expect(page.getByText(callbackPendingCaption)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conectar Monday', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(marker).toContainText('stage=callback_query | code=oauth_state_invalid');
  expect(new URL(page.url()).searchParams.get('stage')).toBe('callback_query');
  expect(new URL(page.url()).searchParams.get('reason')).toBe('oauth_state_invalid');
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/status`].includes(call.path))).toBe(true);
  await testInfo.attach('stored-status-refresh-observation', { contentType: 'application/json', body: JSON.stringify({
    synthetic: true, statusHttp: 503, connectionState: 'error', connectionCode: 'oauth_state_invalid', pending: true,
    callbackMarkerVisible: await marker.isVisible(), callbackStage: 'callback_query', callbackCode: 'oauth_state_invalid', queryMarkerPreserved: true,
    boardReadEnabled: false, refreshErrorVisible: true, statusFeedbackVisible: await page.getByTestId('monday-status-update-result').isVisible(), externalRequests: 0,
  }) });
  await expect(page.getByTestId('monday-status-update-result')).toHaveText('La consulta del estado guardado no se confirmó.');
  await expect(page.getByTestId('monday-status-update-result')).not.toContainText('Estado guardado consultado:');
  await expect(marker).toContainText('Diagnóstico del retorno OAuth anterior (informativo).');
  await expect(page.locator('body')).toContainText('Actualizar estado consulta el estado guardado de la conexión.');
  await expect(page.getByText('Operación de integración pendiente. Consulta el estado guardado.', { exact: true })).toBeVisible();
  await expectFits(page);
});

test('an explicit stored-status refresh cannot confirm consultation after owner authentication is lost', async ({ page, monday }, testInfo) => {
  let authenticated = true;
  monday.respond('GET', `${api}/owner/session`, () => ({ body: authenticated ? ownerSession : { available: true, authenticated: false } }));
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  monday.respond('GET', `${api}/status`, { body: { ...connection('error', 'oauth_state_invalid'), pending: true } });
  await page.goto('/office/monday?oauth=error&stage=callback_query&reason=oauth_state_invalid');
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toContainText('stage=callback_query | code=oauth_state_invalid');
  await expect(page.getByTestId('monday-status-update-result')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: 'Actualizar estado', exact: true });
  await expect(refresh).toBeEnabled();
  const statusCallsBefore = monday.calls.filter(call => call.path === `${api}/status`).length;
  authenticated = false;
  await refresh.click();
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveCount(0);
  expect(monday.calls.filter(call => call.path === `${api}/status`).length).toBe(statusCallsBefore);
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/owner/login`, `${api}/status`].includes(call.path))).toBe(true);
  await testInfo.attach('stored-status-refresh-observation', { contentType: 'application/json', body: JSON.stringify({
    synthetic: true, ownerAuthenticated: false, statusRequestsAdded: 0, connectionControlsVisible: false,
    statusFeedbackVisible: await page.getByTestId('monday-status-update-result').isVisible(), externalRequests: 0,
  }) });
  await expect(page.getByTestId('monday-status-update-result')).toHaveText('La consulta del estado guardado no se confirmó.');
  await expect(page.getByTestId('monday-status-update-result')).not.toContainText('Estado guardado consultado:');
  await expectFits(page);
});

test('a forged callback complete marker grants neither owner session nor data access', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: { available: true, authenticated: false } });
  monday.respond('GET', `${api}/owner/login`, { body: { csrfToken, expiresAt } });
  await page.goto('/office/monday?oauth=complete');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveCount(0);
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/owner/login`].includes(call.path))).toBe(true);
  await expectFits(page);
});

test('a forged callback complete marker cannot connect an authenticated disconnected owner', async ({ page, monday }) => {
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, { body: connection('disconnected') });
  await page.goto('/office/monday?oauth=complete');
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
  await expect(page.getByRole('button', { name: 'Conectar Monday', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveCount(0);
  expect(monday.calls.every(call => call.method === 'GET' && [`${api}/owner/session`, `${api}/status`].includes(call.path))).toBe(true);
  await expectFits(page);
});

const callbackRawSentinel = 'SYNTHETIC_PRIVATE_CALLBACK_QUERY_MUST_NOT_APPEAR';
const invalidCallbackMarkers = [
  { name: 'unknown stage', query: `oauth=error&stage=${callbackRawSentinel}&reason=scope_mismatch` },
  { name: 'unknown reason', query: `oauth=error&stage=token_response&reason=${callbackRawSentinel}` },
  { name: 'unknown outcome', query: `oauth=${callbackRawSentinel}&stage=token_response&reason=scope_mismatch` },
  { name: 'case-altered stage', query: 'oauth=error&stage=TOKEN_RESPONSE&reason=scope_mismatch' },
  { name: 'case-altered reason', query: 'oauth=error&stage=token_response&reason=SCOPE_MISMATCH' },
  { name: 'padded enum', query: 'oauth=error&stage=token_response%20&reason=scope_mismatch' },
  { name: 'padded reason', query: 'oauth=error&stage=token_response&reason=scope_mismatch%20' },
  { name: 'missing stage', query: 'oauth=error&reason=scope_mismatch' },
  { name: 'missing reason', query: 'oauth=error&stage=token_response' },
  { name: 'missing outcome', query: 'stage=token_response&reason=scope_mismatch' },
  { name: 'duplicate outcome', query: 'oauth=error&oauth=error&stage=token_response&reason=scope_mismatch' },
  { name: 'duplicate stage', query: 'oauth=error&stage=token_response&stage=token_response&reason=scope_mismatch' },
  { name: 'duplicate reason', query: 'oauth=error&stage=token_response&reason=scope_mismatch&reason=scope_mismatch' },
  { name: 'encoded duplicate key', query: 'oauth=error&%6fauth=error&stage=token_response&reason=scope_mismatch' },
  { name: 'extra query field', query: `oauth=error&stage=token_response&reason=scope_mismatch&token=${callbackRawSentinel}` },
  { name: 'raw provider description', query: `oauth=error&stage=token_response&reason=scope_mismatch&error_description=${callbackRawSentinel}` },
  { name: 'complete with error fields', query: 'oauth=complete&stage=token_response&reason=scope_mismatch' },
] as const;

for (const invalid of invalidCallbackMarkers) test(`callback marker ignores ${invalid.name} without blocking owner login or status`, async ({ page, monday }) => {
  const password = 'SYNTHETIC_INVALID_CALLBACK_OWNER_PASSWORD_ONLY';
  syntheticCallbackOwner(monday, connection('disconnected'));
  await page.goto(`/office/monday?${invalid.query}`);
  expect((await submitSyntheticOwner(page, password)).status()).toBe(200);
  await expect(page.getByTestId('monday-connection-state')).toHaveText('Desconectado');
  await expect(page.getByRole('button', { name: 'Conectar Monday', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-oauth-return-diagnostic')).toHaveCount(0);
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  expect(await page.evaluate(marker => document.documentElement.outerHTML.includes(marker), callbackRawSentinel), 'Raw callback input never enters the DOM').toBe(false);
  expect(monday.calls.filter(call => call.path === `${api}/status`).length).toBeGreaterThan(0);
  await expectPrivateCallbackLogin(page, monday, password);
});

const continuationOne = 'A'.repeat(43);
const continuationTwo = 'B'.repeat(42) + 'A';
const fixtureNow = new Date('2026-10-12T04:00:00.000Z');
const checkpointExpiresAt = '2026-10-12T04:05:00.000Z';
function commercialItem(id: string, stage: string | null = 'Conversion', redacted = false) {
  return { id, boardId: boardIds[0], sourceUpdatedAt: readAt, readAt, columns: [
    { id: 'stage_fixture', field: 'stage', type: 'status', text: stage, redacted },
    { id: 'count_fixture', field: 'guest_count', type: 'numbers', text: '10', redacted: false },
  ] };
}
function batch(overrides: Record<string, unknown> = {}) {
  return { status: 'partial', boardId: boardIds[0], mappingVersion: 'fixture-commercial-v1', readAt, pages: 4, reason: 'page_limit',
    items: [commercialItem('990010')], paging: { nextBatch: continuationOne, expiresAt: checkpointExpiresAt, pagesRead: 4, itemsRead: 1 }, ...overrides };
}
function confirmedOwner(monday: MondayHarness, value: unknown = connection()) {
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, { body: value });
}

test('board capabilities name all five boards and independently gate commercial and updates reads', async ({ page, monday }) => {
  confirmedOwner(monday);
  await page.goto('/office/monday');
  const select = page.getByLabel('Tablero autorizado', { exact: true });
  await expect(select.locator('option')).toHaveText([
    'Lead Management · 18403945258', 'Deals · 18411103560', 'Catering Funnel · 18398057136',
    'Catering Form · 18396813878', 'Quotes & Invoices · 18377848804',
  ]);
  await expect(page.getByText('Renovación automática desactivada. La renovación disponible es manual.', { exact: true })).toBeVisible();
  await select.selectOption(boardIds[1]);
  await expect(select).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-board-capability')).toContainText('forbidden_board');
  await select.selectOption(boardIds[2]);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeEnabled();
  await expect(page.getByTestId('monday-board-capability')).toContainText('columns_unconfigured');
  await select.selectOption(boardIds[4]);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeEnabled();
  expect(monday.calls.every(call => call.method === 'GET')).toBe(true);
  await expectFits(page);
});

test('commercial availability distinguishes empty, redacted and not queried without inferring payments', async ({ page, monday }) => {
  confirmedOwner(monday);
  monday.respond('POST', `${api}/read-board`, { body: batch({ status: 'complete', reason: undefined, pages: 1,
    items: [commercialItem('990010', null), commercialItem('990011', null, true), commercialItem('990012')],
    paging: { nextBatch: null, expiresAt: null, pagesRead: 1, itemsRead: 3 } }) });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  const reading = page.getByTestId('monday-reading');
  await expect(reading).toContainText('Sin valor confirmado');
  await expect(reading).toContainText('Oculto por privacidad');
  await expect(reading).toContainText('No consultado');
  await expect(reading).toContainText('Total del tablero: desconocido');
  await expect(reading).toContainText('no acreditan pago, cierre, envío ni documentos');
  await expect(reading).toContainText('Fuente: Monday · Tablero 18403945258');
  await expect(reading.locator('article')).toHaveCount(3);
  await expect(reading.locator('article').first().locator('dt')).toHaveText(['Etapa', 'Tipo de evento', 'Personas', 'Fecha del evento', 'Servicio', 'Importe', 'Estado de cotización']);
  await expectFits(page);
});

test('continuation requires one explicit action and accumulates bounded provenance without exposing the handle', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  let reads = 0;
  monday.respond('POST', `${api}/read-board`, route => {
    expectOwnerCsrf(route); reads++;
    expect(route.request().postDataJSON()).toEqual(reads === 1 ? { boardId: boardIds[0] } : { boardId: boardIds[0], continuation: continuationOne });
    return { body: reads === 1 ? batch() : batch({ status: 'complete', reason: undefined, pages: 1,
      items: [commercialItem('990011')], paging: { nextBatch: null, expiresAt: null, pagesRead: 5, itemsRead: 2 } }) };
  });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  const reading = page.getByTestId('monday-reading');
  await expect(reading.locator('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeEnabled();
  await page.clock.fastForward(1000);
  expect(reads).toBe(1);
  await expect(page.locator('body')).not.toContainText(continuationOne);
  await page.getByRole('button', { name: 'Continuar lectura', exact: true }).click();
  await expect(reading.locator('article')).toHaveCount(2);
  await expect(reading).toContainText('2 ítems · 5 páginas');
  await expect(reading).toContainText('Total del tablero: desconocido');
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toHaveCount(0);
  expect(reads).toBe(2);
  await expectFits(page);
});

test('a rate limit preserves confirmed items and enforces the explicit wait on the rotated continuation', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  let reads = 0;
  monday.respond('POST', `${api}/read-board`, route => {
    expectOwnerCsrf(route); reads++;
    return { body: reads === 1 ? batch() : batch({ status: 'blocked', reason: 'rate_limited', pages: 0, items: [], retryAfterSeconds: 60,
      paging: { nextBatch: continuationTwo, expiresAt: checkpointExpiresAt, pagesRead: 4, itemsRead: 1 } }) };
  });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar lectura', exact: true }).click();
  const reading = page.getByTestId('monday-reading');
  await expect(reading.locator('article')).toHaveCount(1);
  await expect(reading).toContainText('rate_limited');
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-continuation-state')).toContainText('Espera');
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeEnabled();
  expect(reads).toBe(2);
  await expectFits(page);
});

test('a first-page rate limit without a checkpoint holds the wait across board selection', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  monday.respond('POST', `${api}/read-board`, { body: batch({ status: 'blocked', reason: 'rate_limited', pages: 0, items: [], retryAfterSeconds: 60,
    paging: { nextBatch: null, expiresAt: null, pagesRead: 0, itemsRead: 0 } }) });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await expect(page.getByTestId('monday-reading')).toContainText('Leído: Sin lectura confirmada');
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await page.getByLabel('Tablero autorizado', { exact: true }).selectOption(boardIds[4]);
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-provider-wait')).toContainText('Espera');
  await page.getByRole('button', { name: 'Actualizar estado', exact: true }).click();
  await expect(page.getByTestId('monday-status-update-result')).toHaveText(/^Estado guardado consultado: .+ UTC$/);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('button', { name: 'Leer tablero', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Leer actualizaciones', exact: true })).toBeEnabled();
  expect(monday.calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

test('a server cooldown rejection preserves the unconsumed continuation handle', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  let reads = 0;
  monday.respond('POST', `${api}/read-board`, route => {
    expectOwnerCsrf(route); reads++;
    return { body: reads === 1 ? batch() : batch({ status: 'blocked', reason: 'rate_limited', pages: 0, items: [], retryAfterSeconds: 60,
      paging: { nextBatch: continuationOne, expiresAt: checkpointExpiresAt, pagesRead: 4, itemsRead: 1 } }) };
  });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar lectura', exact: true }).click();
  await expect(page.getByTestId('monday-reading').locator('article')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeEnabled();
  expect(reads).toBe(2);
});

test('an unconfirmed continuation keeps prior items and stops replaying its uncertain handle', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  monday.respond('POST', `${api}/read-board`, { body: batch() });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  monday.respond('POST', `${api}/read-board`, async route => { await route.abort('failed'); });
  await page.getByRole('button', { name: 'Continuar lectura', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No se pudo confirmar');
  await expect(page.getByTestId('monday-reading').locator('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toHaveCount(0);
});

test('a checkpoint expires locally and selection clears its continuation without an automatic request', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  monday.respond('POST', `${api}/read-board`, { body: batch() });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await page.clock.fastForward(300_001);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toBeDisabled();
  await expect(page.getByTestId('monday-continuation-state')).toContainText('Continuación expirada');
  expect(monday.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await page.getByLabel('Tablero autorizado', { exact: true }).selectOption(boardIds[2]);
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toHaveCount(0);
});

for (const mismatch of ['mapping', 'grant'] as const) test(`a changed ${mismatch} after the batch prevents mixed readings`, async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  let reads = 0;
  const initial = connection();
  const changed = mismatch === 'grant' ? { ...initial, connectedAt: '2026-10-12T04:00:01.000Z' }
    : { ...initial, boardCapabilities: getMondayBoardCapabilities(fixtureMapping, 'fixture-commercial-v2', true) };
  monday.respond('GET', `${api}/owner/session`, { body: ownerSession });
  monday.respond('GET', `${api}/status`, () => ({ body: reads ? changed : initial }));
  monday.respond('POST', `${api}/read-board`, () => { reads++; return { body: batch() }; });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toHaveCount(0);
});

const malformedBatches = [
  { name: 'different mapping', value: () => batch({ mappingVersion: 'other-map' }) },
  { name: 'unmapped column', value: () => batch({ items: [{ ...commercialItem('990010'), columns: [{ id: 'private_field', field: 'stage', type: 'status', text: 'Private', redacted: false }] }] }) },
  { name: 'duplicate items', value: () => batch({ items: [commercialItem('990010'), commercialItem('990010')] }) },
  { name: 'provider cursor', value: () => ({ ...batch(), cursor: 'SYNTHETIC_CURSOR_MUST_NOT_RENDER' }) },
  { name: 'over-budget journey', value: () => batch({ paging: { nextBatch: continuationOne, expiresAt: checkpointExpiresAt, pagesRead: 41, itemsRead: 1 } }) },
  { name: 'malformed handle', value: () => batch({ paging: { nextBatch: 'unsafe', expiresAt: checkpointExpiresAt, pagesRead: 4, itemsRead: 1 } }) },
] as const;
for (const malformed of malformedBatches) test(`read contract rejects ${malformed.name} before displaying data`, async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  monday.respond('POST', `${api}/read-board`, { body: malformed.value() });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('La respuesta no cumple el contrato de Monday');
  await expect(page.getByTestId('monday-reading')).toHaveCount(0);
});

test('a repeated item across continuation batches is rejected while retaining earlier verified data', async ({ page, monday }) => {
  await page.clock.install({ time: fixtureNow });
  confirmedOwner(monday);
  let reads = 0;
  monday.respond('POST', `${api}/read-board`, () => ({ body: ++reads === 1 ? batch() : batch({ pages: 1,
    paging: { nextBatch: continuationTwo, expiresAt: checkpointExpiresAt, pagesRead: 5, itemsRead: 2 } }) }));
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar lectura', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('La respuesta no cumple el contrato de Monday');
  await expect(page.getByTestId('monday-reading').locator('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continuar lectura', exact: true })).toHaveCount(0);
});

test('forged capabilities cannot enable Deals or display an unverified board name', async ({ page, monday }) => {
  const malformed = JSON.parse(JSON.stringify(connection()));
  malformed.boardCapabilities[1].commercialRead.enabled = true;
  malformed.boardCapabilities[1].commercialRead.reason = null;
  malformed.boardCapabilities[1].name = 'SYNTHETIC_UNVERIFIED_NAME_MUST_NOT_RENDER';
  confirmedOwner(monday, malformed);
  await page.goto('/office/monday');
  await expect(page.getByRole('alert')).toContainText('La respuesta no cumple el contrato de Monday');
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('SYNTHETIC_UNVERIFIED_NAME_MUST_NOT_RENDER');
  expect(monday.calls.every(call => call.method === 'GET')).toBe(true);
});

test('items preserve their confirmed page read time before the final batch timestamp', async ({ page, monday }) => {
  confirmedOwner(monday);
  const priorRead = '2026-10-11T11:59:58.000Z';
  monday.respond('POST', `${api}/read-board`, { body: batch({ status: 'complete', reason: undefined, pages: 2,
    items: [{ ...commercialItem('990010'), readAt: priorRead }, commercialItem('990011')],
    paging: { nextBatch: null, expiresAt: null, pagesRead: 2, itemsRead: 2 } }) });
  await page.goto('/office/monday');
  await page.getByRole('button', { name: 'Leer tablero', exact: true }).click();
  await expect(page.getByTestId('monday-reading').locator('article')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
