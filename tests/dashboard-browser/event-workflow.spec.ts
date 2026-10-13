import { createHash } from 'node:crypto';
import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { EVENT_FIXTURE } from '../../src/office/dashboard/event-workflow';

// Exercise the actual local UI. All event transitions are in-memory simulations;
// no success responses, provider calls, payment callbacks or identities are mocked.
const workspace = (page: Page) => page.getByTestId('event-workspace');
const control = (page: Page, name: string) => workspace(page).getByRole('button', { name, exact: true });
const attestations = (page: Page) => workspace(page).getByRole('group', { name: 'Revisión humana simulada · versión exacta' }).getByRole('checkbox');
function watchEffects(page: Page) {
  const effects: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname.startsWith('/office-api/') || !['localhost', '127.0.0.1'].includes(url.hostname)) effects.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  return effects;
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.locator('.ga-sidebar').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}
async function tab(page: Page, name: string) {
  const target = workspace(page).getByRole('tab', { name, exact: true });
  await target.click();
  await expect(target).toHaveAttribute('aria-selected', 'true');
  await expect(workspace(page).getByRole('tabpanel')).toBeVisible();
}
async function openEvent(page: Page) {
  await page.goto('/office/dashboard');
  await expect(page.getByTestId('approved-metric-opportunities')).toBeVisible();
  await navigate(page, 'Eventos');
  await expect(workspace(page)).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function capture(page: Page, testInfo: TestInfo, stage: string) {
  await noOverflow(page);
  await page.evaluate(() => document.fonts.ready);
  // Capture the same top-of-page state, including sticky navigation.
  await page.evaluate(() => { window.scrollTo(0, 0); const sidebar = document.querySelector('.ga-sidebar'); if (sidebar) sidebar.scrollTop = 0; });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `test-results/dashboard-visual/${testInfo.project.name}-event-${stage}.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
}
async function openPdfPreview(page: Page) {
  const preview = page.getByTestId('event-pdf-preview');
  if (!(await preview.isVisible())) await control(page, 'Ver vista previa del PDF').click();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
}
async function attestAndApprove(page: Page) {
  await tab(page, 'Revisión exacta');
  await openPdfPreview(page);
  for (const checkbox of await attestations(page).all()) await checkbox.check();
  await control(page, 'Simular aprobación exacta').click();
  await expect(workspace(page).getByText('Aprobada en DEMO · sin envío real', { exact: true })).toBeVisible();
}
async function closeSimulatedSale(page: Page) {
  await attestAndApprove(page);
  await control(page, 'Simular envío de propuesta').click();
  await control(page, 'Simular cierre humano').click();
  await expect(workspace(page).getByText('Cierre humano DEMO', { exact: true })).toBeVisible();
}
async function assertUnknownPayment(page: Page) {
  await expect(page.getByTestId('event-collected')).toHaveText('Desconocido');
  await expect(page.getByTestId('event-balance')).toHaveText('Desconocido');
}
async function expectFact(root: Locator, label: string, value: string) {
  await expect(root.locator('.gew-facts > div').filter({ has: root.page().getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) }).getByRole('definition')).toHaveText(value);
}

test('one exact synthetic identity spans all event views, with reachable brief and review and no external effects', async ({ page }, testInfo) => {
  const effects = watchEffects(page);
  await openEvent(page);
  const originals = workspace(page).locator('.gew-card').filter({ has: page.getByRole('heading', { name: 'Conversación original', exact: true }) });
  for (const [label, value] of Object.entries({ Cuenta: 'DEMO-GOURMET', Buzón: 'eventos@invalid.test', Destinatario: 'aurora@invalid.test', Evento: 'DEMO-EVT-042', Oportunidad: 'DEMO-OP-042', Contacto: 'DEMO-L-014', Hilo: 'DEMO-TH-042:r2' })) await expectFact(originals, label, value);
  await expect(workspace(page)).toContainText('20 personas');
  await expect(workspace(page)).toContainText('Finalmente seremos 24 personas');
  await capture(page, testInfo, 'consultation');
  await tab(page, 'Brief');
  await expect(page).toHaveURL(/#events\/brief$/);
  await expect(workspace(page).getByRole('heading', { name: 'Brief compartido · BRIEF-042:r2', exact: true })).toBeVisible();
  await page.goBack();
  await expect(workspace(page).getByRole('tab', { name: 'Consulta', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(workspace(page).getByRole('tab', { name: 'Brief', exact: true })).toHaveAttribute('aria-selected', 'true');
  for (const [name, stage] of [['Cotización', 'quote'], ['Revisión exacta', 'review'], ['Cobro', 'payment'], ['Operación', 'operations'], ['Tastings · Regus', 'tastings']] as const) {
    await tab(page, name);
    await expect(workspace(page).locator('.gew-case')).toContainText('DEMO-EVT-042 · DEMO-OP-042 · 24 personas');
    if (stage === 'quote') {
      const wrapper = workspace(page).locator('.gew-table-wrap');
      await expect(wrapper.locator('thead th')).toHaveCount(4);
      await expect(wrapper.locator('tfoot td')).toContainText('3,000 U. DEMO');
      expect(await wrapper.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const bounds = await wrapper.boundingBox();
      expect(bounds).not.toBeNull();
      for (const cell of await wrapper.locator('th,td').all()) {
        const box = await cell.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
        expect(await cell.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
      }
    }
    await capture(page, testInfo, stage);
  }
  for (const name of ['Propuestas', 'Enlaces de pago', 'Calendario', 'Tastings', 'Proveedores', 'Logística']) {
    await navigate(page, name);
    await expect(workspace(page)).toHaveCount(1);
    await expect(workspace(page).locator('.gew-case')).toContainText('DEMO-EVT-042');
    await noOverflow(page);
  }
  expect(effects).toEqual([]);
});

test('obsolete quote cannot be approved and repeated exact-review clicks remain local and separate from sending', async ({ page, context }) => {
  const effects = watchEffects(page);
  await openEvent(page); await tab(page, 'Cotización');
  await control(page, 'v1 · obsoleta').dblclick();
  await expect(control(page, 'Aprobar v1 · no disponible')).toBeDisabled();
  await expect(workspace(page)).toContainText('20 personas · versión obsoleta');
  await control(page, 'Volver a v2 vigente').click();
  await control(page, 'Revisar mensaje y adjunto').click();
  await expect(page).toHaveURL(/#quotes\/revision$/);
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  await expect(control(page, 'Enviar correo real')).toBeDisabled();
  await expect(control(page, 'Simular envío de propuesta')).toBeDisabled();
  await expect(control(page, 'Simular cierre humano')).toBeDisabled();
  const pdf = workspace(page).getByRole('link', { name: 'Descargar PDF completo', exact: true });
  const href = await pdf.getAttribute('href');
  expect(href).toMatch(/^\/(?!\/)/);
  // Independent file-integrity check; the in-page preview is exercised through the UI below.
  const response = await context.request.get(href!);
  expect(response.status()).toBe(200);
  const bytes = await response.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBe(EVENT_FIXTURE.attachment.byteLength);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(EVENT_FIXTURE.attachment.sha256);
  await openPdfPreview(page);
  const checks = attestations(page);
  await checks.nth(0).check(); await checks.nth(1).check();
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  await checks.nth(2).check(); await control(page, 'Simular aprobación exacta').dblclick();
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  await expect(control(page, 'Simular envío de propuesta')).toBeEnabled();
  await expect(control(page, 'Simular cierre humano')).toBeDisabled();
  await expect(workspace(page)).toContainText('Envío ficticio: pendiente');
  await control(page, 'Simular envío de propuesta').dblclick();
  await expect(control(page, 'Simular envío de propuesta')).toBeDisabled();
  await control(page, 'Simular cierre humano').dblclick();
  await expect(control(page, 'Simular cierre humano')).toBeDisabled();
  await expect(control(page, 'Enviar correo real')).toBeDisabled();
  await tab(page, 'Operación');
  await control(page, 'Iniciar búsqueda simulada').dblclick();
  await expect(control(page, 'Iniciar búsqueda simulada')).toBeDisabled();
  await expect(workspace(page)).toContainText('No aceptado');
  await expect(workspace(page)).toContainText('No asignado');
  await expect(control(page, 'Contactar proveedor real')).toBeDisabled();
  expect(effects).toEqual([]);
});

test('opening and closing the exact PDF preview preserves edited draft and attestations without navigating away', async ({ page, context }, testInfo) => {
  const effects = watchEffects(page);
  const popups: Page[] = [];
  page.on('popup', popup => popups.push(popup));
  await openEvent(page); await tab(page, 'Revisión exacta');
  const url = page.url();
  const pageCount = context.pages().length;
  const subject = workspace(page).getByLabel('Asunto', { exact: true });
  const body = workspace(page).getByLabel('Texto completo que se revisaría', { exact: true });
  await subject.fill('Versión editada antes de leer el PDF');
  await body.fill('Texto de laboratorio conservado al abrir y cerrar el adjunto.');
  const checks = attestations(page);
  await checks.nth(0).check(); await checks.nth(1).check();
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  const pdf = workspace(page).getByRole('link', { name: 'Descargar PDF completo', exact: true });
  await expect(pdf).toHaveAttribute('download', EVENT_FIXTURE.attachment.fileName);
  expect(await pdf.getAttribute('target')).toBeNull();
  await openPdfPreview(page);
  await expect(page.getByTestId('event-pdf-preview')).toHaveAttribute('alt', `Página 1 de la propuesta ${EVENT_FIXTURE.attachment.fileName}`);
  expect(await page.getByTestId('event-pdf-preview').getAttribute('src')).toMatch(/^\/(?!\/)/);
  const previewWidth = await page.getByTestId('event-pdf-preview').evaluate(image => image.getBoundingClientRect().width);
  const attachmentWidth = await workspace(page).locator('.gew-attachment').evaluate(element => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  expect(previewWidth).toBeGreaterThanOrEqual(attachmentWidth - 2);
  expect(previewWidth).toBeLessThanOrEqual(attachmentWidth + 1);
  await capture(page, testInfo, 'review-pdf-preview');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await control(page, 'Ocultar vista previa del PDF').click();
    await expect(page.getByTestId('event-pdf-preview')).not.toBeVisible();
    await expect(subject).toHaveValue('Versión editada antes de leer el PDF');
    await expect(body).toHaveValue('Texto de laboratorio conservado al abrir y cerrar el adjunto.');
    await expect(checks.nth(0)).toBeChecked(); await expect(checks.nth(1)).toBeChecked();
    await expect(checks.nth(2)).not.toBeChecked();
    await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
    await expect(page).toHaveURL(url);
    await expect(workspace(page)).toBeVisible();
    await openPdfPreview(page);
  }
  await checks.nth(2).check();
  await control(page, 'Simular aprobación exacta').click();
  await expect(workspace(page).getByText('Aprobada en DEMO · sin envío real', { exact: true })).toBeVisible();
  await control(page, 'Ocultar vista previa del PDF').click();
  await expect(control(page, 'Simular envío de propuesta')).toBeEnabled();
  await expect(page).toHaveURL(url);
  expect(popups).toEqual([]); expect(context.pages()).toHaveLength(pageCount);
  expect(effects).toEqual([]);
});

const invalidations: Array<{ name: string; mutate: (page: Page) => Promise<void> }> = [
  { name: 'recipient', mutate: async page => { await workspace(page).getByLabel('Para', { exact: true }).fill('segunda@invalid.test'); } },
  { name: 'CC', mutate: async page => { await workspace(page).getByLabel('CC', { exact: true }).fill('copia@invalid.test'); } },
  { name: 'BCC', mutate: async page => { await workspace(page).getByLabel('CCO', { exact: true }).fill('oculta@invalid.test'); } },
  { name: 'subject', mutate: async page => { await workspace(page).getByLabel('Asunto', { exact: true }).fill('Asunto cambiado de laboratorio'); } },
  { name: 'body', mutate: async page => { await workspace(page).getByLabel('Texto completo que se revisaría', { exact: true }).fill('Texto nuevo que requiere revisión completa.'); } },
  { name: 'attachment', mutate: async page => { await workspace(page).getByRole('checkbox', { name: 'Incluir este adjunto en la versión revisada', exact: true }).uncheck(); } },
  { name: 'source context', mutate: async page => { await control(page, 'Simular contexto actualizado').click(); } },
];
for (const { name, mutate } of invalidations) test(`changing ${name} invalidates exact approval and all dependent simulated stages`, async ({ page }) => {
  const effects = watchEffects(page);
  await openEvent(page); await closeSimulatedSale(page);
  await tab(page, 'Operación'); await control(page, 'Iniciar búsqueda simulada').click();
  await tab(page, 'Cobro');
  for (const step of ['Preparar solicitud DEMO', 'Simular revisión de solicitud', 'Simular generación de enlace', 'Simular revisión del mensaje de cobro', 'Simular compartir referencia', 'Simular consulta con timeout']) await control(page, step).click();
  await control(page, 'Alternativo · 900 confirmados').click();
  await tab(page, 'Revisión exacta'); await mutate(page);
  await expect(workspace(page).getByRole('status')).toContainText('Revisión invalidada');
  await expect(workspace(page).getByText('Aprobada en DEMO · sin envío real', { exact: true })).toHaveCount(0);
  for (const checkbox of await attestations(page).all()) await expect(checkbox).not.toBeChecked();
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  await expect(control(page, 'Simular envío de propuesta')).toBeDisabled();
  await expect(control(page, 'Simular cierre humano')).toBeDisabled();
  await tab(page, 'Cobro'); await assertUnknownPayment(page);
  await expect(control(page, 'Preparar solicitud DEMO')).toBeDisabled();
  await expect(control(page, 'Simular revisión de solicitud')).toBeDisabled();
  await expect(workspace(page).getByRole('definition').filter({ hasText: /^No creada$/ })).toBeVisible();
  await tab(page, 'Operación'); await expect(control(page, 'Iniciar búsqueda simulada')).toBeDisabled();
  expect(effects).toEqual([]);
});

test('draft and planning edits persist across sidebar views and history, while an explicit reset clears them', async ({ page }) => {
  await openEvent(page); await tab(page, 'Revisión exacta');
  await workspace(page).getByLabel('Asunto', { exact: true }).fill('Revisión temporal conservada');
  await attestations(page).nth(0).check();
  await navigate(page, 'Logística');
  await workspace(page).getByRole('checkbox', { name: 'He preparado una lista local para revisión de compras', exact: true }).check();
  await navigate(page, 'Tastings');
  await workspace(page).getByLabel('Zona propuesta', { exact: true }).fill('San Isidro');
  await navigate(page, 'Dashboard');
  await expect(workspace(page)).toHaveCount(0);
  await navigate(page, 'Propuestas'); await tab(page, 'Revisión exacta');
  await expect(workspace(page).getByLabel('Asunto', { exact: true })).toHaveValue('Revisión temporal conservada');
  await expect(attestations(page).nth(0)).toBeChecked();
  await page.goBack();
  await expect(workspace(page).getByRole('tab', { name: 'Cotización', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(workspace(page).getByLabel('Asunto', { exact: true })).toHaveValue('Revisión temporal conservada');
  await navigate(page, 'Proveedores');
  await expect(workspace(page).getByRole('checkbox', { name: 'He preparado una lista local para revisión de compras', exact: true })).toBeChecked();
  await navigate(page, 'Tastings');
  await expect(workspace(page).getByLabel('Zona propuesta', { exact: true })).toHaveValue('San Isidro');
  await control(page, 'Reiniciar simulación local').dblclick();
  await expect(workspace(page).getByLabel('Zona propuesta', { exact: true })).toHaveValue('');
  await tab(page, 'Revisión exacta');
  await expect(workspace(page).getByLabel('Asunto', { exact: true })).toHaveValue(EVENT_FIXTURE.subject);
  for (const checkbox of await attestations(page).all()) await expect(checkbox).not.toBeChecked();
  await tab(page, 'Operación');
  for (const checkbox of await workspace(page).getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await noOverflow(page);
});

test('payment timeout preserves the same unknown request and an alternative paid scenario never updates the principal', async ({ page }) => {
  const effects = watchEffects(page);
  await openEvent(page); await closeSimulatedSale(page); await tab(page, 'Cobro');
  await assertUnknownPayment(page);
  const steps = ['Preparar solicitud DEMO', 'Simular revisión de solicitud', 'Simular generación de enlace', 'Simular revisión del mensaje de cobro', 'Simular compartir referencia', 'Simular consulta con timeout'];
  for (let index = 0; index < steps.length; index += 1) {
    for (const later of steps.slice(index + 1)) await expect(control(page, later)).toBeDisabled();
    await control(page, steps[index]).dblclick();
    await expect(control(page, steps[index])).toBeDisabled();
    await assertUnknownPayment(page);
  }
  await expect(workspace(page).getByRole('status')).toContainText('TIMEOUT_DEMO');
  await expect(workspace(page)).toContainText('no reenviar');
  for (const step of steps) await expect(control(page, step)).toBeDisabled();
  const facts = workspace(page).locator('.gew-card').filter({ has: page.getByRole('heading', { name: 'Identidad y condiciones exactas', exact: true }) });
  await expectFact(facts, 'Solicitud', 'PR-042:r2');
  await expectFact(facts, 'Referencia simulada', 'LINK-LAB-042');
  await expectFact(facts, 'URL real', 'No generada');
  await control(page, 'Alternativo · 900 confirmados').click();
  await expect(page.getByTestId('event-collected')).toHaveText('900 U. DEMO');
  await expect(page.getByTestId('event-balance')).toHaveText(/2[.,]100 U\. DEMO/);
  await expect(workspace(page)).toContainText('Excepción humana: pago sin proveedor aceptado');
  await expect(workspace(page)).toContainText('Conciliación');
  await control(page, 'Volver al cobro principal').click();
  await assertUnknownPayment(page); await expectFact(facts, 'Solicitud', 'PR-042:r2');
  await expect(control(page, 'Simular consulta con timeout')).toBeDisabled();
  await tab(page, 'Operación');
  await expect(workspace(page)).toContainText('No aceptado');
  await expect(workspace(page)).toContainText('No asignado');
  await expect(workspace(page)).toContainText('Este evento no puede marcarse listo');
  expect(effects).toEqual([]);
});

for (const interruption of ['pagehide', 'refresh', 'expiry'] as const) test(`${interruption} withdraws the event state and never restores an old approval on reload`, async ({ page }) => {
  if (interruption === 'expiry') await page.clock.install();
  await openEvent(page); await closeSimulatedSale(page);
  await workspace(page).getByLabel('CC', { exact: true }).fill('temporal@invalid.test');
  await attestAndApprove(page);
  if (interruption === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  if (interruption === 'expiry') await page.clock.runFor(15 * 60_000 + 1000);
  if (interruption !== 'refresh') {
    await expect(workspace(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(interruption === 'expiry' ? 'vista venció' : 'vista se retiró');
  }
  await page.getByTestId('dashboard-refresh').click();
  await expect(workspace(page)).toBeVisible();
  await tab(page, 'Revisión exacta');
  await expect(workspace(page).getByLabel('CC', { exact: true })).toHaveValue('');
  await expect(control(page, 'Simular aprobación exacta')).toBeDisabled();
  await expect(control(page, 'Simular envío de propuesta')).toBeDisabled();
  await expect(control(page, 'Simular cierre humano')).toBeDisabled();
  for (const checkbox of await attestations(page).all()) await expect(checkbox).not.toBeChecked();
  await tab(page, 'Cobro'); await assertUnknownPayment(page);
  await expect(control(page, 'Preparar solicitud DEMO')).toBeDisabled();
});

test('Regus coordination remains unbooked with unknown food permission and keyboard-accessible mobile-safe tabs', async ({ page }) => {
  const effects = watchEffects(page);
  await openEvent(page); await navigate(page, 'Tastings');
  const prepare = control(page, 'Preparar ficha de coordinación');
  await expect(prepare).toBeDisabled();
  await workspace(page).getByLabel('Zona propuesta', { exact: true }).fill('San Isidro');
  await workspace(page).getByLabel('Fecha propuesta del encuentro', { exact: true }).fill('2026-11-17T16:00');
  await prepare.dblclick();
  await expect(prepare).toBeDisabled();
  await expect(workspace(page)).toContainText('Ficha local preparada para revisión humana');
  const facts = workspace(page).locator('.gew-card').filter({ has: page.getByRole('heading', { name: 'Verificaciones pendientes', exact: true }) });
  await expectFact(facts, 'Alimentos externos', 'Permiso desconocido');
  await expectFact(facts, 'Reserva', 'No realizada');
  await expectFact(facts, 'Coste completo', 'Desconocido; no es cero');
  await expectFact(facts, 'Centro y dirección', 'Por elegir y verificar');
  await expect(control(page, 'Reservar sala real')).toBeDisabled();
  await expect(control(page, 'Enviar invitación real')).toBeDisabled();
  await workspace(page).getByLabel('Zona propuesta', { exact: true }).fill('Miraflores');
  await expect(workspace(page).getByText('Ficha local preparada para revisión humana', { exact: true })).toHaveCount(0);
  await expect(prepare).toBeEnabled();
  await expectFact(facts, 'Reserva', 'No realizada');
  await noOverflow(page);
  await workspace(page).getByRole('tab', { name: 'Tastings · Regus', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(workspace(page).getByRole('tab', { name: 'Consulta', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(workspace(page).getByRole('tab', { name: 'Brief', exact: true })).toBeFocused();
  await expect(workspace(page).getByRole('tab', { name: 'Brief', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(workspace(page).getByRole('tab', { name: 'Tastings · Regus', exact: true })).toBeFocused();
  await noOverflow(page);
  expect(effects).toEqual([]);
});
