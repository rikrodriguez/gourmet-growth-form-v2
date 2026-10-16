import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { TEST_PROPOSAL_API as API, TEST_PROPOSAL_IDENTITY as ID, TEST_PROPOSAL_CSRF as CSRF } from '../../src/office/external-proposal-contracts';
const panel = (page: Page) => page.getByTestId('external-proposal-panel');
async function access(page: Page, lead = 'demo-history-a') {
 await page.getByRole('button', { name: 'Verificar acceso al historial', exact: true }).click();
 await page.getByLabel('Lead autorizado', { exact: true }).selectOption(lead);
 await page.getByRole('button', { name: 'Consultar historial del lead', exact: true }).click();
 await expect(panel(page)).toBeVisible(); await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(1); await expect(page.getByTestId('dashboard-persisted-quotes')).toHaveCount(0);
}
async function read(page: Page) {
 await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click();
 await expect(panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' })).toBeVisible();
}
async function associate(page: Page) { await panel(page).getByRole('button', { name: 'Asociar versión actual de prueba' }).click(); await expect(panel(page).getByRole('status')).toHaveText('Pendiente de revisión interna'); }
async function approve(page: Page) { await panel(page).getByRole('checkbox').check(); await panel(page).getByRole('button', { name: 'Aprobar documento internamente' }).click(); await expect(panel(page).getByRole('status')).toHaveText('Aprobada internamente · sin envío'); }
async function projected(request: APIRequestContext) { return (await request.get(`${API}/access`)).json(); }
async function control(page: Page, name: string, path = '/__durable-fixture/control') {
 const response = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === 'POST');
 await page.getByRole('button', { name, exact: true }).click(); const result = await response; expect(result.ok()).toBe(true); return result.json();
}
test.beforeEach(async ({ page, request }) => {
 const reset = await request.post('/__durable-control', { data: { action: 'reset' } }); expect(reset.ok()).toBe(true);
 await page.route('**/*', async route => { expect(new URL(route.request().url()).hostname).toBe('127.0.0.1'); await route.continue(); });
 await page.goto('/office/dashboard#quotes'); await expect(panel(page)).toHaveCount(0); await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(0); await access(page);
});
test('the normal application entry remains unconfigured and makes no integration request', async ({ page }) => {
 const paths: string[] = [];
 page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith(API) || path.startsWith('/__durable-quote')) paths.push(path); });
 await page.goto('/office/dashboard?plain=1#quotes');
 await expect(page.getByTestId('dashboard-persisted-quotes')).toBeVisible();
 await page.getByTestId('dashboard-verify-quotes').click();
 await expect(page.getByTestId('dashboard-persisted-quotes')).toContainText('Sin conexión operativa configurada');
 await page.getByRole('button', { name: 'Verificar acceso al historial', exact: true }).click();
 await expect(page.getByTestId('dashboard-lead-history')).toContainText('Sin fuente de historial configurada');
 await expect(panel(page)).toHaveCount(0); await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(0);
 expect(paths).toEqual([]);
});
test('the existing Dashboard refresh closes the expediente and requires a fresh review', async ({ page }) => {
 await read(page); await associate(page); await panel(page).getByRole('checkbox').check();
 await page.getByTestId('dashboard-refresh').click();
 await expect(page.getByTestId('dashboard-refresh')).toHaveText('Actualizar muestra');
 await expect(panel(page)).toHaveCount(0); await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(0);
 await access(page); await read(page); await expect(panel(page).getByRole('checkbox')).not.toBeChecked();
});
test('a late proposal from lead A cannot populate or approve the new server-mapped lead B', async ({ page, request }, info) => {
 await read(page); await associate(page);
 const old = await projected(request), before = await (await request.get(`${API}/proposal`, { headers: { [ID]: old.access.identityKey } })).json();
 let release!: () => void, arrived!: () => void;
 const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { arrived = resolve; });
 await page.route(`**${API}/proposal`, async route => {
  const response = await route.fetch(); arrived(); await waiting;
  try { await route.fulfill({ response }); } catch { /* The abandoned selection may already be aborted. */ }
 });
 await panel(page).getByRole('button', { name: 'Consultar propuesta externa', exact: true }).click(); await started;
 await control(page, 'Cambiar lead sintético en servidor', '/__durable-control'); await expect(panel(page)).toHaveCount(0);
 await access(page, 'demo-history-b');
 const stale = await request.post(`${API}/commands`, { headers: { origin: 'http://127.0.0.1:4194', [ID]: old.access.identityKey, [CSRF]: old.csrfToken }, data: { action: 'approve', key: 'lead-a-after-b', expectedRevision: before.revision, reviewKey: before.snapshot.reviewKey } });
 expect(stale.status()).toBe(403);
 release(); await page.unroute(`**${API}/proposal`); await read(page);
 await expect(panel(page)).toContainText('Lead: demo-history-b · Evento: SYNTHETIC-EVENT-b · Propuesta: SYNTHETIC-PROPOSAL-b');
 await expect(panel(page).getByRole('status')).toHaveText('Sin propuesta asociada');
 await associate(page); await expect(panel(page)).toContainText('PROPUESTA SINTÉTICA 2');
 await expect(panel(page)).not.toContainText('PROPUESTA SINTÉTICA 1'); await expect(panel(page).getByRole('checkbox')).not.toBeChecked();
 await approve(page); await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(1);
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-lead-b.png` });
 console.log('DASHBOARD_PROPOSAL_LEAD_ISOLATION ' + JSON.stringify({ project: info.project.name, from: old.target, to: (await projected(request)).target, staleApprovalStatus: stale.status(), oneWorkspace: true }));
});
test('a late lead A history is discarded after the server switches to lead B', async ({ page }, info) => {
 let release!: () => void, arrived!: () => void;
 const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { arrived = resolve; });
 await page.route(`**${API}/history`, async route => {
  if (!route.request().headers()[ID]) { await route.continue(); return; }
  const response = await route.fetch(); arrived(); await waiting;
  try { await route.fulfill({ response }); } catch { /* Old lead read was cancelled. */ }
 });
 await page.getByRole('button', { name: 'Consultar historial del lead', exact: true }).click(); await started;
 await page.getByLabel('Lead autorizado', { exact: true }).selectOption(''); await expect(panel(page)).toHaveCount(0);
 await control(page, 'Cambiar lead sintético en servidor', '/__durable-control');
 await page.unroute(`**${API}/history`); await access(page, 'demo-history-b'); release();
 await expect(page.getByTestId('persisted-quote-workspace')).toHaveCount(1);
 await expect(page.getByTestId('persisted-quote-workspace').getByRole('heading', { name: 'SYNTHETIC-EVENT-b', exact: true })).toBeVisible();
 await expect(page.getByTestId('dashboard-lead-history')).not.toContainText('SYNTHETIC-EVENT-a');
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-late-history.png` });
});
test('the actual Dashboard keeps one workspace and approves the server-mapped synthetic document', async ({ page, request }, info) => {
 const grant = await projected(request); expect(grant.access.identityKey).toMatch(/^proposal-[A-Za-z0-9_-]{43}$/);
 const history = await request.get(`${API}/history`, { headers: { [ID]: grant.access.identityKey } });
 expect((await history.json()).identityKey).toBe(grant.access.identityKey);
 await read(page); await associate(page); await approve(page);
 await expect(panel(page)).toContainText('PROPUESTA SINTÉTICA 1');
 await expect(panel(page).locator('a,iframe,img,textarea')).toHaveCount(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-approved.png` });
 await page.getByTestId('external-proposal-panel').scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-shell.png`, fullPage: true });
});
test('a different API PID and Pool recover the exact document and approval without cleaning schemas', async ({ page, request }, info) => {
 await read(page); await associate(page); await approve(page);
 const oldAccess = await projected(request), headers = { [ID]: oldAccess.access.identityKey, [CSRF]: oldAccess.csrfToken, origin: 'http://127.0.0.1:4194' };
 const before = await (await request.get(`${API}/proposal`, { headers })).json();
 const pid = (await (await request.get('/__durable-fixture/pid')).json()).pid;
 const restarted = await control(page, 'Reiniciar proceso de prueba', '/__durable-control');
 expect(restarted.oldPid).toBe(pid); expect(restarted.pid).not.toBe(pid); expect(restarted.oldExitCode).toBe(0); expect(restarted.poolClosed).toBe(true);
 await expect(panel(page)).toHaveCount(0); await expect(page.getByLabel('Lead autorizado', { exact: true })).toHaveCount(0);
 const stale = await request.post(`${API}/commands`, { headers, data: { action: 'approve', key: 'old-process-review', expectedRevision: before.revision, reviewKey: before.snapshot.reviewKey } }); expect(stale.status()).toBe(403);
 await access(page); await read(page); await expect(panel(page).getByRole('status')).toHaveText('Aprobada internamente · sin envío');
 const fresh = await projected(request); expect(fresh.access.identityKey).not.toBe(oldAccess.access.identityKey);
 const after = await (await request.get(`${API}/proposal`, { headers: { [ID]: fresh.access.identityKey } })).json();
 expect(after.snapshot).toEqual(before.snapshot); expect(after.approval).toEqual(before.approval); expect(after.revision).toBe(before.revision);
 expect((await (await request.get('/__durable-fixture/pid')).json()).pid).toBe(restarted.pid);
 console.log('DASHBOARD_PROPOSAL_RESTART_EVIDENCE ' + JSON.stringify({ project: info.project.name, oldPid: pid, newPid: restarted.pid, oldExitCode: restarted.oldExitCode, poolClosed: restarted.poolClosed, staleReviewStatus: stale.status(), recoveredRevision: after.revision, recoveredVersion: after.snapshot.sourceVersion, sameDocument: true, sameApproval: true, identityChanged: true }));
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-recovered.png` });
 await control(page, 'Publicar versión sintética nueva'); await read(page);
 await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 await associate(page); await panel(page).getByRole('checkbox').check();
 const candidate = await (await request.get(`${API}/proposal`, { headers: { [ID]: fresh.access.identityKey } })).json();
 await control(page, 'Retirar aprobación sintética'); await expect(panel(page)).toHaveCount(0);
 const denied = await request.post(`${API}/commands`, { headers: { origin: 'http://127.0.0.1:4194', [ID]: fresh.access.identityKey, [CSRF]: fresh.csrfToken }, data: { action: 'approve', key: 'post-restart-revoked', expectedRevision: candidate.revision, reviewKey: candidate.snapshot.reviewKey } });
 expect(denied.status()).toBe(403); expect((await (await request.get('/__durable-fixture/pid')).json()).pid).toBe(restarted.pid);
 console.log('DASHBOARD_PROPOSAL_POST_RESTART_INVALIDATION ' + JSON.stringify({ project: info.project.name, pid: restarted.pid, versionObsolete: true, revokedReviewStatus: denied.status() }));
});
test('a document version change rejects a checked stale review over HTTP', async ({ page, request }, info) => {
 await read(page); await associate(page); await panel(page).getByRole('checkbox').check();
 await control(page, 'Publicar versión sintética nueva');
 await panel(page).getByRole('button', { name: 'Aprobar documento internamente' }).click(); await expect(panel(page).getByRole('alert')).toBeVisible();
 await read(page); await expect(panel(page).getByRole('status')).toHaveText('Versión o contexto obsoleto · aprobación invalidada');
 const grant = await projected(request), stored = await (await request.get(`${API}/proposal`, { headers: { [ID]: grant.access.identityKey } })).json();
 expect(stored.approval).toBeNull(); expect(stored.revision).toBe(1);
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-obsolete.png` });
 await associate(page); await expect(panel(page)).toContainText('Versión inmutable: v2'); await approve(page);
});
test('grant changes clear review and deny stale or revoked approval before a write', async ({ page, request }, info) => {
 await read(page); await associate(page); await panel(page).getByRole('checkbox').check();
 const old = await projected(request), view = await (await request.get(`${API}/proposal`, { headers: { [ID]: old.access.identityKey } })).json();
 await control(page, 'Retirar aprobación sintética'); await expect(panel(page)).toHaveCount(0);
 const stale = await request.post(`${API}/commands`, { headers: { origin: 'http://127.0.0.1:4194', [ID]: old.access.identityKey, [CSRF]: old.csrfToken }, data: { action: 'approve', key: 'revoked-approval', expectedRevision: view.revision, reviewKey: view.snapshot.reviewKey } }); expect(stale.status()).toBe(403);
 await access(page); await read(page); await expect(panel(page).getByRole('status')).toHaveText('Pendiente de revisión interna');
 await panel(page).getByRole('checkbox').check(); await expect(panel(page).getByRole('button', { name: 'Aprobar documento internamente' })).toBeDisabled();
 await panel(page).screenshot({ path: `test-results/dashboard-visual/${info.project.name}-dashboard-proposal-readonly.png` });
 await control(page, 'Retirar acceso sintético'); await expect(panel(page)).toHaveCount(0);
 const denied = await request.get(`${API}/access`); expect(denied.status()).toBe(403);
 await control(page, 'Restaurar acceso sintético'); await expect(panel(page)).toHaveCount(0); await access(page); await read(page);
 await expect(panel(page).getByRole('checkbox')).not.toBeChecked(); await approve(page);
});
