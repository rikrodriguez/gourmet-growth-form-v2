import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { EventQuoteRecord, EventQuoteView, QuoteCommand } from '../../src/office/backend/event-quote-contracts';
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

function makeApp(onCatalog?: (call: number) => void | Promise<void>) {
  let calls = 0;
  return createDurableTestQuoteApi({ pool, vault, accessSchema, quoteSchema, allowedOrigin: headers.origin,
    clock: () => now, resolveExistingSession: async () => proof,
    catalogFor: async scope => {
      assert.deepEqual(scope, testScope);
      await onCatalog?.(++calls);
      return structuredClone(testCatalog);
    },
  });
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
const expirySources = ['session', 'membership', 'grant'] as const;
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


async function approved(app: App): Promise<EventQuoteView> {
  const quoted = await seed(app, true);
  return execute(app, approve(quoted));
}
function prepare(record: EventQuoteRecord): QuoteCommand {
  const q = record.quotes.at(-1)!, decision = record.decisions.find(d => d.quoteDigest === q.digest)!;
  return { action: 'prepare_payment', key: 'synthetic-prepare-payment', expectedRevision: record.revision,
    quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: decision.digest, artifactSha256: q.artifact.sha256 };
}

test('payment preparation durable SQL/access transaction upgrades only its aggregate and recovers after API replacement', async () => {
  let app = makeApp();
  try {
    const original = await approved(app), input = prepare(original.record);
    const pending = await execute(app, input), persisted = await snapshot();
    assert.equal(pending.record.schemaVersion, 2); assert.equal(pending.record.paymentPreparations!.length, 1);
    assert.equal(persisted.audits.length, 4); assert.equal(pending.record.paymentPreparations![0].publicPaymentUrl, null);
    assert.deepEqual(pending.record.quotes, original.record.quotes); assert.deepEqual(pending.record.decisions, original.record.decisions);
    const serialized = JSON.stringify(persisted.events);
    for (const secret of [testBrief.recipient, testBrief.originalMessage, testCatalog.terms, pending.record.paymentPreparations![0].id]) assert.equal(serialized.includes(secret), false);
    await app.close(); app = makeApp();
    const recovered = await app.inject({ url: `${API}/${eventId}`, headers });
    assert.equal(recovered.statusCode, 200, recovered.body); assert.deepEqual(recovered.json(), pending);
    assert.deepEqual(await execute(app, input), pending); assert.deepEqual(await snapshot(), persisted);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {Pool} from 'pg';
      import {PostgresEventQuoteStore} from './src/office/backend/event-quote-postgres.ts';
      import {MondayVault} from './src/office/backend/monday-store.ts';
      import {DEFAULT_OFFICE_DATABASE_URL} from './src/office/backend/postgres-store.ts';
      import {testScope} from './tests/office/event-quote-fixtures.ts';
      const pool=new Pool({connectionString:DEFAULT_OFFICE_DATABASE_URL});
      try { const store=new PostgresEventQuoteStore(pool,{schema:process.argv[1],vault:new MondayVault(Buffer.alloc(32,73))});
        process.stdout.write(JSON.stringify(await store.read(testScope,process.argv[2])));
      } finally {await pool.end();}
    `, quoteSchema, eventId], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), pending.record);

  } finally { await app.close(); }
});

test('two durable API instances racing one payment request commit one append-only preparation', async () => {
  const app = makeApp(), other = makeApp();
  try {
    const initial = await approved(app), input = prepare(initial.record);
    const [left, right] = await Promise.all([execute(app, input), execute(other, input)]);
    assert.deepEqual(left, right); assert.equal(left.record.paymentPreparations!.length, 1);
    const saved = await snapshot(); assert.equal(saved.audits.length, 4); assert.equal(saved.record!.receipts.length, 4);
    const conflict = await command(other, { ...input, key: 'another-preparation', expectedRevision: 4 });
    assert.equal(conflict.statusCode, 409); assert.deepEqual(await snapshot(), saved);
  } finally { await app.close(); await other.close(); }
});

for (const mutation of [
  'UPDATE event_grants SET can_approve=false',
  'UPDATE event_grants SET can_write=false,can_approve=false',
  'UPDATE event_grants SET enabled=false',
  'UPDATE sessions SET revoked_at=now()',
  "UPDATE users SET enabled=false",
] as const) {
  test(`payment request rejects withdrawn authority before SQL: ${mutation}`, async () => {
    const app = makeApp();
    try {
      const initial = await approved(app), saved = await snapshot(), attempts = await writeAttempts();
      await pool.query(mutation.replace(/UPDATE (\w+)/, `UPDATE ${accessSchema}.$1`));
      const denied = await command(app, prepare(initial.record));
      if (mutation.includes('sessions') || mutation.includes('users')) assert.equal(denied.statusCode, 401, denied.body); else assertDenied(denied);
      assert.deepEqual(await snapshot(), saved); assert.equal(await writeAttempts(), attempts);
    } finally { await app.close(); }
  });
}

test('payment request cannot substitute another event even with the exact approved quote payload', async () => {
  const app = makeApp();
  try {
    const initial = await approved(app), saved = await snapshot();
    const response = await app.inject({ method: 'POST', url: `${API}/other-event/commands`, headers, payload: prepare(initial.record) });
    assertDenied(response); assert.deepEqual(await snapshot(), saved);
  } finally { await app.close(); }
});

for (const source of expirySources) {
  test(`${source} expiry after SQL preparation rolls back schema upgrade, request, audit and receipt`, async () => {
    let app = makeApp();
    try {
      const initial = await approved(app), input = prepare(initial.record), saved = await snapshot(), attempts = await writeAttempts();
      const deadline = TEST_AT + 1000; await expireAt(source, deadline); await app.close();
      let sawPendingWrite = false;
      app = makeApp(async call => {
        if (call !== 2) return;
        assert.equal(await writeAttempts(), attempts + 1); sawPendingWrite = true; now = deadline;
      });
      assertDenied(await command(app, input)); assert.equal(sawPendingWrite, true);
      assert.deepEqual(await snapshot(), saved); assert.equal(saved.record!.schemaVersion, 1);
      now = TEST_AT; await app.close(); app = makeApp();
      const retried = await execute(app, input); assert.equal(retried.record.schemaVersion, 2);
      assert.equal(retried.record.paymentPreparations!.length, 1); assert.equal(retried.record.revision, 4);
    } finally { await app.close(); }
  });
}
