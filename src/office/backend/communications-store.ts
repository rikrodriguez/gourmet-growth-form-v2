import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommunicationsLedger, CommunicationsScope, CommunicationsStore } from './communications-contracts';
import type { MondayStore, MondayVault } from './monday-store';

export type CommunicationsStoreErrorCode = 'COMMUNICATIONS_INVALID_SCOPE' | 'COMMUNICATIONS_INVALID_LEDGER' | 'COMMUNICATIONS_STORE_UNAVAILABLE';
export class CommunicationsStoreError extends Error {
  constructor(readonly code: CommunicationsStoreErrorCode) { super(code); this.name = 'CommunicationsStoreError'; }
}
function fail(code: CommunicationsStoreErrorCode = 'COMMUNICATIONS_INVALID_LEDGER'): never { throw new CommunicationsStoreError(code); }
const MAX_LEDGER_BYTES = 512 * 1024;
const MAX_EVENTS = 1000;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= Number.MAX_SAFE_INTEGER;
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);

// Detach plain finite JSON before reading any fields or invoking a serializer.
// Accessors, toJSON functions, sparse arrays and cycles are never executed.
function data(value: unknown, limit = MAX_LEDGER_BYTES, error: CommunicationsStoreErrorCode = 'COMMUNICATIONS_INVALID_LEDGER'): unknown {
  const ancestors = new Set<object>(); let nodes = 0;
  const visit = (current: unknown, depth: number) => {
    if (++nodes > 100_000 || depth > 32) fail(error);
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return;
    if (!current || typeof current !== 'object' || ancestors.has(current)) fail(error);
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail(error);
    const keys = Reflect.ownKeys(current);
    if (keys.length > 100_000 || array && keys.length !== current.length + 1) fail(error);
    ancestors.add(current);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || (!array || key !== 'length') && !descriptor.enumerable || array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) fail(error);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  };
  try {
    visit(value, 0);
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > limit) fail(error);
    return JSON.parse(encoded) as unknown;
  } catch { fail(error); }
}
type Row = Record<string, unknown>;
function row(value: unknown, fields?: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Row;
  if (fields && (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field)))) fail();
  return result;
}
function scope(raw: unknown): CommunicationsScope {
  try {
    const value = row(data(raw, 1024, 'COMMUNICATIONS_INVALID_SCOPE'), ['organizationId', 'actorId', 'partition', 'dataMode']);
    if (!token(value.organizationId) || !token(value.actorId) || value.partition !== 'external' || !['fixture', 'live'].includes(value.dataMode as string)) fail('COMMUNICATIONS_INVALID_SCOPE');
    return value as CommunicationsScope;
  } catch { fail('COMMUNICATIONS_INVALID_SCOPE'); }
}
export function communicationsStorageKey(raw: CommunicationsScope): string {
  const owner = scope(raw);
  return `monday-communications-${createHash('sha256').update(JSON.stringify([owner.organizationId, owner.actorId, owner.partition, owner.dataMode])).digest('hex')}`;
}
function ledger(raw: unknown, owner: CommunicationsScope): CommunicationsLedger {
  const value = row(data(raw), ['version', 'scope', 'revision', 'events']);
  let bound: CommunicationsScope;
  try { bound = scope(value.scope); } catch { fail(); }
  if (value.version !== 1 || !isDeepStrictEqual(bound, owner) || !positive(value.revision) || !Array.isArray(value.events) || value.events.length !== value.revision || value.events.length > MAX_EVENTS) fail();
  for (let index = 0; index < value.events.length; index++) {
    const event = row(value.events[index], ['revision', 'type', 'value']);
    if (event.revision !== index + 1 || !['snapshot', 'association', 'draft', 'approval'].includes(event.type as string)) fail();
    const payload = row(event.value);
    if (!token(payload.id)) fail();
    if (event.type === 'approval') {
      if (!token(payload.draftId) || !positive(payload.draftRevision) || typeof payload.draftDigest !== 'string' || !/^[a-f0-9]{64}$/.test(payload.draftDigest) || payload.approvedBy !== owner.actorId || !Number.isSafeInteger(payload.approvedAtMs) || (payload.approvedAtMs as number) < 0 || payload.status !== 'approved_unsent') fail();
    } else if (!positive(payload.revision) || typeof payload.digest !== 'string' || !/^[a-f0-9]{64}$/.test(payload.digest)) fail();
  }
  return value as CommunicationsLedger;
}

// Reuses the existing encrypted private-record table, caller-owned store and
// vault. Logical ledger revisions and the physical store CAS token are distinct.
// Semantic replay belongs to the communications service; this boundary enforces
// safe structure, exact scope, authenticated encryption and immutable history.
export function createCommunicationsStore(options: { scope: CommunicationsScope; store: MondayStore; vault: MondayVault }): CommunicationsStore {
  const owner = scope(options.scope); const key = communicationsStorageKey(owner); const aad = `communications:v1:${key}`;
  const physical = options.store; const vault = options.vault;
  async function read() {
    let raw: unknown;
    try { raw = await physical.read(key); } catch { fail('COMMUNICATIONS_STORE_UNAVAILABLE'); }
    if (raw === null) return null;
    const stored = row(data(raw, 1_048_576), ['revision', 'value']);
    if (!positive(stored.revision)) fail();
    let opened: unknown;
    try { opened = vault.open(stored.value, aad); } catch { fail(); }
    return { revision: stored.revision, ledger: ledger(opened, owner) };
  }
  return {
    read,
    async compareAndSet(expectedRevision, raw) {
      if (expectedRevision !== null && !positive(expectedRevision)) fail();
      const candidate = ledger(raw, owner);
      const current = await read();
      if ((current?.revision ?? null) !== expectedRevision) return false;
      if (current ? candidate.revision !== current.ledger.revision + 1 || !isDeepStrictEqual(current.ledger.events, candidate.events.slice(0, current.ledger.events.length)) : candidate.revision !== 1) fail();
      let sealed: unknown;
      try { sealed = vault.seal(candidate, aad); } catch { fail(); }
      try { return await physical.compareAndSet(key, expectedRevision, sealed); } catch { fail('COMMUNICATIONS_STORE_UNAVAILABLE'); }
    },
  };
}
