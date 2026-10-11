import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { FunctionId, OfficeCommand, OfficeSnapshot } from '../../src/office/contracts';

const localOrigin = 'http://127.0.0.1:4175';
const api = '/office-api';
const functions: Array<{ id: FunctionId; label: string }> = [
  { id: 'sales', label: 'Ventas' },
  { id: 'proposals', label: 'Propuestas' },
  { id: 'coordination', label: 'Coordinación / Tastings' },
  { id: 'logistics', label: 'Logística' },
  { id: 'suppliers', label: 'Proveedores' },
  { id: 'finance', label: 'Finanzas' },
  { id: 'quality', label: 'Calidad' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'talent', label: 'Talento' },
];
const key = () => `qa-${randomUUID()}`;
const syntheticText = (topic: string) => `Escenario sintético QA ${topic} ${randomUUID()}`;

// Every browser request is observed. An unexpected external request is blocked
// and fails the test; no submission, LLM, analytics or provider is permitted.
const test = base.extend<{ networkBoundary: void }>({
  networkBoundary: [async ({ context, page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const blocked: string[] = [];
    const runtimeErrors: string[] = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      blocked.push(`${route.request().method()} ${url.href}`);
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.hostname === '127.0.0.1' && url.port === '4175') {
        socket.connectToServer();
      } else {
        blocked.push(`WebSocket ${url.href}`);
        socket.close();
      }
    });
    await use();
    expect(blocked, 'No external request should be attempted').toEqual([]);
    expect(runtimeErrors, 'No browser runtime error should occur').toEqual([]);
  }, { auto: true }],
});

async function session(request: APIRequestContext, scope: Record<string, unknown> = { role: 'operator' }) {
  const response = await request.post(`${api}/session`, { headers: { Origin: localOrigin }, data: scope });
  expect(response.status()).toBe(200);
  const auth = await response.json();
  expect(auth).toMatchObject({ mode: 'demo', actorId: 'OFFICE_DEMO_OPERATOR', storage: { kind: 'postgres', durable: true }, outboundEffects: 0 });
  return auth;
}

async function snapshot(request: APIRequestContext): Promise<OfficeSnapshot> {
  const response = await request.get(`${api}/snapshot`);
  expect(response.status()).toBe(200);
  const state = await response.json() as OfficeSnapshot;
  expect(state).toMatchObject({ mode: 'demo', outboundEffects: 0, mondayWrites: 0 });
  for (const item of state.cases) {
    expect(item.evidence.simulated).toBe(true);
    for (const row of [...item.tasks, ...item.results, ...item.approvals, ...item.messages, ...item.history]) {
      expect(row.evidence.simulated).toBe(true);
      expect(row.evidence.reference).toMatch(new RegExp(`^demo:${item.id}:`));
    }
  }
  return state;
}

async function command(request: APIRequestContext, input: OfficeCommand, expectedStatus = 200) {
  const response = await request.post(`${api}/commands`, { headers: { Origin: localOrigin }, data: input });
  expect(response.status()).toBe(expectedStatus);
  return response;
}

async function boot(page: Page) {
  const auth = await session(page.request);
  expect(auth.role).toBe('operator');
  const response = await page.goto('/office/');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  await selectCase(page, 'demo-aurora');
}

function workspace(page: Page) {
  return page.getByRole('dialog', { name: 'Espacio de trabajo', exact: true });
}

async function closeWorkspace(page: Page, name = 'Cerrar espacio de trabajo') {
  if (!await workspace(page).isVisible()) return;
  await workspace(page).getByRole('button', { name, exact: true }).click();
  await expect(workspace(page)).not.toBeVisible();
  await page.waitForFunction(() => window.history.state?.officeDrawer !== true);
}

async function openDemoMenu(page: Page) {
  const menu = page.locator('details.office-session-menu');
  if (!await menu.evaluate(element => (element as HTMLDetailsElement).open)) {
    await menu.locator('summary').first().click();
  }
  return menu;
}

async function selectCase(page: Page, id: string) {
  await closeWorkspace(page);
  const menu = await openDemoMenu(page);
  await page.getByLabel('Caso de demostración').selectOption(id);
  await menu.locator('summary').first().click();
}

async function showView(page: Page, name: 'Mi oficina' | 'Historial' | 'Dashboard' | 'Aprobaciones') {
  await closeWorkspace(page);
  await page.getByRole('tab', { name: name === 'Aprobaciones' ? /^Aprobaciones(?: \d+)?$/ : name, exact: true }).click();
}

async function openFunction(page: Page, id: FunctionId) {
  const selected = functions.find(item => item.id === id)!;
  if (!await workspace(page).isVisible()) {
    await showView(page, 'Mi oficina');
    await page.getByRole('button', { name: 'Nueva tarea', exact: true }).click();
  }
  const button = workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true }).getByRole('button', { name: selected.label, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace(page).getByRole('heading', { name: selected.label, exact: true })).toBeVisible();
}

async function draft(page: Page, id: FunctionId, text = syntheticText(id)): Promise<Locator> {
  await openFunction(page, id);
  await page.getByLabel('Contenido del borrador').fill(text);
  const response = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preparar borrador', exact: true }).click();
  expect((await response).status()).toBe(200);
  const card = workspace(page).locator('article[data-testid^="office-approval-"]').filter({ hasText: text });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('cliente-demo@invalid.test');
  await expect(card).toContainText('Gourmet · cuenta de demostración');
  await expect(card.locator('.digest code')).toHaveText(/^[a-f0-9]{64}$/);
  return card;
}

test('requires PostgreSQL and an explicit DEMO session, with synthetic evidence only', async ({ page, request }) => {
  const health = await request.get(`${api}/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 });

  const unauthorized = await request.get(`${api}/snapshot`);
  expect(unauthorized.status()).toBe(401);
  await page.goto('/office/');
  await expect(page.getByLabel('Permiso de sesión')).toHaveValue('viewer');
  await page.getByRole('button', { name: 'Abrir sesión DEMO', exact: true }).click();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  const viewerSession = await page.request.get(`${api}/session`);
  expect(await viewerSession.json()).toMatchObject({ role: 'viewer', actorId: 'OFFICE_DEMO_OPERATOR' });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.getByText(/^Sin LLM conectado\./)).toBeVisible();
  const state = await snapshot(page.request);
  expect(state.cases.map(item => item.id)).toEqual(['demo-aurora', 'demo-cedar', 'demo-harbor']);
  expect(state.note).toMatch(/DEMOSTRACIÓN/);
});

test('approved office composition fits 1586×992 with artwork and persistent chat', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'The approved composition is measured at its desktop reference size.');
  await page.setViewportSize({ width: 1586, height: 992 });
  await boot(page);
  await expect(page.getByRole('heading', { name: 'Mi oficina', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /La oficina, con/ })).toHaveCount(0);
  await expect(workspace(page)).not.toBeVisible();
  await expect(page.getByLabel('Contenido del borrador')).not.toBeVisible();
  const art = page.locator('img.office-scene-art');
  await expect(art).toBeVisible();
  await expect.poll(() => art.evaluate(image => {
    const element = image as HTMLImageElement;
    return { loaded: element.complete, width: element.naturalWidth, height: element.naturalHeight };
  })).toEqual({ loaded: true, width: 959, height: 799 });
  await expect(page.getByRole('region', { name: 'Coordinación', exact: true })).toBeVisible();
  await expect(page.getByLabel('Mensaje contextual')).toBeVisible();
  const layout = await page.evaluate(() => {
    const art = document.querySelector('.office-scene-art')!.getBoundingClientRect();
    const sidebar = document.querySelector('.office-sidebar')!.getBoundingClientRect();
    const chat = document.querySelector('.office-chat')!.getBoundingClientRect();
    return {
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sidebarRight: sidebar.right,
      artLeft: art.left, artRight: art.right, artWidth: art.width, artHeight: art.height,
      artTop: art.top, artBottom: art.bottom,
      chatLeft: chat.left, chatRight: chat.right, chatTop: chat.top, chatBottom: chat.bottom,
    };
  });
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.pageHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.artLeft).toBeGreaterThanOrEqual(layout.sidebarRight);
  expect(layout.artWidth).toBeGreaterThan(850);
  expect(layout.artHeight).toBeGreaterThan(650);
  expect(layout.chatLeft).toBeGreaterThanOrEqual(layout.artRight);
  expect(Math.abs(layout.chatTop - layout.artTop)).toBeLessThan(8);
  expect(Math.abs(layout.chatBottom - layout.artBottom)).toBeLessThan(8);
  expect(layout.chatRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.artBottom).toBeLessThanOrEqual(layout.viewportHeight);
  await page.screenshot({ path: testInfo.outputPath('office-approved-composition-1586x992.png') });
});

test('department controls select real contextual functions without creating work', async ({ page }) => {
  await boot(page);
  const before = (await snapshot(page.request)).cases;
  for (const item of [
    { department: 'Ventas', function: 'Ventas' },
    { department: 'Marketing', function: 'Marketing' },
    { department: 'Operaciones', function: 'Coordinación / Tastings' },
    { department: 'Proveedores', function: 'Proveedores' },
    { department: 'Finanzas', function: 'Finanzas' },
    { department: 'Calidad', function: 'Calidad' },
  ]) {
    const button = page.getByRole('button', { name: `Seleccionar ${item.department}`, exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: item.function === 'Coordinación / Tastings' ? 'Coordinación' : item.function, exact: true })).toBeVisible();
    await expect(page.getByRole('log', { name: `Conversación de ${item.function}`, exact: true })).toHaveCount(1);
    await expect(page.getByLabel('Mensaje contextual')).toBeVisible();
    await expect(workspace(page)).not.toBeVisible();
  }
  for (const item of [
    { shortcut: 'Revisar eventos', function: 'Coordinación / Tastings' },
    { shortcut: 'Ver seguimientos', function: 'Ventas' },
    { shortcut: 'Buscar proveedor', function: 'Proveedores' },
  ]) {
    const shortcut = page.getByRole('button', { name: item.shortcut, exact: true });
    await shortcut.click();
    await expect(workspace(page).getByRole('heading', { name: item.function, exact: true })).toBeVisible();
    await closeWorkspace(page);
    await expect(shortcut).toBeFocused();
  }
  expect((await snapshot(page.request)).cases).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('all office views remain reachable by keyboard and history keeps focus across sidebar layouts', async ({ page }) => {
  await boot(page);
  const home = page.getByRole('tab', { name: 'Mi oficina', exact: true });
  await home.focus();
  for (const name of ['Dashboard', /^Aprobaciones/, 'Historial', 'Mi oficina']) {
    await page.keyboard.press('ArrowRight');
    const tab = page.getByRole('tab', { name, exact: typeof name === 'string' });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
  await page.keyboard.press('End');
  const history = page.getByRole('tab', { name: 'Historial', exact: true });
  await expect(history).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Historial', exact: true })).toBeVisible();
  const initialViewport = page.viewportSize()!;
  await page.setViewportSize({ width: initialViewport.width <= 760 ? 1586 : 320, height: 720 });
  if (initialViewport.width <= 760) await expect(history).toHaveClass(/sidebar-history-tab/);
  else await expect(history).not.toHaveClass(/sidebar-history-tab/);
  await expect(history).toBeFocused();
  await page.setViewportSize(initialViewport);
  if (initialViewport.width <= 760) await expect(history).not.toHaveClass(/sidebar-history-tab/);
  else await expect(history).toHaveClass(/sidebar-history-tab/);
  await expect(history).toBeFocused();
  await page.keyboard.press('Home');
  await expect(home).toBeFocused();
  await expect(home).toHaveAttribute('aria-selected', 'true');
});

test('Nueva tarea supports keyboard, close, Back and preserved unsubmitted content', async ({ page }) => {
  await boot(page);
  const before = (await snapshot(page.request)).cases;
  const trigger = page.getByRole('button', { name: 'Nueva tarea', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(workspace(page)).toBeVisible();
  const functionNav = workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true });
  await expect(functionNav.getByRole('button')).toHaveCount(9);
  for (const item of functions) await expect(functionNav.getByRole('button', { name: item.label, exact: true })).toBeVisible();
  const firstControl = workspace(page).getByRole('button', { name: 'Volver a mi oficina', exact: true });
  const lastControl = workspace(page).locator('button:enabled').last();
  await expect(firstControl).toBeFocused();
  await lastControl.focus();
  await page.keyboard.press('Tab');
  await expect(firstControl).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastControl).toBeFocused();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    expect(await workspace(page).evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  }
  const text = syntheticText('unsubmitted-drawer');
  await workspace(page).getByLabel('Contenido del borrador').fill(text);
  await page.keyboard.press('Escape');
  await expect(workspace(page)).not.toBeVisible();
  await page.waitForFunction(() => window.history.state?.officeDrawer !== true);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(workspace(page).getByLabel('Contenido del borrador')).toHaveValue(text);
  await closeWorkspace(page, 'Volver a mi oficina');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await closeWorkspace(page);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.goBack();
  await expect(workspace(page)).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.reload();
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  await expect(workspace(page)).not.toBeVisible();
  await page.waitForFunction(() => window.history.state?.officeDrawer !== true);
  await trigger.click();
  await closeWorkspace(page);
  await expect(trigger).toBeFocused();
  expect((await snapshot(page.request)).cases).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('closing and reopening contextual chat restores focus and unsubmitted text', async ({ page }) => {
  await boot(page);
  const before = (await snapshot(page.request)).cases;
  const text = syntheticText('unsubmitted-chat');
  await page.getByLabel('Mensaje contextual').fill(text);
  const close = page.getByRole('button', { name: 'Cerrar conversación', exact: true });
  await close.focus();
  await page.keyboard.press('Enter');
  const reopen = page.getByRole('button', { name: 'Abrir conversación', exact: true });
  await expect(reopen).toBeFocused();
  await expect(page.getByLabel('Mensaje contextual')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await expect(page.getByLabel('Mensaje contextual')).toHaveValue(text);
  expect((await snapshot(page.request)).cases).toEqual(before);
});

test('a drawer opened by Ricardo restores visible Nueva tarea after resizing to mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page);
  const before = (await snapshot(page.request)).cases;
  const human = page.getByRole('button', { name: /^Ricardo Humano/ });
  await human.focus();
  await page.keyboard.press('Enter');
  await expect(workspace(page)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.keyboard.press('Escape');
  await expect(workspace(page)).not.toBeVisible();
  await page.waitForFunction(() => window.history.state?.officeDrawer !== true);
  const fallback = page.getByRole('button', { name: 'Nueva tarea', exact: true });
  await expect(fallback).toBeVisible();
  await expect(fallback).toBeFocused();
  expect((await snapshot(page.request)).cases).toEqual(before);
});

test('all nine functions save a contextual chat and a human-review draft', async ({ page }) => {
  await boot(page);
  const questions = new Map<FunctionId, string>();
  for (const item of functions) {
    await openFunction(page, item.id);
    await closeWorkspace(page);
    const text = syntheticText(`chat-${item.id}`);
    questions.set(item.id, text);
    await page.getByLabel('Mensaje contextual').fill(text);
    const response = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Guardar pregunta', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText(`DEMO — ${text}`, { exact: true })).toBeVisible();
    await draft(page, item.id);
  }
  const state = await snapshot(page.request);
  const selected = state.cases.find(item => item.id === 'demo-aurora')!;
  for (const item of functions) {
    const question = selected.messages.find(message => message.functionId === item.id && message.text === `DEMO — ${questions.get(item.id)}`)!;
    expect(question).toBeDefined();
    expect(selected.messages.find(message => message.evidence.reference === `${question.evidence.reference}:response`)?.text).toMatch(/Respuesta guionada local.*sin LLM/);
    expect(selected.approvals.some(approval => approval.functionId === item.id && approval.body.includes('Escenario sintético QA'))).toBe(true);
  }
});

for (const decision of [
  { action: 'approve', button: 'Aprobar', label: 'Aprobado DEMO', status: 'approved_demo' },
  { action: 'reject', button: 'Rechazar', label: 'Rechazado DEMO', status: 'rejected_demo' },
  { action: 'cancel', button: 'Cancelar', label: 'Cancelado DEMO', status: 'cancelled_demo' },
] as const) {
  test(`${decision.action} records an exact local decision and survives refresh`, async ({ page }) => {
    await boot(page);
    const text = syntheticText(decision.action);
    let card = await draft(page, 'proposals', text);
    await card.getByRole('button', { name: `${decision.button} revisión 1`, exact: true }).click();
    await expect(card).toContainText(decision.label);
    const state = await snapshot(page.request);
    const saved = state.cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.body.includes(text))!;
    expect(saved.status).toBe(decision.status);
    expect(saved.revision).toBe(1);
    expect(saved.digest).toMatch(/^[a-f0-9]{64}$/);
    await page.reload();
    await openFunction(page, 'proposals');
    card = page.getByTestId(`office-approval-${saved.id}`);
    await expect(card).toContainText(text);
    await expect(card).toContainText(decision.label);
    await expect(card).toContainText(saved.digest);
  });
}

test('revision invalidates an old decision and keeps the new exact content pending', async ({ page }) => {
  await boot(page);
  const text = syntheticText('revision-old');
  const card = await draft(page, 'proposals', text);
  const initial = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.body.includes(text))!;
  const approvalResponse = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await card.getByRole('button', { name: 'Aprobar revisión 1', exact: true }).click();
  const previousApprovalCommand = (await approvalResponse).request().postDataJSON() as OfficeCommand;
  await expect(card).toContainText('Aprobado DEMO');
  await card.getByRole('button', { name: 'Editar revisión 1', exact: true }).click();
  const revisedText = syntheticText('revision-new');
  await page.getByLabel('Nuevo contenido de la revisión').fill(revisedText);
  await page.getByRole('button', { name: 'Guardar nueva revisión', exact: true }).click();
  const revisedCard = page.getByTestId(`office-approval-${initial.id}`);
  await expect(revisedCard).toContainText(revisedText);
  await expect(revisedCard.getByRole('button', { name: 'Aprobar revisión 2', exact: true })).toBeEnabled();
  const revised = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === initial.id)!;
  expect(revised).toMatchObject({ revision: 2, status: 'pending', body: `DEMO — ${revisedText}` });
  expect(revised.digest).not.toBe(initial.digest);
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'proposals', action: 'approve', approvalId: initial.id, revision: initial.revision, digest: initial.digest }, 409);
  const replay = await (await command(page.request, previousApprovalCommand)).json();
  expect(replay.replayed).toBe(true);
  expect((replay.snapshot as OfficeSnapshot).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === initial.id)).toMatchObject({ revision: 2, status: 'pending' });
  await page.reload();
  await openFunction(page, 'proposals');
  await expect(page.getByTestId(`office-approval-${initial.id}`)).toContainText(revisedText);
  await expect(page.getByTestId(`office-approval-${initial.id}`).getByRole('button', { name: 'Aprobar revisión 2', exact: true })).toBeEnabled();
});

test('a stale browser cannot approve content changed by another session', async ({ page }) => {
  await boot(page);
  const oldText = syntheticText('stale-tab');
  const card = await draft(page, 'marketing', oldText);
  const saved = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.body.includes(oldText))!;
  const updatedText = syntheticText('other-session');
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'marketing', action: 'revise', approvalId: saved.id, revision: saved.revision, digest: saved.digest, text: updatedText });
  const response = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await card.getByRole('button', { name: 'Aprobar revisión 1', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(workspace(page).getByRole('alert')).toContainText(/cambi|revisi|conflic/i);
  await closeWorkspace(page);
  await expect(page.getByRole('alert')).toContainText(/cambi|revisi|conflic/i);
  const current = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === saved.id)!;
  expect(current).toMatchObject({ revision: 2, status: 'pending', body: `DEMO — ${updatedText}` });
  const menu = await openDemoMenu(page);
  await page.getByRole('button', { name: 'Actualizar oficina', exact: true }).click();
  await menu.locator('summary').first().click();
  await openFunction(page, 'marketing');
  await expect(page.getByTestId(`office-approval-${saved.id}`)).toContainText(updatedText);
});

test('case navigation keeps payment, supplier acceptance and human sale independent', async ({ page }) => {
  await boot(page);
  await selectCase(page, 'demo-harbor');
  await openFunction(page, 'suppliers');
  await expect(page.getByRole('button', { name: 'Preparar borrador', exact: true })).toBeDisabled();
  await expect(page.getByText(/cerrar la venta humana|cierre humano/i).first()).toBeVisible();
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-harbor', functionId: 'suppliers', action: 'draft', text: syntheticText('blocked-supplier') }, 403);
  const state = await snapshot(page.request);
  expect(state.cases.find(item => item.id === 'demo-aurora')).toMatchObject({ payment: 'verified', supplier: 'pending', saleClosed: true });
  expect(state.cases.find(item => item.id === 'demo-cedar')).toMatchObject({ payment: 'pending', supplier: 'accepted', saleClosed: true });
  expect(state.cases.find(item => item.id === 'demo-harbor')).toMatchObject({ saleClosed: false, assignment: 'queued', closerAvailable: false });
  await selectCase(page, 'demo-cedar');
  await draft(page, 'finance');
});

test('dashboard and history present synthetic coverage and saved work without overflow', async ({ page }, testInfo) => {
  await boot(page);
  await draft(page, 'talent', syntheticText('history-coverage'));
  await showView(page, 'Historial');
  const history = page.getByRole('tabpanel', { name: 'Historial', exact: true });
  await expect(history.getByRole('heading', { name: 'Borrador preparado · DEMO', exact: true }).first()).toBeVisible();
  await expect(history.getByText(/sintétic|DEMOSTRACIÓN|DEMO/i).first()).toBeVisible();
  await showView(page, 'Dashboard');
  await expect(page.getByRole('heading', { name: 'Una lectura con cobertura.', exact: true })).toBeVisible();
  await expect(page.getByText('MUESTRA SINTÉTICA · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByText('Métricas derivadas de 3 casos confirmados por la API. Esta muestra no mide resultados del negocio.', { exact: true })).toBeVisible();
  await expect(page.getByText('Cobertura: 1/3 casos con contacto humano sintético. 2/3 con intento acreditado.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Periodo observado/)).toBeVisible();
  await expect(page.getByRole('cell', { name: '35 s', exact: true })).toBeVisible();
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.width);
  await page.screenshot({ path: testInfo.outputPath('office-dashboard-synthetic.png'), fullPage: true });
  await showView(page, 'Mi oficina');
  await page.screenshot({ path: testInfo.outputPath('office-workspace-synthetic.png'), fullPage: true });
});

test('keyboard can select a function, save a draft and reach a decision at 320px', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Nueva tarea', exact: true }).click();
  const functionButton = workspace(page).getByRole('navigation', { name: 'Funciones de la oficina', exact: true }).getByRole('button', { name: 'Calidad', exact: true });
  await functionButton.focus();
  await page.keyboard.press('Enter');
  await expect(functionButton).toHaveAttribute('aria-pressed', 'true');
  const content = page.getByLabel('Contenido del borrador');
  await content.focus();
  await expect(content).toBeFocused();
  const text = syntheticText('keyboard');
  await content.fill(text);
  const create = page.getByRole('button', { name: 'Preparar borrador', exact: true });
  await create.focus();
  await page.keyboard.press('Enter');
  const card = page.locator('article[data-testid^="office-approval-"]').filter({ hasText: text });
  const reject = card.getByRole('button', { name: 'Rechazar revisión 1', exact: true });
  await expect(reject).toBeEnabled();
  await reject.focus();
  await page.keyboard.press('Enter');
  await expect(card).toContainText('Rechazado DEMO');
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.width);
});

test('a committed command with a lost response retries the same key without duplicating work', async ({ page }) => {
  await boot(page);
  await openFunction(page, 'talent');
  const before = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
  const text = syntheticText('lost-response');
  const observed: OfficeCommand[] = [];
  let committedSnapshot: OfficeSnapshot | undefined;
  let interrupted = false;
  await page.route(/\/office-api\/commands?$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON() as OfficeCommand;
    observed.push(input);
    if (!interrupted && input.action === 'draft' && input.text === text) {
      interrupted = true;
      // This reaches the actual PostgreSQL API and commits the command first.
      // Only the browser response is lost; no backend response is fabricated.
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      committedSnapshot = (await committed.json()).snapshot as OfficeSnapshot;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.getByLabel('Contenido del borrador').fill(text);
  await page.getByRole('button', { name: 'Preparar borrador', exact: true }).click();
  await expect(workspace(page).getByRole('alert')).toContainText(/conexión|confirm|respuesta/i);
  await closeWorkspace(page);
  await expect(page.getByRole('alert')).toContainText(/conexión|confirm|respuesta/i);
  expect(observed).toHaveLength(1);
  expect(committedSnapshot).toBeDefined();
  const committedCase = committedSnapshot!.cases.find(item => item.id === before.id)!;
  const saved = committedCase.approvals.filter(item => item.body.includes(text));
  expect(saved).toHaveLength(1);
  expect(committedCase.tasks).toHaveLength(before.tasks.length + 1);
  expect(committedCase.history).toHaveLength(before.history.length + 1);
  await page.reload();
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Operación sin confirmación', exact: true })).toContainText('Talento');
  await expect(page.getByRole('button', { name: 'Reintentar operación exacta', exact: true })).toBeEnabled();
  expect(observed).toHaveLength(1);
  const retryResponse = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await page.getByRole('button', { name: /^Reintentar/ }).click();
  const retried = await retryResponse;
  expect(retried.status()).toBe(200);
  expect((await retried.json()).replayed).toBe(true);
  expect(observed).toHaveLength(2);
  expect(observed[1]).toEqual(observed[0]);
  await openFunction(page, 'talent');
  await expect(page.getByTestId(`office-approval-${saved[0].id}`)).toContainText(text);
  await page.reload();
  await openFunction(page, 'talent');
  const persisted = (await snapshot(page.request)).cases.find(item => item.id === before.id)!;
  expect(persisted.approvals.filter(item => item.body.includes(text))).toHaveLength(1);
  expect(persisted.tasks).toHaveLength(before.tasks.length + 1);
  expect(persisted.history).toHaveLength(before.history.length + 1);
  await expect(page.getByTestId(`office-approval-${saved[0].id}`)).toContainText(text);
  await closeWorkspace(page);
  await expect(page.getByRole('button', { name: /^Reintentar/ })).toHaveCount(0);
});

test('API rejects incorrect digests, terminal decisions and conflicting idempotency', async ({ request }) => {
  await session(request);
  const input: OfficeCommand = { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'quality', action: 'draft', text: syntheticText('api-guard') };
  const created = await (await command(request, input)).json();
  const saved = (created.snapshot as OfficeSnapshot).cases.find(item => item.id === input.caseId)!.approvals.find(item => item.body.includes(input.text!))!;
  const decide: OfficeCommand = { idempotencyKey: key(), caseId: input.caseId, functionId: input.functionId, action: 'approve', approvalId: saved.id, revision: saved.revision, digest: saved.digest };
  await command(request, { ...decide, idempotencyKey: key(), digest: '0'.repeat(64) }, 409);
  const accepted = await (await command(request, decide)).json();
  expect(accepted.replayed).toBe(false);
  const replay = await (await command(request, decide)).json();
  expect(replay.replayed).toBe(true);
  await command(request, { ...decide, idempotencyKey: key(), action: 'reject' }, 409);
  await command(request, { ...input, text: syntheticText('conflicting-command') }, 409);
  const state = await snapshot(request);
  expect(state.cases.find(item => item.id === input.caseId)!.approvals.find(item => item.id === saved.id)!.status).toBe('approved_demo');
});

test('API enforces role, case and function scopes and same-origin mutation', async ({ request }) => {
  await session(request, { role: 'viewer' });
  await snapshot(request);
  await command(request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'sales', action: 'draft', text: syntheticText('viewer') }, 403);
  await session(request, { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['sales'] });
  const scoped = await snapshot(request);
  expect(scoped.cases.map(item => item.id)).toEqual(['demo-aurora']);
  for (const row of [...scoped.cases[0].tasks, ...scoped.cases[0].approvals, ...scoped.cases[0].messages, ...scoped.cases[0].results, ...scoped.cases[0].history]) expect(row.functionId).toBe('sales');
  await command(request, { idempotencyKey: key(), caseId: 'demo-cedar', functionId: 'sales', action: 'chat', text: syntheticText('wrong-case') }, 403);
  await command(request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'finance', action: 'chat', text: syntheticText('wrong-function') }, 403);
  const forbiddenOrigin = await request.post(`${api}/commands`, { headers: { Origin: 'https://untrusted.invalid' }, data: { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: syntheticText('wrong-origin') } });
  expect(forbiddenOrigin.status()).toBe(403);
  const logout = await request.delete(`${api}/session`, { headers: { Origin: localOrigin } });
  expect(logout.status()).toBe(204);
  expect((await request.get(`${api}/snapshot`)).status()).toBe(401);
});

for (const action of ['draft', 'chat'] as const) {
  test('an unconfirmed ' + action + ' retries in place and clears only confirmed text', async ({ page }) => {
    await boot(page);
    if (action === 'draft') await openFunction(page, 'quality');
    const before = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
    const text = syntheticText('in-place-retry-' + action);
    const inputs: OfficeCommand[] = [];
    await page.route(/\/office-api\/commands?$/, async route => {
      const input = route.request().postDataJSON() as OfficeCommand;
      inputs.push(input);
      if (inputs.length === 1) return route.abort('failed');
      return route.continue();
    });
    const field = page.getByLabel(action === 'draft' ? 'Contenido del borrador' : 'Mensaje contextual');
    await field.fill(text);
    await page.getByRole('button', { name: action === 'draft' ? 'Preparar borrador' : 'Guardar pregunta', exact: true }).click();
    const surface = action === 'draft' ? workspace(page) : page;
    await expect(surface.getByRole('alert')).toContainText('No se han confirmado cambios');
    const retry = surface.getByRole('button', { name: 'Reintentar operación exacta', exact: true });
    await expect(retry).toBeEnabled();
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(surface.getByRole('region', { name: 'Operación sin confirmación', exact: true })).toHaveCount(0);
    await expect(field).toHaveValue('');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    const after = (await snapshot(page.request)).cases.find(item => item.id === before.id)!;
    expect(after.tasks).toHaveLength(before.tasks.length + 1);
    expect(after.history).toHaveLength(before.history.length + 1);
    if (action === 'draft') {
      expect(after.approvals.filter(item => item.body === 'DEMO — ' + text)).toHaveLength(1);
      await expect(workspace(page).locator('article[data-testid^="office-approval-"]').filter({ hasText: text })).toHaveCount(1);
    } else {
      expect(after.messages.filter(item => item.text === 'DEMO — ' + text)).toHaveLength(1);
      await expect(page.getByRole('button', { name: 'Guardar pregunta', exact: true })).toBeDisabled();
    }
  });
}

test('suggested draft opens its exact review and cancelling an edit writes nothing', async ({ page }) => {
  await boot(page);
  const original = syntheticText('suggested-review');
  const card = await draft(page, 'talent', original);
  const id = (await card.getAttribute('data-testid'))!;
  await closeWorkspace(page);
  await page.getByRole('button', { name: 'Seleccionar Calidad', exact: true }).click();
  const before = (await snapshot(page.request)).cases;
  await page.getByRole('button', { name: 'Ver borrador', exact: true }).click();
  const target = workspace(page).getByTestId(id);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  await expect(workspace(page).getByRole('heading', { name: 'Talento', exact: true })).toBeVisible();
  await target.getByRole('button', { name: 'Editar revisión 1', exact: true }).click();
  const cancelled = syntheticText('cancelled-edit');
  await target.getByLabel('Nuevo contenido de la revisión').fill(cancelled);
  await target.getByRole('button', { name: 'Cancelar edición', exact: true }).click();
  await expect(target).toContainText(original);
  await expect(target).not.toContainText(cancelled);
  expect((await snapshot(page.request)).cases).toEqual(before);
  await closeWorkspace(page);
  await page.getByRole('button', { name: 'Ver revisiones', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: /^Aprobaciones/ }).getByTestId(id)).toContainText(original);
});

test('a rapid double click and closing an in-flight drawer create one exact draft', async ({ page }) => {
  await boot(page);
  await openFunction(page, 'marketing');
  const before = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
  const text = syntheticText('double-click');
  const inputs: OfficeCommand[] = [];
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route(/\/office-api\/commands?$/, async route => {
    inputs.push(route.request().postDataJSON() as OfficeCommand);
    received();
    await held;
    return route.continue();
  });
  await page.getByLabel('Contenido del borrador').fill(text);
  try {
    await page.getByRole('button', { name: 'Preparar borrador', exact: true }).dblclick();
    await started;
    await expect(page.getByRole('button', { name: 'Preparar borrador', exact: true })).toBeDisabled();
    expect(inputs).toHaveLength(1);
    await closeWorkspace(page);
  } finally { release(); }
  await openFunction(page, 'marketing');
  await expect(workspace(page).locator('article[data-testid^="office-approval-"]').filter({ hasText: text })).toHaveCount(1);
  expect(inputs).toHaveLength(1);
  const after = (await snapshot(page.request)).cases.find(item => item.id === before.id)!;
  expect(after.approvals).toHaveLength(before.approvals.length + 1);
  expect(after.tasks).toHaveLength(before.tasks.length + 1);
  expect(after.history).toHaveLength(before.history.length + 1);
  expect(after.approvals.filter(item => item.body === 'DEMO — ' + text)).toHaveLength(1);
});

test('revision content is locked during confirmation and saves the exact reviewed text once', async ({ page }) => {
  await boot(page);
  const createdCard = await draft(page, 'quality');
  const id = (await createdCard.getAttribute('data-testid'))!.slice('office-approval-'.length);
  const card = workspace(page).getByTestId('office-approval-' + id);
  const original = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === id)!;
  await card.getByRole('button', { name: 'Editar revisión 1', exact: true }).click();
  const text = syntheticText('locked-revision');
  const content = card.getByLabel('Nuevo contenido de la revisión');
  await content.fill(text);
  const inputs: OfficeCommand[] = [];
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { received = resolve; });
  await page.route(/\/office-api\/commands?$/, async route => {
    inputs.push(route.request().postDataJSON() as OfficeCommand);
    received();
    await held;
    return route.continue();
  });
  try {
    await card.getByRole('button', { name: 'Guardar nueva revisión', exact: true }).click();
    await started;
    await expect(content).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Cancelar edición', exact: true })).toBeDisabled();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ action: 'revise', approvalId: id, revision: 1, digest: original.digest, text });
  } finally { release(); }
  await expect(content).toHaveCount(0);
  await expect(card).toContainText('DEMO — ' + text);
  await expect(card.getByRole('button', { name: 'Aprobar revisión 2', exact: true })).toBeEnabled();
  const saved = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === id)!;
  expect(saved).toMatchObject({ revision: 2, body: 'DEMO — ' + text, status: 'pending' });
  expect(saved.digest).not.toBe(original.digest);
  expect(inputs).toHaveLength(1);
});

test('failed and empty reads keep evidence honest and recover through refresh', async ({ page }) => {
  await boot(page);
  const before = await snapshot(page.request);
  let read: 'offline' | 'empty' | 'real' = 'offline';
  await page.route(/\/office-api\/snapshot$/, async route => {
    if (read === 'offline') return route.fulfill({ status: 503, json: { error: 'QA_SYNTHETIC_UNAVAILABLE' } });
    if (read === 'empty') return route.fulfill({ status: 200, json: { ...before, cases: [], note: 'DEMO · Lectura QA sintética sin casos.' } });
    return route.continue();
  });
  const menu = await openDemoMenu(page);
  await page.getByRole('button', { name: 'Actualizar oficina', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Se conserva la última lectura confirmada');
  await expect(page.getByLabel('Caso de demostración')).toHaveValue('demo-aurora');
  read = 'empty';
  await page.getByRole('button', { name: 'Actualizar oficina', exact: true }).click();
  await expect(page.getByLabel('Caso de demostración')).toBeDisabled();
  await menu.locator('summary').first().click();
  await expect(page.getByLabel('Mensaje contextual')).toBeDisabled();
  await showView(page, 'Dashboard');
  await expect(page.getByText('Métricas derivadas de 0 casos confirmados por la API. Esta muestra no mide resultados del negocio.', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Dashboard', exact: true }).locator('.sla-value')).toContainText('Sin muestra');
  await showView(page, 'Historial');
  await expect(page.getByRole('heading', { name: 'No hay registros confirmados', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nueva tarea', exact: true }).click();
  await expect(workspace(page).getByRole('heading', { name: 'Sin casos confirmados', exact: true })).toBeVisible();
  await expect(page.getByLabel('Contenido del borrador')).toHaveCount(0);
  await closeWorkspace(page);
  read = 'real';
  const recoveredMenu = await openDemoMenu(page);
  await page.getByRole('button', { name: 'Actualizar oficina', exact: true }).click();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  await recoveredMenu.locator('summary').first().click();
  await openFunction(page, 'finance');
  await expect(page.getByLabel('Contenido del borrador')).toBeEnabled();
  expect((await snapshot(page.request)).cases).toEqual(before.cases);
});

test('UI permissions follow server case and function scopes and expire while idle', async ({ page }) => {
  const auth = await session(page.request, { role: 'operator', caseIds: ['demo-cedar'], functionIds: ['finance'] });
  await page.goto('/office/');
  await expect(page.getByText('Operador · DEMO', { exact: true })).toBeVisible();
  const before = (await snapshot(page.request)).cases;
  const menu = await openDemoMenu(page);
  expect(await page.getByLabel('Caso de demostración').locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['demo-cedar']);
  await menu.locator('summary').first().click();
  await openFunction(page, 'quality');
  await expect(page.getByLabel('Contenido del borrador')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preparar borrador', exact: true })).toBeDisabled();
  await openFunction(page, 'finance');
  await expect(page.getByLabel('Contenido del borrador')).toBeEnabled();
  await closeWorkspace(page);
  await expect(page.getByLabel('Mensaje contextual')).toBeEnabled();
  // Clamp only the browser's returned capability expiry; the server scope is real.
  await page.clock.install();
  const expiresAt = new Date(Date.now() + 10_000).toISOString();
  await page.route(/\/office-api\/session$/, route => route.fulfill({ status: 200, json: { ...auth, expiresAt } }));
  await page.reload();
  await openFunction(page, 'finance');
  await closeWorkspace(page);
  await expect(page.getByLabel('Mensaje contextual')).toBeEnabled();
  await page.clock.fastForward(31_000);
  await expect(page.getByText('Sesión DEMO pendiente', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Mensaje contextual')).toBeDisabled();
  await openFunction(page, 'finance');
  await expect(page.getByRole('button', { name: 'Preparar borrador', exact: true })).toBeDisabled();
  expect((await snapshot(page.request)).cases).toEqual(before);
});

for (const group of [functions.slice(0, 3), functions.slice(3, 6), functions.slice(6, 9)]) {
  test('local DEMO scripts complete review without external execution: ' + group.map(item => item.id).join(', '), async ({ page }, testInfo) => {
    // Three complete workflows include four writes each and durable UI reloads.
    test.setTimeout(75_000);
    await boot(page);
    const before = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
    const approved: Array<{ id: string; functionId: FunctionId; text: string; digest: string; originalReference: string; question: string }> = [];
    for (const item of group) {
      await openFunction(page, item.id);
      await closeWorkspace(page);
      const question = syntheticText('complete-chat-' + item.id);
      await page.getByLabel('Mensaje contextual').fill(question);
      await page.getByRole('button', { name: 'Guardar pregunta', exact: true }).click();
      await expect(page.getByText('DEMO — ' + question, { exact: true })).toBeVisible();
      await openFunction(page, item.id);
      await page.getByLabel('Contenido del borrador').fill('');
      const createdResponse = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
      await page.getByRole('button', { name: 'Preparar borrador', exact: true }).click();
      const created = (await (await createdResponse).json()).snapshot as OfficeSnapshot;
      const saved = created.cases.find(row => row.id === before.id)!.approvals.find(approval => approval.functionId === item.id && !before.approvals.some(old => old.id === approval.id))!;
      expect(saved.body).toMatch(/^DEMO — Respuesta guionada local.*sin LLM/);
      expect(saved.status).toBe('pending');
      const card = workspace(page).getByTestId('office-approval-' + saved.id);
      await expect(card).toContainText('envío bloqueado');
      await card.getByRole('button', { name: 'Editar revisión 1', exact: true }).click();
      const text = syntheticText('complete-revision-' + item.id);
      await card.getByLabel('Nuevo contenido de la revisión').fill(text);
      const revisedResponse = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
      await card.getByRole('button', { name: 'Guardar nueva revisión', exact: true }).click();
      const revisedSnapshot = (await (await revisedResponse).json()).snapshot as OfficeSnapshot;
      const revised = revisedSnapshot.cases.find(row => row.id === before.id)!.approvals.find(approval => approval.id === saved.id)!;
      expect(revised).toMatchObject({ status: 'pending', revision: 2, body: 'DEMO — ' + text });
      expect(revised.digest).not.toBe(saved.digest);
      await card.getByRole('button', { name: 'Aprobar revisión 2', exact: true }).click();
      await expect(card).toContainText('Aprobado DEMO');
      approved.push({ id: saved.id, functionId: item.id, text, digest: revised.digest, originalReference: saved.evidence.reference, question });
      await page.reload();
      await openFunction(page, item.id);
      const persisted = workspace(page).getByTestId('office-approval-' + saved.id);
      await expect(persisted).toContainText('Aprobado DEMO');
      await expect(persisted).toContainText(text);
      await expect(persisted.locator('.digest code')).toHaveText(revised.digest);
    }
    await showView(page, 'Historial');
    await expect(page.getByRole('tabpanel', { name: 'Historial', exact: true }).getByRole('heading', { name: 'Aprobación registrada · DEMO', exact: true }).first()).toBeVisible();
    const latestHistory = await page.getByRole('tabpanel', { name: 'Historial', exact: true }).locator('.history-list > li').evaluateAll(rows => rows.slice(0, 12).map(row => ({ function: row.querySelector('.eyebrow')?.textContent ?? '', title: row.querySelector('h3')?.textContent ?? '' })));
    for (const item of group) {
      for (const title of ['Chat guionado guardado · DEMO', 'Borrador preparado · DEMO', 'Nueva revisión · DEMO', 'Aprobación registrada · DEMO']) {
        expect(latestHistory.some(row => row.function.startsWith(item.label + ' · ') && row.title === title)).toBe(true);
      }
    }
    const after = (await snapshot(page.request)).cases.find(item => item.id === before.id)!;
    for (const item of approved) {
      const saved = after.approvals.find(approval => approval.id === item.id)!;
      expect(saved).toMatchObject({ functionId: item.functionId, status: 'approved_demo', revision: 2, body: 'DEMO — ' + item.text, digest: item.digest });
      expect(after.tasks.find(task => task.evidence.reference === saved.evidence.reference)?.status).toBe('blocked');
      expect(after.tasks.find(task => task.evidence.reference === item.originalReference)?.status).toBe('stale');
      expect(after.results.find(result => result.evidence.reference === saved.evidence.reference)?.detail).toContain('envío y ejecución externa siguen bloqueados');
      const question = after.messages.find(message => message.text === 'DEMO — ' + item.question)!;
      expect(question).toMatchObject({ functionId: item.functionId });
      expect(after.messages.find(message => message.evidence.reference === question.evidence.reference + ':response')?.text).toMatch(/Respuesta guionada local.*sin LLM/);
      expect(after.history.filter(row => row.functionId === item.functionId)).toHaveLength(before.history.filter(row => row.functionId === item.functionId).length + 4);
    }
    expect(after).toMatchObject({ payment: before.payment, supplier: before.supplier, saleClosed: before.saleClosed, paymentEvidence: before.paymentEvidence, supplierEvidence: before.supplierEvidence });
    await testInfo.attach('review-workflow-synthetic', { body: JSON.stringify({ approved, outboundEffects: 0, mondayWrites: 0, payment: after.payment, supplier: after.supplier, saleClosed: after.saleClosed }, null, 2), contentType: 'application/json' });
  });
}

test('selected commercial thread binds an unsent internal reply through revision and approval', async ({ page }) => {
  await boot(page);
  await openFunction(page, 'sales');
  const initial = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
  const thread = initial.commercialThreads!.find(item => item.id === 'commercial-demo-aurora-followup')!;
  expect(thread).toBeDefined();
  const inbox = page.getByTestId('commercial-inbox');
  await expect(inbox).toContainText('Gmail y Monday están desconectados');
  await expect(inbox).toContainText('Gmail · FALTANTE');
  await expect(inbox).toContainText('Monday · FALTANTE');
  await page.getByLabel('Hilo comercial simulado').selectOption(thread.id);
  await expect(page.getByTestId('commercial-thread-context')).toContainText(thread.subject);
  await selectCase(page, 'demo-cedar');
  await openFunction(page, 'sales');
  await expect(page.getByLabel('Hilo comercial simulado')).toHaveValue('commercial-demo-cedar-brief');
  await expect(page.getByTestId('commercial-thread-context')).not.toContainText(thread.recipient);
  await selectCase(page, 'demo-aurora');
  await openFunction(page, 'sales');
  await expect(page.getByLabel('Hilo comercial simulado')).toHaveValue('commercial-demo-aurora-brief');
  await page.getByLabel('Hilo comercial simulado').selectOption(thread.id);
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'sales', action: 'draft', commercialThreadId: thread.id, commercialThreadRevision: thread.revision, commercialThreadDigest: '0'.repeat(64) }, 409);
  const createdResponse = page.waitForResponse(response => /\/office-api\/commands?$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preparar respuesta interna', exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(200);
  const input = response.request().postDataJSON() as OfficeCommand;
  expect(input).toMatchObject({ caseId: 'demo-aurora', functionId: 'sales', action: 'draft', commercialThreadId: thread.id, commercialThreadRevision: thread.revision, commercialThreadDigest: thread.digest });
  expect(Object.hasOwn(input, 'text')).toBe(false);
  const created = (await response.json()).snapshot as OfficeSnapshot;
  const previousIds = new Set(initial.approvals.map(item => item.id));
  const approval = created.cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => !previousIds.has(item.id))!;
  expect(approval.commercialContext).toEqual(thread);
  const card = page.getByTestId(`office-approval-${approval.id}`);
  await expect(card).toContainText('Borrador interno · sin enviar');
  await expect(card).toContainText(thread.recipient);
  await card.getByTestId('approval-commercial-context').locator('summary').first().click();
  await expect(card.getByTestId('approval-commercial-context')).toContainText(thread.subject);
  await expect(card.getByTestId('approval-commercial-context')).toContainText(thread.digest);
  await expect(card.getByTestId('approval-commercial-context')).toContainText('Gmail · FALTANTE');
  for (const message of thread.messages) await expect(card.getByTestId('approval-commercial-context')).toContainText(message.text);
  await page.getByLabel('Hilo comercial simulado').selectOption('commercial-demo-aurora-brief');
  await expect(page.getByTestId('commercial-thread-context')).not.toContainText(thread.subject);
  await expect(card.getByTestId('approval-commercial-context')).toContainText(thread.subject);
  await card.getByRole('button', { name: 'Editar revisión 1', exact: true }).click();
  const revisedText = syntheticText('commercial-exact-review');
  await page.getByLabel('Nuevo contenido de la revisión').fill(revisedText);
  await page.getByRole('button', { name: 'Guardar nueva revisión', exact: true }).click();
  await expect(card).toContainText(revisedText);
  for (const message of thread.messages) await expect(card.getByTestId('approval-commercial-context')).toContainText(message.text);
  await expect(card.getByRole('button', { name: 'Aprobar revisión 2', exact: true })).toBeEnabled();
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-aurora', functionId: 'sales', action: 'approve', approvalId: approval.id, revision: approval.revision, digest: approval.digest }, 409);
  await card.getByRole('button', { name: 'Aprobar revisión 2', exact: true }).click();
  await expect(card).toContainText('Aprobado DEMO');
  const saved = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!;
  expect(saved.approvals.find(item => item.id === approval.id)).toMatchObject({ revision: 2, status: 'approved_demo', body: `DEMO — ${revisedText}`, commercialContext: thread });
  expect(saved.history).toHaveLength(initial.history.length + 3);
  await showView(page, 'Historial');
  await expect(page.getByRole('heading', { name: 'Aprobación registrada · DEMO', exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  await openFunction(page, 'sales');
  await expect(page.getByTestId(`office-approval-${approval.id}`)).toContainText('Aprobado DEMO');
  await expect(page.getByTestId(`office-approval-${approval.id}`).getByTestId('approval-commercial-context')).toContainText(thread.digest);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
