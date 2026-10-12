import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemoryMondayStore, MondayVault, type MondayStore } from '../../src/office/backend/monday-store';
import { MONDAY_READ_BOARD_IDS, MONDAY_READ_SCOPES, type MondayReadClient } from '../../src/office/backend/monday-read';
import { createMondayOAuthService, parseMondayConfiguration, MONDAY_OAUTH_ORIGIN, MondayOAuthError, type MondayOAuthStatus } from '../../src/office/backend/monday-oauth';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const KEY = 'monday-renewal-ricardo';
function connected(expiresAt = NOW + 15 * 60_000): MondayOAuthStatus {
  return { state: 'connected', code: null, actorId: '78158865', accountId: null, accountVerified: false,
    configuredAccountId: '29907909', boardAccessVerified: true, boardAccessReadAt: new Date(NOW).toISOString(),
    scopes: [...MONDAY_READ_SCOPES], expiresAt: new Date(expiresAt).toISOString(), connectedAt: new Date(NOW).toISOString(),
    identityReadAt: new Date(NOW).toISOString(), lastReadAt: null, updatedAt: new Date(NOW).toISOString(), pending: false,
    grantFingerprint: createHash('sha256').update(`synthetic-generation:${expiresAt}`).digest('base64url') };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function factory() {
  const module = await import('../../src/office/backend/monday-renewal').catch(() => null);
  assert.equal(typeof module?.createMondayRenewalScheduler, 'function', 'scheduler factory must be implemented');
  return module!.createMondayRenewalScheduler;
}
async function setup(enabled = true, store: MondayStore = new MemoryMondayStore()) {
  const create = await factory(); let now = NOW; let value = connected(); let statuses = 0; let refreshes = 0;
  let statusAction = async () => value;
  let refreshAction = async () => { value = connected(now + 3600_000); return value; };
  let timerId = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const vault = new MondayVault(Buffer.alloc(32, 19));
  const service = { async status() { statuses++; return statusAction(); }, async refresh() { refreshes++; return refreshAction(); } };
  const timers = { setTimeout(callback: () => void, delay: number) { const id = ++timerId; tasks.set(id, { callback, delay }); return id; }, clearTimeout(handle: unknown) { tasks.delete(handle as number); } };
  const scheduler = create({ enabled, store, vault, service, clock: () => now, timers });
  return { scheduler, service, store, vault, tasks, timers, clock: () => now, statuses: () => statuses, refreshes: () => refreshes,
    setTime(time: number) { now = time; }, setStatus(status: MondayOAuthStatus) { value = status; },
    setStatusAction(action: typeof statusAction) { statusAction = action; }, setRefreshAction(action: typeof refreshAction) { refreshAction = action; } };
}

test('default-disabled scheduler never reads dependencies or schedules work', async () => {
  const create = await factory(); let effects = 0;
  const forbidden = () => { effects++; throw new Error('private-canary'); };
  const scheduler = create({ service: { status: forbidden, refresh: forbidden }, store: { read: forbidden, compareAndSet: forbidden },
    vault: { seal: forbidden, open: forbidden }, clock: forbidden, timers: { setTimeout: forbidden, clearTimeout: forbidden } });
  scheduler.start(); await scheduler.tick(); scheduler.stop(); scheduler.start();
  assert.equal(effects, 0); assert.equal(scheduler.status().state, 'disabled');
  assert.ok(!JSON.stringify(scheduler.status()).includes('private-canary'));
});

test('refresh occurs at the 15-minute boundary and keeps the configured account unverified', async () => {
  const fixture = await setup(); fixture.setStatus(connected(NOW + 15 * 60_000 + 1));
  await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0);
  fixture.setTime(NOW + 1); await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 1);
  assert.equal((await fixture.service.status()).accountVerified, false);
  const stored = await fixture.store.read(KEY); assert.ok(stored);
  assert.ok(!JSON.stringify(stored.value).includes('78158865')); assert.ok(!JSON.stringify(stored.value).includes('expiresAt'));
  assert.ok(JSON.stringify(stored.value).length < 2048);
});

test('expired, invalid, pending and terminal grants are never automatically refreshed', async () => {
  const invalid: Partial<MondayOAuthStatus>[] = [
    { expiresAt: new Date(NOW).toISOString() }, { expiresAt: null }, { expiresAt: 'tomorrow' },
    { state: 'expired' }, { state: 'disconnected' }, { actorId: '78158866' }, { boardAccessVerified: false },
    { pending: true }, { scopes: ['boards:read', 'updates:read'] }, { scopes: [...MONDAY_READ_SCOPES, 'boards:write'] },
    { scopes: ['boards:read', 'boards:read', 'me:read'] },
    { grantFingerprint: undefined }, { grantFingerprint: null }, { grantFingerprint: 'invalid' }, { grantFingerprint: 'A'.repeat(42) + 'B' },
    ...(['refresh_uncertain', 'token_invalid', 'scope_mismatch', 'identity_mismatch', 'connection_changed', 'board_access_unverified', 'read_unavailable'] as const).map(code => ({ code })),
  ];
  for (const patch of invalid) {
    const fixture = await setup(); fixture.setStatus({ ...connected(), ...patch });
    await fixture.scheduler.tick(); await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0, JSON.stringify(patch));
  }
});

test('scheduled refresh is bound to the fresh internal grant fingerprint', async () => {
  const create = await factory(); const snapshot = connected(); let input: unknown;
  const scheduler = create({ enabled: true, clock: () => NOW, store: new MemoryMondayStore(), vault: new MondayVault(Buffer.alloc(32, 19)),
    service: { async status() { return snapshot; }, async refresh(value) { input = value; return connected(NOW + 3600_000); } } });
  await scheduler.tick(); assert.deepEqual(input, { expectedGrantFingerprint: snapshot.grantFingerprint });
});

test('two workers with one durable store only dispatch one refresh', async () => {
  const first = await setup(); const second = await setup(true, first.store);
  const gate = deferred<MondayOAuthStatus>(); first.setRefreshAction(() => gate.promise);
  const pending = first.scheduler.tick();
  while (first.refreshes() === 0) await new Promise<void>(resolve => setImmediate(resolve));
  const saved = await first.store.read(KEY); assert.ok(saved);
  const claim = first.vault.open(saved.value, KEY) as { leaseUntil: number; phase: string };
  assert.ok(claim.leaseUntil - NOW <= 1003); assert.equal(claim.phase, 'attempted');
  await second.scheduler.tick(); assert.equal(second.refreshes(), 0);
  gate.resolve(connected(NOW + 3600_000)); await pending;
  await second.scheduler.tick(); assert.equal(first.refreshes() + second.refreshes(), 1);
});

test('local overlapping ticks cannot duplicate an in-flight refresh', async () => {
  const fixture = await setup(); const gate = deferred<MondayOAuthStatus>(); fixture.setRefreshAction(() => gate.promise);
  const pending = fixture.scheduler.tick();
  while (fixture.refreshes() === 0) await new Promise<void>(resolve => setImmediate(resolve));
  await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 1);
  gate.resolve(connected(NOW + 3600_000)); await pending;
});

test('restart and expired scheduling lease never replay an uncertain attempt', async () => {
  const first = await setup(); first.setRefreshAction(async () => { throw new Error('private-provider-canary'); });
  await first.scheduler.tick(); const second = await setup(true, first.store); second.setTime(NOW + 60_000);
  await second.scheduler.tick(); assert.equal(second.refreshes(), 0);
  assert.equal(second.scheduler.status().state, 'suspended');
  assert.ok(!JSON.stringify(first.scheduler.status()).includes('private-provider-canary'));
});

test('backoff for pre-dispatch read failure grows 60/120/240 seconds and caps at 900 seconds', async () => {
  const fixture = await setup(); fixture.setStatusAction(async () => { throw new Error('private-store-canary'); });
  let time = NOW;
  for (const seconds of [60, 120, 240, 480, 900, 900]) {
    fixture.setTime(time); await fixture.scheduler.tick();
    assert.equal(fixture.scheduler.status().nextCheckAt, new Date(time + seconds * 1000).toISOString());
    await fixture.scheduler.tick(); time += seconds * 1000;
  }
  assert.equal(fixture.statuses(), 6); assert.equal(fixture.refreshes(), 0);
  assert.ok(!JSON.stringify(fixture.scheduler.status()).includes('private-store-canary'));
});

test('retry after storage failure requires a fresh valid service status', async () => {
  let fail = true; const memory = new MemoryMondayStore();
  const store: MondayStore = { read: key => fail ? Promise.reject(new Error('private')) : memory.read(key), compareAndSet: (...args) => memory.compareAndSet(...args) };
  const fixture = await setup(true, store); await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0);
  fail = false; fixture.setStatus({ ...connected(), code: 'refresh_uncertain' }); fixture.setTime(NOW + 60_000);
  await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0);
});

test('lost CAS claim backs off before retry and never dispatches', async () => {
  const memory = new MemoryMondayStore(); let conflicts = 0;
  const fixture = await setup(true, { read: key => memory.read(key), async compareAndSet() { conflicts++; return false; } });
  await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0);
  assert.equal(fixture.scheduler.status().nextCheckAt, new Date(NOW + 60_000).toISOString());
  await fixture.scheduler.tick(); assert.equal(conflicts, 1);
});

test('manual refresh or disconnect while claiming cancels scheduled dispatch', async () => {
  for (const replacement of [connected(NOW + 3600_000), { ...connected(), state: 'disconnected' as const, actorId: null }]) {
    const fixture = await setup(); let reads = 0;
    fixture.setStatusAction(async () => ++reads === 1 ? connected() : replacement);
    await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0);
  }
});

test('success without a later expiry suspends automatic renewal across restart', async () => {
  const unchanged = { ...connected(), grantFingerprint: createHash('sha256').update('new-generation-same-expiry').digest('base64url') };
  const first = await setup(); first.setRefreshAction(async () => unchanged); await first.scheduler.tick();
  assert.equal(first.scheduler.status().state, 'suspended'); assert.equal(first.scheduler.status().reason, 'expiry_not_extended');
  first.setTime(NOW + 60_000); await first.scheduler.tick(); assert.equal(first.refreshes(), 1);
  const second = await setup(true, first.store); second.setStatus(unchanged); second.setTime(NOW + 120_000); await second.scheduler.tick();
  assert.equal(second.refreshes(), 0); assert.equal(second.scheduler.status().reason, 'expiry_not_extended');
});

test('refresh terminal result stops repeating attempts', async () => {
  for (const code of ['refresh_uncertain', 'token_invalid', 'scope_mismatch', 'identity_mismatch'] as const) {
    const fixture = await setup(); fixture.setRefreshAction(async () => ({ ...connected(), state: 'error', code, expiresAt: null }));
    await fixture.scheduler.tick(); fixture.setTime(NOW + 900_000); await fixture.scheduler.tick();
    assert.equal(fixture.refreshes(), 1); assert.equal(fixture.scheduler.status().state, 'suspended');
  }
});

test('operation contention can retry only after fresh valid state', async () => {
  const fixture = await setup(); fixture.setRefreshAction(async () => { throw new MondayOAuthError('operation_in_progress', 409); });
  await fixture.scheduler.tick(); assert.equal(fixture.scheduler.status().state, 'backoff');
  fixture.setTime(NOW + 60_000); fixture.setStatus({ ...connected(), pending: true }); await fixture.scheduler.tick();
  assert.equal(fixture.refreshes(), 1);
});

test('contention error after token consumption cannot reopen a durable attempted claim', async () => {
  const fixture = await setup(); let reads = 0;
  fixture.setStatusAction(async () => ++reads <= 2 ? connected() : { ...connected(), state: 'disconnected', expiresAt: null, actorId: null, pending: true });
  fixture.setRefreshAction(async () => { throw new MondayOAuthError('operation_in_progress', 409); });
  await fixture.scheduler.tick(); assert.equal(fixture.scheduler.status().state, 'suspended');
  const restarted = await setup(true, fixture.store); restarted.setTime(NOW + 60_000);
  await restarted.scheduler.tick(); assert.equal(restarted.refreshes(), 0);
});

test('start checks every minute and stop cancels future work and in-flight pre-dispatch work', async () => {
  const fixture = await setup(); fixture.setStatus(connected(NOW + 3600_000)); fixture.scheduler.start();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(fixture.tasks.size, 1);
  assert.equal([...fixture.tasks.values()][0].delay, 60_000); fixture.scheduler.stop(); assert.equal(fixture.tasks.size, 0);
  const callback = deferred<MondayOAuthStatus>(); const stopped = await setup(); stopped.setStatusAction(() => callback.promise);
  stopped.scheduler.start(); stopped.scheduler.stop(); callback.resolve(connected());
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped.refreshes(), 0); assert.equal(stopped.tasks.size, 0);
});

test('real OAuth service rotates one complete pair after exact scopes, Info and all five metadata checks', async () => {
  const create = await factory(); let now = NOW; const store = new MemoryMondayStore(); const vault = new MondayVault(Buffer.alloc(32, 19));
  const nonce = Buffer.alloc(32, 11).toString('base64url'); let posts = 0; let identities = 0; let boards = 0;
  const configuration = parseMondayConfiguration({ MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'synthetic-secret',
    MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64'), MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com',
    MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909' }, MONDAY_OAUTH_ORIGIN);
  const readClient: MondayReadClient = {
    async getIdentity() { identities++; return { id: '78158865', email: 'info@gourmet-corp.com', readAt: new Date(now).toISOString() }; },
    async verifyBoardAccess() { boards++; return { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(now).toISOString() }; },
    async readBoard() { throw new Error('record reads prohibited'); }, async readUpdates() { throw new Error('updates reads prohibited'); },
  };
  const service = createMondayOAuthService({ configuration, store, vault, readClient, clock: () => now, requestTimeoutMs: 100,
    fetch: async (_url, init) => {
      posts++; const body = JSON.parse(init!.body as string) as { grant_type: string; refresh_token?: string };
      if (body.grant_type === 'refresh_token') {
        assert.equal(body.refresh_token, 'synthetic-refresh-1');
        const saved = await store.read('monday-connection-ricardo'); assert.ok(saved);
        const value = vault.open(saved.value, 'monday-connection-ricardo') as { tokens: unknown; attempt: { kind: string } };
        assert.equal(value.tokens, null); assert.equal(value.attempt.kind, 'refresh');
      }
      const access = `${Buffer.from('{"alg":"synthetic"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, tag: posts })).toString('base64url')}.c3ludGhldGlj`;
      return new Response(JSON.stringify({ access_token: access, refresh_token: `synthetic-refresh-${posts}`, token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' ') }), { headers: { 'Content-Type': 'application/json' } });
    } });
  const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: nonce });
  await service.callback({ state: new URL(start.authorizationUrl).searchParams.get('state')!, code: 'synthetic-code' }, nonce);
  now += 45 * 60_000;
  const scheduler = create({ enabled: true, service, store, vault, clock: () => now });
  await scheduler.tick(); assert.equal(posts, 2); assert.equal(identities, 2); assert.equal(boards, 2); assert.equal(MONDAY_READ_BOARD_IDS.length, 5);
  const saved = await store.read('monday-connection-ricardo'); assert.ok(saved);
  const value = vault.open(saved.value, 'monday-connection-ricardo') as { tokens: { accessToken: string; refreshToken: string; scopes: string[] }; attempt: null };
  assert.equal(value.tokens.refreshToken, 'synthetic-refresh-2'); assert.deepEqual(value.tokens.scopes, MONDAY_READ_SCOPES); assert.equal(value.attempt, null);
  assert.equal((await service.status()).accountVerified, false);
  assert.ok(!JSON.stringify(scheduler.status()).includes(value.tokens.accessToken));
});

test('manual rotation with identical timestamps and expiry rejects the scheduler stale generation before another POST', async () => {
  const create = await factory(); let now = NOW; let posts = 0; const store = new MemoryMondayStore(); const vault = new MondayVault(Buffer.alloc(32, 19));
  const nonce = Buffer.alloc(32, 11).toString('base64url');
  const configuration = parseMondayConfiguration({ MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'synthetic-secret',
    MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64'), MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com',
    MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909' }, MONDAY_OAUTH_ORIGIN);
  const readClient: MondayReadClient = {
    async getIdentity() { return { id: '78158865', email: 'info@gourmet-corp.com', readAt: new Date(now).toISOString() }; },
    async verifyBoardAccess() { return { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(now).toISOString() }; },
    async readBoard() { throw new Error('record reads prohibited'); }, async readUpdates() { throw new Error('updates reads prohibited'); },
  };
  const service = createMondayOAuthService({ configuration, store, vault, readClient, clock: () => now, requestTimeoutMs: 100,
    fetch: async () => {
      posts++;
      const access = `${Buffer.from('{"alg":"synthetic"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + 3600, tag: posts })).toString('base64url')}.c3ludGhldGlj`;
      return new Response(JSON.stringify({ access_token: access, refresh_token: `synthetic-refresh-${posts}`, token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' ') }), { headers: { 'Content-Type': 'application/json' } });
    } });
  const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: nonce });
  await service.callback({ state: new URL(start.authorizationUrl).searchParams.get('state')!, code: 'synthetic-code' }, nonce);
  now += 45 * 60_000; await service.refresh();
  const before = await service.status();
  const scheduler = create({ enabled: true, store, vault, clock: () => now, service: {
    status: () => service.status(), async refresh(input) {
      await service.refresh(); const manual = await service.status();
      for (const field of ['expiresAt', 'connectedAt', 'identityReadAt', 'boardAccessReadAt', 'updatedAt'] as const) assert.equal(manual[field], before[field]);
      assert.notEqual(manual.grantFingerprint, before.grantFingerprint);
      return service.refresh(input);
    },
  } });
  await scheduler.tick(); assert.equal(posts, 3); assert.equal(scheduler.status().reason, 'grant_changed');
  const after = await service.status(); assert.equal(after.state, 'connected'); assert.equal(after.pending, false);
  await scheduler.tick(); assert.equal(posts, 3);
});

test('stop then restart during an old status read keeps exactly one future timer', async () => {
  const fixture = await setup(); const gate = deferred<MondayOAuthStatus>(); fixture.setStatusAction(() => gate.promise);
  fixture.scheduler.start(); fixture.scheduler.stop(); fixture.scheduler.start();
  gate.resolve(connected(NOW + 3600_000)); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fixture.tasks.size, 1); fixture.scheduler.stop();
});

test('post-dispatch persistence failure is terminal and cannot replay after restart', async () => {
  const memory = new MemoryMondayStore(); let reads = 0;
  const store: MondayStore = { async read(key) { reads++; if (reads === 3) throw new Error('private-after-post'); return memory.read(key); }, compareAndSet: (...args) => memory.compareAndSet(...args) };
  const first = await setup(true, store); await first.scheduler.tick(); assert.equal(first.refreshes(), 1); assert.equal(first.scheduler.status().state, 'suspended');
  const second = await setup(true, memory); second.setTime(NOW + 60_000); await second.scheduler.tick(); assert.equal(second.refreshes(), 0);
});

test('failed final persistence cannot lose the unchanged-expiry stop across a new generation', async () => {
  const memory = new MemoryMondayStore(); let reads = 0;
  const store: MondayStore = { async read(key) { if (++reads === 3) throw new Error('private-after-post'); return memory.read(key); }, compareAndSet: (...args) => memory.compareAndSet(...args) };
  const unchanged = { ...connected(), grantFingerprint: createHash('sha256').update('rotated-without-expiry-extension').digest('base64url') };
  const first = await setup(true, store); first.setRefreshAction(async () => unchanged); await first.scheduler.tick();
  const second = await setup(true, memory); second.setStatus(unchanged); second.setTime(NOW + 60_000);
  await second.scheduler.tick(); assert.equal(second.refreshes(), 0); assert.equal(second.scheduler.status().state, 'suspended');
});

test('a malformed private claim fails closed with no provider operation', async () => {
  const fixture = await setup(); await fixture.store.compareAndSet(KEY, null, fixture.vault.seal({ version: 1, secret: 'private-canary' }, KEY));
  await fixture.scheduler.tick(); assert.equal(fixture.refreshes(), 0); assert.equal(fixture.scheduler.status().state, 'backoff');
  assert.ok(!JSON.stringify(fixture.scheduler.status()).includes('private-canary'));
});
