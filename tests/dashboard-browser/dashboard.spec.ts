import { test, expect, type Page, type BrowserContext, type TestInfo } from '@playwright/test';

// Actual Vite UI and guarded local API/isolated PostgreSQL, not mocked successes.
// Response interception below is limited to intentional failure/late-read tests.
async function open(page: Page) {
  await page.goto('/office/dashboard');
  await expect(page.getByTestId('approved-metric-opportunities')).toBeVisible();
}
async function showNavigation(page: Page) {
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  if (await menu.isVisible()) await menu.click();
}
async function navigate(page: Page, name: string) {
  await showNavigation(page);
  await page.locator('.ga-sidebar').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}
async function openReviews(page: Page) {
  await navigate(page, 'Revisión local');
  await expect(page.getByTestId('dashboard-read-reviews')).toBeEnabled();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function showProvenance(page: Page) {
  const details = page.locator('.ga-read-status');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  await expect(page.getByTestId('dashboard-provenance')).toBeVisible();
}
async function captureSyntheticView(page: Page, testInfo: TestInfo, section: 'overview' | 'opportunities' | 'inbox' | 'sources') {
  const disclosure = page.locator('.ga-read-status[open]');
  if (await disclosure.count()) await disclosure.locator('summary').click();
  await expect(page.locator('.gd-skip')).not.toBeFocused();
  await expect(page.locator('.gd-skip')).toHaveCSS('clip-path', 'inset(50%)');
  await page.evaluate(() => document.fonts.ready);
  // Capture the same top-of-page state, including sticky navigation.
  await page.evaluate(() => { window.scrollTo(0, 0); const sidebar = document.querySelector('.ga-sidebar'); if (sidebar) sidebar.scrollTop = 0; });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `test-results/dashboard-visual/${testInfo.project.name}-${section}.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
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

test('dashboard is separate, synthetic, readable and does not start a session or fetch provider data', async ({ page }, testInfo) => {
  const apiRequests: string[] = []; const external: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/office-api/')) apiRequests.push(`${request.method()} ${url.pathname}`); if (!['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(url.origin); });
  await open(page); await showProvenance(page); await expect(page.getByTestId('dashboard-provenance')).toContainText('muestra local sintética');
  await expect(page.getByTestId('approved-metric-opportunities')).toContainText('4');
  for (const id of ['pipeline', 'conversion']) await expect(page.getByTestId(`approved-metric-${id}`)).toContainText('—');
  await expect(page.getByTestId('approved-revenue-history')).toContainText('—');
  await expect(page.getByTestId('approved-dashboard-disclosure')).toContainText('Datos reales desconocidos');
  await expect(page.getByTestId('approved-revenue-bar')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-read-reviews')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-provenance')).toContainText('Corte:');
  await expect(page.getByTestId('dashboard-provenance')).toContainText('Cobertura: parcial; datos reales desconocidos');
  await expect(page.getByTestId('dashboard-provenance')).toContainText('sin conexión a proveedores');
  await noOverflow(page);
  await showNavigation(page);
  await expect(page.getByRole('link', { name: 'Oficina', exact: true })).toHaveAttribute('href', '/office/');
  await expect(page.locator('.approved-office-scene')).toHaveCount(0);
  await openReviews(page);
  await navigate(page, 'Dashboard');
  const demo = page.getByTestId('dashboard-visual-mode');
  await expect(demo).toHaveAttribute('aria-pressed', 'false');
  await demo.click();
  await expect(page.getByTestId('approved-dashboard-summary')).toHaveAttribute('data-visual-demo', 'true');
  await expect(page.getByTestId('approved-metric-pipeline')).toContainText('18.400');
  await expect(page.getByTestId('approved-metric-contacts')).toContainText('38');
  await expect(page.getByTestId('approved-metric-conversion')).toContainText('68%');
  await expect(page.getByTestId('approved-revenue-bar')).toHaveCount(6);
  await expect(page.getByTestId('approved-dashboard-disclosure')).toContainText('Cifras ficticias');
  await noOverflow(page);
  await captureSyntheticView(page, testInfo, 'overview');
  await demo.click();
  await expect(page.getByTestId('approved-metric-pipeline')).toContainText('—');
  await expect(page.getByTestId('approved-revenue-bar')).toHaveCount(0);
  expect(apiRequests).toEqual([]); expect(external).toEqual([]);
});

test('read-only Kanban keeps missing fields explicit and card selection cannot mutate stages', async ({ page }, testInfo) => {
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.method()); });
  await open(page); await navigate(page, 'Oportunidades');
  await expect(page.getByTestId('dashboard-opportunity')).toHaveCount(4);
  await expect(page.getByText('Importe sin verificar')).toHaveCount(4);
  await expect(page.getByText('Sin fecha verificada', { exact: true })).toBeVisible();
  expect(await page.getByTestId('dashboard-opportunity').first().getAttribute('draggable')).not.toBe('true');
  await noOverflow(page); expect(writes).toEqual([]);
  const countWidth = await page.locator('.gd-section-toolbar > p').evaluate(element => element.getBoundingClientRect().width);
  expect(countWidth).toBeGreaterThanOrEqual(140);
  await captureSyntheticView(page, testInfo, 'opportunities');
});

test('inbox filters preserve mailbox identity and disclose absent social connections', async ({ page }, testInfo) => {
  await open(page); await navigate(page, 'Bandeja');
  await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('info@example.test');
  await page.getByRole('button', { name: /La misma consulta en otro buzón/ }).click();
  await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('felipe@example.test');
  const reviewPanel = page.getByRole('region', { name: 'Contexto de revisión de respuesta' });
  await expect(reviewPanel).toContainText('Sin vinculación verificada');
  const reviewLink = reviewPanel.getByRole('link', { name: 'Revisar en Comunicaciones' });
  await expect(reviewLink).toHaveAttribute('href', '/office/communications');
  expect((await reviewLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await captureSyntheticView(page, testInfo, 'inbox');
  for (const channel of ['Instagram', 'Messenger']) { await page.getByRole('button', { name: new RegExp(`^${channel}`) }).click(); await expect(page.getByRole('heading', { name: `${channel} pendiente de conexión` })).toBeVisible(); await expect(page.getByText('La bandeja real no se ha consultado.', { exact: false })).toBeVisible(); }
  await page.getByRole('button', { name: /^Formulario web/ }).click(); await expect(page.getByRole('article', { name: 'Detalle de la conversación' })).toContainText('No acredita una importación'); await noOverflow(page);
});

test('sources distinguish sample cut from unverified providers and refresh does not pretend a new cut', async ({ page }, testInfo) => {
  await open(page); await showProvenance(page); const before = await page.getByTestId('dashboard-provenance').innerText();
  await page.getByTestId('dashboard-refresh').click(); await expect(page.getByTestId('dashboard-provenance')).toHaveText(before, { useInnerText: true });
  await navigate(page, 'Fuentes');
  await expect(page.getByText('Sin configurar', { exact: true })).toHaveCount(8);
  await expect(page.getByText('Sin verificación', { exact: true })).toHaveCount(8); await noOverflow(page);
  await captureSyntheticView(page, testInfo, 'sources');
});

test('explicit queue read without a session shows unknown rather than zero and never starts one', async ({ page }) => {
  const calls: string[] = []; page.on('request', r => { if (r.url().includes('/office-api/communications')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await open(page); await openReviews(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByRole('alert')).toContainText('No hay una sesión local vigente');
  await expect(page.getByText('Sin pendientes en esta cola sintética consultada.')).toHaveCount(0);
  expect(calls).toEqual(['GET /office-api/communications']);
});

test('queue projects real local saved draft and links to exact review without preserving approval or selection', async ({ page, context }) => {
  const view = await seedReview(context); const before = view.workflow.revision;
  await open(page); await openReviews(page); await page.getByTestId('dashboard-read-reviews').click();
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
  await seedReview(context, true); await open(page); await openReviews(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByText('Aprobado en la muestra · no enviado', { exact: false })).toBeVisible();
  await page.route('**/office-api/communications', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_read_unavailable' }) }));
  await page.getByTestId('dashboard-read-reviews').click(); await expect(page.getByRole('alert')).toContainText('pendientes son desconocidos');
  await expect(page.getByText('Aprobado en la muestra · no enviado', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Revisar en Comunicaciones:/ })).toHaveCount(0);
});

test('pagehide withdraws data and a late read cannot repopulate the queue', async ({ page, context }) => {
  await seedReview(context); await open(page); await openReviews(page);
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
  await seedReview(context); await page.clock.install(); await open(page); await openReviews(page); await page.getByTestId('dashboard-read-reviews').click();
  await expect(page.getByText('Necesita revisión', { exact: false })).toBeVisible();
  await page.clock.runFor(15 * 60_000 + 1000);
  await expect(page.getByRole('status')).toContainText('vista venció'); await expect(page.getByRole('link', { name: /Revisar en Comunicaciones:/ })).toHaveCount(0);
  await page.getByTestId('dashboard-refresh').click(); await expect(page.getByTestId('dashboard-read-reviews')).toBeEnabled(); await expect(page.getByText('Aún no consultada.', { exact: false })).toBeVisible();
});

test('keyboard navigation has named controls, visible focus, and separate Office route with preserved operational tabs', async ({ page }, testInfo) => {
  await open(page); await expect(page.locator('.gd-skip')).toHaveCSS('clip-path', 'inset(50%)');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await expect(page.locator('.gd-skip')).toHaveCSS('clip-path', 'none');
  await page.keyboard.press('Enter'); await expect(page.locator('#gd-main')).toBeFocused();
  await expect(page.locator('.gd-skip')).toHaveCSS('clip-path', 'inset(50%)');
  if (testInfo.project.name === 'dashboard-mobile') {
    await expect(page.getByRole('button', { name: 'Menú', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ga-navigation-container')).not.toBeVisible();
    await showNavigation(page);
    await expect(page.getByRole('button', { name: 'Cerrar menú', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await noOverflow(page);
    for (const control of await page.locator('.ga-sidebar').getByRole('button').all()) {
      if (await control.isVisible()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await navigate(page, 'Oportunidades');
  await expect(page).toHaveURL(/#opportunities$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Oportunidades', exact: true })).toBeFocused();
  await navigate(page, 'Fuentes');
  await expect(page).toHaveURL(/#sources$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Oportunidades', exact: true })).toBeFocused();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Fuentes', exact: true })).toBeFocused();
  await showNavigation(page);
  await page.getByRole('link', { name: 'Oficina', exact: true }).click();
  await expect(page.locator('.approved-office-scene')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Operaciones', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('href', '/office/dashboard');
  await page.getByRole('tab', { name: 'Mi oficina', exact: true }).focus(); await page.keyboard.press('End'); await expect(page.getByRole('tab', { name: 'Historial', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('tab', { name: 'Mi oficina', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click(); await expect(page.getByTestId('approved-metric-opportunities')).toBeVisible(); await noOverflow(page);
});

test('Propuestas and Eventos default to closed Guardadas without implicit sessions or quote reads', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/office/event-quotes')) calls.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await open(page);
  for (const name of ['Propuestas', 'Eventos']) {
    await navigate(page, name);
    await expect(page.getByTestId('dashboard-quotes-saved')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dashboard-persisted-quotes')).toContainText('Sin conexión operativa configurada');
    await expect(page.getByTestId('event-workspace')).toHaveCount(0);
    await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(0);
    await page.getByTestId('dashboard-verify-quotes').click();
    await expect(page.getByTestId('dashboard-verify-quotes')).toBeEnabled();
    await expect(page.getByTestId('dashboard-persisted-quotes')).toContainText('cotizaciones guardadas permanecen cerradas');
    await expect(page.getByTestId('dashboard-quote-event')).toHaveCount(0);
    await noOverflow(page);
  }
  expect(calls).toEqual([]);
});

test('DEMO is explicit, separate from Guardadas, and main quote navigation returns closed', async ({ page }) => {
  await open(page); await navigate(page, 'Eventos');
  await page.getByTestId('dashboard-quotes-demo').click();
  await expect(page.getByTestId('event-workspace')).toContainText('DEMO-EVT-042');
  await expect(page.getByTestId('dashboard-persisted-quotes')).toHaveCount(0);
  await expect(page).toHaveURL(/#events\/consulta$/);
  await navigate(page, 'Propuestas');
  await expect(page.getByTestId('dashboard-persisted-quotes')).toBeVisible();
  await expect(page.getByTestId('event-workspace')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId('event-workspace')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('dashboard-persisted-quotes')).toBeVisible();
  await expect(page.getByTestId('event-workspace')).toHaveCount(0);
});

test('explicit legacy demo route remains reachable but plain routes never choose it', async ({ page }) => {
  await page.goto('/office/dashboard#quotes/revision');
  await expect(page.getByTestId('event-workspace')).toBeVisible();
  await expect(page.getByTestId('dashboard-quotes-demo')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('dashboard-quotes-saved').click();
  await expect(page).toHaveURL(/#quotes$/);
  await expect(page.getByTestId('dashboard-persisted-quotes')).toBeVisible();
  await expect(page.getByTestId('event-workspace')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('dashboard-quotes-saved')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('event-workspace')).toHaveCount(0);
});
