import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createEventQuoteApi, EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF } from '../../src/office/backend/event-quote-http';
import { createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

test('HTTP -> real PostgreSQL -> separate process recovery preserves exact artifact and internal approval', async () => {
  const schema = `quote_test_${randomUUID().replaceAll('-', '')}`, pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL });
  const store = new PostgresEventQuoteStore(pool, { schema, vault: new MondayVault(Buffer.alloc(32, 81)) });
  const service = createEventQuoteService({ store, catalogFor: async () => testCatalog, clock: () => TEST_AT });
  const app = createEventQuoteApi({ service, allowedOrigin: 'http://127.0.0.1:4175', clock: () => TEST_AT,
    resolveIdentity: request => request.headers.cookie === 'test-session=existing' ? { scope: testScope, actor: testActor, csrfToken: 'test-csrf-existing-session', expiresAtMs: TEST_AT + 60000 } : null });
  const headers = { host: '127.0.0.1:4175', origin: 'http://127.0.0.1:4175', cookie: 'test-session=existing', [CSRF]: 'test-csrf-existing-session' };
  const post = (payload: unknown) => app.inject({ method: 'POST', url: `${API}/event-http/commands`, headers, payload: payload as object });
  try {
    await store.initialize();
    let response = await post({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief }); assert.equal(response.statusCode, 200, response.body);
    response = await post({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: response.json().record.briefs[0].digest, expectedCatalogDigest: digest(testCatalog), selections: [{ itemId: 'TEST-ITEM', quantity: 24 }] }); assert.equal(response.statusCode, 200, response.body);
    const quote = response.json().record.quotes[0];
    response = await post({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: 1, quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256, intendedRecipient: testBrief.recipient }); assert.equal(response.statusCode, 200, response.body);
    const approved = response.json(); assert.equal(approved.currentQuoteStatus, 'approved_internal_unsent');
    const html = await app.inject({ method: 'GET', url: `${API}/event-http/quotes/1/artifact`, headers }); assert.equal(html.statusCode, 200); assert.equal(html.body, quote.artifact.html); assert.match(html.headers['content-security-policy']!, /sandbox/);
    assert.equal((await app.inject({ method: 'GET', url: `${API}/event-http`, headers: { host: headers.host } })).statusCode, 401);
    await app.close();
    // A genuinely separate Node process, new pool/service/vault and no inherited
    // HTTP session. Only synthetic fixture data and a fixed test key are used.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {Pool} from 'pg';
      import {PostgresEventQuoteStore} from './src/office/backend/event-quote-postgres.ts';
      import {MondayVault} from './src/office/backend/monday-store.ts';
      import {createEventQuoteService} from './src/office/backend/event-quote-workflow.ts';
      import {DEFAULT_OFFICE_DATABASE_URL} from './src/office/backend/postgres-store.ts';
      import {TEST_AT,testScope,testActor,testCatalog} from './tests/office/event-quote-fixtures.ts';
      const pool=new Pool({connectionString:DEFAULT_OFFICE_DATABASE_URL});
      try { const store=new PostgresEventQuoteStore(pool,{schema:process.argv[1],vault:new MondayVault(Buffer.alloc(32,81))});
        const service=createEventQuoteService({store,catalogFor:async()=>testCatalog,clock:()=>TEST_AT});
        process.stdout.write(JSON.stringify(await service.read(testScope,testActor,'event-http')));
      } finally { await pool.end(); }
    `, schema], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), approved);
  } finally { await app.close(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); }
});
