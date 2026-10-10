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
  await page.getByLabel('Caso de demostración').selectOption('demo-aurora');
}

async function openFunction(page: Page, id: FunctionId) {
  const selected = functions.find(item => item.id === id)!;
  await page.getByRole('button', { name: selected.label, exact: true }).click();
  await page.getByRole('tab', { name: 'Espacio de trabajo', exact: true }).click();
}

async function draft(page: Page, id: FunctionId, text = syntheticText(id)): Promise<Locator> {
  await openFunction(page, id);
  await page.getByLabel('Contenido del borrador').fill(text);
  const response = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preparar borrador', exact: true }).click();
  expect((await response).status()).toBe(200);
  const card = page.locator('article[data-testid^="office-approval-"]').filter({ hasText: text });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('cliente-demo@invalid.test');
  await expect(card).toContainText('Gourmet · cuenta de demostración');
  await expect(card.locator('.digest code')).toHaveText(/^[a-f0-9]{64}$/);
  return card;
}

test('requires PostgreSQL and a real development session, with synthetic evidence only', async ({ page, request }) => {
  const health = await request.get(`${api}/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 });

  const unauthorized = await request.get(`${api}/snapshot`);
  expect(unauthorized.status()).toBe(401);
  await page.goto('/office/');
  await expect(page.getByLabel('Permiso de sesión')).toHaveValue('viewer');
  await page.getByRole('button', { name: 'Abrir sesión de desarrollo', exact: true }).click();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  const viewerSession = await page.request.get(`${api}/session`);
  expect(await viewerSession.json()).toMatchObject({ role: 'viewer', actorId: 'OFFICE_DEMO_OPERATOR' });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.getByText(/^Sin LLM conectado\./)).toBeVisible();
  const state = await snapshot(page.request);
  expect(state.cases.map(item => item.id)).toEqual(['demo-aurora', 'demo-cedar', 'demo-harbor']);
  expect(state.note).toMatch(/DEMOSTRACIÓN/);
});

test('all nine functions save a contextual chat and a human-review draft', async ({ page }) => {
  await boot(page);
  for (const item of functions) {
    await openFunction(page, item.id);
    const text = syntheticText(`chat-${item.id}`);
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
    expect(selected.messages.some(message => message.functionId === item.id && message.text.includes(`chat-${item.id}`))).toBe(true);
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
  await expect(page.getByRole('alert')).toContainText(/cambi|revisi|conflic/i);
  const current = (await snapshot(page.request)).cases.find(item => item.id === 'demo-aurora')!.approvals.find(item => item.id === saved.id)!;
  expect(current).toMatchObject({ revision: 2, status: 'pending', body: `DEMO — ${updatedText}` });
  await page.getByRole('button', { name: 'Actualizar oficina', exact: true }).click();
  await expect(page.getByTestId(`office-approval-${saved.id}`)).toContainText(updatedText);
});

test('case navigation keeps payment, supplier acceptance and human sale independent', async ({ page }) => {
  await boot(page);
  await page.getByLabel('Caso de demostración').selectOption('demo-harbor');
  await openFunction(page, 'suppliers');
  await expect(page.getByRole('button', { name: 'Preparar borrador', exact: true })).toBeDisabled();
  await expect(page.getByText(/cerrar la venta humana|cierre humano/i).first()).toBeVisible();
  await command(page.request, { idempotencyKey: key(), caseId: 'demo-harbor', functionId: 'suppliers', action: 'draft', text: syntheticText('blocked-supplier') }, 403);
  const state = await snapshot(page.request);
  expect(state.cases.find(item => item.id === 'demo-aurora')).toMatchObject({ payment: 'verified', supplier: 'pending', saleClosed: true });
  expect(state.cases.find(item => item.id === 'demo-cedar')).toMatchObject({ payment: 'pending', supplier: 'accepted', saleClosed: true });
  expect(state.cases.find(item => item.id === 'demo-harbor')).toMatchObject({ saleClosed: false, assignment: 'queued', closerAvailable: false });
  await page.getByLabel('Caso de demostración').selectOption('demo-cedar');
  await draft(page, 'finance');
});

test('dashboard and history present synthetic coverage and saved work without overflow', async ({ page }, testInfo) => {
  await boot(page);
  await draft(page, 'talent', syntheticText('history-coverage'));
  await page.getByRole('tab', { name: 'Historial', exact: true }).click();
  await expect(page.getByText('Borrador preparado · DEMO', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/sintétic|DEMOSTRACIÓN|DEMO/i).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Una lectura con cobertura.', exact: true })).toBeVisible();
  await expect(page.getByText('MUESTRA SINTÉTICA · DEMO', { exact: true })).toBeVisible();
  await expect(page.getByText('Métricas derivadas de 3 casos confirmados por la API. Esta muestra no mide resultados del negocio.', { exact: true })).toBeVisible();
  await expect(page.getByText('Cobertura: 1/3 casos con contacto humano sintético. 2/3 con intento acreditado.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Periodo observado/)).toBeVisible();
  await expect(page.getByRole('cell', { name: '35 s', exact: true })).toBeVisible();
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.width);
  await page.screenshot({ path: testInfo.outputPath('office-dashboard-synthetic.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Espacio de trabajo', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('office-workspace-synthetic.png'), fullPage: true });
});

test('keyboard can select a function, save a draft and reach a decision at 320px', async ({ page }) => {
  await boot(page);
  const functionButton = page.getByRole('button', { name: 'Calidad', exact: true });
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
  await expect(page.getByRole('alert')).toContainText(/conexión|confirm|respuesta/i);
  expect(observed).toHaveLength(1);
  expect(committedSnapshot).toBeDefined();
  const committedCase = committedSnapshot!.cases.find(item => item.id === before.id)!;
  const saved = committedCase.approvals.filter(item => item.body.includes(text));
  expect(saved).toHaveLength(1);
  expect(committedCase.tasks).toHaveLength(before.tasks.length + 1);
  expect(committedCase.history).toHaveLength(before.history.length + 1);
  const retryResponse = page.waitForResponse(res => /\/office-api\/commands?$/.test(res.url()) && res.request().method() === 'POST');
  await page.getByRole('button', { name: /^Reintentar/ }).click();
  const retried = await retryResponse;
  expect(retried.status()).toBe(200);
  expect((await retried.json()).replayed).toBe(true);
  expect(observed).toHaveLength(2);
  expect(observed[1]).toEqual(observed[0]);
  await expect(page.getByTestId(`office-approval-${saved[0].id}`)).toContainText(text);
  await page.reload();
  await openFunction(page, 'talent');
  const persisted = (await snapshot(page.request)).cases.find(item => item.id === before.id)!;
  expect(persisted.approvals.filter(item => item.body.includes(text))).toHaveLength(1);
  expect(persisted.tasks).toHaveLength(before.tasks.length + 1);
  expect(persisted.history).toHaveLength(before.history.length + 1);
  await expect(page.getByTestId(`office-approval-${saved[0].id}`)).toContainText(text);
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
  await page.getByLabel('Caso de demostración').selectOption('demo-cedar');
  await expect(page.getByLabel('Hilo comercial simulado')).toHaveValue('commercial-demo-cedar-brief');
  await expect(page.getByTestId('commercial-thread-context')).not.toContainText(thread.recipient);
  await page.getByLabel('Caso de demostración').selectOption('demo-aurora');
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
  await page.getByRole('tab', { name: 'Historial', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aprobación registrada · DEMO', exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Caso de demostración')).toBeEnabled();
  await expect(page.getByTestId(`office-approval-${approval.id}`)).toContainText('Aprobado DEMO');
  await expect(page.getByTestId(`office-approval-${approval.id}`).getByTestId('approval-commercial-context')).toContainText(thread.digest);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
