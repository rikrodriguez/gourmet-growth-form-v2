import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Actual Vite UI and guarded local API/isolated PostgreSQL, not mocked successes.
// Response interception below is limited to intentional failure/late-read tests.
async function open(page: Page) {
  await page.goto('/office/dashboard');
  await expect(page.getByTestId('dashboard-metric-opportunities')).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function seedReview(context: BrowserContext, approve = false) {
  const request = context.request;
  const headers = { Origin: 'http://127.0.0.1:4175' };
  let response = await request.post('/office-api/communications/session', { headers, data: {} });
  expect(response.status()).toBe(200); let view = await response.json();
  const mutationHeaders = { ...headers, 'x-communications-csrf': view.session.csrfToken };
  response = await request.post('/office-api/communications/associations', { headers: mutationHeaders, data: { expectedRevision: view.workflow.revision, id: 'dashboard-browser-link', ...view.workflow.candidates[0], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:explicit-synthetic-test-review' } });
  expect(response.status()).toBe(200); view = await response.json();
  response = await request.post('/office-api/communications/drafts', { headers: mutationHeaders, data: { expectedRevision: view.workflow.revision, id: 'dashboard-browser-draft', associationId: 'dashboard-browser-link', purpose: 'reply', to: ['aurora@example.test'], cc: [], bcc: [], subject: 'Propuesta de prueba sin enviar', bodyText: 'Contenido sintético exacto del borrador', bodyHtml: null, attachments: [] } });
  expect(response.status()).toBe(200); view = await response.json();
  if (approve) {
    const draft = view.workflow.drafts.at(-1);
    response = await request.post('/office-api/communications/approvals', { headers: mutationHeaders, data: { expectedRevision: view.workflow.revision, id: 'dashboard-browser-approval', draftId: draft.id, draftRevision: draft.revision, draftDigest: draft.digest } });
    expect(response.status()).toBe(200); view = await response.json();
  }
  return view;
}

test('dashboard is separate, synthetic, readable and does not start a session or fetch provider data', async ({ page }) => {
  const apiRequests: string[] = []; const external: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/office-api/')) apiRequests.push(`${request.method()} ${url.pathname}`); if (!['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(url.origin); });
  await open(page); await expect(page.getByTestId('dashboard-provenance')).toContainText('muestra local sintética');
  await expect(page.getByTestId('dashboard-metric-opportunities')).toContainText('4');
  for (const id of ['pipeline', 'conversion']) await expect(page.getByTestId(`dashboard-metric-${id}`)).toContainText('—');
  await expect(page.getByTestId('dashboard-revenue-history')).toContainText('—');
  await expect(page.getByTestId('dashboard-read-reviews')).toBeEnabled(); await noOverflow(page);
  expect(apiRequests).toEqual([]); expect(external).toEqual([]);
  await expect(page.getByRole('link', { name: 'Oficina', exact: true })).toHaveAttribute('href', '/office/');
  await expect(page.locator('.approved-office-scene')).toHaveCount(0);
});

test('read-only Kanban keeps missing fields explicit and card selection cannot mutate stages', async ({ page }) => {
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.method()); });
  await open(page); await page.getByRole('button', { name: 'Oportunidades', exact: true }).click();
  await expect(page.getByTestId('dashboard-opportunity')).toHaveCount(4);
  await expect(page.getByText('Importe sin verificar')).toHaveCount(4);
  await expect(page.getByText('Sin fecha verificada', { exact: true })).toBeVisible();
  expect(await page.getByTestId('dashboard-opportunity').first().getAttribute('draggable')).not.toBe('true');
  await noOverflow(page); expect(writes).toEqual([]);
});

test('inbox filters preserve mailbox identity and disclose absent social connections', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Bandeja', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('info@example.test');
  await page.getByRole('button', { name: /La misma consulta en otro buzón/ }).click();
  await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('felipe@example.test');
  for (const channel of ['Instagram', 'Messenger']) { await page.getByRole('button', { name: new RegExp(`^${channel}`) }).click(); await expect(page.getByRole('heading', { name: `${channel} pendiente de conexión` })).toBeVisible(); await expect(page.getByText('La bandeja real no se ha consultado.', { exact: false })).toBeVisible(); }
  await page.getByRole('button', { name: /^Formulario web/ }).click(); await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('No acredita una importación'); await noOverflow(page);
});

test('sources distinguish sample cut from unverified providers and refresh does not pretend a new cut', async ({ page }) => {
  await open(page); const before = await page.getByTestId('dashboard-provenance').innerText();
  await page.getByTestId('dashboard-refresh').click(); await expect(page.getByTestId('dashboard-provenance')).toHaveText(before, { useInnerText: true });
  await page.getByRole('button', { name: 'Fuentes', exact: true }).click();
  await expect(page.getByText('Sin configurar', { exact: true })).toHaveCount(8);
  await expect(page.getByText('Sin verificación', { exact: true })).toHaveCount(8); await noOverflow(page);
});

test('explicit queue read without a session shows unknown rather than zero and never starts one', async ({ page }) => {
  const calls: string[] = []; page.on('request', r => { if (r.url().includes('/office-api/communications')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await open(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByRole('alert')).toContainText('No hay una sesión local vigente');
  await expect(page.getByText('Sin pendientes en esta cola sintética consultada.')).toHaveCount(0);
  expect(calls).toEqual(['GET /office-api/communications']);
});

test('queue projects real local saved draft and links to exact review without preserving approval or selection', async ({ page, context }) => {
  const view = await seedReview(context); const before = view.workflow.revision;
  await open(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByText('Necesita revisión', { exact: false })).toBeVisible();
  await expect(page.getByText('aurora@example.test · Buzón felipe@example.test')).toBeVisible();
  const latest = await (await context.request.get('/office-api/communications', { headers: { Origin: 'http://127.0.0.1:4175' } })).json();
  expect(latest.workflow.revision).toBe(before); expect(latest.workflow.outbox).toEqual([]);
  await page.getByRole('link', { name: 'Revisar en Comunicaciones: Propuesta de prueba sin enviar' }).click();
  await expect(page).toHaveURL(/\/office\/communications$/);
  await expect(page.getByRole('region', { name: 'Sesión y almacenamiento' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Aprobar revisión/ })).toHaveCount(0);
  await page.goBack(); await page.getByTestId('dashboard-refresh').click();
  await expect(page.getByText('Aún no consultada.', { exact: false })).toBeVisible();
});

test('failed refresh removes a previously verified approval instead of leaving readiness visible', async ({ page, context }) => {
  await seedReview(context, true); await open(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByText('Aprobado en la muestra · no enviado', { exact: false })).toBeVisible();
  await page.route('**/office-api/communications', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_read_unavailable' }) }));
  await page.getByTestId('dashboard-read-reviews').click(); await expect(page.getByRole('alert')).toContainText('pendientes son desconocidos');
  await expect(page.getByText('Aprobado en la muestra · no enviado', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Revisar en Comunicaciones:/ })).toHaveCount(0);
});

test('pagehide withdraws data and a late read cannot repopulate the queue', async ({ page, context }) => {
  await seedReview(context); await open(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let settled!: () => void; const settledPromise = new Promise<void>(resolve => { settled = resolve; });
  await page.route('**/office-api/communications', async route => { const response = await route.fetch(); entered(); await gate; try { await route.fulfill({ response }); } catch { /* Page withdrawal may have aborted the read. */ } finally { settled(); } });
  await page.getByTestId('dashboard-read-reviews').click(); await enteredPromise;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); release();
  await settledPromise;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('status')).toContainText('vista se retiró');
  await expect(page.getByRole('link', { name: /Revisar en Comunicaciones:/ })).toHaveCount(0);
  await page.getByTestId('dashboard-refresh').click(); await expect(page.getByText('Aún no consultada.', { exact: false })).toBeVisible();
});

test('15-minute display expiry clears queue and requires an explicit new load', async ({ page, context }) => {
  await seedReview(context); await page.clock.install(); await open(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByText('Necesita revisión', { exact: false })).toBeVisible();
  await page.clock.runFor(15 * 60_000 + 1000);
  await expect(page.getByRole('status')).toContainText('vista venció'); await expect(page.getByRole('link', { name: /Revisar en Comunicaciones:/ })).toHaveCount(0);
  await page.getByTestId('dashboard-refresh').click(); await expect(page.getByTestId('dashboard-metric-opportunities')).toBeVisible(); await expect(page.getByText('Aún no consultada.', { exact: false })).toBeVisible();
});

test('keyboard navigation has named controls, visible focus, and separate Office route with preserved operational tabs', async ({ page }) => {
  await open(page); await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.locator('#gd-main')).toBeFocused();
  await page.getByRole('link', { name: 'Oficina', exact: true }).click();
  await expect(page.locator('.approved-office-scene')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Operaciones', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('href', '/office/dashboard');
  await page.getByRole('tab', { name: 'Mi oficina', exact: true }).focus(); await page.keyboard.press('End'); await expect(page.getByRole('tab', { name: 'Historial', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('tab', { name: 'Mi oficina', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click(); await expect(page.getByTestId('dashboard-metric-opportunities')).toBeVisible(); await noOverflow(page);
});
