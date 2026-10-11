import { randomUUID } from 'node:crypto';
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { validateOfficeSnapshot } from '../../src/office/adapter';
import type { OfficeCommand, OfficeSnapshot } from '../../src/office/contracts';
import { createOfficeApi } from '../../src/office/backend/http';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { projectOfficeSnapshot } from '../../src/office/backend/state';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import type { SupplyOperation } from '../../src/office/supply-contracts';

type Fulfillment = { status: number; headers: Record<string, string>; body: string };
type SupplyApi = { store: PostgresOfficeStore; inject: (route: Route) => Promise<Fulfillment> };
const apiOrigin = 'http://127.0.0.1:4175';
const test = base.extend<{ supplyApi: SupplyApi }>({
  supplyApi: [async ({ context, page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    // Browser API traffic crosses the real parser/session/role boundary and a
    // private PostgreSQL aggregate. No reset or mutation of shared demo state.
    const store = new PostgresOfficeStore({ stateId: `test-browser-supply-${randomUUID()}` });
    await store.initialize();
    const api = createOfficeApi(store);
    await api.ready();
    const external: string[] = [];
    const runtimeErrors: string[] = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    const inject = async (route: Route): Promise<Fulfillment> => {
      const request = route.request();
      const url = new URL(request.url());
      const incoming = await request.allHeaders();
      const response = await api.inject({
        method: request.method() as 'GET' | 'POST' | 'DELETE', url: `${url.pathname}${url.search}`,
        headers: {
          ...incoming,
          host: new URL(apiOrigin).host,
          ...(incoming.origin === 'http://127.0.0.1:4176' ? { origin: apiOrigin } : {}),
        },
        payload: request.postData() ?? undefined,
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      return { status: response.statusCode, headers, body: response.body };
    };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      external.push(`${route.request().method()} ${url.hostname}`);
      await route.abort('blockedbyclient');
    });
    await context.route('**/office-api/**', async route => { await route.fulfill(await inject(route)); });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.hostname === new URL(origin).hostname && url.port === new URL(origin).port) socket.connectToServer();
      else { external.push(`WebSocket ${url.hostname}`); socket.close(); }
    });
    try { await use({ store, inject }); }
    finally {
      await api.close(); await store.close();
      expect(external, 'Every browser network request stays on loopback').toEqual([]);
      expect(runtimeErrors, 'Supply workflow renders without runtime errors').toEqual([]);
    }
  }, { auto: true }],
});

function workspace(page: Page) { return page.getByRole('dialog', { name: 'Espacio de trabajo', exact: true }); }
async function boot(page: Page, role: 'viewer' | 'operator' = 'operator') {
  await page.goto('/office/');
  await page.getByLabel('Permiso de sesión').selectOption(role);
  await page.getByRole('button', { name: 'Abrir sesión DEMO', exact: true }).click();
  await expect(page.getByText(role === 'operator' ? 'Operador · DEMO' : 'Sólo lectura · DEMO', { exact: true })).toBeVisible();
}
async function openFunction(page: Page, label: 'Proveedores' | 'Logística') {
  if (!await workspace(page).isVisible()) await page.getByRole('button', { name: 'Nueva tarea', exact: true }).click();
  const navigation = workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true });
  await expect(navigation.getByRole('button')).toHaveCount(9);
  await navigation.getByRole('button', { name: label, exact: true }).click();
  await expect(workspace(page).getByRole('heading', { name: label, exact: true })).toBeVisible();
}
async function clickCommand(page: Page, control: Locator, expected = 200) {
  const response = page.waitForResponse(item => /\/office-api\/commands?$/.test(item.url()) && item.request().method() === 'POST');
  await control.click();
  const confirmed = await response;
  expect(confirmed.status()).toBe(expected);
  const body = await confirmed.json();
  if (expected === 200) validateOfficeSnapshot(body.snapshot, 'demo');
  return body as { snapshot: OfficeSnapshot; replayed: boolean };
}
async function assertFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await workspace(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test('persists source-to-assignment and validated-menu-to-review, with exact DEMO approvals', async ({ page, supplyApi }, testInfo) => {
  test.setTimeout(120_000);
  await boot(page);
  await openFunction(page, 'Proveedores');
  const sourcing = workspace(page).getByTestId('supply-sourcing');
  await expect(sourcing.getByTestId('supply-queue')).toContainText('En cola');
  await expect(sourcing).toContainText('Facebook Marketplace');
  await expect(sourcing).toContainText('MeetAChef');
  await clickCommand(page, sourcing.getByRole('button', { name: 'Incorporar digest ficticio', exact: true }));
  const digest = sourcing.getByTestId('supply-digest-supply-digest-demo-aurora-mixed');
  await expect(digest).toContainText('Asunto y cuerpo no coinciden');
  await expect(digest.locator('dt').filter({ hasText: 'Registros extraídos' }).locator('..')).toContainText('5');
  await expect(digest.locator('dt').filter({ hasText: 'Candidatos únicos' }).locator('..')).toContainText('4');
  await expect(sourcing.locator('article[data-testid^="supply-candidate-"]')).toHaveCount(4);
  const candidate = sourcing.getByTestId('supply-candidate-candidate-demo-alba');
  await expect(candidate).toContainText('25.00 USD / hora');
  await expect(candidate.getByRole('button', { name: 'Preparar selección para aprobación', exact: true })).toBeDisabled();
  await expect(candidate.getByRole('button', { name: 'Verificar disponible DEMO', exact: true })).toBeDisabled();
  await clickCommand(page, candidate.getByRole('button', { name: 'Evaluar como elegible DEMO', exact: true }));
  await clickCommand(page, candidate.getByRole('button', { name: 'Verificar disponible DEMO', exact: true }));
  const completeTerms = candidate.locator('article.result-card').filter({ hasText: 'supply-terms-demo-aurora-alba-complete' });
  await expect(completeTerms).toContainText('35.00 USD / hora');
  await expect(completeTerms).toContainText('140.00 USD');
  await clickCommand(page, completeTerms.getByRole('button', { name: 'Validar condiciones DEMO', exact: true }));
  // A second ingestion has a new command key, while human facts and identity
  // remain authoritative. It must not reset the reviewed candidate.
  const beforeDuplicate = (await supplyApi.store.snapshot()).office.supply!.cases['demo-aurora'].candidates['candidate-demo-alba'];
  await clickCommand(page, sourcing.getByRole('button', { name: 'Incorporar digest ficticio', exact: true }));
  const afterDuplicate = (await supplyApi.store.snapshot()).office.supply!.cases['demo-aurora'].candidates['candidate-demo-alba'];
  expect(afterDuplicate).toEqual(beforeDuplicate);
  await clickCommand(page, candidate.getByRole('button', { name: 'Preparar selección para aprobación', exact: true }));
  const selectionReview = workspace(page).locator('article.approval-card').filter({ hasText: 'Selección de chef · revisión interna DEMO' });
  await expect(selectionReview).toHaveCount(1);
  const selectionContext = selectionReview.getByTestId('approval-supply-context');
  await expect(selectionContext).toContainText('25.00 USD / hora');
  await expect(selectionContext).toContainText('140.00 USD');
  await expect(selectionContext).toContainText('Ventana del evento');
  const selectionBody = selectionReview.locator('.approval-body');
  await expect(selectionBody).toContainText('total 140.00 USD');
  await expect(selectionBody).not.toContainText('14000 USD');
  await expect(selectionReview.getByRole('button', { name: /^Editar revisión/ })).toHaveCount(0);
  const selection = sourcing.locator('article[data-testid^="supply-selection-"]');
  await expect(selection.getByRole('button', { name: 'Registrar asignación DEMO', exact: true })).toBeDisabled();
  await clickCommand(page, selectionReview.getByRole('button', { name: /^Aprobar revisión/ }));
  let state = await supplyApi.store.snapshot();
  expect(Object.keys(state.office.supply!.assignments)).toHaveLength(0);
  expect(state.office.cases['demo-aurora'].supplier).toBe('pending');
  await clickCommand(page, selection.getByRole('button', { name: 'Registrar asignación DEMO', exact: true }));
  await expect(sourcing.locator('article[data-testid^="supply-assignment-"]')).toHaveCount(1);
  await expect(sourcing).toContainText('Sin contratar');
  state = await supplyApi.store.snapshot();
  expect(Object.values(state.office.supply!.assignments)).toHaveLength(1);
  expect(Object.values(state.office.supply!.assignments)[0].externalHired).toBe(false);
  expect(state.office.cases['demo-aurora'].supplier).toBe('pending');

  await openFunction(page, 'Logística');
  const procurement = workspace(page).getByTestId('supply-procurement');
  const incompleteMenu = procurement.getByTestId('supply-menu-preview-supply-menu-demo-aurora-missing-quantity');
  await expect(incompleteMenu).toContainText('Porciones sin validar');
  await clickCommand(page, incompleteMenu.getByRole('button', { name: 'Validar menú y cantidades DEMO', exact: true }));
  await expect(procurement.getByTestId('supply-menu-validated')).toContainText('Bloqueado por datos faltantes');
  await expect(procurement.getByRole('button', { name: 'Preparar lista desde menú validado', exact: true })).toBeDisabled();
  const menu = procurement.getByTestId('supply-menu-preview-supply-menu-demo-aurora-complete');
  await expect(menu).toContainText('1000 g');
  await expect(menu).toContainText('recipe-demo-rice');
  await clickCommand(page, menu.getByRole('button', { name: 'Validar menú y cantidades DEMO', exact: true }));
  await clickCommand(page, procurement.getByRole('button', { name: 'Preparar lista desde menú validado', exact: true }));
  await expect(procurement.getByTestId('supply-purchase-list')).toContainText('1000 g');
  const missingOption = procurement.getByTestId('supply-option-preview-supply-option-demo-aurora-missing');
  await expect(missingOption).toContainText('Dirección sin validar');
  await clickCommand(page, missingOption.getByRole('button', { name: 'Preparar opción con coste total', exact: true }));
  const incompleteOption = procurement.locator('article[data-testid^="supply-option-"]').filter({ hasText: 'Opción con datos faltantes · DEMO' }).filter({ has: page.getByRole('button', { name: 'Preparar revisión de abastecimiento', exact: true }) });
  await expect(incompleteOption.getByRole('button', { name: 'Preparar revisión de abastecimiento', exact: true })).toBeDisabled();
  const optionFixture = procurement.getByTestId('supply-option-preview-supply-option-demo-aurora-complete');
  await clickCommand(page, optionFixture.getByRole('button', { name: 'Preparar opción con coste total', exact: true }));
  const option = procurement.locator('article[data-testid^="supply-option-"]').filter({ hasText: 'Opción completa · DEMO' }).filter({ has: page.getByRole('button', { name: 'Preparar revisión de abastecimiento', exact: true }) });
  await expect(option).toContainText('49.00 USD');
  await expect(option).toContainText('Dirección sintética DEMO');
  await expect(option).toContainText('Ventana de entrega');
  await clickCommand(page, option.getByRole('button', { name: 'Preparar revisión de abastecimiento', exact: true }));
  const purchaseReview = workspace(page).locator('article.approval-card').filter({ hasText: 'Lista y opción de compra · revisión interna DEMO' });
  await expect(purchaseReview.getByTestId('approval-supply-context')).toContainText('49.00 USD');
  await expect(purchaseReview.getByTestId('approval-supply-context')).toContainText('1000 g');
  const purchaseBody = purchaseReview.locator('.approval-body');
  await expect(purchaseBody).toContainText('subtotal 20.00 USD');
  await expect(purchaseBody).toContainText('total 49.00 USD');
  await expect(purchaseBody).not.toContainText('2000 USD');
  await expect(purchaseBody).not.toContainText('4900 USD');
  await expect(purchaseReview.getByRole('button', { name: /^Editar revisión/ })).toHaveCount(0);
  await clickCommand(page, purchaseReview.getByRole('button', { name: /^Aprobar revisión/ }));
  state = await supplyApi.store.snapshot();
  const approvedOption = Object.values(state.office.supply!.cases['demo-aurora'].options).find(item => item.reviewStatus === 'approved_demo')!;
  expect(approvedOption).toMatchObject({ totalCents: 4900, externalOrdered: false, externalPaid: false, externalReceived: false });
  const independent = new PostgresOfficeStore({ stateId: supplyApi.store.stateId });
  try {
    await independent.initialize();
    expect((await independent.snapshot()).office.supply).toEqual(state.office.supply);
  } finally { await independent.close(); }
  validateOfficeSnapshot(projectOfficeSnapshot(state, Date.now()), 'demo');
  await page.reload();
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  await openFunction(page, 'Logística');
  await expect(workspace(page).getByTestId('supply-procurement')).toContainText('Aprobado DEMO');
  await expect(workspace(page).getByRole('button', { name: /^Comprar|^Enviar formulario|^Contratar/ })).toHaveCount(0);
  await assertFits(page);
  await page.screenshot({ path: testInfo.outputPath('supply-procurement-synthetic.png'), fullPage: true });
  await openFunction(page, 'Proveedores');
  await expect(workspace(page).getByTestId('supply-sourcing')).toContainText('Asignación interna DEMO registrada');
  await assertFits(page);
  await page.screenshot({ path: testInfo.outputPath('supply-sourcing-synthetic.png'), fullPage: true });
});

test('viewer reads supply facts and exact previews without write permission', async ({ page, supplyApi }) => {
  await boot(page, 'viewer');
  await openFunction(page, 'Proveedores');
  await expect(workspace(page).getByTestId('supply-sourcing')).toContainText('En cola');
  await expect(workspace(page).getByRole('button', { name: 'Incorporar digest ficticio', exact: true })).toBeDisabled();
  await openFunction(page, 'Logística');
  const menu = workspace(page).getByTestId('supply-menu-preview-supply-menu-demo-aurora-complete');
  await expect(menu).toContainText('1000 g');
  await expect(menu.getByRole('button', { name: 'Validar menú y cantidades DEMO', exact: true })).toBeDisabled();
  for (const button of await workspace(page).getByTestId('supply-procurement').getByRole('button').all()) await expect(button).toBeDisabled();
  expect(Object.keys((await supplyApi.store.snapshot()).office.commands)).toHaveLength(0);
  await assertFits(page);
});

test('an uncertain supply result survives reload and retries only the original durable command', async ({ page, context, supplyApi }) => {
  const commands: OfficeCommand[] = [];
  let interrupted = false;
  await context.route('**/office-api/command*', async route => {
    const command = route.request().postDataJSON() as OfficeCommand;
    commands.push(command);
    if (!interrupted && command.supply?.step === 'ingest_digest') {
      interrupted = true;
      const response = await supplyApi.inject(route);
      expect(response.status).toBe(200);
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  await boot(page);
  await openFunction(page, 'Proveedores');
  await workspace(page).getByRole('button', { name: 'Incorporar digest ficticio', exact: true }).click();
  await expect(workspace(page).getByRole('region', { name: 'Operación sin confirmación', exact: true })).toBeVisible();
  await expect(workspace(page).getByRole('button', { name: 'Incorporar digest ficticio', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Operación sin confirmación', exact: true })).toBeVisible();
  const replay = await clickCommand(page, page.getByRole('button', { name: 'Reintentar operación exacta', exact: true }));
  expect(replay.replayed).toBe(true);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0].supply?.step).toBe('ingest_digest');
  const state = await supplyApi.store.snapshot();
  expect(Object.keys(state.office.commands)).toEqual([commands[0].idempotencyKey]);
  expect(Object.values(state.office.supply!.cases['demo-aurora'].candidates)).toHaveLength(4);
  await expect(page.getByRole('region', { name: 'Operación sin confirmación', exact: true })).toHaveCount(0);
  await openFunction(page, 'Proveedores');
  await expect(workspace(page).getByTestId('supply-sourcing').locator('article[data-testid^="supply-candidate-"]')).toHaveCount(4);
  await assertFits(page);
});

test('stale supplier and purchase reviews stay readable but cannot be approved', async ({ page, supplyApi }) => {
  test.setTimeout(120_000);
  const apply = async (supply: SupplyOperation) => executeOfficeCommand(supplyApi.store, {
    idempotencyKey: `qa-stale-${randomUUID()}`, caseId: 'demo-aurora',
    functionId: ['validate_menu', 'build_purchase_list', 'choose_purchase_option', 'review_purchase'].includes(supply.step) ? 'logistics' : 'suppliers', action: 'draft', supply,
  });
  const candidateRevision = async () => (await supplyApi.store.snapshot()).office.supply!.cases['demo-aurora'].candidates['candidate-demo-alba'].revision;
  // Set up exact pending reviews through normal persisted domain commands.
  // Subsequent changes and historical decisions use the authenticated browser.
  await apply({ step: 'ingest_digest', fixtureId: 'supply-digest-demo-aurora-mixed' });
  await apply({ step: 'evaluate_candidate', candidateId: 'candidate-demo-alba', revision: await candidateRevision(), verdict: 'eligible' });
  await apply({ step: 'verify_availability', candidateId: 'candidate-demo-alba', revision: await candidateRevision(), status: 'available' });
  await apply({ step: 'approve_terms', candidateId: 'candidate-demo-alba', revision: await candidateRevision(), termsFixtureId: 'supply-terms-demo-aurora-alba-complete' });
  await apply({ step: 'select_candidate', candidateId: 'candidate-demo-alba', revision: await candidateRevision() });
  await apply({ step: 'validate_menu', fixtureId: 'supply-menu-demo-aurora-complete' });
  await apply({ step: 'build_purchase_list' });
  await apply({ step: 'choose_purchase_option', optionFixtureId: 'supply-option-demo-aurora-complete', listRevision: (await supplyApi.store.snapshot()).office.supply!.cases['demo-aurora'].list!.revision });
  const option = Object.values((await supplyApi.store.snapshot()).office.supply!.cases['demo-aurora'].options)[0];
  await apply({ step: 'review_purchase', optionId: option.id, revision: option.revision });
  const original = await supplyApi.store.snapshot();
  const selectionBinding = Object.values(original.office.approvals).find(item => item.supplyContext?.kind === 'selection')!;
  const purchaseBinding = Object.values(original.office.approvals).find(item => item.supplyContext?.kind === 'purchase')!;
  await boot(page);
  await openFunction(page, 'Proveedores');
  const candidate = workspace(page).getByTestId('supply-candidate-candidate-demo-alba');
  await clickCommand(page, candidate.getByRole('button', { name: 'Evaluar como elegible DEMO', exact: true }));
  const selectionReview = workspace(page).getByTestId(`office-approval-${selectionBinding.id}`);
  await expect(selectionReview).toContainText('Desactualizada · DEMO');
  await expect(selectionReview.getByTestId('approval-supply-context')).toContainText('140.00 USD');
  await expect(selectionReview.getByRole('button', { name: /^Aprobar revisión/ })).toBeDisabled();
  await expect(selectionReview.getByRole('button', { name: /^Rechazar revisión/ })).toBeEnabled();
  await clickCommand(page, selectionReview.getByRole('button', { name: /^Cancelar revisión/ }));
  expect((await supplyApi.store.snapshot()).office.approvals[selectionBinding.id].digest).toBe(selectionBinding.digest);
  await openFunction(page, 'Logística');
  const menu = workspace(page).getByTestId('supply-menu-preview-supply-menu-demo-aurora-complete');
  await clickCommand(page, menu.getByRole('button', { name: 'Validar menú y cantidades DEMO', exact: true }));
  const purchaseReview = workspace(page).getByTestId(`office-approval-${purchaseBinding.id}`);
  await expect(purchaseReview).toContainText('Desactualizada · DEMO');
  await expect(purchaseReview.getByTestId('approval-supply-context')).toContainText('49.00 USD');
  await expect(purchaseReview.getByRole('button', { name: /^Aprobar revisión/ })).toBeDisabled();
  await expect(purchaseReview.getByRole('button', { name: /^Cancelar revisión/ })).toBeEnabled();
  await clickCommand(page, purchaseReview.getByRole('button', { name: /^Rechazar revisión/ }));
  expect((await supplyApi.store.snapshot()).office.approvals[purchaseBinding.id].digest).toBe(purchaseBinding.digest);
  await assertFits(page);
});
