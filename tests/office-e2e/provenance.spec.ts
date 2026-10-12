import { test as base, expect, type Page, type Route } from '@playwright/test';
import type { BridgeBindingRevision, BridgeSourceVersion } from '../../src/office/canonical-bridge-contracts';

const readAt = '2026-10-12T06:00:00.000Z';
const stamp = Date.parse(readAt) - 10_000;
const hex = (n: number) => n.toString(16).padStart(64, '0');
const sourceVersion = (n: number, kind: BridgeSourceVersion['kind'], version = 'v1', entity = n): BridgeSourceVersion => ({
  id: `version-${hex(n)}`, entityId: `entity-${hex(entity)}`, kind,
  reference: { sourceSystem: 'fixture:canonical', boardId: `demo-${kind}`, itemId: `synthetic-${entity}` },
  sourceVersion: version, contentDigest: hex(100 + n),
  provenance: { evidenceRef: `fixture:evidence-${n}`, observedAtMs: stamp - 1000 },
  recordedAtMs: stamp, recordedBy: 'OFFICE_DEMO_OPERATOR',
});
const versions = [sourceVersion(1, 'lead'), sourceVersion(2, 'event'), sourceVersion(3, 'quote'), sourceVersion(4, 'quote', 'v2', 3), sourceVersion(5, 'invoice')];
const refs = { lead: versions[0].id, event: versions[1].id, quote: versions[2].id, invoice: versions[4].id };
const history: BridgeBindingRevision[] = [
  { bindingId: 'synthetic-chain', revision: 1, digest: hex(201), previousDigest: null, action: 'bind', refs, targetRevision: null, evidenceRef: 'fixture:explicit-binding', recordedAtMs: stamp, recordedBy: 'OFFICE_DEMO_OPERATOR' },
  { bindingId: 'synthetic-chain', revision: 2, digest: hex(202), previousDigest: hex(201), action: 'unlink', refs: null, targetRevision: null, evidenceRef: 'fixture:explicit-unlink', recordedAtMs: stamp + 1000, recordedBy: 'OFFICE_DEMO_OPERATOR' },
  { bindingId: 'synthetic-chain', revision: 3, digest: hex(203), previousDigest: hex(202), action: 'revert', refs, targetRevision: 1, evidenceRef: 'fixture:explicit-revert', recordedAtMs: stamp + 2000, recordedBy: 'OFFICE_DEMO_OPERATOR' },
];
const bridge = (overrides = {}) => ({ state: 'empty', partition: 'demo', storage: 'postgres', revision: 0, sourceVersions: [], bindings: [], importsEnabled: false, automaticLinking: false, metricsConsumed: false, coverage: 'complete', ...overrides });
const demo = (overrides = {}) => ({
  schemaVersion: 1, source: 'demo', synthetic: true, readAt,
  coverage: { caseIds: ['demo-aurora', 'demo-cedar', 'demo-harbor'], functionIds: ['sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent'] },
  officeEvidence: [{ caseId: 'demo-aurora', source: 'fixture:office-demo', reference: 'demo:demo-aurora:fixture-read', observedAt: readAt, simulated: true }],
  bridge: bridge(), ...overrides,
});
const monday = (overrides = {}) => ({
  schemaVersion: 1, source: 'monday', synthetic: false, readAt,
  connection: { state: 'connected', configured: true, boardAccessVerified: true, identityReadAt: readAt, lastReadAt: null, expiresAt: '2099-10-12T06:00:00.000Z' },
  bridge: bridge({ state: 'unconfigured', partition: 'external', storage: null, revision: null, coverage: 'not_queried' }), ...overrides,
});
type Response = { status?: number; body: unknown };
type Harness = { calls: Array<{ method: string; path: string }>; respond(path: string, response: Response): void };
const test = base.extend<{ provenance: Harness }>({
  provenance: [async ({ context, page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const responses = new Map<string, Response>();
    const calls: Harness['calls'] = [];
    const unexpected: string[] = [];
    const external: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { external.push(`${request.method()} ${url.hostname}`); await route.abort('blockedbyclient'); return; }
      if (!url.pathname.startsWith('/office-api/')) { await route.continue(); return; }
      calls.push({ method: request.method(), path: url.pathname });
      const response = responses.get(url.pathname);
      if (request.method() !== 'GET' || url.search || !response) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected_test_route' }) });
        return;
      }
      await route.fulfill({ status: response.status ?? 200, contentType: 'application/json', body: JSON.stringify(response.body) });
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.origin === origin.replace(/^http/, 'ws')) socket.connectToServer();
      else { external.push(`WebSocket ${url.hostname}`); socket.close(); }
    });
    try { await use({ calls, respond(path, response) { responses.set(path, response); } }); }
    finally {
      expect(unexpected, 'Read-only provenance never logs in, renews, imports or reads provider records').toEqual([]);
      expect(external, 'Synthetic browser tests never contact an external service').toEqual([]);
      expect(errors, 'Provenance renders without runtime errors').toEqual([]);
    }
  }, { auto: true }],
});
const demoPanel = (page: Page) => page.getByTestId('provenance-demo');
const mondayPanel = (page: Page) => page.getByTestId('provenance-monday');
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
function responses(harness: Harness, demoResponse: Response, mondayResponse: Response) {
  harness.respond('/office-api/provenance', demoResponse);
  harness.respond('/office-api/monday/provenance', mondayResponse);
}

test('missing sessions have independent access links and no credentials form or writes', async ({ page, provenance }) => {
  responses(provenance, { status: 401, body: { error: 'unauthorized' } }, { status: 401, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } });
  await page.goto('/office/provenance');
  await expect(page.getByRole('heading', { name: 'Procedencia de la oficina', exact: true })).toBeVisible();
  await expect(demoPanel(page)).toContainText('Acceso DEMO pendiente');
  await expect(mondayPanel(page)).toContainText('Acceso Monday pendiente');
  await expect(demoPanel(page).getByRole('link', { name: 'Abrir oficina DEMO' })).toHaveAttribute('href', '/office/');
  await expect(mondayPanel(page).getByRole('link', { name: 'Acceso del propietario Monday' })).toHaveAttribute('href', '/office/monday');
  await expect(page.locator('input, form')).toHaveCount(0);
  expect(provenance.calls.every(call => call.method === 'GET' && ['/office-api/provenance', '/office-api/monday/provenance'].includes(call.path))).toBe(true);
  await fits(page);
});

test('DEMO evidence remains readable when the independent Monday session is missing', async ({ page, provenance }) => {
  responses(provenance, { body: demo() }, { status: 401, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('demo:demo-aurora:fixture-read');
  await expect(demoPanel(page)).toContainText('Sin vínculos guardados');
  await expect(mondayPanel(page)).toContainText('Acceso Monday pendiente');
  await expect(mondayPanel(page)).not.toContainText('demo:demo-aurora:fixture-read');
  await expect(page.getByTestId('provenance-demo-evidence')).toHaveCount(1);
  await fits(page);
});

test('Monday connection metadata never implies imported records or operational business metrics', async ({ page, provenance }) => {
  responses(provenance, { status: 401, body: { error: 'unauthorized' } }, { body: monday() });
  await page.goto('/office/provenance/');
  await expect(demoPanel(page)).toContainText('Acceso DEMO pendiente');
  await expect(mondayPanel(page)).toContainText('Conexión confirmada');
  await expect(mondayPanel(page)).toContainText('Fuente pendiente de acordar');
  await expect(mondayPanel(page)).toContainText('No se han consultado registros comerciales en esta vista');
  await expect(mondayPanel(page)).not.toContainText('Sin vínculos guardados');
  await expect(mondayPanel(page)).not.toContainText('Ventas cerradas');
  await fits(page);
});

test('exact pinned versions and explicit unlink/reversion history are displayed without choosing the newest quote', async ({ page, provenance }) => {
  responses(provenance, { body: demo({ bridge: bridge({ state: 'available', revision: 8, sourceVersions: versions, bindings: history }) }) }, { body: monday() });
  await page.goto('/office/provenance');
  const linked = demoPanel(page).getByTestId('provenance-binding-synthetic-chain-3');
  await expect(linked).toContainText('Reversión');
  await expect(linked).toContainText('Cotización · v1');
  await expect(linked).toContainText(versions[2].id);
  await expect(linked).not.toContainText(versions[3].id);
  await expect(demoPanel(page).getByTestId('provenance-binding-synthetic-chain-2')).toContainText('Desvinculación');
  await expect(demoPanel(page)).toContainText('fixture:explicit-revert');
  await expect(mondayPanel(page)).not.toContainText('synthetic-chain');
  await fits(page);
});

test('unavailable services do not become confirmed empty readings or zero counts', async ({ page, provenance }) => {
  responses(provenance, { status: 503, body: { error: 'storage_unavailable' } }, { status: 503, body: { error: 'storage_unavailable' } });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('Lectura no disponible');
  await expect(mondayPanel(page)).toContainText('Lectura no disponible');
  await expect(page.locator('body')).not.toContainText('Sin vínculos guardados');
  await expect(page.locator('body')).not.toContainText('0 referencias');
  await fits(page);
});

test('an unavailable bridge preserves DEMO evidence and reports unknown coverage', async ({ page, provenance }) => {
  responses(provenance, { body: demo({ bridge: bridge({ state: 'unavailable', storage: null, revision: null, coverage: 'not_queried' }) }) }, { body: monday() });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('demo:demo-aurora:fixture-read');
  await expect(demoPanel(page)).toContainText('Vínculos no disponibles');
  await expect(demoPanel(page)).not.toContainText('Sin vínculos guardados');
  await expect(demoPanel(page)).not.toContainText('0 referencias');
  await fits(page);
});

test('partial coverage remains explicit and source references remain in their own panel', async ({ page, provenance }) => {
  const sources = Array.from({ length: 50 }, (_, index) => sourceVersion(index + 10, 'lead'));
  responses(provenance, { body: demo({ bridge: bridge({ state: 'available', revision: 50, sourceVersions: sources, coverage: 'partial' }) }) }, { body: monday() });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('Cobertura parcial');
  await expect(demoPanel(page).getByTestId('provenance-source-version')).toHaveCount(50);
  await expect(mondayPanel(page).getByTestId('provenance-source-version')).toHaveCount(0);
  await fits(page);
});

test('unknown or sensitive fields invalidate one panel without exposing raw responses', async ({ page, provenance }) => {
  const privateMarker = 'SYNTHETIC_PRIVATE_RESPONSE_NOT_FOR_RENDER';
  responses(provenance, { body: { ...demo(), token: privateMarker } }, { body: monday() });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('Respuesta no verificada');
  await expect(mondayPanel(page)).toContainText('Conexión confirmada');
  await expect(page.locator('body')).not.toContainText(privateMarker);
  await fits(page);
});

test('a restricted bridge remains distinct from an empty bridge', async ({ page, provenance }) => {
  responses(provenance, { body: demo({ coverage: { caseIds: ['demo-aurora'], functionIds: ['sales'] }, bridge: bridge({ state: 'scope_restricted', storage: null, revision: null, coverage: 'not_queried' }) }) }, { body: monday() });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('Lectura restringida al alcance autorizado');
  await expect(demoPanel(page)).not.toContainText('Sin vínculos guardados');
  await expect(demoPanel(page).getByTestId('provenance-demo-evidence')).toHaveCount(1);
  await fits(page);
});

test('an external source in DEMO is rejected without rendering its reference', async ({ page, provenance }) => {
  const externalReference = 'SYNTHETIC_EXTERNAL_ROW_NOT_FOR_DEMO';
  const externalVersion = { ...sourceVersion(10, 'lead'), reference: { sourceSystem: 'monday', boardId: 'synthetic-board', itemId: externalReference } };
  responses(provenance, { body: demo({ bridge: bridge({ state: 'available', revision: 1, sourceVersions: [externalVersion] }) }) }, { body: monday() });
  await page.goto('/office/provenance');
  await expect(demoPanel(page)).toContainText('Respuesta no verificada');
  await expect(page.locator('body')).not.toContainText(externalReference);
  await expect(mondayPanel(page)).toContainText('Conexión confirmada');
  await fits(page);
});

test('office menus and the Monday owner header expose the independent read-only page', async ({ page, provenance }) => {
  provenance.respond('/office-api/session', { status: 401, body: { error: 'UNAUTHORIZED' } });
  provenance.respond('/office-api/monday/owner/session', { body: { available: false, authenticated: false } });
  responses(provenance, { status: 401, body: { error: 'UNAUTHORIZED' } }, { status: 401, body: { error: 'MONDAY_OWNER_UNAUTHORIZED' } });
  await page.goto('/office/');
  await expect(page.locator('.sidebar-provenance-link')).toHaveAttribute('href', '/office/provenance');
  await page.locator('.office-session-menu > summary').click();
  await expect(page.getByRole('link', { name: 'Procedencia · DEMO y Monday' })).toHaveAttribute('href', '/office/provenance');
  await page.goto('/office/monday');
  await page.getByRole('link', { name: 'Procedencia', exact: true }).click();
  await expect(page).toHaveURL(/\/office\/provenance$/);
  await expect(page.getByRole('heading', { name: 'Procedencia de la oficina', exact: true })).toBeVisible();
  await fits(page);
});
