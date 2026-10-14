import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { chromium, type Browser } from '@playwright/test';
import { testScope, testActor, testCatalog } from '../office/event-quote-fixtures';
// Explicit isolated test composition, never imported by the app or its servers.
// Run after starting the local office test database. No external requests or real identity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const now = Date.now();
const eventId = 'BROWSER-EVENT';
const schema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const accessSchema = `quote_access_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 4, connectionTimeoutMillis: 1000 });
const vault = new MondayVault(randomBytes(32));
const store = new PostgresEventQuoteStore(pool, { schema, vault });
const access = new PostgresQuoteAccessRepository(pool, { schema: accessSchema });
// This synthetic proof exists only in the server adapter. The browser never receives it.
const proof = { sessionToken: `synthetic_session_${randomUUID()}`, csrfToken: `synthetic_csrf_${randomUUID()}` };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const catalog = { ...testCatalog, validUntilMs: now + 86_400_000 };
let clockOffset = 0;
let pendingCatalog: { entered(): void; released: Promise<void>; finished(): void } | undefined;
const makeApi = () => createDurableTestQuoteApi({ pool, vault, quoteSchema: schema, accessSchema,
  dashboardEventId: eventId, allowedOrigin: 'http://127.0.0.1:4197', resolveExistingSession: () => proof, clock: () => Date.now() + clockOffset,
  catalogFor: async scope => {
    assert.deepEqual(scope, testScope, 'Catalog must come from the authorized workspace');
    if (pendingCatalog) {
      const pending = pendingCatalog; pendingCatalog = undefined;
      pending.entered(); await pending.released; pending.finished();
    }
    return catalog;
  },
});
let browser: Browser | undefined;
let api: ReturnType<typeof makeApi> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let initialized = false, accessInitialized = false;
try {
await store.initialize(); initialized = true;
await access.initializeTestSchema(); accessInitialized = true;
const scope = [testScope.organizationId, testScope.workspaceId, testScope.mode];
await pool.query(`INSERT INTO ${accessSchema}.users VALUES ($1,$2,$3,$4,'MANAGER',true,1)`, [...scope, testActor.actorId]);
await pool.query(`INSERT INTO ${accessSchema}.memberships VALUES ('browser-membership',$1,$2,$3,$4,1,$5,NULL)`, [...scope, testActor.actorId, new Date(now - 1000)]);
await pool.query(`INSERT INTO ${accessSchema}.sessions VALUES ($1,$2,$3,$4,$5,$6,'browser-membership',1,1,$7,NULL)`, [hash(proof.sessionToken), hash(proof.csrfToken), ...scope, testActor.actorId, new Date(now + 600_000)]);
await pool.query(`INSERT INTO ${accessSchema}.assignments VALUES ($1,$2,$3,$4,$5,1,true)`, [...scope, eventId, testActor.actorId]);
await pool.query(`INSERT INTO ${accessSchema}.event_grants VALUES ($1,$2,$3,$4,$5,1,true,true,true,$6,NULL)`, [...scope, eventId, testActor.actorId, new Date(now - 1000)]);
api = makeApi(); await api.listen({ host: '127.0.0.1', port: 4198 });
const harness = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {DashboardPage} from '/src/office/DashboardPage.tsx';
import {eventQuoteClient} from '/src/office/event-quote-client.ts';
import {createDashboardQuoteAccessSource} from '/src/office/dashboard/quote-access.ts';
import '/src/office/office.css'; import '/src/office/dashboard.css'; import '/src/office/dashboard-navigation.css';
import '/src/office/dashboard/approved-dashboard.css'; import '/src/office/dashboard/event-workflow.css'; import '/src/office/dashboard/dashboard-integration.css';
const source=createDashboardQuoteAccessSource({subscribe(callback){window.addEventListener('test-access-withdraw',callback);return()=>window.removeEventListener('test-access-withdraw',callback)}});
createRoot(document.getElementById('root')).render(<DashboardPage quoteAccessSource={source} quoteClient={eventQuoteClient}/>);`;
vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 4197, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4198', changeOrigin: false } } }, plugins: [{name:'temporary-quote-harness', resolveId(id){ if (id === '/quote-harness.tsx') return id; }, async load(id){ if(id === '/quote-harness.tsx') return (await transformWithEsbuild(harness, 'quote-harness.tsx', {loader:'tsx',jsx:'automatic'})).code; }, configureServer(server){ server.middlewares.use((req,res,next)=>{if(req.url === '/quote-test'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/quote-harness.tsx"></script></body></html>');}else next();});}}] });
await vite.listen();
browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.clock.install({ time: Date.now() });
const errors: string[] = []; const external: string[] = []; const quoteRequests: string[] = [];
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/office/event-quotes')) quoteRequests.push(request.method()); });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => { const url = new URL(route.request().url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.href); await route.abort(); } else await route.continue(); });
await mkdir(new URL('../../test-results/dashboard-visual/', import.meta.url), { recursive: true });
  await page.goto('http://127.0.0.1:4197/quote-test');
  await page.getByTestId('approved-dashboard-summary').waitFor();
  await page.getByRole('button', {name: 'Propuestas', exact: true}).click();
  await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(quoteRequests.length, 0, 'Mounting Propuestas must not read a session or quote');
  assert.equal(await page.getByTestId('persisted-quote-approve').count(), 0);
  const openSaved = async (eventId = 'BROWSER-EVENT') => {
    await page.getByTestId('dashboard-verify-quotes').click();
    await page.getByTestId('dashboard-quote-event').selectOption(eventId);
    assert.equal(await page.getByTestId('dashboard-quote-event').locator('option').count(), 2, 'Only one preassigned event may be projected');
    await page.getByTestId('dashboard-open-quote').click();
  };
  await openSaved();
  await page.getByLabel('Contacto', { exact: true }).fill('Browser synthetic contact');
  await page.getByLabel('Destinatario previsto', { exact: true }).fill('browser@example.test');
  await page.getByLabel('Mensaje original', { exact: true }).fill('Synthetic manual inquiry for 24 guests.');
  await page.getByLabel('Comensales', { exact: true }).fill('24');
  await page.getByLabel('Fecha propuesta', { exact: true }).fill('Synthetic proposed date');
  await page.getByLabel('Lugar propuesto', { exact: true }).fill('Synthetic proposed location');
  await page.getByLabel('Requisitos y pendientes', { exact: true }).fill('All logistics still unconfirmed.');
  await page.getByRole('button', { name: 'Crear expediente', exact: true }).click();
  await page.getByRole('heading', {name: 'Brief manual · versión 1', exact: true}).waitFor();
  await page.getByLabel(/Partida sintética/).fill('24');
  await page.getByRole('button', {name: 'Generar versión de cotización'}).click();
  await page.getByRole('heading', {name: 'Revisión exacta · cotización v1', exact: true}).waitFor();
  const review = page.getByRole('checkbox'); await review.check();
  await page.getByTestId('persisted-quote-approve').click();
  await page.getByText('Aprobada internamente · sin envío', {exact:true}).first().waitFor();
  let persisted = await store.read(testScope, eventId); assert.equal(persisted!.decisions.length, 1); assert.equal(persisted!.revision, 3);
  // Recreate the full server composition with the same durable SQL rows and vault.
  await api.close(); api = makeApi(); await api.listen({ host: '127.0.0.1', port: 4198 });
  const requestsBeforeReload = quoteRequests.length;
  await page.reload(); await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(await page.getByTestId('persisted-quote-approve').count(), 0);
  assert.equal(quoteRequests.length, requestsBeforeReload, 'Reload must not reopen the existing identity');
  await openSaved(); await page.getByText('Aprobada internamente · sin envío', {exact:true}).first().waitFor(); assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  await page.getByLabel('Comensales',{exact:true}).fill('25'); assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  await page.getByRole('button', {name:'Guardar nueva versión del brief'}).click(); await page.getByText('Cotización obsoleta', {exact:true}).first().waitFor();
  await page.getByLabel(/Partida sintética/).fill('25'); await page.getByRole('button', {name:'Generar versión de cotización'}).click();
  await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  const artifact = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/BROWSER-EVENT/quotes/1/artifact'); assert.equal(artifact.status(), 200); assert.match(await artifact.text(), /Cotización v1/); assert.match(artifact.headers()['content-security-policy'], /sandbox/);
  // Full-page captures must start at the top so sticky navigation is not stitched halfway down.
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-desktop.png', import.meta.url)), fullPage:true});
  await page.setViewportSize({width:360,height:780}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-mobile.png', import.meta.url)), fullPage:true});
  const notifyWithdrawal = () => page.evaluate(() => window.dispatchEvent(new Event('test-access-withdraw')));
  const assertClosed = async () => {
    await page.getByTestId('dashboard-quote-event').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('dashboard-quote-event').count(), 0);
    assert.equal(await page.getByTestId('persisted-quote-approve').count(), 0);
    assert.equal(await page.getByLabel('Contacto', { exact: true }).count(), 0);
  };
  // Actual server-side session revocation; the host's signal only closes the view.
  await pool.query(`UPDATE ${accessSchema}.sessions SET revoked_at=now()`);
  await notifyWithdrawal(); await page.getByText(/El acceso cambió o se retiró/).waitFor(); await assertClosed();
  await page.getByTestId('dashboard-verify-quotes').click();
  await page.getByText(/No se pudo verificar el acceso/).waitFor(); await assertClosed();
  const afterWithdraw = quoteRequests.length;
  await pool.query(`UPDATE ${accessSchema}.sessions SET revoked_at=NULL`);
  await notifyWithdrawal();
  assert.equal(quoteRequests.length, afterWithdraw, 'Restoring SQL authority must not trigger a read');
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  // Observe a delayed real event GET, then close it. Its late response cannot revive the view.
  await page.getByRole('button', { name: 'Cerrar expediente', exact: true }).click();
  await page.getByTestId('dashboard-verify-quotes').click();
  await page.getByTestId('dashboard-quote-event').selectOption(eventId);
  let releaseStarted!: () => void, releaseRead!: () => void, finishRead!: () => void;
  const delayStarted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Delayed event GET did not reach the durable catalog provider')), 10_000);
    timer.unref(); releaseStarted = () => { clearTimeout(timer); resolve(); };
  });
  const released = new Promise<void>(resolve => { releaseRead = resolve; });
  let completed = false;
  const finished = new Promise<void>(resolve => { finishRead = () => { completed = true; resolve(); }; });
  // Arm only the real event GET before allowing it to reach the API. The
  // transaction remains pending until the test explicitly closes the view.
  await page.route(`http://127.0.0.1:4197/api/office/event-quotes/${eventId}`, async route => {
    pendingCatalog = { entered: releaseStarted, released, finished: finishRead };
    await route.continue();
  }, { times: 1 });
  try {
    await page.getByTestId('dashboard-open-quote').click(); await delayStarted;
    assert.equal(completed, false);
    await page.getByRole('button', { name: 'Cerrar expediente', exact: true }).click(); await assertClosed();
    assert.equal(completed, false, 'The delayed read must still be pending when the view closes');
    releaseRead(); await finished; await assertClosed();
  } finally { releaseRead(); }
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Dashboard',exact:true}).click(); await page.getByTestId('approved-dashboard-summary').waitFor();
  assert.equal(await page.getByTestId('persisted-quote-approve').count(),0);
  assert.match(await page.getByTestId('approved-dashboard-disclosure').innerText(),/Datos reales desconocidos/);
  assert.match(await page.getByTestId('approved-metric-pipeline').innerText(),/—/);
  const beforeBack = quoteRequests.length; await page.goBack(); await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(quoteRequests.length,beforeBack); assert.equal(await page.getByTestId('dashboard-quote-event').count(),0);
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  // No host signal: a shorter SQL session expiry changes the opaque revision.
  await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1`, [new Date(Date.now() + 300_000)]);
  await page.getByRole('button',{name:'Recargar expediente',exact:true}).click();
  await page.getByText(/El servidor retiró o no pudo verificar este acceso/).waitFor(); await assertClosed();
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  // Read-only is persisted in the event grant, rather than a fabricated UI flag.
  await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=false,can_approve=false`);
  await notifyWithdrawal(); await assertClosed(); await openSaved();
  await page.getByText(/Solo lectura\. Puedes revisar/).waitFor();
  assert.equal(await page.getByLabel('Contacto', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Generar versión de cotización' }).isDisabled(), true);
  assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  const readOnlyStatus = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/status');
  assert.equal(readOnlyStatus.status(), 200);
  const readOnlySession = (await readOnlyStatus.json()).session;
  const forbidden = await page.request.post(`http://127.0.0.1:4197/api/office/event-quotes/${eventId}/commands`, {
    headers: { Origin: 'http://127.0.0.1:4197', 'x-event-quote-csrf': readOnlySession.csrfToken,
      'x-event-quote-access-revision': readOnlySession.accessRevision },
    data: { action: 'brief', key: 'blocked-readonly', expectedRevision: 5, brief: {} },
  });
  assert.equal(forbidden.status(), 403, 'Direct HTTP cannot bypass the read-only SQL grant');
  // Establish the loaded state before advancing both clocks to the SQL deadline.
  const grantExpiresAt = Date.now() + 120_000;
  await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=true,can_approve=true,effective_to=$1`, [new Date(grantExpiresAt)]);
  await notifyWithdrawal(); await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  clockOffset = grantExpiresAt - Date.now() + 1;
  await page.clock.fastForward(grantExpiresAt - await page.evaluate(() => Date.now()) + 1);
  await page.getByText(/El acceso o el catálogo venció/).waitFor(); await assertClosed();
  const expired = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/dashboard/access');
  assert.equal(expired.status(), 403);
  await pool.query(`UPDATE ${accessSchema}.event_grants SET effective_to=NULL`);
  await notifyWithdrawal(); await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  // An unannounced server change is still enforced and withdraws the stale UI on reload.
  await pool.query(`UPDATE ${accessSchema}.event_grants SET enabled=false`);
  await page.getByRole('button',{name:'Recargar expediente',exact:true}).click();
  await page.getByText(/El servidor retiró o no pudo verificar este acceso/).waitFor(); await assertClosed();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  persisted = await store.read(testScope, eventId); assert.equal(persisted!.revision,5); assert.equal(persisted!.decisions.length,1);
  console.log('PASS: durable SQL session and fixed-event Dashboard projection; explicit access with no reads on mount/reload/restore/history; Chromium desktop/mobile create -> quote -> internal approval -> API restart -> recovery -> stale edit -> v2; artifact isolation; SQL session revocation and grant withdrawal; delayed real GET discarded on close; persisted read-only enforcement and grant expiry; no JS errors or external requests. PostgreSQL preserves exact revisions and decisions. Screenshots in test-results/dashboard-visual/.');
} finally {
  await browser?.close(); await vite?.close(); await api?.close();
  try {
    if (initialized) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (accessInitialized) await pool.query(`DROP SCHEMA IF EXISTS ${accessSchema} CASCADE`);
  }
  finally { await pool.end(); }
}
