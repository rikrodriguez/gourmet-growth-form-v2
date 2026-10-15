import { test, expect, type Page } from '@playwright/test';
const panel = (page: Page) => page.getByTestId('external-proposal-panel');
async function control(page: Page, name: string) {
 const response = page.waitForResponse(r => r.url().endsWith('/__proposal-fixture') && r.request().postDataJSON()?.action === 'control');
 await page.getByRole('button', { name, exact: true }).click(); await response;
}
async function lead(page: Page, id = 'demo-history-a') {
 await page.getByLabel('Lead autorizado', { exact: true }).selectOption(id);
 await page.getByRole('button', { name: 'Consultar historial del lead', exact: true }).click();
 await expect(panel(page)).toBeVisible();
}
async function read(page: Page) { await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' })).toBeVisible(); }
async function associate(page: Page) { await panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' }).click(); await expect(panel(page).getByRole('status')).toHaveText('Pendiente de revisión interna'); }
async function approve(page: Page) {
 await panel(page).getByRole('checkbox').check(); await panel(page).getByRole('button', { name: 'Aprobar documento internamente' }).click();
 await expect(panel(page).getByRole('status')).toHaveText('Aprobada internamente · sin envío');
}
test.beforeEach(async ({ page, request }) => {
 await page.route('**/*', async route => { expect(['127.0.0.1', 'localhost']).toContain(new URL(route.request().url()).hostname); await route.continue(); });
 await request.post('http://127.0.0.1:4196/__proposal-fixture', { data: { action: 'reset' } });
 await page.goto('/tests/external-proposal-browser/index.html');
 await expect(panel(page)).toHaveCount(0);
 await page.getByRole('button', { name: 'Verificar acceso al historial', exact: true }).click();
 await lead(page);
});
test('useful exact document flow, independent editor and no automatic external request', async ({ page }, info) => {
 const external: string[] = [], providerReads: string[] = [];
 page.on('request', r => { if (!['127.0.0.1','localhost'].includes(new URL(r.url()).hostname)) external.push(r.url()); if (r.url().endsWith('/__proposal-fixture') && r.postDataJSON()?.action === 'proposal-read') providerReads.push(r.url()); });
 await expect(panel(page)).not.toContainText('PROPUESTA SINTÉTICA 1'); expect(providerReads).toEqual([]);
 await read(page); await expect(panel(page)).toContainText('Sin propuesta asociada');
 await associate(page); await expect(panel(page).getByRole('button', { name: 'Aprobar documento internamente' })).toBeDisabled();
 await expect(panel(page).getByLabel('Contenido exacto de propuesta')).toContainText('PROPUESTA SINTÉTICA 1');
 await approve(page); await expect(panel(page)).toContainText('Versión inmutable: v1');
 await expect(panel(page).locator('a,iframe,img,textarea')).toHaveCount(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
 await panel(page).scrollIntoViewIfNeeded();
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-external-proposal-approved.png` });
 expect(external).toEqual([]);
});
test('document v2 invalidates approval and requires a fresh exact review', async ({ page }, info) => {
 await read(page); await associate(page); await approve(page);
 await control(page, 'Publicar documento sintético v2'); await read(page);
 await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 await expect(panel(page).getByRole('button', { name: 'Aprobar documento internamente' })).toBeDisabled();
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-external-proposal-obsolete.png` });
 await associate(page); await expect(panel(page)).toContainText('Versión inmutable: v2'); await approve(page);
});
test('reference_only cannot approve a document and never previews its URL', async ({ page }, info) => {
 await control(page, 'Usar referencia sin documento'); await read(page);
 await panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' }).click();
 await expect(panel(page).getByRole('status')).toHaveText('reference_only · referencia sin documento verificable');
 await expect(panel(page).getByRole('checkbox')).toBeDisabled();
 await expect(panel(page).getByRole('button', { name: 'Aprobar documento internamente' })).toBeDisabled();
 await expect(panel(page)).not.toContainText('https://');
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-external-proposal-reference.png` });
});
test('recipient edited in the existing workspace clears review; saved change invalidates approval', async ({ page }) => {
 await read(page); await associate(page); await approve(page);
 await page.getByLabel('Destinatario previsto', { exact: true }).fill('changed@example.test');
 await expect(panel(page)).toHaveCount(0); await expect(page.getByText('El brief cambió. Guarda y vuelve a revisar la propuesta externa.')).toBeVisible();
 await page.getByRole('button', { name: 'Guardar nueva versión del brief' }).click();
 await expect(panel(page)).toBeVisible(); await read(page);
 await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 await associate(page); await expect(panel(page)).toContainText('changed@example.test');
});
test('late response cannot restore a previous lead or a withdrawn identity', async ({ page }) => {
 await read(page); await associate(page);
 await control(page, 'Demorar respuesta sintética');
 await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click();
 await lead(page, 'demo-history-b'); await page.waitForTimeout(750);
 await expect(panel(page)).not.toContainText('PROPUESTA SINTÉTICA 1');
 await read(page); await associate(page); await expect(panel(page)).toContainText('PROPUESTA SINTÉTICA 2');
 await control(page, 'Demorar respuesta sintética');
 await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click();
 await control(page, 'Retirar acceso sintético'); await page.waitForTimeout(750);
 await expect(panel(page)).toHaveCount(0); await expect(page.getByLabel('Lead autorizado', { exact: true })).toHaveCount(0);
});
test('lost response is recovered manually after a service restart without duplicate association', async ({ page }) => {
 await read(page); await control(page, 'Perder próxima respuesta sintética');
 await panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' }).click();
 await expect(panel(page).getByRole('alert')).toBeVisible();
 await control(page, 'Reiniciar servicio sintético'); await read(page);
 await expect(panel(page)).toContainText('Asociación: 1'); await approve(page);
});
test('a corrupt hash or a response for another lead is cleared without approval', async ({ page }) => {
 await read(page); await associate(page);
 for (const corruption of ['content', 'lead']) {
  const handler = async (route: import('@playwright/test').Route) => {
   if (route.request().postDataJSON()?.action !== 'proposal-read') { await route.fallback(); return; }
   const response = await route.fetch(), body = await response.json();
   if (corruption === 'content') body.snapshot.content += '\nTampered'; else body.leadId = 'demo-history-b';
   await route.fulfill({ response, json: body });
  };
  await page.route('**/__proposal-fixture', handler);
  await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toBeVisible(); await expect(panel(page).getByRole('checkbox')).toHaveCount(0);
  await page.unroute('**/__proposal-fixture', handler); await read(page);
 }
});
