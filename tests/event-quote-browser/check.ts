import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { canonical } from '../../src/office/backend/event-quote-workflow';
import type { EventQuoteRecord, EventQuoteView, PaymentConfigurationFactsV2, PaymentContractModeV2, TestPaymentDraftDependenciesV2 } from '../../src/office/backend/event-quote-contracts';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { chromium, type Browser, type Locator } from '@playwright/test';
import { testScope, testActor, testCatalog } from '../office/event-quote-fixtures';
import { receiveIsolatedPaymentContractV2 } from '../payments-contract/php-v2-receiver';
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
// Synthetic binding owned by this server fixture. No recipient/email or body
// field can select a lead, tenant, actor or provider account.
const canonicalLeadKey = (scope: typeof testScope, event: string) => canonical({ scope, event });
const canonicalLeadFixtures = new Map([[canonicalLeadKey(testScope, eventId), 'browser-synthetic-canonical-lead']]);
let validationFault: 'none' | 'altered_receipt' | 'timeout' | 'session_expiry' = 'none';
let validationCalls = 0, phpStarts = 0, validationAborts = 0, sessionDeadline = 0;
let latestValidationSignal: AbortSignal | undefined;
let paymentDraftsEnabled = false;
const testPaymentDrafts: TestPaymentDraftDependenciesV2 = {
  resolveCanonicalLead: async (scope, event) => {
    const canonicalLeadId = canonicalLeadFixtures.get(canonicalLeadKey(scope, event));
    return canonicalLeadId ? { source: 'synthetic_fixture', canonicalLeadId } : null;
  },
  validationTimeoutMs: 2000,
  validateContract: async (body, nowMs, signal) => {
    validationCalls++; latestValidationSignal = signal;
    const receipt = await receiveIsolatedPaymentContractV2(body, nowMs, signal, () => { phpStarts++; });
    if (validationFault === 'altered_receipt') {
      const altered = JSON.parse(receipt); altered.authorizationVerified = true;
      return JSON.stringify(altered);
    }
    if (validationFault === 'timeout') {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => { validationAborts++; reject(new Error('SYNTHETIC_VALIDATION_DELAY_ABORTED')); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (validationFault === 'session_expiry') clockOffset = sessionDeadline - Date.now() + 1;
    return receipt;
  },
};
const makeApi = () => createDurableTestQuoteApi({ pool, vault, quoteSchema: schema, accessSchema,
  dashboardEventId: eventId, allowedOrigin: 'http://127.0.0.1:4197', resolveExistingSession: () => proof, clock: () => Date.now() + clockOffset,
  ...(paymentDraftsEnabled ? { testPaymentDrafts } : {}),
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
const visualPath = (filename: string) => fileURLToPath(new URL('../../test-results/dashboard-visual/' + filename, import.meta.url));
const draftForQuote = (version: number) => page.getByTestId('persisted-payment-v2-request').filter({
  has: page.getByRole('heading', { name: 'Borrador de contrato v2 · cotización v' + version, exact: true }),
});
const quoteReviewCard = () => page.locator('section.gew-card').filter({
  has: page.getByRole('heading', { name: /^Revisión exacta · cotización v\d+$/ }),
});
const settleViewport = () => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
});
const assertQuoteMoneyFits = async (viewportName: string) => {
  const review = quoteReviewCard();
  assert.equal(await review.count(), 1, 'There must be one exact source quote review');
  const heading = await review.getByRole('heading', { level: 3 }).innerText();
  const cells = review.locator('tbody td:nth-child(3), tbody td:nth-child(4), tfoot td');
  assert.ok(await cells.count() >= 5, 'Source quote must expose its unit, line subtotal and three totals');
  for (const cell of await cells.all()) {
    await cell.scrollIntoViewIfNeeded();
    const geometry = await cell.evaluate(element => {
      const box = element.getBoundingClientRect(), glyphs: Array<{ text: string; left: number; right: number; top: number; bottom: number }> = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const value = node.textContent ?? '';
        for (let index = 0; index < value.length; index++) {
          if (!value[index].trim()) continue;
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width > 0 && rect.height > 0) glyphs.push({ text: value[index], left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
          }
          range.detach();
        }
      }
      // Actual character boxes must share a vertical band. CSS white-space or
      // scrollWidth alone cannot detect a final digit wrapped onto a new line.
      const singleLine = glyphs.length > 0 && Math.max(...glyphs.map(g => g.top)) < Math.min(...glyphs.map(g => g.bottom));
      const tolerance = 0.75;
      const insideCell = glyphs.every(g => g.left >= box.left - tolerance && g.right <= box.right + tolerance && g.top >= box.top - tolerance && g.bottom <= box.bottom + tolerance);
      const insideViewport = glyphs.every(g => g.left >= -tolerance && g.right <= window.innerWidth + tolerance && g.top >= -tolerance && g.bottom <= window.innerHeight + tolerance);
      return { text: element.textContent, cell: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, glyphs, singleLine, insideCell, insideViewport };
    });
    const context = heading + ' / ' + viewportName + ': ' + JSON.stringify(geometry);
    assert.ok(geometry.singleLine, 'Monetary text must render on one real line: ' + context);
    assert.ok(geometry.insideCell, 'Every monetary glyph must remain inside its own visible cell: ' + context);
    assert.ok(geometry.insideViewport, 'Every monetary glyph must be visible without clipping: ' + context);
  }
};
const capturePaymentState = async (prefix: string, detail: Locator) => {
  await page.waitForFunction(() => !document.querySelector('[data-testid="persisted-quote-workspace"]')?.textContent?.includes('Guardando'));
  assert.equal(await detail.count(), 1, 'The exact payment state must have one detail section');
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 360, height: 780 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleViewport();
    await assertQuoteMoneyFits(viewport.name);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, prefix + ' must not overflow ' + viewport.name);
    assert.equal(await detail.locator('a').count(), 0, 'Pending payment states must expose no executable anchors');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
    await page.screenshot({ path: visualPath(prefix + '-' + viewport.name + '.png'), fullPage: true, animations: 'disabled' });
    // Element capture preserves the payment text at its native readable scale,
    // independently of the height of the complete quote and history page.
    await detail.screenshot({ path: visualPath(prefix + '-' + viewport.name + '-detail.png'), animations: 'disabled' });
    if (prefix !== 'payments-v2-selector-empty') {
      const review = quoteReviewCard(), heading = await review.getByRole('heading', { level: 3 }).innerText();
      const version = /^Revisión exacta · cotización v(\d+)$/.exec(heading); assert.ok(version);
      await review.screenshot({ path: visualPath('quote-v' + version[1] + '-' + viewport.name + '-detail.png'), animations: 'disabled' });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await settleViewport();
};
const captureDraft = async (mode: '50' | '100' | '49', version: number) => {
  const draft = draftForQuote(version);
  await draft.getByText('Pendiente de configuración y aprobación · sin enlace', { exact: true }).waitFor();
  const label = mode === '50' ? '50 % inicial y 50 % de saldo'
    : mode === '100' ? '100 % por adelantado' : 'Reserva fija de USD 49 (excepción)';
  await draft.getByText(label, { exact: true }).waitFor();
  if (mode === '100') assert.match(await draft.innerText(), /Sin saldo futuro/);
  assert.match(await draft.innerText(), /Proveedor desactivado y receptor del contrato v2 no disponible/);
  assert.match(await draft.innerText(), /La aprobación interna de la cotización no autoriza este contrato/);
  await capturePaymentState('payments-v2-' + mode, draft);
};
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
  const preparationPosts = () => quoteRequests.filter(method => method === 'POST').length;
  const beforePrepare = preparationPosts();
  const paymentMode = page.getByTestId('persisted-payment-mode');
  assert.equal(await paymentMode.inputValue(), '', 'Payment mode must require an explicit choice');
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  assert.equal(await paymentMode.locator('option:checked').getAttribute('value'), '', 'Fixed 49 must never be selected automatically');
  const paymentCard = page.locator('section.gew-card').filter({
    has: page.getByRole('heading', { name: 'Preparación de enlace de pago', exact: true }),
  });
  await capturePaymentState('payments-v2-selector-empty', paymentCard);
  await paymentMode.selectOption('fixed_49_reservation');
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true, 'A total below 49 cannot prepare a fixed reservation');
  assert.equal(preparationPosts(), beforePrepare, 'Selecting a mode must not save or execute a request');
  await paymentMode.selectOption('retainer_50');
  await page.waitForFunction(() => !(document.querySelector('[data-testid="persisted-payment-prepare"]') as HTMLButtonElement)?.disabled);
  // Same-turn repeated clicks exercise the synchronous in-flight lock.
  await page.getByTestId('persisted-payment-prepare').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.getByText('Pendiente de configuración y aprobación · sin enlace', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="persisted-quote-workspace"]')?.textContent?.includes('Guardando'));
  assert.equal(preparationPosts(), beforePrepare + 1);
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  assert.equal(await page.getByTestId('persisted-payment-v2-request').locator('a').count(), 0);
  persisted = await store.read(testScope, eventId);
  assert.equal(persisted!.revision, 4); assert.equal(persisted!.schemaVersion, 3); assert.deepEqual(persisted!.paymentPreparations, []); assert.equal(persisted!.paymentContractPreparationsV2!.length, 1);
  const originalPreparation = structuredClone(persisted!.paymentContractPreparationsV2![0]);
  assert.equal(originalPreparation.publicPaymentUrl, null); assert.equal(originalPreparation.providerEnabled, false);
  assert.equal(originalPreparation.paymentMode, 'retainer_50');
  assert.equal(originalPreparation.depositCents, persisted!.quotes[0].depositCents);
  assert.deepEqual(originalPreparation.depositBasis, { kind: 'quoted_percentage', basisPoints: 5000 });
  assert.equal(originalPreparation.initialPaymentCents, originalPreparation.depositCents);
  assert.equal(originalPreparation.paymentBalanceCents, originalPreparation.totalCents - originalPreparation.initialPaymentCents);
  assert.equal(originalPreparation.quotedDepositMatchesMode, true);
  assert.equal(originalPreparation.status, 'pending_configuration');
  for (const field of ['paymentTerms', 'paymentSchedule', 'paymentTermsApproval', 'canonicalLeadId'] as const) assert.equal(originalPreparation[field], null);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/payment-preparation-desktop.png', import.meta.url)), fullPage:true});
  await page.setViewportSize({width:360,height:780});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/payment-preparation-mobile.png', import.meta.url)), fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await captureDraft('50', 1);
  // Recreate the full server composition with the same durable SQL rows and vault.
  await api.close(); api = makeApi(); await api.listen({ host: '127.0.0.1', port: 4198 });
  const requestsBeforeReload = quoteRequests.length;
  await page.reload(); await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(await page.getByTestId('persisted-quote-approve').count(), 0);
  assert.equal(quoteRequests.length, requestsBeforeReload, 'Reload must not reopen the existing identity');
  await openSaved(); await page.getByText('Aprobada internamente · sin envío', {exact:true}).first().waitFor(); assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  await page.getByText('Pendiente de configuración y aprobación · sin enlace', { exact: true }).waitFor();
  assert.deepEqual((await store.read(testScope, eventId))!.paymentContractPreparationsV2![0], originalPreparation);
  assert.equal(await paymentMode.inputValue(), '', 'Recovery must not restore a default payment choice');
  await page.getByLabel('Comensales',{exact:true}).fill('25'); assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  await page.getByRole('button', {name:'Guardar nueva versión del brief'}).click(); await page.getByText('Cotización obsoleta', {exact:true}).first().waitFor();
  await page.getByText('Borrador obsoleto · conservar solo como historial', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  await page.getByLabel(/Partida sintética/).fill('25'); await page.getByRole('button', {name:'Generar versión de cotización'}).click();
  await page.getByRole('heading',{name:'Revisión exacta · cotización v2',exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  assert.equal(await paymentMode.inputValue(), '', 'A new quote version requires a fresh explicit payment choice');
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  const artifact = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/BROWSER-EVENT/quotes/1/artifact'); assert.equal(artifact.status(), 200); assert.match(await artifact.text(), /Cotización v1/); assert.match(artifact.headers()['content-security-policy'], /sandbox/);
  // Full-page captures must start at the top so sticky navigation is not stitched halfway down.
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-desktop.png', import.meta.url)), fullPage:true});
  await page.setViewportSize({width:360,height:780}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForFunction(() => window.scrollY === 0);
  await page.screenshot({path:fileURLToPath(new URL('../../test-results/dashboard-visual/persisted-quote-mobile.png', import.meta.url)), fullPage:true});
  // The second approved quote explicitly chooses 100 percent, preserving its
  // original quoted 50-percent deposit and the previous immutable v2 draft.
  await page.getByRole('checkbox').check(); await page.getByTestId('persisted-quote-approve').click();
  await page.getByText('Aprobada internamente · sin envío', { exact: true }).first().waitFor();
  assert.equal(await paymentMode.inputValue(), '');
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  await paymentMode.selectOption('full_upfront');
  await page.getByText('Pago único del 100 %. Sin saldo futuro. Requiere condiciones explícitas y aprobación.', { exact: true }).waitFor();
  await page.getByTestId('persisted-payment-prepare').click();
  await page.getByText('Pendiente de configuración y aprobación · sin enlace', { exact: true }).waitFor();
  persisted = await store.read(testScope, eventId);
  assert.equal(persisted!.revision, 8); assert.equal(persisted!.schemaVersion, 3);
  assert.deepEqual(persisted!.paymentPreparations, []);
  assert.equal(persisted!.paymentContractPreparationsV2!.length, 2);
  assert.deepEqual(persisted!.paymentContractPreparationsV2![0], originalPreparation);
  const fullPreparation = structuredClone(persisted!.paymentContractPreparationsV2![1]);
  assert.equal(fullPreparation.paymentMode, 'full_upfront');
  assert.equal(fullPreparation.initialPaymentCents, fullPreparation.totalCents);
  assert.equal(fullPreparation.paymentBalanceCents, 0);
  assert.equal(fullPreparation.depositCents, persisted!.quotes[1].depositCents);
  assert.deepEqual(fullPreparation.depositBasis, { kind: 'quoted_percentage', basisPoints: 5000 });
  assert.equal(fullPreparation.quotedDepositMatchesMode, false);
  assert.equal(fullPreparation.paymentSchedule, null); assert.equal(fullPreparation.paymentTermsApproval, null);
  assert.equal(fullPreparation.providerEnabled, false); assert.equal(fullPreparation.publicPaymentUrl, null);
  assert.equal(fullPreparation.blockers.includes('PAYMENT_SCHEDULE_REQUIRED'), false);
  assert.equal(await page.getByTestId('persisted-payment-v2-request').locator('a').count(), 0);
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  await captureDraft('100', 2);
  // A third quote reuses the second brief. Its larger synthetic quantity makes
  // the fixed-49 exception testable without changing the catalog or policies.
  const quotesBeforeFixed = structuredClone(persisted!.quotes);
  await page.getByLabel(/Partida sintética/).fill('100');
  await page.getByRole('button', { name: 'Generar versión de cotización' }).click();
  await page.getByRole('heading', { name: 'Revisión exacta · cotización v3', exact: true }).waitFor();
  persisted = await store.read(testScope, eventId);
  assert.equal(persisted!.revision, 9); assert.equal(persisted!.briefs.length, 2);
  assert.deepEqual(persisted!.quotes.slice(0, 2), quotesBeforeFixed);
  assert.equal(persisted!.quotes[2].briefVersion, 2);
  assert.equal(persisted!.quotes[2].briefDigest, persisted!.quotes[1].briefDigest);
  assert.equal(persisted!.quotes[2].totalCents, 10807);
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  assert.equal(await paymentMode.inputValue(), '', 'The fixed-49 exception must require another explicit choice');
  await page.getByRole('checkbox').check(); await page.getByTestId('persisted-quote-approve').click();
  await page.getByText('Aprobada internamente · sin envío', { exact: true }).first().waitFor();
  assert.equal((await store.read(testScope, eventId))!.revision, 10);
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  await paymentMode.selectOption('fixed_49_reservation');
  await page.waitForFunction(() => !(document.querySelector('[data-testid="persisted-payment-prepare"]') as HTMLButtonElement)?.disabled);
  await page.getByTestId('persisted-payment-prepare').click();
  const fixedDraft = draftForQuote(3);
  await fixedDraft.getByText('Pendiente de configuración y aprobación · sin enlace', { exact: true }).waitFor();
  persisted = await store.read(testScope, eventId);
  assert.equal(persisted!.revision, 11); assert.equal(persisted!.schemaVersion, 3);
  assert.equal(persisted!.decisions.length, 3); assert.equal(persisted!.paymentContractPreparationsV2!.length, 3);
  assert.deepEqual(persisted!.paymentPreparations, []);
  assert.deepEqual(persisted!.paymentContractPreparationsV2!.slice(0, 2), [originalPreparation, fullPreparation]);
  assert.deepEqual(persisted!.quotes.slice(0, 2), quotesBeforeFixed);
  const fixedPreparation = structuredClone(persisted!.paymentContractPreparationsV2![2]), fixedQuote = persisted!.quotes[2];
  assert.equal(fixedPreparation.paymentMode, 'fixed_49_reservation');
  assert.equal(fixedPreparation.initialPaymentCents, 4900);
  assert.equal(fixedPreparation.paymentBalanceCents, 5907);
  assert.equal(fixedPreparation.paymentBalanceCents, fixedQuote.totalCents - 4900);
  assert.equal(fixedPreparation.depositCents, fixedQuote.depositCents);
  assert.equal(fixedPreparation.depositCents, 5404);
  assert.deepEqual(fixedPreparation.depositBasis, { kind: 'quoted_percentage', basisPoints: 5000 });
  assert.equal(fixedPreparation.terms, fixedQuote.catalog.terms);
  assert.equal(fixedPreparation.quotedDepositMatchesMode, false);
  assert.equal(fixedPreparation.providerEnabled, false); assert.equal(fixedPreparation.publicPaymentUrl, null);
  assert.equal(fixedPreparation.status, 'pending_configuration');
  for (const field of ['paymentTerms', 'paymentSchedule', 'paymentTermsApproval', 'canonicalLeadId'] as const) assert.equal(fixedPreparation[field], null);
  assert.ok(fixedPreparation.blockers.includes('QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED'));
  assert.ok(fixedPreparation.blockers.includes('PAYMENT_SCHEDULE_REQUIRED'));
  await fixedDraft.getByText('Reserva fija de USD 49 (excepción)', { exact: true }).waitFor();
  await fixedDraft.getByText(/El importe inicial o la base de cálculo de la modalidad elegida difieren del anticipo cotizado/).waitFor();
  assert.equal(await fixedDraft.locator('a').count(), 0);
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  await captureDraft('49', 3);
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
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
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
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Dashboard',exact:true}).click(); await page.getByTestId('approved-dashboard-summary').waitFor();
  assert.equal(await page.getByTestId('persisted-quote-approve').count(),0);
  assert.match(await page.getByTestId('approved-dashboard-disclosure').innerText(),/Datos reales desconocidos/);
  assert.match(await page.getByTestId('approved-metric-pipeline').innerText(),/—/);
  const beforeBack = quoteRequests.length; await page.goBack(); await page.getByTestId('dashboard-verify-quotes').waitFor();
  assert.equal(quoteRequests.length,beforeBack); assert.equal(await page.getByTestId('dashboard-quote-event').count(),0);
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
  // No host signal: a shorter SQL session expiry changes the opaque revision.
  await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1`, [new Date(Date.now() + 300_000)]);
  await page.getByRole('button',{name:'Recargar expediente',exact:true}).click();
  await page.getByText(/El servidor retiró o no pudo verificar este acceso/).waitFor(); await assertClosed();
  await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
  // Read-only is persisted in the event grant, rather than a fabricated UI flag.
  await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=false,can_approve=false`);
  await notifyWithdrawal(); await assertClosed(); await openSaved();
  await page.getByText(/Solo lectura\. Puedes revisar/).waitFor();
  assert.equal(await page.getByLabel('Contacto', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Generar versión de cotización' }).isDisabled(), true);
  assert.equal(await page.getByTestId('persisted-quote-approve').isDisabled(), true);
  assert.equal(await page.getByTestId('persisted-payment-prepare').isDisabled(), true);
  const readOnlyStatus = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/status');
  assert.equal(readOnlyStatus.status(), 200);
  const readOnlySession = (await readOnlyStatus.json()).session;
  const forbidden = await page.request.post(`http://127.0.0.1:4197/api/office/event-quotes/${eventId}/commands`, {
    headers: { Origin: 'http://127.0.0.1:4197', 'x-event-quote-csrf': readOnlySession.csrfToken,
      'x-event-quote-access-revision': readOnlySession.accessRevision },
    data: { action: 'brief', key: 'blocked-readonly', expectedRevision: 11, brief: {} },
  });
  assert.equal(forbidden.status(), 403, 'Direct HTTP cannot bypass the read-only SQL grant');
  // Establish the loaded state before advancing both clocks to the SQL deadline.
  const grantExpiresAt = Date.now() + 120_000;
  await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=true,can_approve=true,effective_to=$1`, [new Date(grantExpiresAt)]);
  await notifyWithdrawal(); await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
  clockOffset = grantExpiresAt - Date.now() + 1;
  await page.clock.fastForward(grantExpiresAt - await page.evaluate(() => Date.now()) + 1);
  await page.getByText(/El acceso o el catálogo venció/).waitFor(); await assertClosed();
  const expired = await page.request.get('http://127.0.0.1:4197/api/office/event-quotes/dashboard/access');
  assert.equal(expired.status(), 403);
  await pool.query(`UPDATE ${accessSchema}.event_grants SET effective_to=NULL`);
  await notifyWithdrawal(); await openSaved(); await page.getByRole('heading',{name:'Revisión exacta · cotización v3',exact:true}).waitFor();
  // An unannounced server change is still enforced and withdraws the stale UI on reload.
  await pool.query(`UPDATE ${accessSchema}.event_grants SET enabled=false`);
  await page.getByRole('button',{name:'Recargar expediente',exact:true}).click();
  await page.getByText(/El servidor retiró o no pudo verificar este acceso/).waitFor(); await assertClosed();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  persisted = await store.read(testScope, eventId); assert.equal(persisted!.revision,11); assert.deepEqual(persisted!.paymentPreparations, []); assert.deepEqual(persisted!.paymentContractPreparationsV2, [originalPreparation, fullPreparation, fixedPreparation]); assert.equal(persisted!.decisions.length,3);
  // Keep the established screenshots and their revision assertions above
  // intact. The additive proof below uses real HTTP and the same durable SQL
  // authority, then crosses the actual isolated PHP validator before commit.
  const beforeHttpProof = structuredClone(persisted!);
  assert.equal(validationCalls, 0); assert.equal(phpStarts, 0);
  clockOffset = 0;
  await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1,revoked_at=NULL`, [new Date(Date.now() + 600_000)]);
  await pool.query(`UPDATE ${accessSchema}.event_grants SET enabled=true,can_write=true,can_approve=true,effective_to=NULL`);
  paymentDraftsEnabled = true;
  await api.close(); api = makeApi(); await api.listen({ host: '127.0.0.1', port: 4198 });
  const httpBase = `http://127.0.0.1:4197/api/office/event-quotes`;
  const authorityHeaders = async () => {
    const response = await page.request.get(`${httpBase}/status`);
    assert.equal(response.status(), 200, await response.text());
    const status = await response.json();
    assert.equal(status.session.mode, 'test');
    assert.equal(status.paymentDraftsEnabled, true, 'The synthetic configuration capability requires explicit server composition');
    sessionDeadline = status.session.expiresAtMs;
    return { Origin: 'http://127.0.0.1:4197', 'x-event-quote-csrf': status.session.csrfToken as string,
      'x-event-quote-access-revision': status.session.accessRevision as string };
  };
  const postCommand = async (command: unknown) => page.request.post(`${httpBase}/${eventId}/commands`, {
    headers: await authorityHeaders(), data: command,
  });
  const commandRecord = async (command: unknown): Promise<EventQuoteRecord> => {
    const response = await postCommand(command);
    assert.equal(response.status(), 200, await response.text());
    const result = await response.json() as EventQuoteView;
    assert.equal(result.externalEffectsEnabled, false);
    assert.deepEqual(await store.read(testScope, eventId), result.record, 'Only a committed SQL result may be reported over HTTP');
    return result.record;
  };
  const browserCommand = async (action: string, click: () => Promise<unknown>) => {
    const responsePromise = page.waitForResponse(response => response.url() === `${httpBase}/${eventId}/commands`
      && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action);
    await click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    const record = ((await response.json()) as EventQuoteView).record;
    assert.deepEqual(await store.read(testScope, eventId), record);
    await page.waitForFunction(() => !document.querySelector('[data-testid="persisted-quote-workspace"]')?.textContent?.includes('Guardando'));
    return { record, command: response.request().postDataJSON() };
  };
  const assertRolledBack = async (before: EventQuoteRecord, command: unknown, status: number) => {
    const response = await postCommand(command);
    assert.equal(response.status(), status, await response.text());
    assert.deepEqual(await store.read(testScope, eventId), before, 'Failed validation/authority must roll back record, audit and command receipt');
  };

  // These explicit far-future calendar fixtures are also exercised by the
  // isolated v2 round-trip suite. They are never parsed from the free-text brief.
  const configuredFacts = (mode: PaymentContractModeV2, balanceCents: number): PaymentConfigurationFactsV2 => ({
    paymentTerms: `${testCatalog.terms}\nFixture de contrato v2: solo borrador interno, sin autorización de cobro.`,
    termsChangeReason: 'Revisión expresa sintética de las nuevas condiciones.',
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
      ? { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York',
        balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
      : { kind: mode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: balanceCents },
    linkExpiration: { kind: 'at', date: '2099-11-20', time: '13:00', timezone: 'America/New_York' },
  });

  for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
    const prefix = `http-proof-${mode}`;
    let record = (await store.read(testScope, eventId))!;
    const existingQuote = record.quotes.at(-1)!;
    record = await commandRecord({ action: 'quote', key: `${prefix}-quote`, expectedRevision: record.revision,
      expectedBriefDigest: record.briefs.at(-1)!.digest, expectedCatalogDigest: existingQuote.catalogDigest,
      selections: existingQuote.lines.map(line => ({ itemId: line.catalogItemId, quantity: line.qty })) });
    const quote = structuredClone(record.quotes.at(-1)!);
    record = await commandRecord({ action: 'approve', key: `${prefix}-quote-approval`, expectedRevision: record.revision,
      quoteVersion: quote.version, quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256, intendedRecipient: record.briefs.at(-1)!.recipient });
    record = await commandRecord({ action: 'prepare_payment_v2', key: `${prefix}-preparation`, expectedRevision: record.revision,
      quoteVersion: quote.version, quoteDigest: quote.digest, approvalDigest: record.decisions.at(-1)!.digest,
      artifactSha256: quote.artifact.sha256, paymentMode: mode });
    const preparation = structuredClone(record.paymentContractPreparationsV2!.at(-1)!);
    const sourceQuotes = structuredClone(record.quotes), sourceBriefs = structuredClone(record.briefs), sourceDecisions = structuredClone(record.decisions);
    const configurationCommand = { action: 'configure_payment_v2', key: `${prefix}-configuration`, expectedRevision: record.revision,
      preparationId: preparation.id, preparationDigest: preparation.digest, ...configuredFacts(mode, preparation.paymentBalanceCents) };
    const beforeConfiguration = structuredClone(record);
    const beforePhp: number = phpStarts;
    await assertRolledBack(beforeConfiguration, { ...configurationCommand, canonicalLeadId: 'browser-forged-lead' }, 400);
    if (mode === 'retainer_50') {
      await pool.query(`UPDATE ${accessSchema}.event_grants SET can_approve=false`);
      await assertRolledBack(beforeConfiguration, configurationCommand, 403);
      await pool.query(`UPDATE ${accessSchema}.event_grants SET can_approve=true`);
      assert.equal(phpStarts, beforePhp, 'Browser injection and missing approval must not reach PHP');
    }
    if (mode === 'retainer_50') {
      await notifyWithdrawal(); await openSaved();
      await page.getByRole('heading', { name: `Revisión exacta · cotización v${quote.version}`, exact: true }).waitFor();
      const draft = draftForQuote(quote.version), facts = configuredFacts(mode, preparation.paymentBalanceCents);
      await draft.getByTestId('payment-v2-terms').fill(facts.paymentTerms);
      await draft.getByTestId('payment-v2-terms-reason').fill(facts.termsChangeReason!);
      await draft.getByTestId('payment-v2-event-date').fill('2099-12-15');
      await draft.getByTestId('payment-v2-event-time').fill('18:00');
      await draft.getByTestId('payment-v2-calendar-timezone').fill('America/New_York');
      await draft.getByTestId('payment-v2-balance-date').fill('2099-12-08');
      await draft.getByTestId('payment-v2-balance-time').fill('12:00');
      await draft.getByTestId('payment-v2-expiration').selectOption('at');
      await draft.getByTestId('payment-v2-expiration-date').fill('2099-11-20');
      await draft.getByTestId('payment-v2-expiration-time').fill('13:00');
      await draft.getByTestId('payment-v2-expiration-timezone').fill('America/New_York');
      record = (await browserCommand('configure_payment_v2', () => draft.getByTestId('payment-v2-configure').click())).record;
      await draft.getByTestId('persisted-payment-v2-review').waitFor();
      assert.equal(await draft.getByTestId('payment-v2-confirm-review').isChecked(), false);
      assert.equal(await draft.getByTestId('payment-v2-register').isDisabled(), true, 'Saving conditions cannot approve or register them automatically');
      await capturePaymentState('payments-v2-conditions-review', draft);
    } else record = await commandRecord(configurationCommand);
    assert.equal(record.schemaVersion, 4);
    const configuration = record.paymentConfigurationsV2!.at(-1)!;
    if (mode !== 'retainer_50') assert.equal(configuration.id, configurationCommand.key);
    assert.equal(configuration.configuration.canonicalLeadId, 'browser-synthetic-canonical-lead');
    assert.equal(configuration.leadSource, 'synthetic_fixture');
    assert.deepEqual(record.quotes, sourceQuotes); assert.deepEqual(record.briefs, sourceBriefs); assert.deepEqual(record.decisions, sourceDecisions);
    assert.deepEqual(record.paymentContractPreparationsV2!.at(-1), preparation);
    assert.equal(phpStarts, beforePhp, 'Saving configuration must not call PHP or create an agreement');
    const register = { action: 'register_payment_draft_v2', key: `${prefix}-registration`, expectedRevision: record.revision,
      configurationId: configuration.id, configurationDigest: configuration.digest, expectedReviewDigest: configuration.reviewDigest };
    const beforeRegistration = structuredClone(record);
    if (mode === 'retainer_50') {
      await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=false,can_approve=false`);
      await assertRolledBack(beforeRegistration, register, 403);
      await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=true,can_approve=true`);
      assert.equal(phpStarts, beforePhp, 'Read-only SQL authority must reject before validation');
      for (const fault of ['altered_receipt', 'timeout', 'session_expiry'] as const) {
        validationFault = fault;
        const startsBeforeFailure: number = phpStarts;
        try {
          await assertRolledBack(beforeRegistration, register, fault === 'session_expiry' ? 403 : fault === 'altered_receipt' ? 422 : 503);
          assert.equal(phpStarts, startsBeforeFailure + 1, 'Each injected post-PHP failure still validates the actual isolated contract exactly once');
          if (fault === 'timeout') {
            assert.equal(latestValidationSignal?.aborted, true, 'Workflow timeout must abort its validation signal');
            assert.equal(validationAborts, 1);
          }
        } finally { validationFault = 'none'; clockOffset = 0; }
      }
    }
    const successfulStarts: number = phpStarts, successfulCalls: number = validationCalls;
    // Two identical HTTP workflows start in parallel; this does not force SQL
    // contention. Together they must validate and append only once.
    let committedCommand: unknown = register;
    if (mode === 'retainer_50') {
      // The user sees the exact persisted review before checking its separate
      // approval and clicking the real registration control in the same card.
      const draft = draftForQuote(quote.version);
      await draft.getByTestId('payment-v2-confirm-review').check();
      const registered = await browserCommand('register_payment_draft_v2', () => draft.getByTestId('payment-v2-register').click());
      record = registered.record; committedCommand = registered.command;
      assert.deepEqual(await commandRecord(committedCommand), record);
      await draft.getByTestId('persisted-payment-v2-registration').getByText('Validación contractual sintética registrada', { exact: true }).waitFor();
      assert.equal(await draft.locator('a').count(), 0);
      await capturePaymentState('payments-v2-registered-retainer', draft);
    } else {
      const registered = await Promise.all([commandRecord(register), commandRecord(register)]);
      assert.deepEqual(registered[0], registered[1]); record = registered[0];
    }
    assert.equal(phpStarts, successfulStarts + 1); assert.equal(validationCalls, successfulCalls + 1);
    const registration = record.paymentDraftRegistrationsV2!.at(-1)!;
    const committedKey = (committedCommand as { key: string }).key;
    assert.equal(registration.id, committedKey); assert.equal(registration.configurationDigest, configuration.digest);
    assert.equal(registration.reviewDigest, configuration.reviewDigest); assert.equal(registration.status, 'draft_internal');
    assert.equal(registration.receipt.status, 'contract_validated_internal');
    assert.equal(registration.receipt.prepared.plan.canonicalLeadId, 'browser-synthetic-canonical-lead');
    assert.equal(registration.receipt.prepared.plan.paymentMode, mode);
    assert.equal(registration.receipt.prepared.plan.initialPaymentCents, preparation.initialPaymentCents);
    assert.equal(registration.receipt.prepared.plan.paymentBalanceCents, preparation.paymentBalanceCents);
    assert.equal(registration.receipt.prepared.plan.sourceQuote.depositCents, quote.depositCents);
    assert.deepEqual(registration.receipt.prepared.plan.sourceQuote.depositBasis, { kind: 'quoted_percentage', basisPoints: quote.catalog.depositBps });
    for (const result of [registration, registration.receipt, registration.receipt.prepared]) {
      assert.equal(result.executable, false); assert.equal(result.providerEnabled, false); assert.equal(result.publicPaymentUrl, null);
    }
    assert.equal(registration.authorizationVerified, false); assert.equal(registration.receipt.authorizationVerified, false);
    if (mode === 'full_upfront') assert.equal(registration.receipt.prepared.plan.paymentSchedule, null);
    assert.deepEqual(record.quotes, sourceQuotes); assert.deepEqual(record.briefs, sourceBriefs); assert.deepEqual(record.decisions, sourceDecisions);
    assert.deepEqual(record.paymentContractPreparationsV2!.at(-1), preparation);
    assert.deepEqual(record.paymentConfigurationsV2!.at(-1), configuration);
    assert.equal(record.receipts.filter(receipt => receipt.key === committedKey).length, 1);
    assert.equal(record.audit.filter(entry => entry.commandKey === committedKey).length, 1);

    await api.close(); api = makeApi(); await api.listen({ host: '127.0.0.1', port: 4198 });
    const afterRestart = await page.request.get(`${httpBase}/${eventId}`);
    assert.equal(afterRestart.status(), 200); assert.deepEqual((await afterRestart.json()).record, record);
    const startsBeforeReplay: number = phpStarts, callsBeforeReplay: number = validationCalls;
    assert.deepEqual(await commandRecord(committedCommand), record, 'Restart replay must return the same committed aggregate');
    assert.equal(phpStarts, startsBeforeReplay); assert.equal(validationCalls, callsBeforeReplay, 'A durable command receipt must skip PHP after restart');
  }
  const afterHttpProof = (await store.read(testScope, eventId))!;
  assert.equal(afterHttpProof.schemaVersion, 4); assert.equal(afterHttpProof.revision, beforeHttpProof.revision + 15);
  assert.equal(afterHttpProof.paymentConfigurationsV2!.length, 3); assert.equal(afterHttpProof.paymentDraftRegistrationsV2!.length, 3);
  assert.deepEqual(afterHttpProof.quotes.slice(0, beforeHttpProof.quotes.length), beforeHttpProof.quotes);
  assert.deepEqual(afterHttpProof.briefs, beforeHttpProof.briefs);
  assert.deepEqual(afterHttpProof.paymentContractPreparationsV2!.slice(0, 3), beforeHttpProof.paymentContractPreparationsV2);
  assert.deepEqual(afterHttpProof.paymentPreparations, []);
  assert.equal(validationCalls, 6); assert.equal(phpStarts, 6); assert.equal(validationAborts, 1);
  const startsBeforeFinalReload: number = phpStarts, callsBeforeFinalReload: number = validationCalls;
  await page.reload(); await page.getByTestId('dashboard-verify-quotes').waitFor(); await openSaved();
  await page.getByRole('heading', { name: `Revisión exacta · cotización v${afterHttpProof.quotes.at(-1)!.version}`, exact: true }).waitFor();
  const visible = (text: string) => text.replace(/\s+/gu, ' ').trim();
  for (const configuration of afterHttpProof.paymentConfigurationsV2!) {
    const preparation = afterHttpProof.paymentContractPreparationsV2!.find(p => p.id === configuration.preparationId)!;
    const draft = draftForQuote(preparation.quoteVersion), facts = configuration.configuration;
    const review = draft.getByTestId('persisted-payment-v2-review');
    await review.waitFor();
    const text = visible(await review.innerText());
    for (const value of [preparation.terms, facts.paymentTerms, facts.termsChangeReason, configuration.reviewDigest])
      if (value !== null) assert.ok(text.includes(visible(value)), `Reload must retain reviewed ${preparation.paymentMode} facts`);
    if (facts.paymentSchedule) {
      const schedule = facts.paymentSchedule;
      for (const value of [schedule.balanceDate, schedule.balanceTime, schedule.timezone]) assert.ok(text.includes(value));
      if (schedule.kind === 'retainer_50') {
        for (const value of [schedule.eventDate, schedule.eventTime, schedule.timingExceptionReason ?? 'Sin excepción solicitada'])
          assert.ok(text.includes(value));
      }
    } else assert.ok(text.includes('Sin saldo futuro'));
    if (facts.linkExpiration.kind === 'at')
      for (const value of [facts.linkExpiration.date, facts.linkExpiration.time, facts.linkExpiration.timezone]) assert.ok(text.includes(value));
    assert.match(await draft.getByTestId('persisted-payment-v2-registration').innerText(), /Validación contractual sintética (registrada|obsoleta)/);
    assert.equal(await draft.getByTestId('payment-v2-register').count(), 0);
    assert.equal(await draft.getByTestId('payment-v2-confirm-review').count(), 0);
    assert.equal(await draft.locator('a').count(), 0);
  }
  assert.equal(await page.getByTestId('payment-v2-conditions-form').count(), 0);
  assert.equal(phpStarts, startsBeforeFinalReload); assert.equal(validationCalls, callsBeforeFinalReload, 'Reload/read-only recovery must not validate PHP again');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const contractEvidence = new URL('../../test-results/gourmet-payments-contract/', import.meta.url);
  await mkdir(contractEvidence, { recursive: true });
  await writeFile(new URL('http-durable-v2.json', contractEvidence), JSON.stringify({
    nodeVersion: process.version, source: 'Current durable HTTP/PostgreSQL/isolated PHP v2 execution',
    initialRevision: beforeHttpProof.revision, finalRevision: afterHttpProof.revision, schemaVersion: afterHttpProof.schemaVersion,
    validationCalls, actualPhpStarts: phpStarts, validationAborts,
    rollbackCases: ['altered_receipt', 'validation_timeout', 'in_flight_session_expiry'],
    authorityCases: ['browser_lead_injection_rejected', 'approval_grant_required', 'write_grant_required'],
    restartReplays: 3, parallelIdenticalRequestModes: ['full_upfront', 'fixed_49_reservation'],
    browserConfiguredAndConfirmedMode: 'retainer_50', sourceQuoteHistoryPreserved: true,
    browserReloadPreservedAllConfiguredFacts: true,
    registrations: afterHttpProof.paymentDraftRegistrationsV2!.map(registration => ({
      paymentMode: registration.receipt.prepared.plan.paymentMode,
      quotedDepositCents: registration.receipt.prepared.plan.sourceQuote.depositCents,
      quotedDepositBasis: registration.receipt.prepared.plan.sourceQuote.depositBasis,
      initialPaymentCents: registration.receipt.prepared.plan.initialPaymentCents,
      paymentBalanceCents: registration.receipt.prepared.plan.paymentBalanceCents,
      bodySha256: registration.bodySha256, receiptDigest: registration.receiptDigest, reviewDigest: registration.reviewDigest,
      status: registration.status, executable: registration.executable, providerEnabled: registration.providerEnabled,
      publicPaymentUrl: registration.publicPaymentUrl, authorizationVerified: registration.authorizationVerified,
    })),
  }, null, 2) + '\n');
  console.log('PASS: actual durable HTTP authorization -> PostgreSQL -> isolated PHP v2 -> committed draft for all three modes; explicit server-only synthetic lead binding; altered receipt, timeout/abort and in-flight session expiry roll back aggregate/audit/receipt; SQL permissions reject before PHP; two identical requests initiated in parallel validate once; API restart and command replay skip PHP; final browser reload retains all three configured reviews without registration controls or payment links; source quote history unchanged; 6 actual PHP validation starts, 3 successful internal drafts, no payment URL or customer authorization.');
  console.log('PASS: durable SQL session and fixed-event Dashboard projection; explicit access with no reads on mount/reload/restore/history; Chromium desktop/mobile create -> quote -> internal approval -> explicit 50-percent double-click-safe v2 payment draft without provider URL -> API restart -> recovery -> stale edit -> quote v2 -> explicit full-upfront draft -> quote v3 -> explicit fixed-49 draft; no automatic 49 selection; full-page and readable detail screenshots for all three saved modes in desktop/mobile; artifact isolation; SQL session revocation and grant withdrawal; delayed real GET discarded on close; persisted read-only enforcement and grant expiry; no JS errors or external requests. PostgreSQL preserves exact revisions and decisions. Screenshots in test-results/dashboard-visual/.');
} finally {
  await browser?.close(); await vite?.close(); await api?.close();
  try {
    if (initialized) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (accessInitialized) await pool.query(`DROP SCHEMA IF EXISTS ${accessSchema} CASCADE`);
  }
  finally { await pool.end(); }
}
