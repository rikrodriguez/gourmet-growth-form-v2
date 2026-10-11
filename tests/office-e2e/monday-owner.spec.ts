import { test as base, expect, type Page, type Route } from '@playwright/test';

type MockResponse = { status?: number; body: unknown };
type MockHandler = (route: Route) => MockResponse | Promise<MockResponse>;
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
    return { status: 401, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } };
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
  expect((await response).status()).toBe(401);
  await expect(password).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Entrar como propietario', exact: true })).toBeVisible();
  await expect(page.getByTestId('monday-connection-state')).toHaveCount(0);
  expect(monday.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `${api}/owner/login` }]);
  expect(monday.calls.every(call => call.path.startsWith(`${api}/owner/`))).toBe(true);
  await expectNoPersistedPassword(page, syntheticPassword);
  await expectFits(page);
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
      items: [{ id: '990001', boardId: boardIds[0], sourceUpdatedAt: readAt, readAt, columns: [
        { id: 'stage_fixture', field: 'stage', type: 'status', text: 'Confirmado', redacted: false },
        { id: 'count_fixture', field: 'guest_count', type: 'numbers', text: '10', redacted: false },
      ] }],
    } };
  });
  monday.respond('POST', `${api}/read-updates`, route => {
    expectOwnerCsrf(route);
    expect(route.request().postDataJSON()).toEqual({ boardId: boardIds[0] });
    return { body: { status: 'complete', boardId: boardIds[0], mappingVersion: 'fixture-commercial-v1', readAt, pages: 1, items: [
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
