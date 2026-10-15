import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { EventQuoteError, type ConfigurePaymentV2Command, type EventQuoteRecord, type EventQuoteService, type EventQuoteStore, type PaymentContractModeV2, type QuoteCommand, type RegisterPaymentDraftV2Command, type TestPaymentDraftDependenciesV2 } from '../../src/office/backend/event-quote-contracts';
import { eventQuoteStorageKey, PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { assertEventQuoteRecord, canonical, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { reviewValidatedPaymentPlanV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { MemoryEventQuoteStore, TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

// These are storage tests with an explicit synthetic validator callback. They
// exercise no PHP application, original database, provider or payment link.
// The separate Payments contract suite verifies the actual isolated PHP parser.
const schema = 'quote_test_' + randomUUID().replaceAll('-', '');
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 });
const vault = new MondayVault(Buffer.alloc(32, 83));
const table = (name: string) => schema + '.' + name;
const storeFor = (connection = pool) => new PostgresEventQuoteStore(connection, { schema, vault });
const modes = ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const;
const catalog = { ...structuredClone(testCatalog), taxBps: 0, depositBps: 3000,
  terms: 'Condiciones originales sintéticas: anticipo 30 %. Línea\ncon café, / y 🍽️.',
  items: [{ ...testCatalog.items[0], unitPriceCents: 10001 }] };
let eventId: string, now = TEST_AT, validations = 0, resolutions = 0;

function syntheticReceipt(body: string): string {
  return JSON.stringify({ status: 'contract_validated_internal', prepared: JSON.parse(body),
    executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false });
}
function dependencies(overrides: Partial<TestPaymentDraftDependenciesV2> = {}): TestPaymentDraftDependenciesV2 {
  return {
    resolveCanonicalLead: async (scope, id) => {
      resolutions++; assert.deepEqual(scope, testScope); assert.equal(id, eventId);
      return { source: 'synthetic_fixture', canonicalLeadId: 'synthetic-private-canonical-lead' };
    },
    validateContract: async (body, atMs, signal) => {
      validations++; assert.equal(atMs, now); assert.equal(signal.aborted, false);
      return syntheticReceipt(body);
    },
    ...overrides,
  };
}
const serviceFor = (store: EventQuoteStore = storeFor(), overrides: Partial<TestPaymentDraftDependenciesV2> = {}) =>
  createEventQuoteService({ store, catalogFor: async () => structuredClone(catalog), clock: () => now, testPaymentDrafts: dependencies(overrides) });
const execute = async (service: EventQuoteService, input: QuoteCommand) => (await service.execute(testScope, testActor, eventId, input)).record;
const create = (): QuoteCommand => ({ action: 'create', key: 'synthetic-create', expectedRevision: 0, brief: testBrief });
function prepare(record: EventQuoteRecord, mode: PaymentContractModeV2 | 'legacy'): QuoteCommand {
  const q = record.quotes.at(-1)!, a = record.decisions.find(a => a.quoteDigest === q.digest)!;
  const pins = { key: mode === 'legacy' ? 'synthetic-legacy' : 'synthetic-prepare-v2', expectedRevision: record.revision,
    quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: a.digest, artifactSha256: q.artifact.sha256 };
  return mode === 'legacy' ? { ...pins, action: 'prepare_payment' } : { ...pins, action: 'prepare_payment_v2', paymentMode: mode };
}
async function approved(service: EventQuoteService) {
  let r = await execute(service, create());
  r = await execute(service, { action: 'quote', key: 'synthetic-quote', expectedRevision: r.revision,
    expectedBriefDigest: r.briefs[0].digest, expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  const q = r.quotes[0];
  return execute(service, { action: 'approve', key: 'synthetic-approve', expectedRevision: r.revision,
    quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
}
async function pending(service: EventQuoteService, mode: PaymentContractModeV2 = 'retainer_50', legacy = false) {
  let r = await approved(service);
  if (legacy) r = await execute(service, prepare(r, 'legacy'));
  return execute(service, prepare(r, mode));
}
function configure(record: EventQuoteRecord, key = 'synthetic-configure-v2'): ConfigurePaymentV2Command {
  const p = record.paymentContractPreparationsV2!.at(-1)!;
  return { action: 'configure_payment_v2', key, expectedRevision: record.revision, preparationId: p.id, preparationDigest: p.digest,
    paymentTerms: 'Condiciones revisadas sintéticas\ncon café, / y 🍽️. No autoriza cobros.',
    termsChangeReason: 'Revisión interna explícita del anticipo cotizado al 30 % y de las condiciones.',
    paymentSchedule: p.paymentMode === 'full_upfront' ? null : p.paymentMode === 'retainer_50'
      ? { kind: 'retainer_50', eventDate: '2099-12-21', eventTime: '19:00', timezone: 'America/Lima', balanceDate: '2099-12-14', balanceTime: '19:00', timingExceptionReason: null }
      : { kind: 'fixed_49_reservation', balanceDate: '2099-12-14', balanceTime: '19:00', timezone: 'Asia/Kathmandu', agreedBalanceCents: p.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2099-12-01', time: '10:30', timezone: 'America/Lima' } };
}
function register(record: EventQuoteRecord, key = 'synthetic-register-v2'): RegisterPaymentDraftV2Command {
  const c = record.paymentConfigurationsV2!.at(-1)!;
  return { action: 'register_payment_draft_v2', key, expectedRevision: record.revision,
    configurationId: c.id, configurationDigest: c.digest, expectedReviewDigest: c.reviewDigest };
}
async function configured(service: EventQuoteService, mode: PaymentContractModeV2 = 'retainer_50', legacy = false) {
  const r = await pending(service, mode, legacy);
  return execute(service, configure(r));
}
async function snapshot() {
  const key = eventQuoteStorageKey(testScope, eventId);
  return { events: (await pool.query('SELECT * FROM ' + table('events') + ' WHERE key=$1', [key])).rows,
    audits: (await pool.query('SELECT * FROM ' + table('audit_events') + ' WHERE event_key=$1 ORDER BY revision', [key])).rows,
    record: await storeFor().read(testScope, eventId) };
}
async function writeAttempts() {
  return Number((await pool.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS attempts FROM ' + table('write_attempts'))).rows[0].attempts);
}
const rejectedRecord = (error: unknown) => error instanceof EventQuoteError && ['INVALID_RECORD', 'INVALID_INPUT', 'QUOTE_STORE_INVALID'].includes(error.code);
const errorCode = (code: string) => (error: unknown) => error instanceof EventQuoteError && error.code === code && error.message === code && !Object.hasOwn(error, 'cause');

before(async () => {
  await storeFor().initialize();
  // A PostgreSQL sequence is deliberately nontransactional. Its increment
  // demonstrates that a failing transaction really reached the SQL write.
  await pool.query('CREATE SEQUENCE ' + table('write_attempts') + '; CREATE FUNCTION ' + table('observe_test_write') +
    "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('" + table('write_attempts') + "'); RETURN NEW; END; $$;" +
    ' CREATE TRIGGER observe_test_write BEFORE INSERT OR UPDATE ON ' + table('events') + ' FOR EACH ROW EXECUTE FUNCTION ' + table('observe_test_write') + '()');
});
beforeEach(() => { eventId = 'synthetic-draft-v2-' + randomUUID(); now = TEST_AT; validations = 0; resolutions = 0; });
after(async () => { try { await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await pool.end(); } });

for (const mode of modes) for (const legacy of [false, true]) {
  test('schema4 persists ' + mode + ' configuration and complete draft receipt, preserving ' + (legacy ? 'legacy and v2' : 'v2') + ' history', async () => {
    const service = serviceFor(), source = await pending(service, mode, legacy), cInput = configure(source);
    const c = await execute(service, cInput), input = register(c), r = await execute(service, input), saved = await snapshot();
    assert.equal(source.schemaVersion, 3); assert.equal(c.schemaVersion, 4); assert.equal(r.schemaVersion, 4);
    assert.equal(c.revision, source.revision + 1); assert.equal(r.revision, c.revision + 1);
    assert.deepEqual(c.paymentDraftRegistrationsV2, []); assert.equal(r.paymentConfigurationsV2!.length, 1); assert.equal(r.paymentDraftRegistrationsV2!.length, 1);
    for (const field of ['briefs', 'quotes', 'decisions', 'paymentPreparations', 'paymentContractPreparationsV2'] as const) assert.deepEqual(r[field], source[field]);
    const p = source.paymentContractPreparationsV2![0], config = r.paymentConfigurationsV2![0], draft = r.paymentDraftRegistrationsV2![0];
    assert.equal(config.status, 'draft_configuration'); assert.equal(config.id, cInput.key); assert.equal(config.leadSource, 'synthetic_fixture');
    assert.equal(config.configuration.canonicalLeadId, 'synthetic-private-canonical-lead'); assert.equal(config.configuration.paymentTerms, cInput.paymentTerms);
    assert.deepEqual(config.configuration.paymentSchedule, cInput.paymentSchedule); assert.deepEqual(config.configuration.linkExpiration, cInput.linkExpiration);
    assert.equal(draft.id, input.key); assert.equal(draft.status, 'draft_internal'); assert.equal(draft.configurationDigest, config.digest);
    assert.equal(draft.reviewDigest, config.reviewDigest); assert.equal(draft.receiptDigest, digest(draft.receipt)); assert.equal(draft.bodySha256, digest(draft.receipt.prepared));
    const prepared = draft.receipt.prepared, plan = prepared.plan;
    assert.equal(plan.paymentMode, mode); assert.equal(plan.initialPaymentCents, p.initialPaymentCents); assert.equal(plan.paymentBalanceCents, p.paymentBalanceCents);
    assert.equal(plan.sourceQuote.depositCents, 3000); assert.deepEqual(plan.sourceQuote.depositBasis, { kind: 'quoted_percentage', basisPoints: 3000 });
    assert.equal(plan.sourceQuote.terms, catalog.terms); assert.equal(plan.paymentTerms, cInput.paymentTerms); assert.equal(plan.termsChangeReason, cInput.termsChangeReason);
    assert.deepEqual(plan.paymentSchedule?.configured ?? null, cInput.paymentSchedule); assert.deepEqual(plan.linkExpiration.configured, cInput.linkExpiration);
    assert.deepEqual(prepared.internalApproval, { actorId: testActor.actorId, atMs: TEST_AT, purpose: 'internal_payment_plan_only', reviewDigest: config.reviewDigest });
    assert.deepEqual(prepared.blockers, ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE']);
    for (const value of [prepared, draft, draft.receipt]) { assert.equal(value.executable, false); assert.equal(value.providerEnabled, false); assert.equal(value.publicPaymentUrl, null); }
    assert.equal(draft.authorizationVerified, false); assert.equal(draft.receipt.authorizationVerified, false);
    assert.equal(validations, 1); assert.ok(resolutions >= 1); assert.deepEqual(saved.record, r); assert.equal(saved.audits.length, r.revision);
    const encrypted = JSON.stringify({ events: saved.events, audits: saved.audits });
    for (const secret of [catalog.terms, cInput.paymentTerms, config.configuration.canonicalLeadId, testBrief.recipient, input.key]) assert.equal(encrypted.includes(secret), false);
    const attempts = await writeAttempts(); assert.deepEqual(await execute(service, input), r); assert.deepEqual(await snapshot(), saved);
    assert.equal(validations, 1); assert.equal(await writeAttempts(), attempts);
  });
}

for (const version of [1, 2, 3] as const) test('reading schema ' + version + ' does not invent schema4 arrays or upgrade historical bytes', async () => {
  const service = serviceFor(); let r = await approved(service);
  if (version >= 2) r = await execute(service, prepare(r, 'legacy'));
  if (version >= 3) r = await execute(service, prepare(r, 'retainer_50'));
  const saved = await snapshot(), attempts = await writeAttempts();
  assert.equal(r.schemaVersion, version); assert.equal(Object.hasOwn(r, 'paymentConfigurationsV2'), false); assert.equal(Object.hasOwn(r, 'paymentDraftRegistrationsV2'), false);
  assert.deepEqual((await serviceFor().read(testScope, testActor, eventId)).record, r); assert.deepEqual(await snapshot(), saved);
  assert.equal(await writeAttempts(), attempts); assert.equal(validations, 0); assert.equal(resolutions, 0);
});

test('schema4 survives independent pools and a separate process; historical reads never rerun the receiver', async () => {
  const service = serviceFor(), c = await configured(service), input = register(c), r = await execute(service, input), saved = await snapshot();
  const secondPool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  try {
    const afterRestart = serviceFor(storeFor(secondPool), { resolveCanonicalLead: async () => { throw new Error('unexpected resolver replay'); }, validateContract: async () => { throw new Error('unexpected validator replay'); } });
    assert.deepEqual(await execute(afterRestart, input), r);
    // Expiry affects eligibility for new work, not the validity of a previously
    // committed encrypted history or its audit-time calendar interpretation.
    now = Date.parse('2100-01-01T00:00:00Z');
    assert.deepEqual(await storeFor(secondPool).read(testScope, eventId), r);
    const source = [
      "import {Pool} from 'pg';", "import {PostgresEventQuoteStore} from './src/office/backend/event-quote-postgres.ts';",
      "import {MondayVault} from './src/office/backend/monday-store.ts';", "import {DEFAULT_OFFICE_DATABASE_URL} from './src/office/backend/postgres-store.ts';",
      "import {testScope} from './tests/office/event-quote-fixtures.ts';", 'const pool=new Pool({connectionString:DEFAULT_OFFICE_DATABASE_URL});',
      'try { const store=new PostgresEventQuoteStore(pool,{schema:process.argv[1],vault:new MondayVault(Buffer.alloc(32,83))});',
      'process.stdout.write(JSON.stringify(await store.read(testScope,process.argv[2]))); } finally {await pool.end();}',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, schema, eventId], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), r); assert.deepEqual(await snapshot(), saved); assert.equal(validations, 1);
  } finally { await secondPool.end(); }
});

for (const action of ['configure', 'register'] as const) test('two PostgreSQL instances serialize same-key ' + action + ' retries into one complete ledger entry', async () => {
  const service = serviceFor(), r = action === 'configure' ? await pending(service) : await configured(service);
  const input = action === 'configure' ? configure(r) : register(r), secondPool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  try {
    const other = serviceFor(storeFor(secondPool));
    const [left, right] = await Promise.all([execute(service, input), (async () => { await new Promise<void>(resolve => setImmediate(resolve)); return execute(other, input); })()]);
    assert.deepEqual(left, right); assert.equal(left.revision, r.revision + 1); assert.equal(left.paymentConfigurationsV2!.length, 1);
    assert.equal(left.paymentDraftRegistrationsV2!.length, action === 'register' ? 1 : 0); assert.equal(validations, action === 'register' ? 1 : 0);
    const saved = await snapshot(), changed = action === 'configure' ? { ...input, paymentTerms: 'Different synthetic terms' } : { ...input, expectedReviewDigest: 'f'.repeat(64) };
    await assert.rejects(execute(other, changed as QuoteCommand), errorCode('IDEMPOTENCY_CONFLICT')); assert.deepEqual(await snapshot(), saved);
  } finally { await secondPool.end(); }
});

for (const action of ['configure', 'register'] as const) test('failed SQL audit rolls back ' + action + ', schema upgrade, draft receipt and command receipt atomically', async () => {
  const service = serviceFor(), r = action === 'configure' ? await pending(service) : await configured(service), input = action === 'configure' ? configure(r) : register(r);
  const saved = await snapshot(), attempts = await writeAttempts();
  await pool.query('CREATE FUNCTION ' + table('fail_draft_audit') + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_DRAFT_DATABASE_DETAIL'; END; $$;" +
    ' CREATE TRIGGER fail_draft_audit BEFORE INSERT ON ' + table('audit_events') + ' FOR EACH ROW EXECUTE FUNCTION ' + table('fail_draft_audit') + '()');
  try {
    await assert.rejects(execute(service, input), errorCode('QUOTE_STORE_UNAVAILABLE')); assert.equal(await writeAttempts(), attempts + 1);
    assert.deepEqual(await snapshot(), saved); assert.equal(saved.record!.receipts.some(receipt => receipt.key === input.key), false);
  } finally { await pool.query('DROP TRIGGER fail_draft_audit ON ' + table('audit_events') + '; DROP FUNCTION ' + table('fail_draft_audit') + '()'); }
  const retried = await execute(service, input); assert.equal(retried.revision, r.revision + 1); assert.equal(retried.receipts.filter(receipt => receipt.key === input.key).length, 1);
  assert.equal(retried.paymentDraftRegistrationsV2!.length, action === 'register' ? 1 : 0);
});

test('a receiver failure leaves configuration, registration, audit and idempotency receipts unchanged and permits retry', async () => {
  const service = serviceFor(), c = await configured(service), input = register(c), saved = await snapshot(), attempts = await writeAttempts();
  const failing = serviceFor(storeFor(), { validateContract: async () => { throw new Error('SYNTHETIC_PRIVATE_RECEIVER_DETAIL'); } });
  await assert.rejects(execute(failing, input), (error: unknown) => error instanceof EventQuoteError && !error.message.includes('SYNTHETIC_PRIVATE_RECEIVER_DETAIL'));
  assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
  const retried = await execute(service, input); assert.equal(retried.paymentDraftRegistrationsV2!.length, 1); assert.equal(retried.revision, c.revision + 1);
});

async function nextBrief(record: EventQuoteRecord): Promise<EventQuoteRecord> {
  const memory: EventQuoteStore = { read: async () => structuredClone(record), transact: async (_scope, _id, change) => structuredClone(await change(structuredClone(record))) };
  return execute(serviceFor(memory), { action: 'brief', key: 'synthetic-next-brief', expectedRevision: record.revision, brief: { ...testBrief, attendees: 25 } });
}

test('the PostgreSQL configuration prefix rejects a fully rehashed lead rewrite even when historical replay and prior audit hashes still match', async () => {
  const original = await configured(serviceFor()), candidate = await nextBrief(original), saved = await snapshot(), attempts = await writeAttempts();
  const entry = candidate.paymentConfigurationsV2![0], p = candidate.paymentContractPreparationsV2![0], q = candidate.quotes[0];
  entry.configuration.canonicalLeadId = 'another-synthetic-canonical-lead';
  const review = reviewValidatedPaymentPlanV2({ scope: testScope, eventId, preparation: p, quote: q, configuration: entry.configuration, nowMs: entry.atMs });
  assert.equal(review.status, 'review_required'); if (review.status !== 'review_required') throw new Error('fixture review must succeed');
  entry.reviewDigest = review.reviewDigest; const { digest: _, ...content } = entry; entry.digest = digest(content);
  // The server-resolved lead is absent from the browser command. A recomputed
  // snapshot can therefore satisfy pure replay without altering prior audit
  // inputs. The store must independently retain the actual committed prefix.
  assertEventQuoteRecord(candidate, testScope, eventId);
  assert.deepEqual(candidate.audit.slice(0, original.revision), original.audit);
  assert.deepEqual(candidate.receipts.slice(0, original.revision), original.receipts);
  await assert.rejects(storeFor().transact(testScope, eventId, () => candidate), errorCode('QUOTE_STORE_INVALID'));
  await assert.rejects(storeFor().transact(testScope, eventId, current => { Object.assign(current!, structuredClone(candidate)); return current!; }), errorCode('QUOTE_STORE_INVALID'));
  assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
});

for (const registered of [false, true]) test('schema4 rejects append-only tampering and removal of ' + (registered ? 'complete registration receipts' : 'reviewed configurations') + ' before SQL', async () => {
  const service = serviceFor(); let original = await configured(service);
  if (registered) original = await execute(service, register(original));
  const candidate = await nextBrief(original), saved = await snapshot(), attempts = await writeAttempts();
  const mutations: ((r: EventQuoteRecord) => void)[] = [
    r => { r.paymentConfigurationsV2![0].configuration.paymentTerms += ' rewritten'; },
    r => { r.paymentConfigurationsV2![0].configuration.canonicalLeadId = 'another-synthetic-lead'; },
    r => { r.paymentConfigurationsV2![0].reviewDigest = 'a'.repeat(64); },
    r => { r.paymentConfigurationsV2 = []; },
    r => { r.paymentConfigurationsV2 = null as never; },
    r => { r.paymentDraftRegistrationsV2 = null as never; },
  ];
  if (registered) mutations.push(
    r => { r.paymentDraftRegistrationsV2![0].receipt.prepared.plan.initialPaymentCents++; },
    r => { r.paymentDraftRegistrationsV2![0].receipt.authorizationVerified = true as never; },
    r => { r.paymentDraftRegistrationsV2![0].receipt.prepared.internalApproval.actorId = 'forged-actor'; },
    r => { r.paymentDraftRegistrationsV2![0].receiptDigest = 'b'.repeat(64); },
    r => { r.paymentDraftRegistrationsV2 = []; },
  );
  for (const mutate of mutations) {
    const forged = structuredClone(candidate); mutate(forged);
    for (const entry of [...forged.paymentConfigurationsV2 ?? [], ...forged.paymentDraftRegistrationsV2 ?? []]) { const { digest: _, ...content } = entry; entry.digest = digest(content); }
    await assert.rejects(storeFor().transact(testScope, eventId, () => forged), rejectedRecord);
    await assert.rejects(storeFor().transact(testScope, eventId, current => { Object.assign(current!, structuredClone(forged)); return current!; }), rejectedRecord);
    assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
  }
});

test('schema4 rejects an independently valid schema3 downgrade and keeps every ledger unchanged', async () => {
  const service = serviceFor(), r = await configured(service), registered = await execute(service, register(r)), saved = await snapshot(), attempts = await writeAttempts();
  const alternativeService = serviceFor(new MemoryEventQuoteStore()); let alternative = await pending(alternativeService);
  for (let index = alternative.revision; index <= registered.revision; index++) alternative = await execute(alternativeService, { action: 'brief', key: 'synthetic-downgrade-' + index,
    expectedRevision: alternative.revision, brief: { ...testBrief, attendees: 25 + index } });
  assert.equal(alternative.schemaVersion, 3); assert.equal(alternative.revision, registered.revision + 1); assertEventQuoteRecord(alternative, testScope, eventId);
  await assert.rejects(storeFor().transact(testScope, eventId, () => alternative), errorCode('QUOTE_STORE_INVALID'));
  assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
});

test('a later brief preserves schema4 configuration and registration bytes while marking the quoted source obsolete', async () => {
  const service = serviceFor(), c = await configured(service), registered = await execute(service, register(c)), attempts = await writeAttempts();
  const before = canonical({ configurations: registered.paymentConfigurationsV2, registrations: registered.paymentDraftRegistrationsV2 });
  const changed = await service.execute(testScope, testActor, eventId, { action: 'brief', key: 'synthetic-obsolete', expectedRevision: registered.revision, brief: { ...testBrief, attendees: 25 } });
  assert.equal(changed.currentQuoteStatus, 'obsolete'); assert.equal(changed.record.schemaVersion, 4);
  assert.equal(canonical({ configurations: changed.record.paymentConfigurationsV2, registrations: changed.record.paymentDraftRegistrationsV2 }), before);
  assert.deepEqual(await storeFor().read(testScope, eventId), changed.record); assert.equal(await writeAttempts(), attempts + 1); assert.equal(validations, 1);
});

test('a new quote and payment mode append a second schema4 configuration and receipt without downgrading or rewriting the first', async () => {
  const service = serviceFor(), c = await configured(service), first = await execute(service, register(c));
  const quoted = await execute(service, { action: 'quote', key: 'synthetic-quote-second', expectedRevision: first.revision,
    expectedBriefDigest: first.briefs.at(-1)!.digest, expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 2 }] });
  const q = quoted.quotes.at(-1)!;
  let r = await execute(service, { action: 'approve', key: 'synthetic-approve-second', expectedRevision: quoted.revision,
    quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  r = await execute(service, { ...prepare(r, 'full_upfront'), key: 'synthetic-prepare-second' });
  assert.equal(r.schemaVersion, 4); assert.equal(r.paymentContractPreparationsV2!.length, 2);
  r = await execute(service, configure(r, 'synthetic-configure-second'));
  r = await execute(service, register(r, 'synthetic-register-second'));
  assert.equal(r.schemaVersion, 4); assert.equal(r.paymentConfigurationsV2!.length, 2); assert.equal(r.paymentDraftRegistrationsV2!.length, 2);
  assert.deepEqual(r.paymentConfigurationsV2![0], first.paymentConfigurationsV2![0]);
  assert.deepEqual(r.paymentDraftRegistrationsV2![0], first.paymentDraftRegistrationsV2![0]);
  assert.equal(r.paymentDraftRegistrationsV2![1].receipt.prepared.plan.paymentMode, 'full_upfront');
  assert.equal(r.paymentDraftRegistrationsV2![1].receipt.prepared.plan.initialPaymentCents, 20002);
  assert.equal(r.paymentDraftRegistrationsV2![1].receipt.prepared.plan.paymentBalanceCents, 0);
  assert.deepEqual(await storeFor().read(testScope, eventId), r); assert.equal(validations, 2);
});

test('schema4 retains the aggregate byte limit and rolls back an oversized append without consuming its key', async () => {
  const service = serviceFor(), c = await configured(service); let committed = await execute(service, register(c));
  let blocked = false;
  for (let index = 0; index < 45; index++) {
    const saved = await snapshot(), attempts = await writeAttempts();
    const input: QuoteCommand = { action: 'brief', key: 'synthetic-bounded-' + index, expectedRevision: committed.revision,
      brief: { ...testBrief, originalMessage: 'x'.repeat(8000), requirements: 'y'.repeat(8000) } };
    try { committed = await execute(service, input); }
    catch (error) {
      assert.ok(errorCode('RECORD_LIMIT')(error)); assert.ok(Buffer.byteLength(JSON.stringify(committed)) > 400 * 1024);
      assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
      assert.equal(saved.record!.receipts.some(receipt => receipt.key === input.key), false);
      // A smaller append can reuse the rejected key; no partial receipt exists.
      const retried = await execute(service, { ...input, brief: testBrief });
      assert.equal(retried.revision, committed.revision + 1); assert.equal(retried.receipts.at(-1)!.key, input.key);
      assert.deepEqual(retried.paymentConfigurationsV2, committed.paymentConfigurationsV2);
      assert.deepEqual(retried.paymentDraftRegistrationsV2, committed.paymentDraftRegistrationsV2);
      blocked = true; break;
    }
  }
  assert.equal(blocked, true, 'the 512 KiB byte limit must reject before the 50-brief or 100-revision limits');
});
