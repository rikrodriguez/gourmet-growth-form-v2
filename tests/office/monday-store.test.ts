import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { MemoryMondayStore, MondayStoreError, MondayVault, MondayVaultError, PostgresMondayStore } from '../../src/office/backend/monday-store';
import type { MondaySealedRecord } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';

// Fixed, synthetic test bytes only. No runtime key, credentials or environment
// secrets are read or generated. The vault creates fresh encryption nonces.
const TEST_KEY = Buffer.alloc(32, 0x47);
const PRIVATE_MARKER = 'SYNTHETIC_OAUTH_VALUE_NOT_A_REAL_CREDENTIAL';
const value = () => ({ accessToken: PRIVATE_MARKER, refreshToken: 'SYNTHETIC_REFRESH_ONLY', account: { id: 'account-demo', scopes: ['boards:read', 'updates:read', 'me:read'] } });
const vaultError = (error: unknown) => error instanceof MondayVaultError && error.code === 'MONDAY_VAULT_INVALID' && error.message === error.code && !Object.hasOwn(error, 'cause');
const storeError = (code: string) => (error: unknown) => error instanceof MondayStoreError && error.code === code && error.message === code && !Object.hasOwn(error, 'cause');
function corrupt(encoded: string): string {
  const bytes = Buffer.from(encoded, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

describe('Monday vault with synthetic keys only', () => {
  it('seals JSON with independent nonces and never exposes plaintext in its persisted envelope', t => {
    const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('UNEXPECTED_MONDAY_NETWORK'); });
    const vault = new MondayVault(TEST_KEY);
    const input = value();
    const first = vault.seal(input, 'monday-test:connection-one');
    const second = vault.seal(input, 'monday-test:connection-one');
    assert.equal(first.version, 1); assert.equal(Buffer.from(first.iv, 'base64url').length, 12); assert.equal(Buffer.from(first.tag, 'base64url').length, 16);
    assert.notEqual(first.iv, second.iv); assert.notEqual(first.ciphertext, second.ciphertext);
    for (const envelope of [first, second]) {
      assert(!JSON.stringify(envelope).includes(PRIVATE_MARKER));
      assert.deepEqual(vault.open(envelope, 'monday-test:connection-one'), input);
      assert.deepEqual(vault.open(JSON.parse(JSON.stringify(envelope)), 'monday-test:connection-one'), input);
    }
    assert.equal(network.mock.callCount(), 0);
  });

  it('binds ciphertext to its record and callback rather than permitting cross-record reuse', () => {
    const vault = new MondayVault(TEST_KEY);
    const sealed = vault.seal(value(), 'monday-test:flow-one:callback-one');
    for (const binding of ['monday-test:flow-two:callback-one', 'monday-test:flow-one:callback-two', '', 'bad\nbinding']) assert.throws(() => vault.open(sealed, binding), vaultError);
    assert.deepEqual(vault.open(sealed, 'monday-test:flow-one:callback-one'), value());
  });

  it('rejects a wrong key, tampering and malformed envelopes with one sanitized error', () => {
    const vault = new MondayVault(TEST_KEY);
    const sealed = vault.seal(value(), 'monday-test:tamper');
    assert.throws(() => new MondayVault(Buffer.alloc(32, 0x58)).open(sealed, 'monday-test:tamper'), vaultError);
    for (const key of ['iv', 'ciphertext', 'tag'] as const) assert.throws(() => vault.open({ ...sealed, [key]: corrupt(sealed[key]) }, 'monday-test:tamper'), vaultError);
    for (const envelope of [null, [], { ...sealed, version: 2 }, { ...sealed, extra: PRIVATE_MARKER }, { ...sealed, tag: 'short' }, { ...sealed, iv: `${sealed.iv}=` }, { ...sealed, ciphertext: '' }]) assert.throws(() => vault.open(envelope, 'monday-test:tamper'), vaultError);
  });

  it('checks data descriptors without running getters or toJSON and refuses lossy or cyclic JSON', () => {
    const vault = new MondayVault(TEST_KEY);
    let reads = 0;
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads += 1; return PRIVATE_MARKER; } });
    const serializer = { toJSON() { reads += 1; return PRIVATE_MARKER; } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hidden = Object.defineProperty({}, 'length', { enumerable: false, value: 3 });
    const sparse = Array(2);
    for (const input of [getter, serializer, cycle, hidden, sparse, undefined, NaN, Infinity, 1n, new Date(), new Map(), { field: undefined }]) assert.throws(() => vault.seal(input, 'monday-test:data'), vaultError);
    const sealed = vault.seal({ ok: true }, 'monday-test:data');
    const envelopeGetter = Object.defineProperty({ ...sealed }, 'tag', { enumerable: true, get() { reads += 1; return sealed.tag; } });
    assert.throws(() => vault.open(envelopeGetter, 'monday-test:data'), vaultError);
    assert.equal(reads, 0);
    assert.deepEqual(vault.open(vault.seal(null, 'monday-test:null'), 'monday-test:null'), null);
  });

  it('copies its exact-length key and bounds plaintext without accepting an invalid key or binding', () => {
    for (const size of [0, 16, 31, 33]) assert.throws(() => new MondayVault(Buffer.alloc(size)), vaultError);
    const callerKey = Buffer.from(TEST_KEY);
    const vault = new MondayVault(callerKey);
    callerKey.fill(0);
    const sealed = vault.seal(value(), 'monday-test:key-copy');
    assert.deepEqual(new MondayVault(TEST_KEY).open(sealed, 'monday-test:key-copy'), value());
    assert.throws(() => vault.seal({ text: 'x'.repeat(1_048_576) }, 'monday-test:oversize'), vaultError);
    for (const binding of ['', 'x'.repeat(513), 'unsafe\u0000binding']) assert.throws(() => vault.seal(value(), binding), vaultError);
  });
});

describe('Monday compare-and-set memory contract', () => {
  it('creates, updates and conditionally deletes with revisions while isolating returned objects', async () => {
    const store = new MemoryMondayStore();
    const key = 'monday-test:memory';
    assert.equal(await store.read(key), null); assert.equal(await store.compareAndSet(key, null, null), true);
    const input = { nested: { attempt: 1 } };
    assert.equal(await store.compareAndSet(key, null, input), true);
    input.nested.attempt = 99;
    assert.equal(await store.compareAndSet(key, null, { attempt: 2 }), false);
    const first = (await store.read(key))!;
    assert(Number.isSafeInteger(first.revision) && first.revision > 0); assert.deepEqual(first.value, { nested: { attempt: 1 } });
    (first.value as { nested: { attempt: number } }).nested.attempt = 77;
    assert.deepEqual((await store.read(key))!.value, { nested: { attempt: 1 } });
    assert.equal(await store.compareAndSet(key, first.revision, { attempt: 2 }), true);
    const second = (await store.read(key))!;
    assert(second.revision > first.revision);
    assert.equal(await store.compareAndSet(key, first.revision, null), false);
    assert.equal(await store.compareAndSet(key, null, null), false);
    assert.equal(await store.compareAndSet(key, second.revision, null), true); assert.equal(await store.read(key), null);
    assert.equal(await store.compareAndSet(key, null, { attempt: 'recreated' }), true);
    const recreated = (await store.read(key))!;
    assert(recreated.revision > second.revision);
    assert.equal(await store.compareAndSet(key, first.revision, { attempt: 'obsolete-refresh' }), false);
    assert.equal(await store.compareAndSet(key, second.revision, null), false);
    assert.deepEqual(await store.read(key), recreated);
  });

  it('chooses one creator and one updater under concurrent CAS attempts', async () => {
    const store = new MemoryMondayStore();
    const key = 'monday-test:memory-race';
    const created = await Promise.all(Array.from({ length: 8 }, (_, attempt) => store.compareAndSet(key, null, { attempt })));
    assert.equal(created.filter(Boolean).length, 1);
    const first = (await store.read(key))!;
    const updated = await Promise.all(Array.from({ length: 8 }, (_, attempt) => store.compareAndSet(key, first.revision, { attempt })));
    const second = (await store.read(key))!;
    assert.equal(updated.filter(Boolean).length, 1); assert(second.revision > first.revision);
    const deleted = await Promise.all(Array.from({ length: 8 }, () => store.compareAndSet(key, second.revision, null)));
    assert.equal(deleted.filter(Boolean).length, 1); assert.equal(await store.read(key), null);
  });

  it('rejects invalid namespaces, revisions and executable data before persistence', async () => {
    const store = new MemoryMondayStore();
    for (const key of ['', 'monday-', 'other-test', 'Monday-test', 'monday-test secret', `monday-${'x'.repeat(114)}`, 'monday-test\n']) {
      await assert.rejects(store.read(key), storeError('MONDAY_STORE_INVALID_KEY'));
      await assert.rejects(store.compareAndSet(key, null, {}), storeError('MONDAY_STORE_INVALID_KEY'));
    }
    for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.compareAndSet('monday-test:bad-revision', revision, {}), storeError('MONDAY_STORE_INVALID_REVISION'));
    for (const input of [undefined, { undefined }, new Map(), { function() {} }]) await assert.rejects(store.compareAndSet('monday-test:bad-record', null, input), storeError('MONDAY_STORE_INVALID_RECORD'));
    const longest = `monday-${'x'.repeat(113)}`;
    assert.equal(await store.compareAndSet(longest, null, {}), true); assert.equal(longest.length, 120);
    assert.equal(await store.read('monday-test:bad-record'), null);
  });
});

describe('Monday SQL boundary without an external API', () => {
  it('uses one CAS statement and sanitizes database failures without retaining their details', async () => {
    let calls = 0;
    const pool = { async query() { calls += 1; throw new Error('SYNTHETIC_DATABASE_PRIVATE_FAILURE_DETAIL'); } } as unknown as Pool;
    const store = new PostgresMondayStore(pool);
    await assert.rejects(store.read('monday-test:failed-read'), storeError('MONDAY_STORE_UNAVAILABLE')); assert.equal(calls, 1);
    await assert.rejects(store.compareAndSet('monday-test:failed-create', null, {}), storeError('MONDAY_STORE_UNAVAILABLE')); assert.equal(calls, 2);
    await assert.rejects(store.compareAndSet('monday-test:failed-update', 1, {}), storeError('MONDAY_STORE_UNAVAILABLE')); assert.equal(calls, 3);
    await assert.rejects(store.compareAndSet('monday-test:failed-delete', 1, null), storeError('MONDAY_STORE_UNAVAILABLE')); assert.equal(calls, 4);
    await assert.rejects(store.compareAndSet('wrong-prefix', null, {}), storeError('MONDAY_STORE_INVALID_KEY')); assert.equal(calls, 4);
  });
});

const AT = Date.parse('2026-10-11T20:00:00.000Z');
const stateId = `monday_test_${randomUUID()}`;
const keys = new Set<string>();
let office: PostgresOfficeStore;
let store: PostgresMondayStore;
const testKey = () => { const key = `monday-test:${randomUUID()}`; keys.add(key); return key; };
async function independent(t: TestContext) {
  const connection = new PostgresOfficeStore({ stateId });
  t.after(() => connection.close());
  await connection.initialize(AT);
  return new PostgresMondayStore(connection.pool);
}

describe('Monday encrypted records on real PostgreSQL (requires office:db start)', () => {
  before(async () => { office = new PostgresOfficeStore({ stateId }); await office.initialize(AT); store = new PostgresMondayStore(office.pool); });
  after(async () => {
    try {
      for (const key of keys) {
        const record = await store.read(key);
        if (record) assert.equal(await store.compareAndSet(key, record.revision, null), true);
      }
    } finally { await office?.close(); }
  });

  it('persists only sealed bytes and reads the same encrypted value through another pool', async t => {
    const key = testKey();
    const vault = new MondayVault(TEST_KEY);
    const sealed = vault.seal(value(), key);
    assert.equal(await store.compareAndSet(key, null, sealed), true);
    const other = await independent(t);
    const read = (await other.read(key))!;
    assert(Number.isSafeInteger(read.revision) && read.revision > 0); assert.deepEqual(read.value, sealed); assert.deepEqual(vault.open(read.value, key), value());
    const persisted = await office.pool.query<{ encoded: string }>('SELECT payload::text AS encoded FROM office_demo.monday_private_records WHERE key=$1', [key]);
    assert.equal(persisted.rowCount, 1); assert(!persisted.rows[0].encoded.includes(PRIVATE_MARKER)); assert(!persisted.rows[0].encoded.includes('SYNTHETIC_REFRESH_ONLY'));
    assert.throws(() => vault.open(read.value, `${key}:different-callback`), vaultError);
  });

  it('serializes competing creates and updates across independent connections', async t => {
    const key = testKey();
    const other = await independent(t);
    const vault = new MondayVault(TEST_KEY);
    const payloads: MondaySealedRecord[] = Array.from({ length: 6 }, (_, attempt) => vault.seal({ attempt }, key));
    const creates = await Promise.all(payloads.map((record, index) => (index % 2 ? other : store).compareAndSet(key, null, record)));
    const first = (await store.read(key))!;
    assert.equal(creates.filter(Boolean).length, 1); assert(Number.isSafeInteger(first.revision) && first.revision > 0);
    const updates = await Promise.all(payloads.map((record, index) => (index % 2 ? other : store).compareAndSet(key, first.revision, record)));
    const second = (await other.read(key))!;
    assert.equal(updates.filter(Boolean).length, 1); assert(second.revision > first.revision);
    const winner = updates.findIndex(Boolean);
    assert.deepEqual(vault.open((await store.read(key))!.value, key), { attempt: winner });
  });

  it('survives pool replacement and makes stale revocation unable to delete a refreshed record', async () => {
    const key = testKey();
    const vault = new MondayVault(TEST_KEY);
    assert.equal(await store.compareAndSet(key, null, vault.seal({ stage: 'before-refresh', marker: PRIVATE_MARKER }, key)), true);
    const first = (await store.read(key))!;
    assert.equal(await store.compareAndSet(key, first.revision, vault.seal({ stage: 'after-refresh', marker: PRIVATE_MARKER }, key)), true);
    const refreshed = (await store.read(key))!;
    await office.close();
    office = new PostgresOfficeStore({ stateId }); await office.initialize(AT); store = new PostgresMondayStore(office.pool);
    const durable = (await store.read(key))!;
    assert.equal(durable.revision, refreshed.revision); assert(durable.revision > first.revision); assert.deepEqual(vault.open(durable.value, key), { stage: 'after-refresh', marker: PRIVATE_MARKER });
    assert.equal(await store.compareAndSet(key, first.revision, null), false); assert.deepEqual(await store.read(key), durable);
    assert.equal(await store.compareAndSet(key, durable.revision, null), true); assert.equal(await store.read(key), null);
  });

  it('conditionally cleans up one key without touching another encrypted connection', async t => {
    const removedKey = testKey(); const keptKey = testKey();
    const vault = new MondayVault(TEST_KEY);
    await store.compareAndSet(removedKey, null, vault.seal({ id: 'remove-demo' }, removedKey));
    await store.compareAndSet(keptKey, null, vault.seal({ id: 'keep-demo' }, keptKey));
    const kept = await store.read(keptKey);
    const other = await independent(t);
    const removed = (await store.read(removedKey))!;
    const results = await Promise.all([store.compareAndSet(removedKey, removed.revision, null), other.compareAndSet(removedKey, removed.revision, null)]);
    assert.equal(results.filter(Boolean).length, 1); assert.equal(await other.read(removedKey), null); assert.deepEqual(await other.read(keptKey), kept);
    assert.equal(await store.compareAndSet(removedKey, null, null), true); assert.equal(await store.compareAndSet(keptKey, null, null), false);
  });

  it('cannot revive revoked tokens or revoke a recreated key using an obsolete opaque revision', async t => {
    const key = testKey();
    const vault = new MondayVault(TEST_KEY);
    const other = await independent(t);
    await store.compareAndSet(key, null, vault.seal({ connection: 'obsolete-demo' }, key));
    const old = (await store.read(key))!;
    assert.equal(await other.compareAndSet(key, old.revision, null), true);
    await store.compareAndSet(key, null, vault.seal({ connection: 'recreated-demo' }, key));
    const recreated = (await other.read(key))!;
    assert(recreated.revision > old.revision);
    assert.equal(await other.compareAndSet(key, old.revision, old.value), false);
    assert.equal(await other.compareAndSet(key, old.revision, null), false);
    assert.deepEqual(await store.read(key), recreated);
    assert.deepEqual(vault.open(recreated.value, key), { connection: 'recreated-demo' });
  });
});
