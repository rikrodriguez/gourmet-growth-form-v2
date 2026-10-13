import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { createEventQuoteService } from '../../src/office/backend/event-quote-workflow';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { chromium, type Browser } from '@playwright/test';
import { createEventQuoteApi } from '../../src/office/backend/event-quote-http';
import { testScope, testActor, testBrief, testCatalog } from '../office/event-quote-fixtures';
// Explicit isolated test composition, never imported by the app or its servers.
// Run after starting the local office test database. No external requests or real identity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const now = Date.now();
const browserActor = { ...testActor, expiresAtMs: now + 600_000 };
const schema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 4, connectionTimeoutMillis: 1000 });
const store = new PostgresEventQuoteStore(pool, { schema, vault: new MondayVault(randomBytes(32)) });
const service = createEventQuoteService({ store, catalogFor: async () => ({ ...testCatalog, validUntilMs: now + 86_400_000 }), clock: Date.now });
const t = { service };
let browser: Browser | undefined;
let api: ReturnType<typeof createEventQuoteApi> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let initialized = false;
try {
await store.initialize(); initialized = true;
let sessionExpiry = now + 600_000;
const baseRead = t.service.read;
t.service.read = async (scope, actor, eventId) => { if (eventId === 'SLOW-EVENT') await new Promise(resolve => setTimeout(resolve, 600)); return baseRead(scope, actor, eventId); };
await t.service.execute(testScope, browserActor, 'SLOW-EVENT', { action: 'create', key: 'slow-intake', expectedRevision: 0, brief: { ...testBrief, contactName: 'Late response must not display' } });
api = createEventQuoteApi({ service: t.service, allowedOrigin: 'http://127.0.0.1:4197', clock: () => Date.now(), resolveIdentity: () => ({ scope: testScope, actor: testActor, csrfToken: 'browser-test-csrf-only', expiresAtMs: sessionExpiry }) });
await api.listen({ host: '127.0.0.1', port: 4198 });
const quoteStatus = await t.service.status(testScope, browserActor);
assert.ok(quoteStatus.catalog && quoteStatus.catalogDigest);
const testGrant = { state: 'ready', identityKey: 'test-identity', durableIdentity: false, scope: testScope,
  expiresAtMs: now + 600_000, eventIds: ['BROWSER-EVENT', 'SLOW-EVENT'],
  permissions: { canRead: true, canWrite: true, canApprove: true },
  catalog: { ready: true, digest: quoteStatus.catalogDigest, authority: 'test_only', validUntilMs: quoteStatus.catalog.validUntilMs } };
const harness = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {DashboardPage} from '/src/office/DashboardPage.tsx';
import {eventQuoteClient} from '/src/office/event-quote-client.ts';
import '/src/office/office.css'; import '/src/office/dashboard.css'; import '/src/office/dashboard-navigation.css';
import '/src/office/dashboard/approved-dashboard.css'; import '/src/office/dashboard/event-workflow.css'; import '/src/office/dashboard/dashboard-integration.css';
const grant=${JSON.stringify(testGrant)}; let identity='test-identity'; let version=0; let accessExpiry=grant.expiresAtMs; const listeners=new Set();
const source={async read(signal){signal.throwIfAborted();return identity ? {...grant, identityKey:identity, expiresAtMs:accessExpiry} : {state:'unavailable'};}, subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback)}};
const withdraw=()=>{identity=null;listeners.forEach(callback=>callback())}; const restore=()=>{identity='restored-test-'+(++version);accessExpiry=grant.expiresAtMs;listeners.forEach(callback=>callback())}; const shortExpiry=()=>{accessExpiry=Date.now()+3000;listeners.forEach(callback=>callback())};
function App(){return <><DashboardPage quoteAccessSource={source} quoteClient={eventQuoteClient}/><aside className="quote-test-controls" aria-label="Isolated test controls"><button onClick={withdraw}>Test logout</button><button onClick={restore}>Test restore identity</button><button onClick={shortExpiry}>Test short access expiry</button></aside></>}; createRoot(document.getElementById('root')).render(<App/>);`;
vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 4197, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4198', changeOrigin: false } } }, plugins: [{name:'temporary-quote-harness', resolveId(id){ if (id === '/quote-harness.tsx') return id; }, async load(id){ if(id === '/quote-harness.tsx') return (await transformWithEsbuild(harness, 'quote-harness.tsx', {loader:'tsx',jsx:'automatic'})).code; }, configureServer(server){ server.middlewares.use((req,res,next)=>{if(req.url === '/quote-test'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/quote-harness.tsx"></script></body></html>');}else next();});}}] });
await vite.listen();
browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
  let persisted = await t.service.read(testScope, browserActor, 'BROWSER-EVENT'); assert.equal(persisted.record.decisions.length, 1); assert.equal(persisted.record.revision, 3);
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
  await page.screenshot({style: '.quote-test-controls { display: none !important; }', path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-desktop.png', import.meta.url)), fullPage:true});
  await page.setViewportSize({width:360,height:780}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({style: '.quote-test-controls { display: none !important; }', path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-mobile.png', import.meta.url)), fullPage:true});
  await page.getByRole('button',{name:'Test logout',exact:true}).click(); await page.getByText(/El acceso cambió o se retiró/).waitFor();
  assert.equal(await page.getByText('browser@example.test',{exact:true}).count(),0); assert.equal(await page.getByTestId('persisted-quote-approve').count(),0);
  const afterWithdraw = quoteRequests.length;
  await page.getByRole('button',{name:'Test restore identity',exact:true}).click();
  assert.equal(quoteRequests.length, afterWithdraw); assert.equal(await page.getByTestId('dashboard-quote-event').count(),0);
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  await page.getByTestId('dashboard-quote-event').selectOption('SLOW-EVENT');
  const slowRequest = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/office/event-quotes/SLOW-EVENT');
  await page.getByTestId('dashboard-open-quote').click(); await slowRequest;
  await page.getByTestId('dashboard-quote-event').selectOption('BROWSER-EVENT'); await page.getByTestId('dashboard-open-quote').click();
  await page.waitForTimeout(900); assert.equal(await page.getByRole('heading',{name:'BROWSER-EVENT',exact:true}).count(),1); assert.equal(await page.getByText('Late response must not display',{exact:true}).count(),0);
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Dashboard',exact:true}).click(); await page.getByTestId('approved-dashboard-summary').waitFor();
  assert.equal(await page.getByTestId('persisted-quote-approve').count(),0);
  assert.match(await page.getByTestId('approved-dashboard-disclosure').innerText(),/Datos reales desconocidos/);
  assert.match(await page.getByTestId('approved-metric-pipeline').innerText(),/—/);
  const beforeBack = quoteRequests.length; await page.goBack(); await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(quoteRequests.length,beforeBack); assert.equal(await page.getByTestId('dashboard-quote-event').count(),0);
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  await page.getByRole('button',{name:'Test short access expiry',exact:true}).click();
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  await page.getByText(/El acceso o el catálogo venció/).waitFor(); assert.equal(await page.getByTestId('dashboard-quote-event').count(),0); assert.equal(await page.getByLabel('Contacto',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Test restore identity',exact:true}).click(); await openSaved();
  await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  // Independent check: the server now reports an earlier session deadline than the projection.
  sessionExpiry = Date.now() + 500;
  await page.getByRole('button',{name:'Recargar expediente',exact:true}).click(); await page.getByText(/El servidor retiró o no pudo verificar este acceso/).waitFor(); assert.equal(await page.getByTestId('persisted-quote-approve').count(),0); assert.equal(await page.getByLabel('Contacto',{exact:true}).count(),0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  persisted = await t.service.read(testScope,browserActor,'BROWSER-EVENT'); assert.equal(persisted.record.revision,5); assert.equal(persisted.record.decisions.length,1);
  console.log('PASS: approved Dashboard explicit access and event selection; no reads on mount/reload/identity restore/history navigation; unknown financial summary; Chromium desktop/mobile intake -> quote -> internal approval -> reload -> stale edit -> v2; artifact isolation; logout/identity reset; observed delayed event GET result; projected access expiry timer; shorter server-session mismatch withdrawal; no JS errors or external requests. PostgreSQL persists the exact revisions and decisions. Screenshots in test-results/dashboard-visual/.');
} finally {
  await browser?.close(); await vite?.close(); await api?.close();
  try { if (initialized) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await pool.end(); }
}
