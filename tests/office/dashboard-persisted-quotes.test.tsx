import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPage, eventModeFromHash } from '../../src/office/DashboardPage';
import { PersistedQuoteSection } from '../../src/office/dashboard/PersistedQuoteSection';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, quoteAccessExpiresAt, unconfiguredDashboardQuoteAccess, validateDashboardQuoteAccess,
  type DashboardQuoteAccessSource, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { EventQuoteClientError, type EventQuoteClient, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { dashboardFixtureSource } from '../../src/office/dashboard/source';
import { TEST_AT, testActor, testBrief, testScope, testService } from './event-quote-fixtures';
const EVENT = 'TEST-EVENT';
async function setup() {
  const t = testService();
  const view = await t.service.execute(testScope, testActor, EVENT, { action: 'create', key: 'dashboard-intake', expectedRevision: 0, brief: testBrief });
  const s = await t.service.status(testScope, testActor);
  const status: EventQuoteStatusResponse = { ...s, session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: 'test-csrf-not-for-display', expiresAtMs: TEST_AT + 60_000 }, externalEffectsEnabled: false };
  const access: DashboardQuoteGrant = { state: 'ready', identityKey: 'existing-test-identity-v1', durableIdentity: false, scope: testScope, expiresAtMs: TEST_AT + 60_000,
    eventIds: [EVENT], permissions: { canRead: true, canWrite: true, canApprove: true }, catalog: { ready: true, digest: s.catalogDigest!, validUntilMs: s.catalog!.validUntilMs, authority: 'test_only' } };
  const calls: string[] = [];
  const client: EventQuoteClient = { async status() { calls.push('status'); return status; }, async read(id) { calls.push(`read:${id}`); return view; }, async execute(id) { calls.push(`execute:${id}`); return view; } };
  return { t, view, status, access, calls, client };
}
const signal = () => new AbortController().signal;
const denied = (error: unknown) => error instanceof EventQuoteClientError;

test('Guardadas is the default in the approved shell and never renders the DEMO expediente', async () => {
  const snapshot = await dashboardFixtureSource.read(signal());
  for (const initialSection of ['quotes', 'events'] as const) {
    const html = renderToStaticMarkup(<DashboardPage initialSection={initialSection} initialSnapshot={snapshot} />);
    assert.match(html, /data-testid="dashboard-persisted-quotes"/);
    assert.match(html, /Sin conexión operativa configurada/);
    assert.match(html, /aria-pressed="true" data-testid="dashboard-quotes-saved"/);
    assert.match(html, /Ejemplo DEMO/); assert.match(html, /Verificar acceso a guardadas/);
    assert.doesNotMatch(html, /data-testid="event-workspace"|DEMO-EVT-042|QUOTE-042|client@example|<select|<form|persisted-quote-workspace/);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  }
});

test('saved connection is available without depending on the synthetic dashboard sample', () => {
  const html = renderToStaticMarkup(<DashboardPage initialSection="quotes" />);
  assert.match(html, /dashboard-persisted-quotes/); assert.match(html, /Importes, cobros y disponibilidad desconocidos/);
  assert.match(html, /no alimenta las métricas/); assert.doesNotMatch(html, /data-testid="approved-metric-/);
});

test('an injected source never reads itself, reveals its identity, or calls quote endpoints during SSR', async () => {
  const { access, client, calls } = await setup(); let reads = 0, subscriptions = 0;
  const source: DashboardQuoteAccessSource = { async read() { reads++; return access; }, subscribe() { subscriptions++; return () => {}; } };
  const html = renderToStaticMarkup(<PersistedQuoteSection source={source} client={client} />);
  assert.equal(reads, 0); assert.equal(subscriptions, 0); assert.deepEqual(calls, []);
  assert.match(html, /Acceso cerrado/); assert.doesNotMatch(html, /existing-test-identity|TEST-ORG|TEST-EVENT|test-csrf|<select/);
  assert.deepEqual(await unconfiguredDashboardQuoteAccess.read(signal()), { state: 'unconfigured' });
});

test('DEMO requires an explicit preview choice and only known legacy event tabs qualify as demo paths', async () => {
  const snapshot = await dashboardFixtureSource.read(signal());
  const html = renderToStaticMarkup(<DashboardPage initialSection="quotes" initialSnapshot={snapshot} initialEventMode="demo" />);
  assert.match(html, /data-testid="event-workspace"/); assert.match(html, /QUOTE-042/); assert.doesNotMatch(html, /dashboard-persisted-quotes/);
  for (const hash of ['', '#quotes', '#events', '#quotes/TEST-EVENT', '#events/unknown', '#inbox/revision', '#unknown/brief']) assert.equal(eventModeFromHash(hash), 'saved');
  for (const hash of ['#quotes/revision', '#events/brief', '#events/consulta', '#payments/cobro']) assert.equal(eventModeFromHash(hash), 'demo');
});

test('access projection is detached, bounded and does not derive durable commercial authority from a demo flag', async () => {
  const { access } = await setup();
  access.expiresAtMs = TEST_AT + 86_400_000;
  const copy = validateDashboardQuoteAccess(access, TEST_AT) as DashboardQuoteGrant;
  assert.equal(copy.expiresAtMs, TEST_AT + 15 * 60_000); assert.equal(quoteAccessExpiresAt(copy), copy.expiresAtMs);
  access.eventIds.push('UNEXPECTED'); access.permissions.canWrite = false; access.scope = { ...access.scope, workspaceId: 'OTHER' };
  assert.deepEqual(copy.eventIds, [EVENT]); assert.equal(copy.permissions.canWrite, true); assert.equal(copy.scope.workspaceId, testScope.workspaceId);
  for (const change of [
    { identityKey: '' }, { durableIdentity: undefined }, { expiresAtMs: TEST_AT }, { expiresAtMs: NaN },
    { scope: { ...testScope, organizationId: '' } }, { scope: { ...testScope, mode: 'demo' } },
    { scope: { ...testScope, mode: 'commercial' }, durableIdentity: false, catalog: { ...copy.catalog, authority: 'owner_authorized' } },
    { scope: { ...testScope, mode: 'commercial' }, durableIdentity: true },
    { catalog: { ...copy.catalog, ready: false } }, { catalog: { ...copy.catalog, digest: 'bad' } }, { catalog: { ...copy.catalog, validUntilMs: TEST_AT } },
    { permissions: { canRead: false, canWrite: true, canApprove: true } }, { permissions: { canRead: true, canWrite: false, canApprove: true } },
    { eventIds: ['../event'] }, { eventIds: ['status'] }, { eventIds: [EVENT, EVENT] },
  ]) assert.throws(() => validateDashboardQuoteAccess({ ...copy, ...change } as DashboardQuoteGrant, TEST_AT), denied);
  const commercial = { ...copy, scope: { ...testScope, mode: 'commercial' as const }, durableIdentity: true, catalog: { ...copy.catalog, authority: 'owner_authorized' as const } };
  assert.equal(validateDashboardQuoteAccess(commercial, TEST_AT).state, 'ready');
  assert.equal(validateDashboardQuoteAccess({ ...copy, eventIds: [] }, TEST_AT).state, 'ready');
});

test('bound client reads only explicit event IDs and validates complete scope before showing content', async () => {
  const { access, client, view, calls } = await setup();
  const gate = new DashboardQuoteAccessGate(); const bound = bindDashboardQuoteClient(client, access, gate.start(), () => TEST_AT);
  assert.equal((await bound.status(signal())).session.mode, 'test');
  assert.equal(await bound.read(EVENT, signal()), view);
  await assert.rejects(() => bound.read('UNPERMITTED', signal()), denied);
  assert.deepEqual(calls, ['status', `read:${EVENT}`]);
  for (const scope of [{ ...testScope, organizationId: 'OTHER' }, { ...testScope, workspaceId: 'OTHER' }, { ...testScope, mode: 'commercial' as const }]) {
    const wrong = { ...client, async read() { return { ...view, record: { ...view.record, scope } }; } };
    const binding = bindDashboardQuoteClient(wrong, access, gate.start(), () => TEST_AT);
    await assert.rejects(() => binding.read(EVENT, signal()), denied);
  }
});

test('read-only projection cannot escalate server status or submit any command', async () => {
  const { access, client, view, calls } = await setup(); access.permissions = { canRead: true, canWrite: false, canApprove: false };
  const bound = bindDashboardQuoteClient(client, access, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  const status = await bound.status(signal()); assert.equal(status.session.canWrite, false); assert.equal(status.session.canApprove, false);
  assert.equal(await bound.read(EVENT, signal()), view);
  await assert.rejects(() => bound.execute(EVENT, { action: 'brief', key: 'blocked', expectedRevision: 1, brief: testBrief }, 'not-used', signal()), denied);
  assert.deepEqual(calls, ['status', `read:${EVENT}`]);
});

test('status must still match authorized catalogue, mode, readiness and expiry', async () => {
  const { access, client, status } = await setup();
  for (const change of [
    { enabled: false }, { catalogDigest: 'f'.repeat(64) }, { catalog: null },
    { catalog: { ...status.catalog!, validUntilMs: TEST_AT } },
    { session: { ...status.session, expiresAtMs: TEST_AT } },
    { session: { ...status.session, mode: 'commercial' as const } },
    { catalog: { ...status.catalog!, authority: 'owner_authorized' as const } },
  ]) {
    const bound = bindDashboardQuoteClient({ ...client, async status() { return { ...status, ...change }; } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    await assert.rejects(() => bound.status(signal()), denied);
  }
});

test('expiry and withdrawal abort outstanding operations and suppress an adapter that ignores abort', async () => {
  const { access, client, view } = await setup(); let clock = TEST_AT;
  const gate = new DashboardQuoteAccessGate(); let release!: () => void; let received: AbortSignal | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const bound = bindDashboardQuoteClient({ ...client, async read(_id, signal) { received = signal; await waiting; return view; } }, access, gate.start(), () => clock);
  const pending = bound.read(EVENT, signal()); gate.cancel(); assert.equal(received?.aborted, true); release();
  await assert.rejects(() => pending, denied); await assert.rejects(() => bound.status(signal()), denied);
  const fresh = bindDashboardQuoteClient(client, access, gate.start(), () => clock);
  clock = access.expiresAtMs; await assert.rejects(() => fresh.read(EVENT, signal()), denied);
});

test('a newer generation or aborted caller cannot revive an earlier identity or event', async () => {
  const { access, client, view } = await setup(); const gate = new DashboardQuoteAccessGate();
  const first = gate.start(); const bound = bindDashboardQuoteClient(client, access, first, () => TEST_AT);
  const second = gate.start(); assert.equal(first.current(), false); assert.equal(first.signal.aborted, true); assert.equal(second.current(), true);
  await assert.rejects(() => bound.read(EVENT, signal()), denied);
  const current = bindDashboardQuoteClient(client, access, second, () => TEST_AT);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => current.read(EVENT, controller.signal), denied);
  assert.equal(await current.read(EVENT, signal()), view); gate.cancel(); assert.equal(second.current(), false);
});

test('composition contains lifecycle withdrawal and no identity provisioning, metrics derivation or storage', () => {
  const source = readFileSync(new URL('../../src/office/dashboard/PersistedQuoteSection.tsx', import.meta.url), 'utf8');
  for (const event of ['visibilitychange', 'pagehide', 'popstate', 'hashchange']) assert(source.includes(event));
  assert.match(source, /source.subscribe/); assert.match(source, /quoteAccessExpiresAt/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|startSession|document.cookie|\.send\(|\.dispatch\(/);
  const page = readFileSync(new URL('../../src/office/DashboardPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /key=\{`\$\{eventSessionEpoch\}-\$\{quoteNavigationEpoch\}-\$\{section\}`\}/);
  assert.match(page, /next === 'quotes' \|\| next === 'events'\) setEventMode\('saved'\)/);
});

test('server access denial and unexpected response scope withdraw the entire dashboard binding', async () => {
  const { access, client, view } = await setup();
  for (const failure of [401, 403]) {
    let withdrawals = 0;
    const bound = bindDashboardQuoteClient({ ...client, async read() { throw new EventQuoteClientError('REQUEST_REJECTED', failure); } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT, () => { withdrawals++; });
    await assert.rejects(() => bound.read(EVENT, signal()), denied); assert.equal(withdrawals, 1);
  }
  let withdrawals = 0;
  const bound = bindDashboardQuoteClient({ ...client, async execute() { return { ...view, record: { ...view.record, scope: { ...testScope, workspaceId: 'OTHER' } } }; } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT, () => { withdrawals++; });
  await assert.rejects(() => bound.execute(EVENT, { action: 'brief', key: 'response-scope', expectedRevision: 1, brief: testBrief }, 'test-only', signal()), denied);
  assert.equal(withdrawals, 1);
});

test('server permission ceiling remains authoritative and earlier server expiry requires re-verification', async () => {
  const { access, client, status } = await setup();
  const gate = new DashboardQuoteAccessGate();
  const restricted = bindDashboardQuoteClient({ ...client, async status() { return { ...status, session: { ...status.session, canWrite: false, canApprove: false } }; } }, access, gate.start(), () => TEST_AT);
  const checked = await restricted.status(signal()); assert.equal(checked.session.canWrite, false); assert.equal(checked.session.canApprove, false);
  const earlier = bindDashboardQuoteClient({ ...client, async status() { return { ...status, session: { ...status.session, expiresAtMs: access.expiresAtMs - 1 } }; } }, access, gate.start(), () => TEST_AT);
  await assert.rejects(() => earlier.status(signal()), denied);
});

test('late command responses are discarded after identity withdrawal even when transport ignores cancellation', async () => {
  const { access, client, view } = await setup(); const gate = new DashboardQuoteAccessGate();
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const bound = bindDashboardQuoteClient({ ...client, async execute() { await waiting; return view; } }, access, gate.start(), () => TEST_AT);
  const pending = bound.execute(EVENT, { action: 'brief', key: 'stale-command', expectedRevision: 1, brief: testBrief }, 'test-only', signal());
  gate.cancel(); release(); await assert.rejects(() => pending, denied);
});

test('canceling an old selected event never withdraws a newer selection in the same verified context', async () => {
  const { access, client, view } = await setup();
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); let withdrawals = 0;
  const bound = bindDashboardQuoteClient({ ...client, async read() { await waiting; return view; } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT, () => { withdrawals++; });
  const oldSelection = new AbortController(); const pending = bound.read(EVENT, oldSelection.signal);
  oldSelection.abort(); release(); await assert.rejects(() => pending, denied); assert.equal(withdrawals, 0);
  assert.equal(await bound.read(EVENT, signal()), view);
  const rejected = bindDashboardQuoteClient({ ...client, async read() { await waiting; throw new EventQuoteClientError('REQUEST_REJECTED', 401); } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT, () => { withdrawals++; });
  const abandoned = new AbortController(); const lateRejection = rejected.read(EVENT, abandoned.signal); abandoned.abort();
  await assert.rejects(() => lateRejection, denied); assert.equal(withdrawals, 0);
});

test('the real service READ_ONLY status allows an existing quote read with every write permission removed', async () => {
  const { t, access } = await setup();
  const actor = { ...testActor, canWrite: false, canApprove: true };
  const serviceStatus = await t.service.status(testScope, actor);
  assert.equal(serviceStatus.enabled, false); assert.equal(serviceStatus.reason, 'READ_ONLY'); assert(serviceStatus.catalog);
  const readOnlyStatus: EventQuoteStatusResponse = { ...serviceStatus, externalEffectsEnabled: false,
    session: { mode: 'test', canWrite: false, canApprove: true, csrfToken: 'readonly-csrf-token-test', expiresAtMs: access.expiresAtMs } };
  let writes = 0;
  const client: EventQuoteClient = { async status() { return readOnlyStatus; }, async read(eventId) { return t.service.read(testScope, actor, eventId); }, async execute() { writes++; throw new Error('must not write'); } };
  access.permissions = { canRead: true, canWrite: false, canApprove: false };
  const bound = bindDashboardQuoteClient(client, access, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  const status = await bound.status(signal());
  assert.equal(status.enabled, false); assert.equal(status.reason, 'READ_ONLY'); assert.equal(status.session.canWrite, false); assert.equal(status.session.canApprove, false);
  const view = await bound.read(EVENT, signal()); assert.equal(view.record.briefs.at(-1)!.originalMessage, testBrief.originalMessage);
  await assert.rejects(() => bound.execute(EVENT, { action: 'brief', key: 'readonly-rejected', expectedRevision: 1, brief: testBrief }, 'unused', signal()), denied);
  assert.equal(writes, 0);
  for (const reason of ['READ_ONLY', 'EXPIRED', 'AUTHORIZED_CATALOG_REQUIRED', null]) {
    const invalid = { ...readOnlyStatus, reason, session: { ...readOnlyStatus.session, canWrite: reason === 'READ_ONLY' } };
    const bad = bindDashboardQuoteClient({ ...client, async status() { return invalid; } }, access, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    await assert.rejects(() => bad.status(signal()), denied);
  }
  const workspace = readFileSync(new URL('../../src/office/dashboard/PersistedQuoteWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /Solo lectura/); assert.match(workspace, /\{status && <div className="gew-columns"/);
});
