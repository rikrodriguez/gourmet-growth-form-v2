import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createStagingOfficeApp } from '../../src/office/backend/staging-app';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { canonical } from '../../src/office/backend/state';
import type { OfficeState, OfficeStore } from '../../src/office/backend/state';
import type { OfficeSnapshot } from '../../src/office/contracts';

const ORIGIN = 'https://office.example.test';
// Public, deliberately nonsecret fixtures. No credentials are generated or
// stored, and the database settings below are parsed without opening a pool.
const TEST_ONLY_USERNAME = 'mock_user';
const TEST_ONLY_PASSWORD = 'TEST_ONLY_STAGING_AUTH_PASSWORD_000000';
const TEST_ONLY_DB_PASSWORD = 'TEST_ONLY_STAGING_DB_PASSWORD_00000000';
const TEST_ONLY_BASIC = `Basic ${Buffer.from(`${TEST_ONLY_USERNAME}:${TEST_ONLY_PASSWORD}`).toString('base64')}`;
const STATIC_ROOT = resolve(process.cwd(), 'dist-office');

// This transaction double is isolated per test. Browser checks cannot establish
// PostgreSQL persistence, container recovery or an actual staging deployment.
class SyntheticTestStore implements OfficeStore {
  state: OfficeState;
  constructor(nowMs: number) { this.state = createOfficeFixtureState(nowMs); }
  async snapshot() { return structuredClone(this.state); }
  async transact<T>(fn: (state: OfficeState) => T | Promise<T>) {
    const next = structuredClone(this.state);
    const result = await fn(next);
    this.state = next;
    return result;
  }
}

type Fixtures = {
  stagingRole: 'viewer' | 'operator';
  authenticated: boolean;
  gateway: { store: SyntheticTestStore; assetPath: string };
};

const test = base.extend<Fixtures>({
  stagingRole: ['viewer', { option: true }],
  authenticated: [true, { option: true }],
  gateway: [async ({ context, page, stagingRole, authenticated }, use) => {
    const nowMs = Date.now();
    const store = new SyntheticTestStore(nowMs);
    const runtime = parseOfficeStagingEnvironment({
      OFFICE_RUNTIME_MODE: 'staging',
      OFFICE_STAGING_ORIGIN: ORIGIN,
      OFFICE_STAGING_USERNAME: TEST_ONLY_USERNAME,
      OFFICE_STAGING_PASSWORD: TEST_ONLY_PASSWORD,
      OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      // Omit this field for viewer to exercise the fail-closed default.
      ...(stagingRole === 'operator' ? { OFFICE_STAGING_ROLE: 'operator' } : {}),
      OFFICE_STAGING_DB_HOST: 'office-db',
      OFFICE_STAGING_DB_PORT: '5432',
      OFFICE_STAGING_DB_USER: 'office_stage',
      OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo',
      OFFICE_STAGING_DB_PASSWORD: TEST_ONLY_DB_PASSWORD,
    });
    expect(runtime.access.role).toBe(stagingRole);
    const app = createStagingOfficeApp(runtime, store, { staticRoot: STATIC_ROOT, clock: () => nowMs });
    const html = readFileSync(resolve(STATIC_ROOT, 'index.html'), 'utf8');
    const assetPath = /<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
    expect(assetPath, 'office:build must produce an asset under /office/').toMatch(/^\/office\/assets\//);
    const externalRequests: string[] = [];
    const runtimeErrors: string[] = [];
    const injectionErrors: string[] = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await context.setExtraHTTPHeaders(authenticated ? { Authorization: TEST_ONLY_BASIC } : {});
    await app.ready();
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== ORIGIN) {
        externalRequests.push(`${request.method()} ${url.origin}`);
        return route.abort('blockedbyclient');
      }
      try {
        const headers = await request.allHeaders();
        delete headers['content-length'];
        const response = await app.inject({
          method: request.method() as 'GET' | 'HEAD' | 'POST' | 'DELETE' | 'OPTIONS',
          url: `${url.pathname}${url.search}`,
          headers: { ...headers, host: runtime.access.host, 'x-forwarded-proto': 'https' },
          remoteAddress: '127.0.0.1',
          payload: request.postDataBuffer() ?? undefined,
        });
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['content-length', 'transfer-encoding', 'connection'].includes(key)) {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
          }
        }
        await route.fulfill({ status: response.statusCode, headers: responseHeaders, body: response.rawPayload });
      } catch (error) {
        injectionErrors.push(error instanceof Error ? error.message : 'Fastify injection failed');
        await route.abort('failed');
      }
    });
    await context.routeWebSocket('**/*', socket => {
      externalRequests.push('Unexpected WebSocket');
      socket.close();
    });
    try { await use({ store, assetPath: assetPath! }); }
    finally {
      await app.close();
      expect(externalRequests, 'No request may reach another origin or WebSocket').toEqual([]);
      expect(runtimeErrors, 'Compiled UI must have no browser runtime error').toEqual([]);
      expect(injectionErrors, 'Browser requests must complete through Fastify inject').toEqual([]);
    }
  }, { auto: true }],
});

async function browserJson(page: Page, path: string, method = 'GET', body?: object) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, method, body });
}

async function assertNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal page overflow at the configured viewport').toBe(true);
}

function workspace(page: Page) {
  return page.getByRole('dialog', { name: 'Espacio de trabajo', exact: true });
}

async function closeWorkspace(page: Page) {
  if (!await workspace(page).isVisible()) return;
  await workspace(page).getByRole('button', { name: 'Cerrar espacio de trabajo', exact: true }).click();
  await expect(workspace(page)).not.toBeVisible();
  await page.waitForFunction(() => window.history.state?.officeDrawer !== true);
}

async function selectCase(page: Page, id: string) {
  await closeWorkspace(page);
  const menu = page.locator('details.office-session-menu');
  if (!await menu.evaluate(element => (element as HTMLDetailsElement).open)) {
    await menu.locator('summary').first().click();
  }
  await page.getByLabel('Caso de demostración').selectOption(id);
  await menu.locator('summary').first().click();
}

async function openFunction(page: Page, name: string) {
  if (!await workspace(page).isVisible()) {
    await page.getByRole('tab', { name: 'Mi oficina', exact: true }).click();
    await page.getByRole('button', { name: 'Nueva tarea', exact: true }).click();
  }
  const button = workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true }).getByRole('button', { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

function assertSynthetic(snapshot: OfficeSnapshot) {
  expect(snapshot).toMatchObject({ mode: 'demo', outboundEffects: 0, mondayWrites: 0 });
  expect(snapshot.cases).toHaveLength(3);
  for (const item of snapshot.cases) {
    expect(item.evidence.simulated).toBe(true);
    for (const row of [...item.tasks, ...item.results, ...item.approvals, ...item.messages, ...item.history]) {
      expect(row.evidence.simulated).toBe(true);
      expect(row.evidence.reference).toMatch(new RegExp(`^demo:${item.id}:`));
    }
  }
}

test.describe('private authentication boundary', () => {
  test.use({ authenticated: false });

  test('anonymous UI, API, compiled assets and health return 401', async ({ page, gateway }) => {
    const before = canonical(gateway.store.state);
    const response = await page.goto('/office/');
    expect(response?.status()).toBe(401);
    expect(await response?.json()).toEqual({ error: 'STAGING_AUTHENTICATION_REQUIRED' });
    for (const path of ['/office-api/health', '/office-api/session', '/office-api/snapshot', gateway.assetPath]) {
      const denied = await browserJson(page, path);
      expect(denied).toEqual({ status: 401, body: { error: 'STAGING_AUTHENTICATION_REQUIRED' } });
    }
    const session = await browserJson(page, '/office-api/session', 'POST', { role: 'operator' });
    expect(session).toEqual({ status: 401, body: { error: 'STAGING_AUTHENTICATION_REQUIRED' } });
    expect(canonical(gateway.store.state)).toBe(before);
    await expect(page.getByRole('heading', { name: 'Mi oficina', exact: true })).toHaveCount(0);
  });

  test('invalid authentication cannot open UI or create an operator session', async ({ page, context, gateway }) => {
    const before = canonical(gateway.store.state);
    await context.setExtraHTTPHeaders({ Authorization: 'Basic VEVTVF9PTkxZX0lOVkFMSUQ=' });
    const response = await page.goto('/office/');
    expect(response?.status()).toBe(401);
    const denied = await browserJson(page, '/office-api/session', 'POST', { role: 'operator' });
    expect(denied).toEqual({ status: 401, body: { error: 'STAGING_AUTHENTICATION_REQUIRED' } });
    expect(canonical(gateway.store.state)).toBe(before);
  });
});

test('compiled office loads approved art and isolates the task drawer at desktop and 320px', async ({ page }, testInfo) => {
  const desktop = !testInfo.project.name.includes('mobile');
  if (desktop) await page.setViewportSize({ width: 1586, height: 992 });
  const response = await page.goto('/office/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Mi oficina', exact: true })).toBeVisible();
  await expect(workspace(page)).not.toBeVisible();
  await expect(page.getByLabel('Contenido del borrador')).toHaveCount(0);
  const art = page.locator('img.office-scene-art');
  await expect(art).toBeVisible();
  await expect.poll(() => art.evaluate(image => {
    const element = image as HTMLImageElement;
    return { loaded: element.complete, width: element.naturalWidth, height: element.naturalHeight };
  })).toEqual({ loaded: true, width: 959, height: 799 });
  const chat = page.getByRole('region', { name: 'Coordinación', exact: true });
  await expect(chat).toBeVisible();
  await expect(page.getByLabel('Mensaje contextual')).toBeVisible();
  await expect(page.getByLabel('Mensaje contextual')).toBeDisabled();
  await assertNoPageOverflow(page);
  if (desktop) {
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), 'The approved desktop Office fits one page').toBe(true);
    const artBounds = await art.boundingBox();
    const chatBounds = await chat.boundingBox();
    expect(artBounds).not.toBeNull();
    expect(chatBounds).not.toBeNull();
    expect(artBounds!.width).toBeGreaterThan(850);
    expect(artBounds!.height).toBeGreaterThan(650);
    expect(chatBounds!.x).toBeGreaterThanOrEqual(artBounds!.x + artBounds!.width);
    expect(Math.abs(chatBounds!.y - artBounds!.y)).toBeLessThan(8);
    expect(Math.abs(chatBounds!.height - artBounds!.height)).toBeLessThan(8);
  }
  await page.screenshot({ path: testInfo.outputPath(`compiled-office-${desktop ? '1586x992' : '320px'}.png`), fullPage: true });
  const trigger = page.getByRole('button', { name: 'Nueva tarea', exact: true });
  await trigger.click();
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true }).getByRole('button')).toHaveCount(9);
  await expect(workspace(page).getByRole('heading', { name: 'Un caso, antes de empezar', exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await page.keyboard.press('Escape');
  await expect(workspace(page)).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('default viewer reads dashboard and history while every write stays blocked', async ({ page, gateway }) => {
  const before = canonical(gateway.store.state);
  const response = await page.goto('/office/');
  expect(response?.status()).toBe(200);
  await expect(page.getByLabel('Permiso de sesión')).toHaveValue('viewer');
  const escalation = await browserJson(page, '/office-api/session', 'POST', { role: 'operator' });
  expect(escalation).toEqual({ status: 403, body: { error: 'FORBIDDEN_STAGING_ROLE' } });
  const opened = page.waitForResponse(response => response.url().endsWith('/office-api/session') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Abrir sesión DEMO', exact: true }).click();
  const session = await opened;
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ mode: 'demo', actorId: 'OFFICE_DEMO_OPERATOR', role: 'viewer', outboundEffects: 0 });
  await expect(page.getByText('Sólo lectura · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  await selectCase(page, 'demo-aurora');
  await openFunction(page, 'Ventas');
  await expect(page.getByLabel('Hilo comercial simulado')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparar respuesta interna', exact: true })).toBeDisabled();
  await openFunction(page, 'Propuestas');
  await expect(page.getByLabel('Contenido del borrador')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preparar borrador', exact: false })).toBeDisabled();
  const card = workspace(page).getByTestId('office-approval-approval-demo-aurora-proposals-fixture');
  for (const name of ['Aprobar revisión 1', 'Rechazar revisión 1', 'Cancelar revisión 1', 'Editar revisión 1']) {
    await expect(card.getByRole('button', { name, exact: false })).toBeDisabled();
  }
  await assertNoPageOverflow(page);
  await closeWorkspace(page);
  await expect(page.getByLabel('Mensaje contextual')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Guardar pregunta', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Operaciones', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Una lectura con cobertura.' })).toBeVisible();
  await expect(page.getByText('Métricas derivadas de 3 casos confirmados por la API.', { exact: false })).toBeVisible();
  await assertNoPageOverflow(page);
  await page.getByRole('tab', { name: 'Historial', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cada decisión deja contexto.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lead sintético registrado', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cierre humano · fixture DEMO', exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await page.getByRole('tab', { name: /^Aprobaciones(?: \d+)?$/ }).click();
  const pendingReview = page.getByRole('tabpanel', { name: /^Aprobaciones(?: \d+)?$/ }).getByTestId('office-approval-approval-demo-aurora-proposals-fixture');
  await expect(pendingReview).toBeVisible();
  for (const name of ['Aprobar revisión 1', 'Rechazar revisión 1', 'Cancelar revisión 1', 'Editar revisión 1']) {
    await expect(pendingReview.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await assertNoPageOverflow(page);
  const denied = await browserJson(page, '/office-api/commands', 'POST', { idempotencyKey: 'test-only-viewer-write', caseId: 'demo-aurora', functionId: 'proposals', action: 'draft', text: 'TEST_ONLY borrador sintético' });
  expect(denied).toEqual({ status: 403, body: { error: 'FORBIDDEN_SCOPE' } });
  const snapshot = await browserJson(page, '/office-api/snapshot');
  expect(snapshot.status).toBe(200);
  assertSynthetic(snapshot.body as OfficeSnapshot);
  expect(canonical(gateway.store.state)).toBe(before);
});

test.describe('explicit operator capability', () => {
  test.use({ stagingRole: 'operator' });

  test('authenticated operator reviews a synthetic draft without outbound effects', async ({ page, gateway }) => {
    const response = await page.goto('/office/');
    expect(response?.status()).toBe(200);
    await expect(page.getByLabel('Permiso de sesión')).toBeVisible();
    await page.getByLabel('Permiso de sesión').selectOption('operator');
    await page.getByRole('button', { name: 'Abrir sesión DEMO', exact: true }).click();
    await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
    const session = await browserJson(page, '/office-api/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ mode: 'demo', actorId: 'OFFICE_DEMO_OPERATOR', role: 'operator', outboundEffects: 0 });
    await selectCase(page, 'demo-aurora');
    await openFunction(page, 'Propuestas');
    const text = 'TEST_ONLY — propuesta sintética para revisar en staging privado.';
    await page.getByLabel('Contenido del borrador').fill(text);
    await page.getByRole('button', { name: 'Preparar borrador', exact: false }).click();
    const card = workspace(page).locator('article[data-testid^="office-approval-"]').filter({ hasText: text });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('cliente-demo@invalid.test');
    await expect(card.locator('.digest code')).toHaveText(/^[a-f0-9]{64}$/);
    await card.getByRole('button', { name: 'Aprobar revisión 1', exact: true }).click();
    await expect(card).toContainText('Aprobado DEMO');
    await assertNoPageOverflow(page);
    const snapshot = await browserJson(page, '/office-api/snapshot');
    expect(snapshot.status).toBe(200);
    const state = snapshot.body as OfficeSnapshot;
    assertSynthetic(state);
    const item = state.cases.find(row => row.id === 'demo-aurora')!;
    expect(item).toMatchObject({ payment: 'verified', supplier: 'pending', saleClosed: true });
    expect(item.approvals.find(row => row.body.includes(text))).toMatchObject({ status: 'approved_demo' });
    expect(Object.keys(gateway.store.state.office.commands)).toHaveLength(2);
    expect(Object.values(gateway.store.state.office.commands).every(row => row.actorId === 'OFFICE_DEMO_OPERATOR')).toBe(true);
  });
});
