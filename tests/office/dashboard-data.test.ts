import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardMetrics, stageAgeDays, formatMoney } from '../../src/office/dashboard/model';
import { createDashboardReviewSource, dashboardFixtureSource, dashboardReviewSource, DashboardReadError, dashboardErrorText } from '../../src/office/dashboard/source';
import { CommunicationsClientError } from '../../src/office/communications-client';
import type { CommunicationsReviewView } from '../../src/office/communications-api-contracts';
import { createCommunicationsWorkflow } from '../../src/office/backend/communications';
import { communicationsFixtureObservations } from '../../src/office/backend/communications-fixture';
import type { CommunicationsStoredRecord, CommunicationsStore, ExactDraft } from '../../src/office/backend/communications-contracts';
const AT = Date.parse('2026-10-13T00:00:00.000Z');
const signal = () => new AbortController().signal;
async function setup() {
  let record: CommunicationsStoredRecord | null = null;
  const store: CommunicationsStore = { async read() { return structuredClone(record); }, async compareAndSet(expected, ledger) { if (expected !== (record?.revision ?? null)) return false; record = { revision: (record?.revision ?? 0) + 1, ledger: structuredClone(ledger) }; return true; } };
  const workflow = createCommunicationsWorkflow({ scope: { organizationId: 'gourmet-communications-fixture', actorId: 'fixture-00000000-0000-4000-8000-000000000000', partition: 'external', dataMode: 'fixture' }, store, clock: () => AT });
  for (const observation of communicationsFixtureObservations(AT)) await workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation });
  async function save(index = 0, id = 'dashboard-draft', extra: Partial<ExactDraft> = {}) {
    let v = await workflow.view();
    v = await workflow.link({ expectedRevision: v.revision, id: `link-${id}`, ...v.candidates[index], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:explicit-human-review' });
    const association = v.associations.at(-1)!;
    const lead = v.snapshots.find(s => s.id === association.leadSnapshotId)!;
    assert.equal(lead.kind, 'lead');
    const input = { id, associationId: association.id, purpose: 'reply' as const, to: [lead.kind === 'lead' ? lead.data.email! : ''], cc: [], bcc: [], subject: 'Revisión sintética', bodyText: 'Texto exacto de prueba', bodyHtml: null, attachments: [], ...extra };
    return workflow.saveDraft({ expectedRevision: v.revision, ...input });
  }
  async function view(): Promise<CommunicationsReviewView> { return { mode: 'fixture', session: { mode: 'fixture', actorId: 'fixture-00000000-0000-4000-8000-000000000000', organizationId: 'gourmet-communications-fixture', csrfToken: 'c'.repeat(64), expiresAt: new Date(AT + 900_000).toISOString(), storage: 'ephemeral', outboundEffects: 0 }, workflow: await workflow.view() }; }
  return { workflow, save, view, reader: { read: async (_signal: AbortSignal) => view() } };
}

test('dashboard fixture has fixed partial provenance, unknown real integrations, zero effects, and no shared mutable snapshot', async () => {
  const first = await dashboardFixtureSource.read(signal());
  assert.equal(first.mode, 'fixture'); assert.equal(first.outboundEffects, 0);
  assert.equal(first.asOf, '2026-10-13T00:00:00.000Z');
  assert.equal(first.sources.find(s => s.id === 'sample')?.coverage, 'partial');
  for (const source of first.sources.filter(s => s.id !== 'sample')) { assert.equal(source.mode, 'unconfigured'); assert.equal(source.coverage, 'unknown'); assert.equal(source.lastVerifiedAt, null); }
  assert.equal(first.opportunities.length, 4); assert.ok(first.opportunities.every(o => o.amountMinor === null && o.currency === null));
  first.opportunities[0].name = 'mutated'; first.sources.length = 0;
  const second = await dashboardFixtureSource.read(signal()); assert.notEqual(second.opportunities[0].name, 'mutated'); assert.equal(second.sources.length, 9);
  assert.deepEqual(Object.keys(dashboardFixtureSource).sort(), ['mode', 'read']);
});

test('fixture reading has no network, session or mutation effect and respects prior abort', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  await dashboardFixtureSource.read(signal());
  const c = new AbortController(); c.abort(); await assert.rejects(dashboardFixtureSource.read(c.signal), { name: 'AbortError' });
});

test('same contact remains distinct across explicit mailbox rows and is not auto-associated', async () => {
  const data = await dashboardFixtureSource.read(signal()); const rows = data.conversations.filter(c => c.contact === 'Aurora · ejemplo');
  assert.equal(rows.length, 2); assert.notEqual(rows[0].mailbox, rows[1].mailbox); assert.notEqual(rows[0].id, rows[1].id); assert.equal(rows[1].opportunityId, null);
});

test('metrics count only sample records; absent money, conversion, revenue and ads stay unknown', async () => {
  const data = await dashboardFixtureSource.read(signal()); const metrics = dashboardMetrics(data);
  assert.equal(metrics.find(m => m.id === 'opportunities')?.value, 4); assert.equal(metrics[0].coverage, 'partial');
  for (const id of ['pipeline', 'conversion', 'revenue', 'ads']) { const m = metrics.find(m => m.id === id)!; assert.equal(m.value, null); assert.equal(m.coverage, 'unknown'); assert.equal(m.currency, null); }
  data.opportunities = []; assert.equal(dashboardMetrics(data)[0].value, 0); assert.equal(dashboardMetrics(data)[1].value, null);
});

test('pipeline totals require complete coverage, known nonnegative safe amounts, and one currency', async () => {
  const data = await dashboardFixtureSource.read(signal());
  data.opportunities.forEach(o => { o.amountMinor = 0; o.currency = 'EUR'; });
  assert.equal(dashboardMetrics(data)[1].value, null);
  data.sources[0].coverage = 'complete'; assert.equal(dashboardMetrics(data)[1].value, 0);
  data.opportunities[0].amountMinor = 12000; assert.equal(dashboardMetrics(data)[1].value, 12000);
  data.opportunities[1].currency = 'USD'; assert.equal(dashboardMetrics(data)[1].value, null); data.opportunities[1].currency = 'EUR';
  for (const invalid of [null, -1, 1.5, Number.MAX_SAFE_INTEGER]) { data.opportunities[1].amountMinor = invalid; assert.equal(dashboardMetrics(data)[1].value, null); }
  data.opportunities.forEach(o => { o.amountMinor = 100; o.stage = 'confirmed'; });
  assert.equal(dashboardMetrics(data).find(m => m.id === 'revenue')?.value, null); assert.equal(dashboardMetrics(data).find(m => m.id === 'conversion')?.value, null);
});

test('money formatting preserves zero and actual currency precision without guessing missing currency', () => {
  assert.equal(formatMoney(null, 'EUR'), 'Sin importe verificado'); assert.equal(formatMoney(1, null), 'Sin importe verificado');
  assert.equal(formatMoney(-1, 'EUR'), 'Sin importe verificado'); assert.equal(formatMoney(1.5, 'EUR'), 'Sin importe verificado');
  assert.match(formatMoney(12345, 'EUR'), /123,45/); assert.match(formatMoney(12345, 'CLP'), /12[.\s]?345/); assert.match(formatMoney(0, 'EUR'), /0,00/);
});

test('stage age uses the fixed observation cut, with missing, malformed and future entry dates unknown', async () => {
  const data = await dashboardFixtureSource.read(signal()); const o = data.opportunities[0];
  assert.equal(stageAgeDays(o, data.asOf), 0); assert.equal(stageAgeDays({ ...o, enteredStageAt: '2026-10-10T00:00:00.000Z' }, data.asOf), 3);
  for (const at of [null, 'not-a-date', '2026-10-14T00:00:00.000Z']) assert.equal(stageAgeDays({ ...o, enteredStageAt: at }, data.asOf), null);
  assert.equal(stageAgeDays(o, 'invalid'), null);
});

test('queue reads do not create drafts, sessions or approvals and empty queue only follows a successful read', async () => {
  const t = await setup(); const before = await t.workflow.view(); let reads = 0;
  const adapter = createDashboardReviewSource({ async read(s) { reads++; assert.equal(s.aborted, false); return t.view(); } }, () => AT);
  assert.deepEqual(Object.keys(adapter), ['read']); const result = await adapter.read(signal()); assert.equal(reads, 1); assert.deepEqual(result.items, []); assert.equal(result.workflowRevision, before.revision); assert.deepEqual(await t.workflow.view(), before);
});

test('queue returns exact latest drafts with explicit distinct mailbox identities and generic review-only links', async () => {
  const t = await setup(); await t.save(0, 'draft-felipe'); await t.save(1, 'draft-info');
  const view = await t.view(); const before = structuredClone(view.workflow);
  const result = await createDashboardReviewSource(t.reader, () => AT).read(signal());
  assert.equal(result.items.length, 2); assert.deepEqual(new Set(result.items.map(i => i.mailbox)), new Set(['felipe@example.test', 'info@example.test']));
  for (const item of result.items) { assert.equal(item.state, 'needs_review'); assert.equal(item.href, '/office/communications'); assert.match(item.reason, /seleccionar el borrador/); assert.equal(item.digest, before.drafts.find(d => d.id === item.id)?.digest); }
  assert.deepEqual(await t.workflow.view(), before);
});

test('queue marks current approval as unsent, latest revision invalidates previous approval and only one item remains', async () => {
  const t = await setup(); let w = await t.save(); const d = w.drafts.at(-1)!;
  await t.workflow.approve({ expectedRevision: w.revision, id: 'approval-dashboard', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest });
  const adapter = createDashboardReviewSource(t.reader, () => AT); assert.equal((await adapter.read(signal())).items[0].state, 'approved_unsent');
  w = await t.workflow.view(); const { revision: _revision, digest: _digest, associationDigest: _associationDigest, contextDigest: _contextDigest, policyVersion: _policyVersion, ...editable } = d; await t.workflow.saveDraft({ ...editable, bodyText: 'Edición nueva', expectedRevision: w.revision });
  const q = await adapter.read(signal()); assert.equal(q.items.length, 1); assert.equal(q.items[0].revision, 2); assert.equal(q.items[0].state, 'needs_review');
  assert.equal((await t.workflow.view()).outboundEffects, 0);
});

test('queue fails closed on altered content digest and changed source context', async () => {
  const t = await setup(); await t.save(); const base = await t.view();
  const tampered = structuredClone(base); tampered.workflow.drafts[0].bodyText = 'Changed after hash';
  let q = await createDashboardReviewSource({ read: async () => tampered }, () => AT).read(signal()); assert.equal(q.items[0].state, 'blocked'); assert.match(q.items[0].reason, /contenido mostrado/);
  const context = structuredClone(base); const thread = context.workflow.snapshots.find(s => s.kind === 'thread')!; if (thread.kind === 'thread') thread.data.messages[0].bodyText = 'Changed context';
  q = await createDashboardReviewSource({ read: async () => context }, () => AT).read(signal()); assert.equal(q.items[0].state, 'blocked'); assert.match(q.items[0].reason, /fuentes o su cobertura/);
});

test('queue rejects cross-account associations rather than guessing from matching contact', async () => {
  const t = await setup(); await t.save(); const v = await t.view();
  const account = v.workflow.snapshots.find(s => s.id === v.workflow.associations[0].accountSnapshotId)!;
  if (account.kind === 'account') account.data.accountId = 'another-account';
  await assert.rejects(createDashboardReviewSource({ read: async () => v }, () => AT).read(signal()), (e: unknown) => e instanceof DashboardReadError && e.code === 'invalid_relation');
});

test('queue rejects expired sessions before projection and again after asynchronous hash verification', async () => {
  const t = await setup(); await t.save(); const reader = t.reader;
  await assert.rejects(createDashboardReviewSource(reader, () => AT + 900_000).read(signal()), (e: unknown) => e instanceof DashboardReadError && e.code === 'expired');
  let ticks = 0; await assert.rejects(createDashboardReviewSource(reader, () => ++ticks === 1 ? AT : AT + 900_000).read(signal()), (e: unknown) => e instanceof DashboardReadError && e.code === 'expired');
});

test('queue rejects nonfixture scope and does not follow alternate providers on errors', async () => {
  const t = await setup(); const v = await t.view(); v.session.organizationId = 'different-organization';
  await assert.rejects(createDashboardReviewSource({ read: async () => v }, () => AT).read(signal()), (e: unknown) => e instanceof DashboardReadError && e.code === 'invalid_scope');
  let calls = 0; const denied = new CommunicationsClientError('forbidden', 403);
  await assert.rejects(createDashboardReviewSource({ async read() { calls++; throw denied; } }).read(signal()), denied); assert.equal(calls, 1);
});

test('queue aborts before read and after a late response without installing stale data', async () => {
  const t = await setup(); let calls = 0; const c = new AbortController(); c.abort();
  await assert.rejects(createDashboardReviewSource({ async read() { calls++; return t.view(); } }, () => AT).read(c.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  const c2 = new AbortController(); await assert.rejects(createDashboardReviewSource({ async read() { const value = await t.view(); c2.abort(); return value; } }, () => AT).read(c2.signal), { name: 'AbortError' });
});

test('browser queue adapter makes one same-origin GET without CSRF/session writes, and strips auth from projection', async t => {
  const context = await setup(); const value = await context.view(); value.session.expiresAt = '2099-01-01T00:00:00.000Z';
  const calls: { input: unknown; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => { calls.push({ input, init }); return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); });
  const q = await dashboardReviewSource.read(signal()); assert.equal(calls.length, 1); assert.equal(calls[0].input, '/office-api/communications'); assert.equal(calls[0].init?.method, 'GET'); assert.equal(calls[0].init?.credentials, 'same-origin'); assert.equal(calls[0].init?.cache, 'no-store'); assert.equal(calls[0].init?.body, undefined);
  assert.doesNotMatch(JSON.stringify(q), /csrfToken|actorId|organizationId/);
});

test('error states explain unknown, inactive, expired and denied instead of zero or readiness', () => {
  assert.match(dashboardErrorText(new Error('private diagnostic')), /desconocidos/); assert.doesNotMatch(dashboardErrorText(new Error('private diagnostic')), /private diagnostic/);
  assert.match(dashboardErrorText(new DashboardReadError('expired')), /sesión local vigente/);
  assert.match(dashboardErrorText(new CommunicationsClientError('missing', 404)), /desactivada/);
  assert.match(dashboardErrorText(new CommunicationsClientError('forbidden', 403)), /Acceso rechazado/);
});
