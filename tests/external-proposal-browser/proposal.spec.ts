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
test('a failed brief save recovers the unsaved recipient before explicitly saving and reopening the proposal', async ({ page, request }, info) => {
 const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
 await read(page); await associate(page); await approve(page);
 const recipient = page.getByLabel('Destinatario previsto', { exact: true });
 await recipient.fill('recovered-draft@example.test');
 await page.getByRole('textbox', { name: 'Requisitos y pendientes', exact: true }).fill('Borrador sintético pendiente de guardar; sin aceptación del cliente.');
 let rejectedSaves = 0;
 const rejectSave = async (route: import('@playwright/test').Route) => {
  if (route.request().postDataJSON()?.action !== 'quote-command') return route.fallback();
  rejectedSaves++; await route.abort('failed');
 };
 await page.route('**/__proposal-fixture', rejectSave);
 await page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true }).click();
 await expect(page.getByRole('alert')).toBeVisible();
 await expect(page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true })).toBeDisabled();
 const target = { leadId: 'demo-history-a', eventId: 'SYNTHETIC-EVENT-a', proposalId: 'SYNTHETIC-PROPOSAL-a' };
 const saved = await (await request.post('/__proposal-fixture', { data: { action: 'quote-read', target } })).json();
 expect(saved.record.briefs).toHaveLength(1); expect(saved.record.briefs[0].recipient).toBe('client@example.test');
 await page.unroute('**/__proposal-fixture', rejectSave);
 await page.getByRole('button', { name: 'Recargar expediente', exact: true }).click();
 await expect(recipient).toBeEnabled();
 await expect(recipient).toHaveValue('recovered-draft@example.test');
 await expect(page.getByRole('textbox', { name: 'Requisitos y pendientes', exact: true })).toHaveValue('Borrador sintético pendiente de guardar; sin aceptación del cliente.');
 const recoveryNotice = page.getByText('Borrador local recuperado, todavía sin guardar. Revisa los datos y guarda para continuar; la propuesta requiere una nueva revisión.', { exact: true });
 await expect(recoveryNotice).toBeVisible();
 await expect(panel(page)).toHaveCount(0);
 await expect(page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true })).toBeEnabled();
 expect(rejectedSaves).toBe(1);
 await recoveryNotice.screenshot({ path: `test-results/dashboard-visual/${info.project.name}-proposal-draft-notice.png` });
 await page.getByRole('heading', { name: 'Brief manual · versión 1', exact: true }).locator('..').screenshot({ path: `test-results/dashboard-visual/${info.project.name}-proposal-draft-recovered.png` });
 await recipient.fill(saved.record.briefs[0].recipient);
 await page.getByRole('textbox', { name: 'Requisitos y pendientes', exact: true }).fill(saved.record.briefs[0].requirements);
 await expect(recoveryNotice).toHaveCount(0); await expect(panel(page)).toBeVisible();
 await expect(page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true })).toBeDisabled();
 await recipient.fill('recovered-draft@example.test');
 await page.getByRole('textbox', { name: 'Requisitos y pendientes', exact: true }).fill('Borrador sintético pendiente de guardar; sin aceptación del cliente.');
 await expect(recoveryNotice).toBeVisible();
 await page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'Brief manual · versión 2', exact: true })).toBeVisible();
 await read(page); await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 await associate(page); await expect(panel(page).getByRole('status')).toHaveText('Pendiente de revisión interna');
 await expect(panel(page).getByRole('checkbox')).not.toBeChecked(); await expect(panel(page)).toContainText('recovered-draft@example.test');
 await page.reload(); await page.getByRole('button', { name: 'Verificar acceso al historial', exact: true }).click(); await lead(page);
 await expect(recipient).toHaveValue('recovered-draft@example.test'); await read(page);
 await expect(panel(page).getByRole('status')).toHaveText('Pendiente de revisión interna'); await approve(page);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-proposal-draft-reopened.png` });
 await lead(page, 'demo-history-b'); await expect(recipient).toHaveValue('client@example.test'); await read(page);
 await expect(panel(page).getByRole('status')).toHaveText('Sin propuesta asociada'); await expect(panel(page)).not.toContainText('recovered-draft@example.test');
 expect(errors).toEqual([]);
 console.log('PROPOSAL_DRAFT_RECOVERY_EVIDENCE=' + JSON.stringify({ project: info.project.name, failedSaves: rejectedSaves, unchangedServerBrief: true, draftRecovered: true, savedBriefVersion: 2, obsoleteApprovalAfterSave: true, reopenedPendingReview: true, approvedInternallyOnlyAfterFreshReview: true }));
});
test('a lost brief save response reopens the committed version without another save', async ({ page, request }) => {
 await read(page); await associate(page); await approve(page);
 await page.getByLabel('Destinatario previsto', { exact: true }).fill('committed-brief@example.test');
 let saves = 0;
 const loseResponse = async (route: import('@playwright/test').Route) => {
  if (route.request().postDataJSON()?.action !== 'quote-command') return route.fallback();
  saves++; const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed');
 };
 await page.route('**/__proposal-fixture', loseResponse);
 await page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.unroute('**/__proposal-fixture', loseResponse);
 await page.getByRole('button', { name: 'Recargar expediente', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'Brief manual · versión 2', exact: true })).toBeVisible();
 await expect(page.getByLabel('Destinatario previsto', { exact: true })).toHaveValue('committed-brief@example.test');
 await expect(page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true })).toBeDisabled();
 await expect(page.getByText(/^Borrador local recuperado/)).toHaveCount(0);
 await read(page); await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 const saved = await (await request.post('/__proposal-fixture', { data: { action: 'quote-read', target: { eventId: 'SYNTHETIC-EVENT-a' } } })).json();
 expect(saved.record.briefs).toHaveLength(2); expect(saved.record.revision).toBe(2); expect(saves).toBe(1);
});
test('a concurrent saved brief remains authoritative when recovering a rejected local save', async ({ page }) => {
 await read(page); await associate(page); await approve(page);
 await page.getByLabel('Destinatario previsto', { exact: true }).fill('uncommitted-concurrent@example.test');
 const rejectSave = async (route: import('@playwright/test').Route) => {
  if (route.request().postDataJSON()?.action !== 'quote-command') return route.fallback();
  await route.abort('failed');
 };
 await page.route('**/__proposal-fixture', rejectSave);
 await page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.unroute('**/__proposal-fixture', rejectSave); await control(page, 'Cambiar destinatario sintético');
 await page.getByRole('button', { name: 'Recargar expediente', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'Brief manual · versión 2', exact: true })).toBeVisible();
 await expect(page.getByLabel('Destinatario previsto', { exact: true })).toHaveValue('other@example.test');
 await expect(page.getByRole('button', { name: 'Guardar nueva versión del brief', exact: true })).toBeDisabled();
 await expect(page.getByText(/^Borrador local recuperado/)).toHaveCount(0);
 await read(page); await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
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
for (const field of ['intendedRecipient', 'sourceVersion', 'provenance', 'briefDigest', 'bindingDigest']) test(`altered review metadata ${field} is cleared before review or approval`, async ({ page, request }, info) => {
 await read(page); await associate(page);
 let original: any; const approvalCommands: unknown[] = [];
 page.on('request', r => { if (r.url().endsWith('/__proposal-fixture') && r.postDataJSON()?.command?.action === 'approve') approvalCommands.push(r.postDataJSON()); });
 await page.route('**/__proposal-fixture', async route => {
  if (route.request().postDataJSON()?.action !== 'proposal-read') { await route.fallback(); return; }
  const response = await route.fetch(), body = await response.json(); original = structuredClone(body);
  if (field === 'intendedRecipient') body.snapshot.intendedRecipient = 'shown-to-reviewer@example.test';
  if (field === 'sourceVersion') body.snapshot.sourceVersion = 'v900';
  if (field === 'provenance') body.snapshot.provenance.evidenceRef = 'unreviewed-evidence';
  if (field === 'briefDigest' || field === 'bindingDigest') body.snapshot[field] = '0'.repeat(64);
  expect(body.snapshot.reviewKey).toBe(original.snapshot.reviewKey);
  expect(body.snapshot.content).toBe(original.snapshot.content); expect(body.snapshot.sha256).toBe(original.snapshot.sha256);
  await route.fulfill({ response, json: body });
 });
 await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click();
 await expect(panel(page).getByRole('alert')).toBeVisible(); await expect(panel(page).getByRole('checkbox')).toHaveCount(0);
 await expect(panel(page).getByRole('button', { name: 'Aprobar documento internamente' })).toHaveCount(0);
 expect(approvalCommands).toEqual([]);
 const response = await request.post('/__proposal-fixture', { data: { action: 'proposal-read', target: { leadId: original.leadId, eventId: original.eventId, proposalId: original.proposalId } } });
 const saved = await response.json(); expect(saved.status).toBe('pending_internal_review'); expect(saved.snapshot.intendedRecipient).toBe('client@example.test');
 if (field === 'intendedRecipient') await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-external-proposal-review-rejected.png` });
});
