import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMondayOAuthService, MondayOAuthError, MONDAY_AUTHORIZED_USER_EMAIL, MONDAY_AUTHORIZED_USER_ID, MONDAY_CONFIGURED_ACCOUNT_ID, MONDAY_OAUTH_CALLBACK, type MondayOAuthOptions } from '../../src/office/backend/monday-oauth';
import { createMondayReadClient, MONDAY_READ_SCOPES } from '../../src/office/backend/monday-read';
import { MondayVault, PostgresMondayStore, type MondayStore } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';

const AT = Date.parse('2026-10-12T12:00:00.000Z');
const BOARD = '18403945258' as const;
const CURSOR = 'SYNTHETIC_PRIVATE_PROVIDER_CURSOR';
const NONCE = Buffer.alloc(32, 17).toString('base64url');
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const errorCode = (code: string) => (error: unknown) => error instanceof MondayOAuthError && error.code === code;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('encrypted continuation and cooldown survive pool replacement and serialize reads across independent PostgreSQL workers', async t => {
  const stateId = `monday_continuity_test_${randomUUID()}`; const prefix = `monday-test:${randomUUID()}:`;
  const keys = new Set<string>(); const connections: PostgresOfficeStore[] = [];
  function scoped(store: PostgresMondayStore): MondayStore {
    const physical = (key: string) => { assert.match(key, /^monday-/); const namespaced = `${prefix}${key.slice(7)}`; keys.add(namespaced); return namespaced; };
    return { read: key => store.read(physical(key)), compareAndSet: (key, revision, value) => store.compareAndSet(physical(key), revision, value) };
  }
  async function newConnection() { const office = new PostgresOfficeStore({ stateId }); connections.push(office); await office.initialize(AT); const postgres = new PostgresMondayStore(office.pool); return { office, postgres, store: scoped(postgres) }; }
  t.after(async () => {
    const cleanup = connections.find(connection => !closed.has(connection));
    try {
      if (cleanup) { const store = new PostgresMondayStore(cleanup.pool); for (const key of keys) { const value = await store.read(key); if (value) assert.equal(await store.compareAndSet(key, value.revision, null), true); } }
    } finally { for (const connection of connections) if (!closed.has(connection)) await connection.close(); }
  });
  const closed = new Set<PostgresOfficeStore>();
  const firstConnection = await newConnection();
  const vault = new MondayVault(Buffer.alloc(32, 51)); let tokenPosts = 0; let pageCalls = 0; let gate: ReturnType<typeof deferred> | null = null; let dispatched = deferred(); let rateLimitNext = false;
  const readClient = createMondayReadClient({ enabled: true, clock: () => AT, mappingVersion: 'postgres-test-v1', columnAllowlist: { [BOARD]: [{ id: 'stage', type: 'status', field: 'stage' }] }, fetch: async (_url, init) => {
    const request = JSON.parse(init!.body as string) as { query: string; variables: { boardIds?: string[]; cursor?: string | null } };
    if (request.query.includes('OfficeMondayIdentity')) return json({ data: { me: { id: MONDAY_AUTHORIZED_USER_ID, email: MONDAY_AUTHORIZED_USER_EMAIL } } });
    if (request.query.includes('OfficeMondayBoardAccess')) return json({ data: { boards: request.variables.boardIds!.map(id => ({ id })) } });
    pageCalls++; if (gate) { dispatched.resolve(); await gate.promise; }
    if (rateLimitNext) { rateLimitNext = false; return json({ canary: CURSOR }, 429, { 'Retry-After': '600' }); }
    const index = request.variables.cursor === null ? 0 : Number(request.variables.cursor!.slice(CURSOR.length + 1));
    return json({ data: { boards: [{ id: BOARD, items_page: { cursor: `${CURSOR}-${index + 1}`, items: Array.from({ length: 25 }, (_, i) => ({ id: String(index * 25 + i + 1), updated_at: null, column_values: [{ id: 'stage', type: 'status', text: 'Contacted' }] })) } }] } });
  } });
  const options: MondayOAuthOptions = { configuration: { enabled: true, clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret', tokenEncryptionKey: Buffer.alloc(32, 51), expectedAccountEmail: MONDAY_AUTHORIZED_USER_EMAIL, expectedUserId: MONDAY_AUTHORIZED_USER_ID, expectedAccountId: MONDAY_CONFIGURED_ACCOUNT_ID, redirectUri: MONDAY_OAUTH_CALLBACK }, store: firstConnection.store, vault, readClient, clock: () => AT, requestTimeoutMs: 2000, fetch: async () => {
    tokenPosts++; const accessToken = `${Buffer.from('{"alg":"synthetic-test-only"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: AT / 1000 + 3600, tag: tokenPosts })).toString('base64url')}.c3ludGhldGlj`;
    return json({ access_token: accessToken, refresh_token: `SYNTHETIC_REFRESH_${tokenPosts}`, token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' ') });
  } };
  const firstService = createMondayOAuthService(options); const start = await firstService.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE });
  assert.equal((await firstService.callback({ state: new URL(start.authorizationUrl).searchParams.get('state')!, code: 'synthetic-code' }, NONCE)).state, 'connected');
  const first = await firstService.readBoard(BOARD); assert.ok(first.paging?.nextBatch); assert.equal(first.paging.pagesRead, 4);
  const slot = `monday-pagination-ricardo-${BOARD}-board`; const persisted = await firstConnection.store.read(slot); assert.ok(persisted);
  const encoded = await firstConnection.office.pool.query<{ encoded: string }>('SELECT payload::text AS encoded FROM office_demo.monday_private_records WHERE key=$1', [`${prefix}${slot.slice(7)}`]);
  assert.equal(encoded.rowCount, 1);
  for (const marker of [CURSOR, first.paging.nextBatch, 'SYNTHETIC_REFRESH', 'synthetic-client-secret']) assert.ok(!encoded.rows[0].encoded.includes(marker));
  assert.equal((vault.open(persisted.value, slot) as { checkpoint: { cursor: string } }).checkpoint.cursor, `${CURSOR}-4`);
  await firstConnection.office.close(); closed.add(firstConnection.office);
  const restartedConnection = await newConnection(); const restarted = createMondayOAuthService({ ...options, store: restartedConnection.store });
  const second = await restarted.readBoard(BOARD, first.paging.nextBatch); assert.equal(second.items[0].id, '101'); assert.equal(second.paging?.pagesRead, 8); assert.equal(second.paging?.expiresAt, first.paging.expiresAt);
  const otherConnection = await newConnection(); const other = createMondayOAuthService({ ...options, store: otherConnection.store });
  gate = deferred(); dispatched = deferred(); const reading = restarted.readBoard(BOARD, second.paging!.nextBatch!); await dispatched.promise;
  await assert.rejects(other.readBoard(BOARD, second.paging!.nextBatch!), errorCode('operation_in_progress'));
  const release = gate; gate = null; release.resolve(); const third = await reading; assert.equal(third.paging?.pagesRead, 12); assert.equal(third.paging?.itemsRead, 300); assert.equal(pageCalls, 12);
  await assert.rejects(other.readBoard(BOARD, second.paging!.nextBatch!), errorCode('read_unavailable')); assert.equal(pageCalls, 12);
  const oldFingerprint = (await other.status()).grantFingerprint!; assert.equal((await other.refresh()).state, 'connected'); assert.equal(tokenPosts, 2);
  await assert.rejects(restarted.readBoard(BOARD, third.paging!.nextBatch!), errorCode('read_unavailable')); assert.equal(pageCalls, 12);
  await assert.rejects(restarted.refresh({ expectedGrantFingerprint: oldFingerprint }), errorCode('connection_changed')); assert.equal(tokenPosts, 2);
  rateLimitNext = true; const limited = await other.readBoard(BOARD); assert.equal(limited.reason, 'rate_limited'); assert.equal(limited.pages, 0); assert.equal(pageCalls, 13);
  const cooldownKey = 'monday-read-cooldown-ricardo'; const encryptedCooldown = await otherConnection.store.read(cooldownKey); assert.ok(encryptedCooldown);
  assert.equal((vault.open(encryptedCooldown.value, cooldownKey) as { retryNotBeforeMs: number }).retryNotBeforeMs, AT + 600_000);
  const storedCooldown = await otherConnection.office.pool.query<{ encoded: string }>('SELECT payload::text AS encoded FROM office_demo.monday_private_records WHERE key=$1', [`${prefix}${cooldownKey.slice(7)}`]);
  assert.equal(storedCooldown.rowCount, 1); assert.ok(!storedCooldown.rows[0].encoded.includes(CURSOR));
  await restartedConnection.office.close(); closed.add(restartedConnection.office); const replacementConnection = await newConnection(); const replacement = createMondayOAuthService({ ...options, store: replacementConnection.store });
  const before = await replacementConnection.store.read('monday-connection-ricardo');
  const waiting = await replacement.readUpdates('18377848804'); assert.equal(waiting.reason, 'rate_limited'); assert.equal(waiting.retryAfterSeconds, 600); assert.equal(waiting.pages, 0); assert.equal(waiting.paging?.nextBatch, null); assert.equal(pageCalls, 13);
  assert.deepEqual(await replacementConnection.store.read('monday-connection-ricardo'), before); assert.deepEqual(await replacementConnection.store.read(cooldownKey), encryptedCooldown);
});
