import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { EventQuoteRecord, EventQuoteView, QuoteCommand, TestPaymentDraftDependenciesV2 } from '../../src/office/backend/event-quote-contracts';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF } from '../../src/office/backend/event-quote-http';
import { eventQuoteStorageKey, PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { digest } from '../../src/office/backend/event-quote-workflow';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

// Real PostgreSQL and the complete HTTP/access/workflow/store composition. All
// identities, content and encryption material belong to this loopback fixture.
const accessSchema = `quote_access_test_${randomUUID().replaceAll('-', '')}`;
const quoteSchema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
const vault = new MondayVault(Buffer.alloc(32, 73));
const store = new PostgresEventQuoteStore(pool, { schema: quoteSchema, vault });
const proof = { sessionToken: 'synthetic_composition_session_1234', csrfToken: 'synthetic_composition_csrf_1234' };
const headers = { host: 'quote.test', origin: 'https://quote.test', 'content-type': 'application/json', [CSRF]: proof.csrfToken };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let now = TEST_AT;
let eventId: string;
const expirySources = ['session', 'membership', 'grant'] as const;

function makeApp(onCatalog?: (call: number) => void | Promise<void>, testPaymentDrafts?: TestPaymentDraftDependenciesV2) {
  let calls = 0;
  return createDurableTestQuoteApi({ pool, vault, accessSchema, quoteSchema, allowedOrigin: headers.origin,
    clock: () => now, resolveExistingSession: async () => proof, testPaymentDrafts,
    catalogFor: async scope => {
      assert.deepEqual(scope, testScope);
      await onCatalog?.(++calls);
      return structuredClone(testCatalog);
    },
  });
}

// This mock isolates the authorization-after-SQL boundary. The browser harness
// separately runs the actual network-disabled PHP validator for all three modes.
const syntheticPaymentDrafts: TestPaymentDraftDependenciesV2 = {
  async resolveCanonicalLead(scope, id) {
    assert.deepEqual(scope, testScope); assert.equal(id, eventId);
    return { source: 'synthetic_fixture', canonicalLeadId: `fixture:${id}` };
  },
  async validateContract(body) {
    return JSON.stringify({ status: 'contract_validated_internal', prepared: JSON.parse(body),
      executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false });
  },
};
async function seedPaymentConfiguration(app: App, configure: boolean) {
  const quoted = await seed(app, true);
  const approved = await execute(app, approve(quoted));
  const q = approved.record.quotes.at(-1)!, d = approved.record.decisions.at(-1)!;
  const selected = await execute(app, { action: 'prepare_payment_v2', key: 'synthetic-select-mode', expectedRevision: approved.record.revision,
    quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: d.digest, artifactSha256: q.artifact.sha256, paymentMode: 'full_upfront' });
  const p = selected.record.paymentContractPreparationsV2!.at(-1)!;
  const input: QuoteCommand = { action: 'configure_payment_v2', key: 'synthetic-configure-payment', expectedRevision: selected.record.revision,
    preparationId: p.id, preparationDigest: p.digest, paymentTerms: 'Explicit synthetic full payment conditions.',
    termsChangeReason: 'Synthetic fixture separately reviews full payment instead of quoted percentage.',
    paymentSchedule: null, linkExpiration: { kind: 'never' } };
  return configure ? { record: (await execute(app, input)).record, input } : { record: selected.record, input };
}

for (const source of expirySources) {
  for (const action of ['configure_payment_v2', 'register_payment_draft_v2'] as const) {
    test(`${source} expiry after SQL ${action} rolls back its draft, audit and receipt`, async () => {
      let app = makeApp(undefined, syntheticPaymentDrafts);
      try {
        const seeded = await seedPaymentConfiguration(app, action === 'register_payment_draft_v2');
        const config = seeded.record.paymentConfigurationsV2?.at(-1);
        const input: QuoteCommand = action === 'configure_payment_v2' ? seeded.input
          : { action, key: 'synthetic-register-payment', expectedRevision: seeded.record.revision,
            configurationId: config!.id, configurationDigest: config!.digest, expectedReviewDigest: config!.reviewDigest };
        const persisted = await snapshot(), attempts = await writeAttempts(), deadline = TEST_AT + 1000;
        await expireAt(source, deadline);
        await app.close();
        let sawPendingWrite = false;
        app = makeApp(async () => {
          // Revalidation can make additional catalogue reads before SQL. Only
          // expire authority after the nontransactional probe proves the append.
          if (await writeAttempts() !== attempts + 1) return;
          sawPendingWrite = true; now = deadline;
        }, syntheticPaymentDrafts);
        assertDenied(await command(app, input));
        assert.equal(sawPendingWrite, true);
        assert.equal(await writeAttempts(), attempts + 1);
        assert.deepEqual(await snapshot(), persisted);
        now = TEST_AT;
        await app.close(); app = makeApp(undefined, syntheticPaymentDrafts);
        const retried = await execute(app, input);
        assert.equal(retried.record.revision, seeded.record.revision + 1);
        const committed = await snapshot();
        assert.deepEqual(await execute(app, input), retried);
        assert.deepEqual(await snapshot(), committed);
        assert.equal(await writeAttempts(), attempts + 2);
      } finally { await app.close(); }
    });
  }
}
type App = ReturnType<typeof makeApp>;
const command = (app: App, payload: QuoteCommand) => app.inject({ method: 'POST', url: `${API}/${eventId}/commands`, headers, payload });
const create = (): QuoteCommand => ({ action: 'create', key: 'synthetic-create', expectedRevision: 0, brief: testBrief });
const quote = (record: EventQuoteRecord): QuoteCommand => ({ action: 'quote', key: 'synthetic-quote', expectedRevision: record.revision,
  expectedBriefDigest: record.briefs.at(-1)!.digest, expectedCatalogDigest: digest(testCatalog),
  selections: [{ itemId: testCatalog.items[0].id, quantity: testBrief.attendees }],
});
const approve = (record: EventQuoteRecord): QuoteCommand => {
  const version = record.quotes.at(-1)!;
  return { action: 'approve', key: 'synthetic-approve', expectedRevision: record.revision, quoteVersion: version.version,
    quoteDigest: version.digest, artifactSha256: version.artifact.sha256, intendedRecipient: testBrief.recipient };
};
async function execute(app: App, input: QuoteCommand): Promise<EventQuoteView> {
  const response = await command(app, input);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().externalEffectsEnabled, false);
  return response.json<EventQuoteView>();
}
async function seed(app: App, withQuote = false): Promise<EventQuoteRecord> {
  const created = await execute(app, create());
  return withQuote ? (await execute(app, quote(created.record))).record : created.record;
}
async function snapshot() {
  const key = eventQuoteStorageKey(testScope, eventId);
  return { events: (await pool.query(`SELECT * FROM ${quoteSchema}.events WHERE key=$1`, [key])).rows,
    audits: (await pool.query(`SELECT * FROM ${quoteSchema}.audit_events WHERE event_key=$1 ORDER BY revision`, [key])).rows,
    record: await store.read(testScope, eventId),
  };
}
async function writeAttempts(): Promise<number> {
  const result = await pool.query(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS attempts FROM ${quoteSchema}.write_attempts`);
  return Number(result.rows[0].attempts);
}
async function expireAt(source: typeof expirySources[number], deadline: number) {
  const table = source === 'session' ? 'sessions' : source === 'membership' ? 'memberships' : 'event_grants';
  const column = source === 'session' ? 'expires_at' : 'effective_to';
  await pool.query(`UPDATE ${accessSchema}.${table} SET ${column}=$1`, [new Date(deadline)]);
}
function assertDenied(response: Awaited<ReturnType<App['inject']>>) {
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(response.json(), { error: 'ACCESS_DENIED' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-disposition'], undefined);
  for (const secret of [testBrief.contactName, testBrief.recipient, testBrief.originalMessage, testCatalog.terms, '<!doctype html>']) {
    assert.equal(response.body.includes(secret), false);
  }
}

before(async () => {
  await new PostgresQuoteAccessRepository(pool, { schema: accessSchema, clock: () => now }).initializeTestSchema();
  await store.initialize();
  // nextval is intentionally nontransactional: it proves the real SQL audit
  // insert occurred even when the enclosing authorization transaction rolls
  // back every event, audit and receipt. This probe exists only in this schema.
  await pool.query(`CREATE SEQUENCE ${quoteSchema}.write_attempts;
    CREATE FUNCTION ${quoteSchema}.observe_test_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('${quoteSchema}.write_attempts'); RETURN NEW; END; $$;
    CREATE TRIGGER observe_test_write AFTER INSERT ON ${quoteSchema}.audit_events
      FOR EACH ROW EXECUTE FUNCTION ${quoteSchema}.observe_test_write()`);
});
beforeEach(async () => {
  now = TEST_AT;
  eventId = `synthetic-${randomUUID()}`;
  await pool.query(`TRUNCATE ${accessSchema}.event_grants,${accessSchema}.assignments,${accessSchema}.sessions,${accessSchema}.memberships,${accessSchema}.users`);
  const identity = [testScope.organizationId, testScope.workspaceId, testScope.mode, testActor.actorId];
  await pool.query(`INSERT INTO ${accessSchema}.users VALUES ($1,$2,$3,$4,'MANAGER',true,1)`, identity);
  await pool.query(`INSERT INTO ${accessSchema}.memberships VALUES ('synthetic-membership',$1,$2,$3,$4,1,$5,NULL)`, [...identity, new Date(TEST_AT - 1000)]);
  await pool.query(`INSERT INTO ${accessSchema}.sessions VALUES ($1,$2,$3,$4,$5,$6,'synthetic-membership',1,1,$7,NULL)`,
    [hash(proof.sessionToken), hash(proof.csrfToken), ...identity, new Date(TEST_AT + 60_000)]);
  await pool.query(`INSERT INTO ${accessSchema}.assignments VALUES ($1,$2,$3,$5,$4,1,true)`, [...identity, eventId]);
  await pool.query(`INSERT INTO ${accessSchema}.event_grants VALUES ($1,$2,$3,$5,$4,1,true,true,true,$6,NULL)`, [...identity, eventId, new Date(TEST_AT - 1000)]);
});
after(async () => {
  try { await pool.query(`DROP SCHEMA IF EXISTS ${accessSchema} CASCADE; DROP SCHEMA IF EXISTS ${quoteSchema} CASCADE`); }
  finally { await pool.end(); }
});

test('durable HTTP composition persists read/write/approval and exact artifacts across restart', async () => {
  let app = makeApp();
  try {
    const quoted = await seed(app, true);
    const approved = await execute(app, approve(quoted));
    assert.equal(approved.currentQuoteStatus, 'approved_internal_unsent');
    assert.equal(approved.record.revision, 3);
    assert.equal(approved.record.audit.length, 3);
    assert.equal(approved.record.receipts.length, 3);
    const persisted = await snapshot();
    assert.equal(persisted.audits.length, 3);
    for (const [index, row] of persisted.audits.entries()) assert.equal(row.receipt_digest, digest(approved.record.receipts[index]));
    await app.close(); app = makeApp();
    const restored = await app.inject({ url: `${API}/${eventId}`, headers });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json(), approved);
    const artifact = await app.inject({ url: `${API}/${eventId}/quotes/1/artifact`, headers });
    assert.equal(artifact.statusCode, 200, artifact.body);
    assert.equal(artifact.body, approved.record.quotes[0].artifact.html);
    assert.equal(artifact.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(artifact.headers['cache-control'], 'no-store');
    assert.match(String(artifact.headers['content-security-policy']), /sandbox/);
    assert.deepEqual(await snapshot(), persisted, 'reads and artifact downloads never mutate stored history');
  } finally { await app.close(); }
});

test('durable read-only grants allow read/artifact but reject writes and approval before mutation', async () => {
  const app = makeApp();
  try {
    const quoted = await seed(app, true);
    const persisted = await snapshot(), attempts = await writeAttempts();
    await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=false,can_approve=false`);
    for (const suffix of ['', '/quotes/1/artifact']) {
      const response = await app.inject({ url: `${API}/${eventId}${suffix}`, headers });
      assert.equal(response.statusCode, 200, response.body);
    }
    for (const input of [create(), { action: 'brief', key: 'synthetic-edit', expectedRevision: 2, brief: testBrief } as const, approve(quoted)]) {
      assertDenied(await command(app, input));
    }
    assert.deepEqual(await snapshot(), persisted);
    assert.equal(await writeAttempts(), attempts);
    await pool.query(`UPDATE ${accessSchema}.event_grants SET enabled=false`);
    for (const suffix of ['', '/quotes/1/artifact']) assertDenied(await app.inject({ url: `${API}/${eventId}${suffix}`, headers }));
    assert.deepEqual(await snapshot(), persisted);
  } finally { await app.close(); }
});

for (const source of expirySources) {
  for (const action of ['create', 'brief', 'quote', 'approve'] as const) {
    test(`${source} expiry after SQL ${action} rolls back the event, audit and receipt`, async () => {
      let app = makeApp();
      try {
        const initial = action === 'create' ? null : await seed(app, action === 'approve');
        const input: QuoteCommand = action === 'create' ? create()
          : action === 'brief' ? { action, key: 'synthetic-edit', expectedRevision: initial!.revision, brief: { ...testBrief, attendees: 30 } }
          : action === 'quote' ? quote(initial!) : approve(initial!);
        const persisted = await snapshot(), attempts = await writeAttempts();
        const deadline = TEST_AT + 1000;
        await expireAt(source, deadline);
        await app.close();
        let sawPendingWrite = false;
        app = makeApp(async call => {
          if (call !== 2) return;
          // The second catalogue read is after store.transact has completed its
          // SQL and audit trigger, but before the access transaction may commit.
          assert.equal(await writeAttempts(), attempts + 1);
          sawPendingWrite = true;
          now = deadline;
        });
        assertDenied(await command(app, input));
        assert.equal(sawPendingWrite, true, 'expiry must occur after a real database write');
        assert.equal(await writeAttempts(), attempts + 1, 'SQL ran even though no business history may survive');
        assert.deepEqual(await snapshot(), persisted, 'encrypted row, independent audit and decrypted receipt ledger all roll back');
        assert.equal((await store.read(testScope, eventId))?.receipts.some(receipt => receipt.key === input.key) ?? false, false);

        // Retry the exact command after restoring test time. An abandoned
        // receipt must neither suppress the operation nor create a conflict.
        now = TEST_AT;
        await app.close(); app = makeApp();
        const retried = await execute(app, input);
        assert.equal(retried.record.revision, (initial?.revision ?? 0) + 1);
        assert.equal(retried.record.audit.length, retried.record.revision);
        assert.equal(retried.record.receipts.filter(receipt => receipt.key === input.key).length, 1);
        const committed = await snapshot();
        assert.equal(committed.audits.length, retried.record.revision);
        assert.deepEqual(await execute(app, input), retried, 'the successful retry then becomes a durable no-op');
        assert.deepEqual(await snapshot(), committed);
        assert.equal(await writeAttempts(), attempts + 2);
      } finally { await app.close(); }
    });
  }

  for (const operation of ['read', 'artifact'] as const) {
    test(`${source} expiry during ${operation} never releases private content or changes history`, async () => {
      let app = makeApp();
      try {
        const record = await seed(app, true), persisted = await snapshot(), attempts = await writeAttempts();
        const deadline = TEST_AT + 1000;
        await expireAt(source, deadline);
        await app.close();
        let sawRead = false;
        app = makeApp(call => {
          assert.equal(call, 1);
          // read() resolves the catalogue only after decrypting the event.
          sawRead = true;
          now = deadline;
        });
        const suffix = operation === 'artifact' ? '/quotes/1/artifact' : '';
        assertDenied(await app.inject({ url: `${API}/${eventId}${suffix}`, headers }));
        assert.equal(sawRead, true);
        assert.deepEqual(await snapshot(), persisted);
        assert.equal(await writeAttempts(), attempts);
        now = TEST_AT;
        await app.close(); app = makeApp();
        const restored = await app.inject({ url: `${API}/${eventId}${suffix}`, headers });
        assert.equal(restored.statusCode, 200, restored.body);
        if (operation === 'artifact') assert.equal(restored.body, record.quotes[0].artifact.html);
        else assert.deepEqual(restored.json<EventQuoteView>().record, record);
      } finally { await app.close(); }
    });
  }
}
