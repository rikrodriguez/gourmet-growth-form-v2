import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMondayReadClient, MONDAY_READ_SCOPES, type MondayReadClient } from '../../src/office/backend/monday-read';
import { createMondayOAuthService, MONDAY_AUTHORIZED_USER_EMAIL, MONDAY_AUTHORIZED_USER_ID, MONDAY_CONFIGURED_ACCOUNT_ID, MONDAY_OAUTH_CALLBACK, MondayOAuthError, type MondayOAuthOptions } from '../../src/office/backend/monday-oauth';
import { MemoryMondayStore, MondayVault, type MondayStore } from '../../src/office/backend/monday-store';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const BOARD = '18403945258' as const;
const OTHER_BOARD = '18377848804' as const;
const CONNECTION = 'monday-connection-ricardo';
const SLOT = `monday-pagination-ricardo-${BOARD}-board`;
const COOLDOWN = 'monday-read-cooldown-ricardo';
const NONCE = Buffer.alloc(32, 17).toString('base64url');
const CURSOR_CANARY = 'synthetic-private-provider-cursor';
const rejected = (code: string) => (error: unknown) => error instanceof MondayOAuthError && error.code === code;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(extra: { expiresInMs?: number; readClient?: MondayReadClient; store?: MondayStore } = {}) {
  let now = NOW; let tokenPosts = 0; let pageCalls = 0; let failPage: number | null = null; let waitSeconds = 30; let pageGate: ReturnType<typeof deferred<void>> | null = null;
  const memory = new MemoryMondayStore(); const store = extra.store ?? memory; const vault = new MondayVault(Buffer.alloc(32, 33));
  const columns = [{ id: 'stage', type: 'status', field: 'stage' }] as const;
  const realReadClient = createMondayReadClient({ enabled: true, clock: () => now, columnAllowlist: { [BOARD]: columns, [OTHER_BOARD]: columns }, mappingVersion: 'test-v1',
    fetch: async (_url, init) => {
      const query = JSON.parse(init!.body as string) as { query: string; variables: { boardIds?: string[]; cursor?: string | null } };
      if (query.query.includes('OfficeMondayIdentity')) return json({ data: { me: { id: MONDAY_AUTHORIZED_USER_ID, email: MONDAY_AUTHORIZED_USER_EMAIL } } });
      if (query.query.includes('OfficeMondayBoardAccess')) return json({ data: { boards: query.variables.boardIds!.map(id => ({ id })) } });
      pageCalls++;
      if (pageGate) await pageGate.promise;
      if (failPage === pageCalls) return json({ canary: CURSOR_CANARY }, 429, { 'Retry-After': String(waitSeconds) });
      const index = query.variables.cursor === null ? 0 : Number(query.variables.cursor!.slice(CURSOR_CANARY.length + 1));
      const boardId = query.variables.boardIds![0];
      return json({ data: { boards: [{ id: boardId, items_page: { cursor: index < 11 ? `${CURSOR_CANARY}-${index + 1}` : null,
        items: Array.from({ length: 25 }, (_, i) => ({ id: String(index * 25 + i + 1), updated_at: null, column_values: [{ id: 'stage', type: 'status', text: 'Contacted' }], ...(query.query.includes('OfficeMondayUpdatesRead') ? { updates: [] } : {}) })).map(item => query.query.includes('OfficeMondayUpdatesRead') ? { id: item.id, updated_at: item.updated_at, updates: [] } : item),
      } }] } });
    },
  });
  const readClient = extra.readClient ?? realReadClient;
  const options: MondayOAuthOptions = { configuration: { enabled: true, clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret', tokenEncryptionKey: Buffer.alloc(32, 33), expectedAccountEmail: MONDAY_AUTHORIZED_USER_EMAIL, expectedUserId: MONDAY_AUTHORIZED_USER_ID, expectedAccountId: MONDAY_CONFIGURED_ACCOUNT_ID, redirectUri: MONDAY_OAUTH_CALLBACK }, store, vault, readClient, clock: () => now, requestTimeoutMs: 1000,
    fetch: async () => {
      tokenPosts++; const accessToken = `${Buffer.from('{"alg":"synthetic-test-only"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor((now + (extra.expiresInMs ?? 3600_000)) / 1000), tag: tokenPosts })).toString('base64url')}.c3ludGhldGlj`;
      return json({ access_token: accessToken, refresh_token: `synthetic-refresh-${tokenPosts}`, token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' ') });
    },
  };
  const service = createMondayOAuthService(options);
  const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE });
  assert.equal((await service.callback({ state: new URL(start.authorizationUrl).searchParams.get('state')!, code: 'synthetic-code' }, NONCE)).state, 'connected');
  return { service, options, store, memory, vault, readClient: realReadClient, now: () => now, setTime: (at: number) => { now = at; }, pageCalls: () => pageCalls, tokenPosts: () => tokenPosts, failPage: (at: number, seconds = 30) => { failPage = at; waitSeconds = seconds; }, gate: (value: ReturnType<typeof deferred<void>> | null) => { pageGate = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function privateRow(f: Fixture, key = SLOT) { const saved = await f.store.read(key); assert.ok(saved); return { saved, value: f.vault.open(saved.value, key) as Record<string, unknown> }; }
async function mutate(f: Fixture, key: string, change: (value: Record<string, unknown>) => void) { const { saved, value } = await privateRow(f, key); change(value); assert.equal(await f.store.compareAndSet(key, saved.revision, f.vault.seal(value, key)), true); }

test('service resumes a bounded batch after restart using only an encrypted fixed checkpoint slot', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD);
  assert.equal(first.pages, 4); assert.equal(first.items.length, 100); assert.equal(first.status, 'partial'); assert.ok(first.paging?.nextBatch);
  assert.match(first.paging.nextBatch, /^[A-Za-z0-9_-]{43}$/); assert.deepEqual({ pages: first.paging.pagesRead, items: first.paging.itemsRead }, { pages: 4, items: 100 });
  const stored = await f.store.read(SLOT); assert.ok(stored); assert.ok(!JSON.stringify(stored).includes(CURSOR_CANARY)); assert.ok(!JSON.stringify(stored).includes(first.paging.nextBatch));
  const decoded = await privateRow(f); assert.equal((decoded.value.checkpoint as { cursor: string }).cursor, `${CURSOR_CANARY}-4`);
  const second = await createMondayOAuthService(f.options).readBoard(BOARD, first.paging.nextBatch);
  assert.equal(second.items[0].id, '101'); assert.equal(second.paging?.pagesRead, 8); assert.equal(second.paging?.itemsRead, 200); assert.equal(second.paging?.expiresAt, first.paging.expiresAt); assert.notEqual(second.paging?.nextBatch, first.paging.nextBatch);
  const third = await f.service.readBoard(BOARD, second.paging!.nextBatch!); assert.equal(third.status, 'complete'); assert.equal(third.paging?.nextBatch, null); assert.equal(third.paging?.pagesRead, 12); assert.equal(third.paging?.itemsRead, 300); assert.equal(await f.store.read(SLOT), null);
  for (const outcome of [first, second, third]) for (const canary of [CURSOR_CANARY, 'synthetic-refresh', 'synthetic-client-secret', 'accessToken', 'seenCursors', 'checkpoint']) assert.ok(!JSON.stringify(outcome).includes(canary));
});

test('untrusted, replayed, cross-board and cross-kind handles are rejected before a provider read', async () => {
  const f = await fixture();
  for (const handle of ['bad', Buffer.alloc(32, 99).toString('base64url'), `${Buffer.alloc(32, 99).toString('base64url')}A`, { cursor: CURSOR_CANARY }]) await assert.rejects(f.service.readBoard(BOARD, handle as string), rejected('read_unavailable'));
  assert.equal(f.pageCalls(), 0);
  const first = await f.service.readBoard(BOARD); const handle = first.paging!.nextBatch!;
  await assert.rejects(f.service.readBoard(OTHER_BOARD, handle), rejected('read_unavailable'));
  await assert.rejects(f.service.readUpdates(BOARD, handle), rejected('read_unavailable'));
  assert.equal(f.pageCalls(), 4);
  const second = await f.service.readBoard(BOARD, handle); assert.equal(second.pages, 4);
  await assert.rejects(f.service.readBoard(BOARD, handle), rejected('read_unavailable')); assert.equal(f.pageCalls(), 8);
});

test('two service instances cannot use the same continuation concurrently', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD); const gate = deferred<void>(); f.gate(gate);
  const a = f.service.readBoard(BOARD, first.paging!.nextBatch!); const b = createMondayOAuthService(f.options).readBoard(BOARD, first.paging!.nextBatch!);
  await assert.rejects(b, rejected('operation_in_progress')); f.gate(null); gate.resolve(); assert.equal((await a).pages, 4); assert.equal(f.pageCalls(), 8);
});

test('grant rotation with identical observed timestamps invalidates both a read continuation and an automatic-refresh fingerprint', async () => {
  const f = await fixture(); const oldStatus = await f.service.status(); const first = await f.service.readBoard(BOARD);
  assert.ok(oldStatus.grantFingerprint); assert.match(oldStatus.grantFingerprint, /^[A-Za-z0-9_-]{43}$/);
  const { value } = await privateRow(f, CONNECTION); assert.equal(oldStatus.grantFingerprint, createHash('sha256').update(value.generation as string).digest('base64url'));
  const rotated = await f.service.refresh(); assert.equal(rotated.expiresAt, oldStatus.expiresAt); assert.equal(rotated.updatedAt, oldStatus.updatedAt); assert.equal(rotated.connectedAt, oldStatus.connectedAt); assert.notEqual(rotated.grantFingerprint, oldStatus.grantFingerprint);
  const before = await f.store.read(CONNECTION);
  await assert.rejects(f.service.refresh({ expectedGrantFingerprint: oldStatus.grantFingerprint! }), rejected('connection_changed'));
  assert.deepEqual(await f.store.read(CONNECTION), before); assert.equal(f.tokenPosts(), 2);
  await assert.rejects(f.service.readBoard(BOARD, first.paging!.nextBatch!), rejected('read_unavailable')); assert.equal(f.pageCalls(), 4);
});

test('guarded refresh rejects malformed fingerprints without token consumption', async () => {
  const f = await fixture(); const before = await f.store.read(CONNECTION);
  for (const value of ['bad', undefined, { secret: 'synthetic-refresh' }]) await assert.rejects(f.service.refresh({ expectedGrantFingerprint: value as string }), error => error instanceof MondayOAuthError && error.code === 'connection_changed' && error.httpStatus === 409);
  assert.deepEqual(await f.store.read(CONNECTION), before); assert.equal(f.tokenPosts(), 1);
  const live = (await f.service.status()).grantFingerprint!; assert.equal((await f.service.refresh({ expectedGrantFingerprint: live })).state, 'connected'); assert.equal(f.tokenPosts(), 2);
});

test('guarded refresh cannot consume an expired grant while manual renewal remains explicit', async () => {
  const f = await fixture({ expiresInMs: 120_000 }); const fingerprint = (await f.service.status()).grantFingerprint!;
  const before = await f.store.read(CONNECTION); f.setTime(NOW + 120_000);
  await assert.rejects(f.service.refresh({ expectedGrantFingerprint: fingerprint }), error => error instanceof MondayOAuthError && error.code === 'expired' && error.httpStatus === 409);
  assert.equal(f.tokenPosts(), 1); assert.deepEqual(await f.store.read(CONNECTION), before);
  assert.equal((await f.service.refresh()).state, 'connected'); assert.equal(f.tokenPosts(), 2);
});

test('guarded refresh rejects a changed connection error with the same generation', async () => {
  const f = await fixture(); const fingerprint = (await f.service.status()).grantFingerprint!;
  await mutate(f, CONNECTION, value => { value.code = 'read_unavailable'; }); const before = await f.store.read(CONNECTION);
  await assert.rejects(f.service.refresh({ expectedGrantFingerprint: fingerprint }), rejected('connection_changed'));
  assert.equal(f.tokenPosts(), 1); assert.deepEqual(await f.store.read(CONNECTION), before);
});

test('guarded refresh whose CAS finishes at expiry never dispatches and restores the known unconsumed pair', async () => {
  const f = await fixture({ expiresInMs: 120_000 }); const fingerprint = (await f.service.status()).grantFingerprint!;
  const before = (await privateRow(f, CONNECTION)).value;
  const delayed: MondayStore = { read: key => f.store.read(key), async compareAndSet(key, revision, value) {
    const saved = await f.store.compareAndSet(key, revision, value);
    if (saved && key === CONNECTION && value !== null && (f.vault.open(value, key) as { attempt?: { kind: string } }).attempt?.kind === 'refresh') f.setTime(NOW + 120_000);
    return saved;
  } };
  f.setTime(NOW + 119_999);
  const result = await createMondayOAuthService({ ...f.options, store: delayed }).refresh({ expectedGrantFingerprint: fingerprint });
  assert.equal(result.state, 'expired'); assert.equal(result.code, 'expired'); assert.equal(result.pending, false); assert.equal(f.tokenPosts(), 1);
  const after = (await privateRow(f, CONNECTION)).value; assert.deepEqual(after.tokens, before.tokens); assert.equal(after.generation, before.generation);
});

test('mapping changes invalidate continuation before any provider request', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD);
  const changed = createMondayReadClient({ enabled: true, mappingVersion: 'changed-v2', columnAllowlist: { [BOARD]: [{ id: 'stage', type: 'status', field: 'stage' }] }, fetch: async () => { assert.fail('mapping mismatch must not call provider'); } });
  await assert.rejects(createMondayOAuthService({ ...f.options, readClient: changed }).readBoard(BOARD, first.paging!.nextBatch!), rejected('read_unavailable')); assert.equal(f.pageCalls(), 4);
});

test('original checkpoint TTL never extends and ends before token expiry', async () => {
  const f = await fixture({ expiresInMs: 120_000 }); const first = await f.service.readBoard(BOARD);
  assert.equal(first.paging?.expiresAt, new Date(NOW + 120_000).toISOString()); f.setTime(NOW + 60_000);
  const second = await f.service.readBoard(BOARD, first.paging!.nextBatch!); assert.equal(second.paging?.expiresAt, first.paging?.expiresAt);
  const longer = await fixture(); const a = await longer.service.readBoard(BOARD); longer.setTime(NOW + 300_000);
  await assert.rejects(longer.service.readBoard(BOARD, a.paging!.nextBatch!), rejected('read_unavailable')); assert.equal(longer.pageCalls(), 4);
});

test('a read lease persisted in the next millisecond keeps the reader original TTL', async () => {
  const f = await fixture(); let moved = false;
  const movingStore: MondayStore = { read: key => f.store.read(key), async compareAndSet(key, revision, value) {
    const success = await f.store.compareAndSet(key, revision, value);
    if (success && !moved && key === CONNECTION && value !== null && (f.vault.open(value, key) as { attempt?: { kind: string } }).attempt?.kind === 'read') { moved = true; f.setTime(NOW + 1); }
    return success;
  } };
  const first = await createMondayOAuthService({ ...f.options, store: movingStore }).readBoard(BOARD);
  assert.equal(first.paging?.expiresAt, new Date(NOW + 1 + 300_000).toISOString()); assert.equal(first.pages, 4);
  const second = await f.service.readBoard(BOARD, first.paging!.nextBatch!); assert.equal(second.paging?.expiresAt, first.paging.expiresAt);
});

test('corrupt private checkpoint bindings and budgets fail before provider requests', async () => {
  for (const field of ['ownerId', 'binding', 'generation', 'boardId', 'kind', 'createdAtMs', 'handleHash', 'actorId', 'mappingVersion', 'expiresAtMs', 'pagesRead', 'itemsRead', 'seenItemIds', 'seenCursors']) {
    const f = await fixture(); const a = await f.service.readBoard(BOARD);
    await mutate(f, SLOT, value => {
      if (['ownerId', 'binding', 'generation', 'boardId', 'kind', 'createdAtMs', 'handleHash'].includes(field)) value[field] = field === 'createdAtMs' ? NOW - 999_999 : 'tampered';
      else (value.checkpoint as Record<string, unknown>)[field] = field === 'pagesRead' ? 41 : field === 'itemsRead' ? 1001 : field === 'expiresAtMs' ? NOW + 999_999 : field.startsWith('seen') ? [] : 'tampered';
    });
    await assert.rejects(f.service.readBoard(BOARD, a.paging!.nextBatch!), rejected('read_unavailable')); assert.equal(f.pageCalls(), 4, field);
  }
});

test('rate limiting preserves private continuity and blocks early retries without a provider request', async () => {
  const f = await fixture(); f.failPage(3); const first = await f.service.readBoard(BOARD);
  assert.equal(first.reason, 'rate_limited'); assert.equal(first.pages, 2); assert.ok(first.paging?.nextBatch);
  const early = await f.service.readBoard(BOARD, first.paging.nextBatch); assert.equal(early.reason, 'rate_limited'); assert.equal(early.pages, 0); assert.equal(early.retryAfterSeconds, 30); assert.equal(early.paging?.nextBatch, first.paging.nextBatch); assert.equal(f.pageCalls(), 3);
  f.setTime(NOW + 30_000); const second = await f.service.readBoard(BOARD, first.paging.nextBatch); assert.equal(second.items[0].id, '51'); assert.equal(second.pages, 4); assert.equal(second.paging?.pagesRead, 6); assert.equal(f.pageCalls(), 7);
});

test('confirmed cooldown blocks fresh records, updates and different allowed boards without writes or checkpoint consumption', async () => {
  const f = await fixture(); f.failPage(3); const first = await f.service.readBoard(BOARD); assert.ok(first.paging?.nextBatch);
  const before = { connection: await f.store.read(CONNECTION), slot: await f.store.read(SLOT), cooldown: await f.store.read(COOLDOWN) }; assert.ok(before.cooldown);
  const waiting = [await f.service.readBoard(BOARD), await f.service.readUpdates(BOARD), await f.service.readBoard(OTHER_BOARD), await createMondayOAuthService(f.options).readUpdates(OTHER_BOARD)];
  for (const result of waiting) { assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'rate_limited'); assert.equal(result.pages, 0); assert.deepEqual(result.items, []); assert.equal(result.retryAfterSeconds, 30); assert.deepEqual(result.paging, { nextBatch: null, expiresAt: null, pagesRead: 0, itemsRead: 0 }); }
  assert.equal(f.pageCalls(), 3); assert.deepEqual({ connection: await f.store.read(CONNECTION), slot: await f.store.read(SLOT), cooldown: await f.store.read(COOLDOWN) }, before);
  const resume = await f.service.readBoard(BOARD, first.paging.nextBatch); assert.equal(resume.paging?.nextBatch, first.paging.nextBatch); assert.equal(resume.paging?.pagesRead, 2); assert.equal(f.pageCalls(), 3);
});

test('an initial page-zero rate limit persists cooldown without a checkpoint and survives a new service', async () => {
  const f = await fixture(); f.failPage(1); const first = await f.service.readBoard(BOARD); assert.equal(first.pages, 0); assert.equal(first.paging?.nextBatch, null); assert.equal(await f.store.read(SLOT), null);
  const stored = await f.store.read(COOLDOWN); assert.ok(stored); assert.ok(!JSON.stringify(stored).includes(CURSOR_CANARY));
  const row = await privateRow(f, COOLDOWN); assert.equal(row.value.retryNotBeforeMs, NOW + 30_000); assert.deepEqual(Object.keys(row.value).sort(), ['binding', 'ownerId', 'retryNotBeforeMs', 'version']);
  assert.equal((await createMondayOAuthService(f.options).readBoard(OTHER_BOARD)).reason, 'rate_limited'); assert.equal(f.pageCalls(), 1); assert.equal((await f.service.status()).lastReadAt, null);
});

test('provider wait longer than cursor TTL still blocks a fresh read after cursor expiry', async () => {
  const f = await fixture(); f.failPage(3, 600); const first = await f.service.readBoard(BOARD); assert.ok(first.paging?.nextBatch); assert.equal(first.paging.expiresAt, new Date(NOW + 300_000).toISOString());
  f.setTime(NOW + 301_000); const waiting = await createMondayOAuthService(f.options).readBoard(BOARD);
  assert.equal(waiting.reason, 'rate_limited'); assert.equal(waiting.retryAfterSeconds, 299); assert.equal(waiting.pages, 0); assert.equal(waiting.paging?.nextBatch, null); assert.equal(f.pageCalls(), 3);
  assert.equal((await privateRow(f, COOLDOWN)).value.retryNotBeforeMs, NOW + 600_000);
  f.setTime(NOW + 600_000); const admitted = await f.service.readBoard(BOARD); assert.equal(admitted.pages, 4); assert.equal(admitted.items[0].id, '1'); assert.equal(f.pageCalls(), 7);
});

test('public wait is bounded but a longer actual Retry-After cannot authorize an early read', async () => {
  const f = await fixture({ expiresInMs: 48 * 3600_000 }); f.failPage(1, 90_000); const first = await f.service.readBoard(BOARD);
  assert.equal(first.retryAfterSeconds, 86_400); assert.equal((await privateRow(f, COOLDOWN)).value.retryNotBeforeMs, NOW + 90_000_000);
  f.setTime(NOW + 86_400_000); const stillWaiting = await createMondayOAuthService(f.options).readBoard(BOARD); assert.equal(stillWaiting.reason, 'rate_limited'); assert.equal(stillWaiting.retryAfterSeconds, 3600); assert.equal(f.pageCalls(), 1);
  f.setTime(NOW + 90_000_000); assert.equal((await f.service.readBoard(BOARD)).pages, 4); assert.equal(f.pageCalls(), 5);
});

test('a rotated grant cannot reset a confirmed record cooldown for the same owner configuration', async () => {
  const f = await fixture(); f.failPage(1); await f.service.readBoard(BOARD); const before = await f.store.read(COOLDOWN);
  assert.equal((await f.service.refresh()).state, 'connected'); assert.equal(f.tokenPosts(), 2);
  assert.equal((await createMondayOAuthService(f.options).readUpdates(OTHER_BOARD)).reason, 'rate_limited'); assert.equal(f.pageCalls(), 1); assert.deepEqual(await f.store.read(COOLDOWN), before);
});

test('malformed or wrong-bound encrypted cooldown fails closed before any provider read', async () => {
  for (const field of ['ownerId', 'binding', 'retryNotBeforeMs', 'version', 'extra']) {
    const f = await fixture(); f.failPage(1); await f.service.readBoard(BOARD);
    await mutate(f, COOLDOWN, value => { value[field] = field === 'retryNotBeforeMs' ? -1 : field === 'version' ? 2 : 'tampered'; });
    await assert.rejects(f.service.readBoard(OTHER_BOARD), rejected('storage_unavailable')); assert.equal(f.pageCalls(), 1);
  }
});

test('cooldown CAS contention preserves the later confirmed deadline and reports that remaining wait', async () => {
  const f = await fixture(); f.failPage(1); let conflict = false;
  const racing: MondayStore = { read: key => f.store.read(key), async compareAndSet(key, revision, value) {
    if (!conflict && key === COOLDOWN && value !== null) {
      conflict = true; const payload = f.vault.open(value, key) as Record<string, unknown>; payload.retryNotBeforeMs = NOW + 120_000;
      assert.equal(await f.store.compareAndSet(key, revision, f.vault.seal(payload, key)), true); return false;
    }
    return f.store.compareAndSet(key, revision, value);
  } };
  const first = await createMondayOAuthService({ ...f.options, store: racing }).readBoard(BOARD); assert.equal(first.retryAfterSeconds, 120);
  assert.equal((await privateRow(f, COOLDOWN)).value.retryNotBeforeMs, NOW + 120_000);
  f.setTime(NOW + 30_000); const blocked = await f.service.readBoard(BOARD); assert.equal(blocked.retryAfterSeconds, 90); assert.equal(blocked.reason, 'rate_limited'); assert.equal(f.pageCalls(), 1);
});

test('unsafe Retry-After multiplication saturates the private deadline and never grants an early read', async () => {
  const f = await fixture({ expiresInMs: 48 * 3600_000 }); const readClient: MondayReadClient = { ...f.readClient, async readBoardBatch(input) {
    return { result: { status: 'blocked', reason: 'rate_limited', retryAfterSeconds: Number.MAX_SAFE_INTEGER, boardId: input.boardId, mappingVersion: 'test-v1', readAt: new Date(f.now()).toISOString(), pages: 0, items: [] }, checkpoint: null };
  } };
  const first = await createMondayOAuthService({ ...f.options, readClient }).readBoard(BOARD); assert.equal(first.retryAfterSeconds, 86_400);
  assert.equal((await privateRow(f, COOLDOWN)).value.retryNotBeforeMs, Number.MAX_SAFE_INTEGER);
  f.setTime(NOW + 86_400_000); assert.equal((await f.service.readBoard(BOARD)).reason, 'rate_limited'); assert.equal(f.pageCalls(), 0);
});

test('lastReadAt advances only after a confirmed provider page and uses the confirmed readAt', async () => {
  const f = await fixture(); f.setTime(NOW + 1000); const blocked = await f.service.readBoard('18398057136'); assert.equal(blocked.pages, 0); assert.equal((await f.service.status()).lastReadAt, null);
  const good = await f.service.readBoard(BOARD); assert.equal((await f.service.status()).lastReadAt, good.readAt);
  f.setTime(NOW + 2000); await f.service.readBoard('18398057136'); assert.equal((await f.service.status()).lastReadAt, good.readAt);
});

test('a new first batch replaces its fixed checkpoint slot and rejects the prior handle', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD); const second = await f.service.readBoard(BOARD); assert.notEqual(second.paging?.nextBatch, first.paging?.nextBatch);
  await assert.rejects(f.service.readBoard(BOARD, first.paging!.nextBatch!), rejected('read_unavailable')); assert.equal(f.pageCalls(), 8);
});

test('checkpoint consumption storage failure never dispatches the continuation', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD);
  const failing: MondayStore = { read: key => f.store.read(key), async compareAndSet(key, revision, value) { if (key === SLOT && value === null) throw new Error('synthetic-private-database-error'); return f.store.compareAndSet(key, revision, value); } };
  await assert.rejects(createMondayOAuthService({ ...f.options, store: failing }).readBoard(BOARD, first.paging!.nextBatch!), rejected('storage_unavailable')); assert.equal(f.pageCalls(), 4); assert.equal((await f.service.status()).pending, false);
});

test('disconnect during a read fences the late response and its continuity', async () => {
  const f = await fixture(); const first = await f.service.readBoard(BOARD); const gate = deferred<void>(); f.gate(gate);
  const reading = f.service.readBoard(BOARD, first.paging!.nextBatch!); await new Promise<void>(resolve => setImmediate(resolve));
  await f.service.disconnect(); f.gate(null); gate.resolve(); await assert.rejects(reading, rejected('connection_changed'));
  assert.equal((await f.service.status()).state, 'disconnected'); await assert.rejects(f.service.readBoard(BOARD, first.paging!.nextBatch!), rejected('not_connected'));
});
