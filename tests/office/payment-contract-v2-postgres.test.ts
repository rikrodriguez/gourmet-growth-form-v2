import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { EventQuoteError, type CatalogSnapshot, type EventQuoteRecord, type EventQuoteView, type PaymentContractModeV2, type PreparePaymentV2Command, type QuoteCommand } from '../../src/office/backend/event-quote-contracts';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF } from '../../src/office/backend/event-quote-http';
import { eventQuoteStorageKey, PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { MemoryEventQuoteStore, TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

// Synthetic encrypted loopback PostgreSQL fixtures only. No receiver, provider,
// executable payment URL or deployed migration is involved.
const accessSchema = 'quote_access_test_' + randomUUID().replaceAll('-', '');
const quoteSchema = 'quote_test_' + randomUUID().replaceAll('-', '');
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
const vault = new MondayVault(Buffer.alloc(32, 79));
const store = new PostgresEventQuoteStore(pool, { schema: quoteSchema, vault });
const proof = { sessionToken: 'synthetic_v2_composition_session_1234', csrfToken: 'synthetic_v2_composition_csrf_1234' };
const headers = { host: 'quote.test', origin: 'https://quote.test', 'content-type': 'application/json', [CSRF]: proof.csrfToken };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const qt = (name: string) => quoteSchema + '.' + name, at = (name: string) => accessSchema + '.' + name;
const modes = ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const;
let now = TEST_AT, eventId: string, catalog: CatalogSnapshot;

function makeApp(onCatalog?: (call: number) => void | Promise<void>) {
  let calls = 0;
  return createDurableTestQuoteApi({ pool, vault, accessSchema, quoteSchema, allowedOrigin: headers.origin,
    clock: () => now, resolveExistingSession: async () => proof,
    catalogFor: async scope => { assert.deepEqual(scope, testScope); await onCatalog?.(++calls); return structuredClone(catalog); },
  });
}
type App = ReturnType<typeof makeApp>;
const command = (app: App, payload: QuoteCommand) => app.inject({ method: 'POST', url: API + '/' + eventId + '/commands', headers, payload });
const create = (): QuoteCommand => ({ action: 'create', key: 'synthetic-create', expectedRevision: 0, brief: testBrief });
const quote = (record: EventQuoteRecord): QuoteCommand => ({ action: 'quote', key: 'synthetic-quote', expectedRevision: record.revision,
  expectedBriefDigest: record.briefs.at(-1)!.digest, expectedCatalogDigest: digest(catalog),
  selections: [{ itemId: catalog.items[0].id, quantity: 1 }],
});
const approve = (record: EventQuoteRecord): QuoteCommand => {
  const q = record.quotes.at(-1)!;
  return { action: 'approve', key: 'synthetic-approve', expectedRevision: record.revision, quoteVersion: q.version,
    quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient };
};
function prepare(record: EventQuoteRecord, paymentMode: PaymentContractModeV2 = 'retainer_50'): PreparePaymentV2Command {
  const q = record.quotes.at(-1)!, decision = record.decisions.find(d => d.quoteDigest === q.digest)!;
  return { action: 'prepare_payment_v2', key: 'synthetic-prepare-v2', expectedRevision: record.revision, paymentMode,
    quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: decision.digest, artifactSha256: q.artifact.sha256 };
}
function legacy(record: EventQuoteRecord): QuoteCommand {
  const { paymentMode: _, ...input } = prepare(record);
  return { ...input, action: 'prepare_payment', key: 'synthetic-prepare-legacy' };
}
async function execute(app: App, input: QuoteCommand): Promise<EventQuoteView> {
  const response = await command(app, input);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().externalEffectsEnabled, false);
  return response.json<EventQuoteView>();
}
async function approved(app: App, legacyFirst = false): Promise<EventQuoteView> {
  let view = await execute(app, create()); view = await execute(app, quote(view.record)); view = await execute(app, approve(view.record));
  return legacyFirst ? execute(app, legacy(view.record)) : view;
}
async function snapshot() {
  const key = eventQuoteStorageKey(testScope, eventId);
  return { events: (await pool.query('SELECT * FROM ' + qt('events') + ' WHERE key=$1', [key])).rows,
    audits: (await pool.query('SELECT * FROM ' + qt('audit_events') + ' WHERE event_key=$1 ORDER BY revision', [key])).rows,
    record: await store.read(testScope, eventId) };
}
async function writeAttempts(): Promise<number> {
  const result = await pool.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS attempts FROM ' + qt('write_attempts'));
  return Number(result.rows[0].attempts);
}
const expirySources = ['session', 'membership', 'grant'] as const;
async function expireAt(source: typeof expirySources[number], deadline: number) {
  const table = source === 'session' ? 'sessions' : source === 'membership' ? 'memberships' : 'event_grants';
  const column = source === 'session' ? 'expires_at' : 'effective_to';
  await pool.query('UPDATE ' + at(table) + ' SET ' + column + '=$1', [new Date(deadline)]);
}
function assertDenied(response: Awaited<ReturnType<App['inject']>>) {
  assert.equal(response.statusCode, 403, response.body); assert.deepEqual(response.json(), { error: 'ACCESS_DENIED' });
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const secret of [testBrief.contactName, testBrief.recipient, testBrief.originalMessage, catalog.terms, '<!doctype html>']) assert.equal(response.body.includes(secret), false);
}
const storeInvalid = (error: unknown) => error instanceof EventQuoteError && error.code === 'QUOTE_STORE_INVALID';
const recordRejected = (error: unknown) => error instanceof EventQuoteError && ['INVALID_RECORD', 'INVALID_INPUT', 'QUOTE_STORE_INVALID'].includes(error.code);

before(async () => {
  await new PostgresQuoteAccessRepository(pool, { schema: accessSchema, clock: () => now }).initializeTestSchema();
  await store.initialize();
  // Nontransactional sequence proves an actual SQL write preceded late expiry
  // and rollback of the aggregate, audit and receipt.
  await pool.query('CREATE SEQUENCE ' + qt('write_attempts') + '; CREATE FUNCTION ' + qt('observe_test_write') +
    "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('" + qt('write_attempts') + "'); RETURN NEW; END; $$;" +
    ' CREATE TRIGGER observe_test_write AFTER INSERT ON ' + qt('audit_events') + ' FOR EACH ROW EXECUTE FUNCTION ' + qt('observe_test_write') + '()');
});
beforeEach(async () => {
  now = TEST_AT; eventId = 'synthetic-v2-' + randomUUID();
  catalog = { ...structuredClone(testCatalog), taxBps: 0, depositBps: 3000,
    terms: 'Condiciones originales sintéticas: anticipo 30 %. Sin autorización de pago.',
    items: [{ ...testCatalog.items[0], unitPriceCents: 10001 }] };
  await pool.query('TRUNCATE ' + ['event_grants', 'assignments', 'sessions', 'memberships', 'users'].map(at).join(','));
  const identity = [testScope.organizationId, testScope.workspaceId, testScope.mode, testActor.actorId];
  await pool.query('INSERT INTO ' + at('users') + " VALUES ($1,$2,$3,$4,'MANAGER',true,1)", identity);
  await pool.query('INSERT INTO ' + at('memberships') + " VALUES ('synthetic-membership',$1,$2,$3,$4,1,$5,NULL)", [...identity, new Date(TEST_AT - 1000)]);
  await pool.query('INSERT INTO ' + at('sessions') + " VALUES ($1,$2,$3,$4,$5,$6,'synthetic-membership',1,1,$7,NULL)",
    [hash(proof.sessionToken), hash(proof.csrfToken), ...identity, new Date(TEST_AT + 60_000)]);
  await pool.query('INSERT INTO ' + at('assignments') + ' VALUES ($1,$2,$3,$5,$4,1,true)', [...identity, eventId]);
  await pool.query('INSERT INTO ' + at('event_grants') + ' VALUES ($1,$2,$3,$5,$4,1,true,true,true,$6,NULL)', [...identity, eventId, new Date(TEST_AT - 1000)]);
});
after(async () => {
  try { await pool.query('DROP SCHEMA IF EXISTS ' + accessSchema + ' CASCADE; DROP SCHEMA IF EXISTS ' + quoteSchema + ' CASCADE'); }
  finally { await pool.end(); }
});

for (const mode of modes) for (const legacyFirst of [false, true]) {
  test('durable v2 ' + mode + ' upgrades schema ' + (legacyFirst ? '2' : '1') + ' to 3 and preserves approved quote and legacy ledger', async () => {
    const app = makeApp();
    try {
      const original = await approved(app, legacyFirst), input = prepare(original.record, mode), pending = await execute(app, input);
      const p = pending.record.paymentContractPreparationsV2![0], q = original.record.quotes[0], saved = await snapshot();
      assert.equal(original.record.schemaVersion, legacyFirst ? 2 : 1); assert.equal(pending.record.schemaVersion, 3);
      assert.equal(pending.record.revision, original.record.revision + 1); assert.equal(saved.audits.length, pending.record.revision);
      assert.equal(pending.record.paymentContractPreparationsV2!.length, 1);
      assert.deepEqual(pending.record.paymentPreparations, original.record.paymentPreparations ?? []);
      for (const field of ['quotes', 'decisions', 'briefs'] as const) assert.deepEqual(pending.record[field], original.record[field]);
      assert.equal(p.paymentMode, mode); assert.equal(p.contractVersion, 2); assert.equal(p.totalCents, 10001);
      assert.equal(p.depositCents, q.depositCents); assert.equal(p.remainingCents, q.totalCents - q.depositCents);
      assert.deepEqual(p.depositBasis, { kind: 'quoted_percentage', basisPoints: 3000 }); assert.equal(p.terms, q.catalog.terms);
      assert.equal(p.initialPaymentCents, mode === 'retainer_50' ? 5001 : mode === 'full_upfront' ? 10001 : 4900);
      assert.equal(p.paymentBalanceCents, p.totalCents - p.initialPaymentCents); assert.equal(p.quotedDepositMatchesMode, false);
      assert.equal(p.status, 'pending_configuration'); assert.equal(p.providerEnabled, false); assert.equal(p.publicPaymentUrl, null);
      for (const field of ['paymentTerms', 'paymentSchedule', 'paymentTermsApproval', 'canonicalLeadId'] as const) assert.equal(p[field], null);
      assert.equal(p.blockers.includes('PAYMENT_SCHEDULE_REQUIRED'), mode !== 'full_upfront');
      for (const blocker of ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_TERMS_REQUIRED', 'PAYMENT_TERMS_APPROVAL_REQUIRED'] as const) assert.ok(p.blockers.includes(blocker));
      const serialized = JSON.stringify(saved.events);
      for (const secret of [testBrief.recipient, testBrief.originalMessage, catalog.terms, p.id]) assert.equal(serialized.includes(secret), false);
      assert.deepEqual(await execute(app, input), pending); assert.deepEqual(await snapshot(), saved);
    } finally { await app.close(); }
  });
}

test('durable v2 50 percent equal to 49 remains distinct from fixed reservation semantics', async () => {
  catalog = { ...catalog, depositBps: 5000, items: [{ ...catalog.items[0], unitPriceCents: 9800 }] };
  const app = makeApp();
  try {
    const original = await approved(app), pending = await execute(app, prepare(original.record)), p = pending.record.paymentContractPreparationsV2![0];
    assert.equal(p.paymentMode, 'retainer_50'); assert.equal(p.initialPaymentCents, 4900); assert.equal(p.paymentBalanceCents, 4900);
    assert.equal(p.quotedDepositMatchesMode, true); assert.equal(p.providerEnabled, false); assert.equal(p.publicPaymentUrl, null);
    assert.equal(p.paymentTermsApproval, null); assert.ok(p.blockers.includes('PAYMENT_TERMS_APPROVAL_REQUIRED'));
  } finally { await app.close(); }
});

test('durable v2 survives API replacement and a separate process with exact idempotency', async () => {
  let app = makeApp();
  try {
    const original = await approved(app, true), input = prepare(original.record), pending = await execute(app, input), saved = await snapshot();
    await app.close(); app = makeApp();
    const recovered = await app.inject({ url: API + '/' + eventId, headers });
    assert.equal(recovered.statusCode, 200, recovered.body); assert.deepEqual(recovered.json(), pending);
    assert.deepEqual(await execute(app, input), pending); assert.deepEqual(await snapshot(), saved);
    const source = [
      "import {Pool} from 'pg';",
      "import {PostgresEventQuoteStore} from './src/office/backend/event-quote-postgres.ts';",
      "import {MondayVault} from './src/office/backend/monday-store.ts';",
      "import {DEFAULT_OFFICE_DATABASE_URL} from './src/office/backend/postgres-store.ts';",
      "import {testScope} from './tests/office/event-quote-fixtures.ts';",
      'const pool=new Pool({connectionString:DEFAULT_OFFICE_DATABASE_URL});',
      'try { const store=new PostgresEventQuoteStore(pool,{schema:process.argv[1],vault:new MondayVault(Buffer.alloc(32,79))});',
      'process.stdout.write(JSON.stringify(await store.read(testScope,process.argv[2]))); } finally {await pool.end();}',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, quoteSchema, eventId],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), pending.record);
  } finally { await app.close(); }
});

for (const mode of modes) test('two jittered durable API instances commit one exact v2 ' + mode + ' request', async () => {
  const app = makeApp(), other = makeApp();
  try {
    const original = await approved(app), input = prepare(original.record, mode);
    const [left, right] = await Promise.all([execute(app, input), (async () => { await new Promise<void>(resolve => setImmediate(resolve)); return execute(other, input); })()]);
    assert.deepEqual(left, right); assert.equal(left.record.paymentContractPreparationsV2!.length, 1);
    const saved = await snapshot(); assert.equal(saved.audits.length, 4); assert.equal(saved.record!.receipts.length, 4);
    const changedMode = await command(other, { ...input, paymentMode: mode === 'full_upfront' ? 'retainer_50' : 'full_upfront' });
    assert.equal(changedMode.statusCode, 409);
    const duplicateQuote = await command(other, { ...input, key: 'another-v2-request', expectedRevision: 4 });
    assert.equal(duplicateQuote.statusCode, 409); assert.deepEqual(await snapshot(), saved);
  } finally { await app.close(); await other.close(); }
});

for (const mutation of [
  'UPDATE event_grants SET can_approve=false', 'UPDATE event_grants SET can_write=false,can_approve=false',
  'UPDATE event_grants SET enabled=false', 'UPDATE sessions SET revoked_at=now()', 'UPDATE users SET enabled=false',
] as const) test('v2 rejects withdrawn payment approval authority before SQL: ' + mutation, async () => {
  const app = makeApp();
  try {
    const original = await approved(app), saved = await snapshot(), attempts = await writeAttempts();
    await pool.query(mutation.replace(/UPDATE (\w+)/, 'UPDATE ' + accessSchema + '.$1'));
    const response = await command(app, prepare(original.record));
    if (mutation.includes('sessions') || mutation.includes('users')) assert.equal(response.statusCode, 401, response.body); else assertDenied(response);
    assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
  } finally { await app.close(); }
});

for (const source of expirySources) for (const legacyFirst of [false, true]) {
  test('v2 ' + source + ' expiry after SQL rolls back schema ' + (legacyFirst ? '2' : '1') + ' upgrade, request, audit and receipt', async () => {
    let app = makeApp();
    try {
      const original = await approved(app, legacyFirst), input = prepare(original.record), saved = await snapshot(), attempts = await writeAttempts();
      const deadline = TEST_AT + 1000; await expireAt(source, deadline); await app.close();
      let sawPendingWrite = false;
      app = makeApp(async call => {
        if (call !== 2) return;
        assert.equal(await writeAttempts(), attempts + 1); sawPendingWrite = true; now = deadline;
      });
      assertDenied(await command(app, input)); assert.equal(sawPendingWrite, true);
      assert.deepEqual(await snapshot(), saved); assert.equal(saved.record!.schemaVersion, legacyFirst ? 2 : 1);
      now = TEST_AT; await app.close(); app = makeApp();
      const retried = await execute(app, input);
      assert.equal(retried.record.schemaVersion, 3); assert.equal(retried.record.paymentContractPreparationsV2!.length, 1);
      assert.deepEqual(retried.record.paymentPreparations, original.record.paymentPreparations ?? []);
    } finally { await app.close(); }
  });
}

for (const legacyFirst of [false, true]) test('v2 failed SQL audit leaves schema ' + (legacyFirst ? '2' : '1') + ' and every ledger unchanged', async () => {
  const app = makeApp();
  try {
    const original = await approved(app, legacyFirst), input = prepare(original.record), saved = await snapshot();
    await pool.query('CREATE FUNCTION ' + qt('fail_v2_audit') + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_V2_DATABASE_DETAIL'; END; $$;" +
      ' CREATE TRIGGER fail_v2_audit BEFORE INSERT ON ' + qt('audit_events') + ' FOR EACH ROW EXECUTE FUNCTION ' + qt('fail_v2_audit') + '()');
    try {
      const failed = await command(app, input);
      assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.body.includes('SYNTHETIC_PRIVATE_V2_DATABASE_DETAIL'), false);
      assert.deepEqual(await snapshot(), saved);
    } finally { await pool.query('DROP TRIGGER fail_v2_audit ON ' + qt('audit_events') + '; DROP FUNCTION ' + qt('fail_v2_audit') + '()'); }
    const retried = await execute(app, input); assert.equal(retried.record.revision, original.record.revision + 1);
    assert.equal(retried.record.paymentContractPreparationsV2!.length, 1);
  } finally { await app.close(); }
});

async function alternateHistory(mode: PaymentContractModeV2 | 'legacy') {
  const service = createEventQuoteService({ store: new MemoryEventQuoteStore(), catalogFor: async () => catalog, clock: () => TEST_AT });
  const run = (input: QuoteCommand) => service.execute(testScope, testActor, eventId, input);
  let view = await run(create()); view = await run(quote(view.record)); view = await run(approve(view.record));
  view = await run(mode === 'legacy' ? legacy(view.record) : prepare(view.record, mode));
  return (await run({ action: 'brief', key: 'synthetic-next-brief', expectedRevision: view.record.revision, brief: { ...testBrief, attendees: 25 } })).record;
}
test('v2 PostgreSQL rejects valid alternate histories, rehashed tampering, removal and schema downgrades without a write', async () => {
  const app = makeApp();
  try {
    const original = await approved(app), pending = await execute(app, prepare(original.record)), saved = await snapshot(), attempts = await writeAttempts();
    // Independently valid alternatives: changed mode and schema-2 history,
    // both with a later revision, must still fail the store history check.
    for (const mode of ['full_upfront', 'legacy'] as const) {
      const alternative = await alternateHistory(mode);
      await assert.rejects(store.transact(testScope, eventId, () => alternative), storeInvalid);
      await assert.rejects(store.transact(testScope, eventId, current => {
        for (const key of Object.keys(current!)) delete (current as unknown as Record<string, unknown>)[key];
        Object.assign(current!, alternative); return current!;
      }), storeInvalid);
      assert.deepEqual(await snapshot(), saved);
    }
    for (const patch of [{ initialPaymentCents: 4900 }, { paymentBalanceCents: 0 }, { providerEnabled: true },
      { quotedDepositMatchesMode: true }, { paymentMode: 'full_upfront' }, { paymentTermsApproval: { approved: true } },
      { publicPaymentUrl: 'https://example.test/synthetic-forged' }]) {
      const forged = structuredClone(pending.record), p = forged.paymentContractPreparationsV2![0];
      Object.assign(p, patch); const { digest: _, ...content } = p; p.digest = digest(content);
      await assert.rejects(store.transact(testScope, eventId, () => forged), recordRejected);
    }
    for (const version of [1, 2] as const) {
      const forged = structuredClone(pending.record); forged.schemaVersion = version; delete forged.paymentContractPreparationsV2;
      if (version === 1) delete forged.paymentPreparations;
      await assert.rejects(store.transact(testScope, eventId, () => forged), recordRejected);
    }
    const removed = structuredClone(pending.record); removed.paymentContractPreparationsV2 = [];
    await assert.rejects(store.transact(testScope, eventId, () => removed), recordRejected);
    const invalidLegacy = structuredClone(pending.record); invalidLegacy.paymentPreparations = null as never;
    await assert.rejects(store.transact(testScope, eventId, () => invalidLegacy), recordRejected);
    assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
    const changed = await execute(app, { action: 'brief', key: 'synthetic-next-brief', expectedRevision: pending.record.revision, brief: { ...testBrief, attendees: 25 } });
    assert.deepEqual(changed.record.paymentContractPreparationsV2, pending.record.paymentContractPreparationsV2); assert.equal(changed.record.schemaVersion, 3);
  } finally { await app.close(); }
});
