import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { EventQuoteError, type BriefInput, type CatalogSnapshot, type EventQuoteRecord, type EventQuoteStore, type QuoteScope } from '../../src/office/backend/event-quote-contracts';
import { PostgresEventQuoteStore, eventQuoteStorageKey } from '../../src/office/backend/event-quote-postgres';
import { createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';

const AT = Date.parse('2026-10-13T16:00:00.000Z');
const KEY = Buffer.alloc(32, 97);
const schema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const missingSchema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const actor = { actorId: 'actor-synthetic', durable: true, canWrite: true, canApprove: true, expiresAtMs: AT + 86_400_000 };
const scope: QuoteScope = { organizationId: 'org-synthetic', workspaceId: 'workspace-synthetic', mode: 'test' };
const brief: BriefInput = { contactName: 'Synthetic Private Contact', recipient: 'synthetic-private@example.test',
  originalMessage: 'Synthetic confidential customer request.', attendees: 12, proposedDate: '2026-12-21',
  proposedLocation: 'Synthetic Private Venue', requirements: 'Synthetic private dietary instructions.' };
const catalog: CatalogSnapshot = { id: 'catalog-synthetic', version: 'v1', authority: 'test_only', approvalRef: 'test-only-owner',
  source: 'synthetic-test-fixture', currency: 'USD', validUntilMs: AT + 86_400_000, taxBps: 1000, depositBps: 5000,
  terms: 'Synthetic terms only; no reservation or acceptance.', items: [{ id: 'meal-synthetic', label: 'Synthetic lunch', unit: 'person', unitPriceCents: 1200 }] };
const pools: Pool[] = [];
const closed = new Set<Pool>();
let pool: Pool;
const connect = () => { const result = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 }); pools.push(result); return result; };
const disconnect = async (value: Pool) => { await value.end(); closed.add(value); };
const storeFor = (connection: Pool = pool, key = KEY) => new PostgresEventQuoteStore(connection, { vault: new MondayVault(key), schema });
const serviceFor = (store: EventQuoteStore = storeFor()) => createEventQuoteService({ store, catalogFor: async () => catalog, clock: () => AT });
const errorCode = (code: string) => (error: unknown) => error instanceof EventQuoteError && error.code === code && error.message === code && !Object.hasOwn(error, 'cause');
const create = (suffix: string, input = brief) => ({ action: 'create' as const, key: `create-${suffix}`, expectedRevision: 0, brief: input });
const changeBrief = (suffix: string, revision: number, input: BriefInput = { ...brief, attendees: 18 }) => ({ action: 'brief' as const, key: `brief-${suffix}`, expectedRevision: revision, brief: input });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const counts = async (eventId: string, owner = scope) => (await pool.query(`SELECT revision,
  (SELECT count(*)::int FROM ${schema}.audit_events a WHERE a.event_key=e.key) AS audits
  FROM ${schema}.events e WHERE e.key=$1`, [eventQuoteStorageKey(owner, eventId)])).rows[0] ?? null;

async function syntheticLedger(eventId: string, input = brief, appendBrief = true): Promise<EventQuoteRecord> {
  let value: EventQuoteRecord | null = null;
  const memory: EventQuoteStore = { read: async () => structuredClone(value), transact: async (_scope, _eventId, fn) => {
    value = structuredClone(await fn(structuredClone(value))); return structuredClone(value);
  } };
  const service = serviceFor(memory);
  const first = await service.execute(scope, actor, eventId, create(eventId, input));
  if (!appendBrief) return first.record;
  return (await service.execute(scope, actor, eventId, changeBrief(eventId, 1))).record;
}

describe('event/quote PostgreSQL persistence in a synthetic isolated schema', () => {
  before(async () => { pool = connect(); await storeFor().initialize(); });
  after(async () => {
    // Only this freshly generated test namespace is removed. Production history
    // has no deletion/reset API and is never touched by these tests.
    try { if (pool) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await Promise.all(pools.filter(value => !closed.has(value)).map(disconnect)); }
  });

  it('does not initialize deployed/default schemas, use remote bootstrap, or auto-migrate absent tables', async () => {
    await assert.rejects(new PostgresEventQuoteStore(pool, { vault: new MondayVault(KEY) }).initialize(), errorCode('QUOTE_STORE_UNAVAILABLE'));
    for (const connectionString of ['postgresql://example.invalid/synthetic', 'postgresql://127.0.0.1/synthetic?host=example.invalid']) {
      const remote = new Pool({ connectionString });
      try { await assert.rejects(new PostgresEventQuoteStore(remote, { vault: new MondayVault(KEY), schema: missingSchema }).initialize(), errorCode('QUOTE_STORE_UNAVAILABLE')); }
      finally { await remote.end(); }
    }
    assert.throws(() => new PostgresEventQuoteStore(pool, { vault: new MondayVault(KEY), schema: 'gourmet_quotes;DROP SCHEMA office_demo' }), errorCode('QUOTE_STORE_UNAVAILABLE'));
    const missing = new PostgresEventQuoteStore(pool, { vault: new MondayVault(KEY), schema: missingSchema });
    await assert.rejects(missing.read(scope, 'event-absent'), errorCode('QUOTE_STORE_UNAVAILABLE'));
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS schema', [missingSchema])).rows[0].schema, null);
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the store never closes its caller-owned pool');
  });

  it('persists briefs, quote artifacts, decisions, receipts and audits across independent pools and same-key restarts', async () => {
    const eventId = 'event-restart'; const firstPool = connect(); const service = serviceFor(storeFor(firstPool));
    const initial = await service.execute(scope, actor, eventId, create(eventId));
    const status = await service.status(scope, actor);
    const quoted = await service.execute(scope, actor, eventId, { action: 'quote', key: 'quote-restart', expectedRevision: 1,
      expectedBriefDigest: initial.record.briefs[0].digest, expectedCatalogDigest: status.catalogDigest,
      selections: [{ itemId: 'meal-synthetic', quantity: 12 }] });
    const quote = quoted.record.quotes[0];
    const approved = await service.execute(scope, actor, eventId, { action: 'approve', key: 'approve-restart', expectedRevision: 2,
      quoteVersion: quote.version, quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256, intendedRecipient: brief.recipient });
    assert.equal(approved.currentQuoteStatus, 'approved_internal_unsent');
    await disconnect(firstPool);
    await assert.rejects(service.read(scope, actor, eventId), errorCode('QUOTE_STORE_UNAVAILABLE'));
    const second = serviceFor(storeFor(connect()));
    assert.deepEqual(await second.read(scope, actor, eventId), approved);
    assert.deepEqual(await second.execute(scope, actor, eventId, create(eventId)), approved, 'a same-command retry is a durable no-op');
    assert.deepEqual(await counts(eventId), { revision: 3, audits: 3 });
    const edited = await second.execute(scope, actor, eventId, changeBrief('restart-after-approval', 3));
    assert.equal(edited.currentQuoteStatus, 'obsolete');
    assert.deepEqual(edited.record.quotes, approved.record.quotes);
    assert.deepEqual(edited.record.decisions, approved.record.decisions);
    assert.deepEqual(await serviceFor(storeFor(connect())).read(scope, actor, eventId), edited);
  });

  it('serializes absent-row creation and update races across separate pools with exactly one command effect', async () => {
    const eventId = 'event-race'; const left = serviceFor(); const right = serviceFor(storeFor(connect()));
    const [a, b] = await Promise.all([left.execute(scope, actor, eventId, create(eventId)), right.execute(scope, actor, eventId, create(eventId))]);
    assert.deepEqual(a, b); assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
    const outcomes = await Promise.allSettled([
      left.execute(scope, actor, eventId, changeBrief('race-left', 1, { ...brief, attendees: 20 })),
      right.execute(scope, actor, eventId, changeBrief('race-right', 1, { ...brief, attendees: 30 })),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert(rejected.reason instanceof EventQuoteError);
    assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
    assert.deepEqual(await left.read(scope, actor, eventId), await right.read(scope, actor, eventId));
  });

  it('isolates every organization, workspace, mode and event identity', async () => {
    const eventId = 'event-isolation'; const store = storeFor(); const service = serviceFor(store);
    const owners = [scope, { ...scope, organizationId: 'org-other' }, { ...scope, workspaceId: 'workspace-other' }];
    for (const owner of owners) {
      assert.equal(await store.read(owner, eventId), null);
      await service.execute(owner, actor, eventId, create(eventId));
    }
    assert.equal(await store.read({ ...scope, mode: 'commercial' }, eventId), null);
    assert.equal(await store.read(scope, 'event-isolation-other'), null);
    for (const owner of owners) { assert.deepEqual((await store.read(owner, eventId))!.scope, owner); assert.deepEqual(await counts(eventId, owner), { revision: 1, audits: 1 }); }
    assert.equal(new Set([...owners, { ...scope, mode: 'commercial' as const }].map(owner => eventQuoteStorageKey(owner, eventId))).size, 4);
  });

  it('stores ciphertext and audit/receipt hashes without plaintext contacts, messages, artifacts or command keys', async () => {
    const eventId = 'event-private'; await serviceFor().execute(scope, actor, eventId, create(eventId));
    const key = eventQuoteStorageKey(scope, eventId);
    const raw = JSON.stringify({ events: (await pool.query(`SELECT * FROM ${schema}.events WHERE key=$1`, [key])).rows,
      audits: (await pool.query(`SELECT * FROM ${schema}.audit_events WHERE event_key=$1`, [key])).rows });
    for (const secret of [brief.contactName, brief.recipient, brief.originalMessage, brief.proposedLocation, brief.requirements, `create-${eventId}`, actor.actorId]) {
      assert.equal(raw.includes(secret), false, `plaintext must not persist: ${secret}`);
    }
    const stored = (await pool.query(`SELECT payload FROM ${schema}.events WHERE key=$1`, [key])).rows[0].payload;
    assert.deepEqual(Object.keys(stored).sort(), ['ciphertext', 'iv', 'tag', 'version']);
    assert(stored.ciphertext.length > 0);
  });

  it('fails closed on wrong encryption keys and swapped ciphertext across scope or event identity', async () => {
    const eventId = 'event-wrong-key'; const service = serviceFor(); await service.execute(scope, actor, eventId, create(eventId));
    await assert.rejects(storeFor(pool, Buffer.alloc(32, 98)).read(scope, eventId), errorCode('QUOTE_STORE_INVALID'));
    const original = (await pool.query(`SELECT * FROM ${schema}.events WHERE key=$1`, [eventQuoteStorageKey(scope, eventId)])).rows[0];
    for (const [owner, targetId] of [[{ ...scope, workspaceId: 'workspace-forged' }, eventId], [scope, 'event-forged']] as const) {
      await pool.query(`INSERT INTO ${schema}.events(key,revision,payload,audit_digest,previous_audit_digest,receipt_digest)
        VALUES($1,1,$2::jsonb,$3,NULL,$4)`, [eventQuoteStorageKey(owner, targetId), JSON.stringify(original.payload), original.audit_digest, original.receipt_digest]);
      await assert.rejects(storeFor().read(owner, targetId), errorCode('QUOTE_STORE_INVALID'));
    }
    assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
  });

  it('detects ciphertext tampering and revision rebinding even when raw SQL appends valid metadata', async () => {
    const eventId = 'event-ciphertext-tampered'; await serviceFor().execute(scope, actor, eventId, create(eventId));
    const key = eventQuoteStorageKey(scope, eventId);
    const original = (await pool.query(`SELECT * FROM ${schema}.events WHERE key=$1`, [key])).rows[0];
    const tampered = { ...original.payload, ciphertext: (original.payload.ciphertext[0] === 'A' ? 'B' : 'A') + original.payload.ciphertext.slice(1) };
    await pool.query(`UPDATE ${schema}.events SET revision=2,payload=$2::jsonb,audit_digest=$3,
      previous_audit_digest=$4,receipt_digest=$5 WHERE key=$1`, [key, JSON.stringify(tampered), 'a'.repeat(64), original.audit_digest, 'b'.repeat(64)]);
    await assert.rejects(storeFor().read(scope, eventId), errorCode('QUOTE_STORE_INVALID'));
    await assert.rejects(storeFor().transact(scope, eventId, value => value!), errorCode('QUOTE_STORE_INVALID'));
  });

  it('revalidates the entire decrypted ledger and the independent audit hashes on every read', async () => {
    const eventId = 'event-ledger-invalid';
    const key = eventQuoteStorageKey(scope, eventId);
    // Build a legitimate one-command ledger through the service for raw DB probes.
    const invalidLedger = await syntheticLedger(eventId, brief, false);
    invalidLedger.briefs[0].originalMessage = 'Altered without recalculating authenticated business digests';
    const sealed = new MondayVault(KEY).seal(invalidLedger, `gourmet-event-quote:v1:${key}:1`);
    await pool.query(`INSERT INTO ${schema}.events(key,revision,payload,audit_digest,previous_audit_digest,receipt_digest)
      VALUES($1,1,$2::jsonb,$3,NULL,$4)`, [key, JSON.stringify(sealed), invalidLedger.audit[0].digest, digest(invalidLedger.receipts[0])]);
    await assert.rejects(storeFor().read(scope, eventId), errorCode('QUOTE_STORE_INVALID'));
    // Correctly encrypted, valid content independently requires exact audit and
    // receipt hashes. Neither a forged audit nor a forged receipt is accepted.
    for (const mismatch of ['audit', 'receipt']) {
      const auditEventId = `event-${mismatch}-hash-invalid`; await serviceFor().execute(scope, actor, auditEventId, create(auditEventId));
      const auditKey = eventQuoteStorageKey(scope, auditEventId);
      const before = (await pool.query(`SELECT * FROM ${schema}.events WHERE key=$1`, [auditKey])).rows[0];
      const candidate = await syntheticLedger(auditEventId);
      const encrypted = new MondayVault(KEY).seal(candidate, `gourmet-event-quote:v1:${auditKey}:2`);
      await pool.query(`UPDATE ${schema}.events SET revision=2,payload=$2::jsonb,audit_digest=$3,previous_audit_digest=$4,receipt_digest=$5
        WHERE key=$1`, [auditKey, JSON.stringify(encrypted), mismatch === 'audit' ? 'c'.repeat(64) : candidate.audit[1].digest,
        before.audit_digest, mismatch === 'receipt' ? 'd'.repeat(64) : digest(candidate.receipts[1])]);
      await assert.rejects(storeFor().read(scope, auditEventId), errorCode('QUOTE_STORE_INVALID'));
    }
  });

  it('rejects valid rewrites, truncated history and in-place callback rewrites without modifying any persisted history', async () => {
    const eventId = 'event-append-only'; const service = serviceFor(); const store = storeFor();
    const initial = (await service.execute(scope, actor, eventId, create(eventId))).record;
    const rewritten = await syntheticLedger(eventId, { ...brief, contactName: 'Different synthetic history' });
    await assert.rejects(store.transact(scope, eventId, () => rewritten), errorCode('QUOTE_STORE_INVALID'));
    await assert.rejects(store.transact(scope, eventId, current => {
      Object.assign(current!, structuredClone(rewritten)); return current!;
    }), errorCode('QUOTE_STORE_INVALID'));
    assert.deepEqual(await store.read(scope, eventId), initial);
    const next = (await service.execute(scope, actor, eventId, changeBrief(eventId, 1))).record;
    await assert.rejects(store.transact(scope, eventId, () => initial), errorCode('QUOTE_STORE_INVALID'));
    assert.deepEqual(await store.read(scope, eventId), next); assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
    const duplicate = await store.transact(scope, eventId, value => value!);
    assert.deepEqual(duplicate, next); assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
  });

  it('rolls back callback exceptions and failed audit inserts with sanitized errors and no partial receipts', async () => {
    const eventId = 'event-rollback'; const service = serviceFor(); const store = storeFor();
    const original = (await service.execute(scope, actor, eventId, create(eventId))).record;
    await assert.rejects(store.transact(scope, eventId, current => { current!.briefs[0].contactName = 'Changed'; throw new Error('SYNTHETIC_PRIVATE_CALLBACK_DETAIL'); }), errorCode('QUOTE_STORE_UNAVAILABLE'));
    assert.deepEqual(await store.read(scope, eventId), original);
    const key = eventQuoteStorageKey(scope, eventId);
    await pool.query(`CREATE FUNCTION ${schema}.fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_key = '${key}' THEN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_DATABASE_DETAIL'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_test_audit BEFORE INSERT ON ${schema}.audit_events FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_test_audit()`);
    try { await assert.rejects(service.execute(scope, actor, eventId, changeBrief('rollback', 1)), errorCode('QUOTE_STORE_UNAVAILABLE')); }
    finally { await pool.query(`DROP TRIGGER fail_test_audit ON ${schema}.audit_events; DROP FUNCTION ${schema}.fail_test_audit()`); }
    assert.deepEqual(await store.read(scope, eventId), original); assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
    await service.execute(scope, actor, eventId, changeBrief('rollback', 1));
    assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
  });

  it('holds the event lock across an asynchronous callback and makes a concurrent transaction observe the committed revision', async () => {
    const eventId = 'event-async-lock'; const firstStore = storeFor(); const secondStore = storeFor(connect());
    await serviceFor(firstStore).execute(scope, actor, eventId, create(eventId));
    const candidate = await syntheticLedger(eventId);
    const entered = deferred(), released = deferred();
    let secondEntered = false;
    const first = firstStore.transact(scope, eventId, async current => {
      assert.equal(current!.revision, 1); entered.resolve(); await released.promise; return candidate;
    });
    let second: Promise<EventQuoteRecord> | undefined;
    try {
      await Promise.race([entered.promise, first]);
      second = secondStore.transact(scope, eventId, async current => {
        secondEntered = true; assert.equal(current!.revision, 2); await Promise.resolve(); return current!;
      });
      // Observe an actual PostgreSQL advisory-lock waiter, rather than infer
      // blocking from timing or from a callback that has not yet been scheduled.
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        blocked = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=$1::oid AND objid=(hashtext($2)::bigint & 4294967295)::oid AND NOT granted) AS blocked`,
        [47001905, eventQuoteStorageKey(scope, eventId)])).rows[0].blocked;
        if (!blocked) await pause(10);
      }
      assert.equal(blocked, true); assert.equal(secondEntered, false);
      assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
    } finally {
      released.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    assert.deepEqual(await first, candidate); assert.deepEqual(await second, candidate);
    assert.equal(secondEntered, true); assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
  });

  it('rolls back an asynchronously rejected callback and releases the lock for the next operation', async () => {
    const eventId = 'event-async-rollback'; const store = storeFor(); const service = serviceFor(store);
    const original = (await service.execute(scope, actor, eventId, create(eventId))).record;
    await assert.rejects(store.transact(scope, eventId, async current => {
      current!.briefs[0].contactName = 'Uncommitted synthetic mutation';
      await Promise.resolve(); throw new Error('SYNTHETIC_PRIVATE_ASYNC_DETAIL');
    }), errorCode('QUOTE_STORE_UNAVAILABLE'));
    assert.deepEqual(await store.read(scope, eventId), original);
    assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
    await serviceFor(storeFor(connect())).execute(scope, actor, eventId, changeBrief('async-rollback', 1));
    assert.deepEqual(await counts(eventId), { revision: 2, audits: 2 });
  });

  it('protects audit against update, deletion, truncate and direct insertion, and prevents event removal', async () => {
    const eventId = 'event-sql-append-only'; await serviceFor().execute(scope, actor, eventId, create(eventId));
    const key = eventQuoteStorageKey(scope, eventId);
    for (const sql of [`UPDATE ${schema}.audit_events SET digest=repeat('a',64) WHERE event_key=$1`, `DELETE FROM ${schema}.audit_events WHERE event_key=$1`]) {
      await assert.rejects(pool.query(sql, [key]), /QUOTE_AUDIT_APPEND_ONLY/);
    }
    await assert.rejects(pool.query(`TRUNCATE ${schema}.audit_events`), /QUOTE_AUDIT_APPEND_ONLY/);
    await assert.rejects(pool.query(`INSERT INTO ${schema}.audit_events SELECT * FROM ${schema}.audit_events WHERE event_key=$1`, [key]), /QUOTE_AUDIT_INTERNAL_ONLY/);
    await assert.rejects(pool.query(`DELETE FROM ${schema}.events WHERE key=$1`, [key]), /QUOTE_HISTORY_APPEND_ONLY/);
    await assert.rejects(pool.query(`TRUNCATE ${schema}.events CASCADE`), /QUOTE_(HISTORY|AUDIT)_APPEND_ONLY/);
    assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
  });

  it('detaches inputs and returned values and never executes candidate getters', async () => {
    const eventId = 'event-detached'; const store = storeFor();
    const original = (await serviceFor(store).execute(scope, actor, eventId, create(eventId))).record;
    const read = (await store.read(scope, eventId))!;
    read.briefs[0].contactName = 'Mutated output'; read.audit.length = 0;
    assert.deepEqual(await store.read(scope, eventId), original);
    let accesses = 0;
    for (const key of ['schemaVersion', 'then']) {
      const unsafe = {};
      Object.defineProperty(unsafe, key, { enumerable: true, get() { accesses++; throw new Error('SYNTHETIC_PRIVATE_GETTER'); } });
      await assert.rejects(store.transact(scope, eventId, () => unsafe as EventQuoteRecord), error => error instanceof EventQuoteError);
    }
    for (const key of ['constructor', 'then']) {
      const unsafe = Promise.resolve(original);
      Object.defineProperty(unsafe, key, { get() { accesses++; throw new Error('SYNTHETIC_PRIVATE_PROMISE_GETTER'); } });
      await assert.rejects(store.transact(scope, eventId, () => unsafe), errorCode('QUOTE_STORE_INVALID'));
    }
    class ExoticPromise<T> extends Promise<T> {}
    await assert.rejects(store.transact(scope, eventId, () => ExoticPromise.resolve(original)), errorCode('QUOTE_STORE_INVALID'));
    assert.equal(accesses, 0); assert.deepEqual(await counts(eventId), { revision: 1, audits: 1 });
    const crossScope = { ...original, scope: { ...scope, workspaceId: 'workspace-other' } };
    await assert.rejects(store.transact(scope, eventId, () => crossScope), error => error instanceof EventQuoteError);
    assert.deepEqual(await store.read(scope, eventId), original);
  });
});
