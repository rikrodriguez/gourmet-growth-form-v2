import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual, types } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { EventQuoteError, type EventQuoteRecord, type EventQuoteStore, type QuoteScope } from './event-quote-contracts';
import { assertEventId, assertEventQuoteRecord, assertQuoteScope, digest } from './event-quote-workflow';
import type { MondayVault } from './monday-store';

const MAX_RECORD_BYTES = 512 * 1024;
const NativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const invalid = () => new EventQuoteError('QUOTE_STORE_INVALID', 500);
const unavailable = () => new EventQuoteError('QUOTE_STORE_UNAVAILABLE', 503);
type DatabaseRow = {
  key: string; revision: number; payload: unknown; audit_digest: string;
  previous_audit_digest: string | null; receipt_digest: string; audit: unknown;
};

export function eventQuoteStorageKey(scope: QuoteScope, eventId: string): string {
  assertQuoteScope(scope); assertEventId(eventId);
  return `event-quote-${createHash('sha256').update(JSON.stringify([scope.organizationId, scope.workspaceId, scope.mode, eventId])).digest('hex')}`;
}
const binding = (key: string, revision: number) => `gourmet-event-quote:v1:${key}:${revision}`;

// Caller-owned Pool and vault only: this class never creates credentials, closes
// the pool, calls a provider or auto-migrates a deployed database.
export class PostgresEventQuoteStore implements EventQuoteStore {
  private readonly schema: string;
  private readonly vault: Pick<MondayVault, 'seal' | 'open'>;
  constructor(private readonly pool: Pool, options: { vault: Pick<MondayVault, 'seal' | 'open'>; schema?: string }) {
    this.schema = options.schema ?? 'gourmet_quotes';
    if (!/^(gourmet_quotes|quote_test_[a-f0-9]{32})$/.test(this.schema)) throw unavailable();
    this.vault = options.vault;
  }

  // Explicit bootstrap for a fresh isolated loopback test schema only. Normal
  // startup must use the separately reviewed prepared migration instead.
  async initialize(): Promise<void> {
    if (!/^quote_test_[a-f0-9]{32}$/.test(this.schema)) throw unavailable();
    let host: string | undefined;
    try {
      if (this.pool.options.connectionString) {
        const address = new URL(this.pool.options.connectionString);
        // pg supports query-string host overrides; do not let a loopback-looking
        // URL redirect this test-only bootstrap to another destination.
        if (!['postgres:', 'postgresql:'].includes(address.protocol) || address.search || address.hash) throw unavailable();
        host = address.hostname;
      } else host = this.pool.options.host;
    } catch { throw unavailable(); }
    if (!host || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw unavailable();
    let client: PoolClient | undefined;
    try {
      const sql = (await readFile(new URL('../../../migrations/office/005_event_quotes.up.sql', import.meta.url), 'utf8')).replaceAll('gourmet_quotes', this.schema);
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* Preserve a sanitized failure. */ } }
      throw unavailable();
    } finally { client?.release(); }
  }

  private selectSql(lock = false): string {
    return `SELECT e.key,e.revision,e.payload,e.audit_digest,e.previous_audit_digest,e.receipt_digest,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',a.revision,'digest',a.digest,
        'previousDigest',a.previous_digest,'receiptDigest',a.receipt_digest) ORDER BY a.revision)
        FROM ${this.schema}.audit_events a WHERE a.event_key=e.key),'[]'::jsonb) AS audit
      FROM ${this.schema}.events e WHERE e.key=$1${lock ? ' FOR UPDATE OF e' : ''}`;
  }

  private validateRow(scope: QuoteScope, eventId: string, key: string, row: DatabaseRow): EventQuoteRecord {
    try {
      if (row.key !== key || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 100) throw invalid();
      const record = this.vault.open(row.payload, binding(key, row.revision));
      assertEventQuoteRecord(record, scope, eventId);
      if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES || record.revision !== row.revision ||
          !Array.isArray(row.audit) || row.audit.length !== record.revision) throw invalid();
      for (let index = 0; index < record.revision; index++) {
        const expected = { revision: index + 1, digest: record.audit[index].digest,
          previousDigest: record.audit[index].previousDigest, receiptDigest: digest(record.receipts[index]) };
        if (!isDeepStrictEqual(row.audit[index], expected)) throw invalid();
      }
      const last = record.audit.at(-1)!;
      if (row.audit_digest !== last.digest || row.previous_audit_digest !== last.previousDigest ||
          row.receipt_digest !== digest(record.receipts.at(-1)!)) throw invalid();
      return record;
    } catch { throw invalid(); }
  }

  async read(scope: QuoteScope, eventId: string): Promise<EventQuoteRecord | null> {
    const key = eventQuoteStorageKey(scope, eventId);
    const owner = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, mode: scope.mode };
    try {
      const result = await this.pool.query<DatabaseRow>(this.selectSql(), [key]);
      if (!result.rows.length) return null;
      if (result.rows.length !== 1) throw invalid();
      return this.validateRow(owner, eventId, key, result.rows[0]);
    } catch (error) { throw safeError(error); }
  }

  async transact(scope: QuoteScope, eventId: string, change: (current: EventQuoteRecord | null) => EventQuoteRecord | Promise<EventQuoteRecord>): Promise<EventQuoteRecord> {
    const key = eventQuoteStorageKey(scope, eventId);
    // Detach identity before an asynchronous boundary; caller mutations must not
    // change either the namespace or authenticated record binding mid-operation.
    const owner = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, mode: scope.mode };
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Advisory lock covers concurrent creation of an absent event across pools.
      // A hash collision only serializes unrelated events, never combines them.
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [47001905, key]);
      const result = await client.query<DatabaseRow>(this.selectSql(true), [key]);
      if (result.rows.length > 1) throw invalid();
      const current = result.rows.length ? this.validateRow(owner, eventId, key, result.rows[0]) : null;
      // A callback may mutate its input. Preserve an independent history for the
      // prefix check so in-place edits cannot erase evidence of a rewrite.
      // Never await a direct candidate: Promise assimilation would execute a
      // hostile `then` getter before the plain-data validator could reject it.
      // Only ordinary native promises from trusted async callbacks are awaited;
      // subclasses and custom lookup hooks are rejected without invoking them.
      const changed: unknown = change(current ? structuredClone(current) : null);
      let candidate: unknown = changed;
      if (types.isPromise(changed)) {
        const constructor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor');
        const then = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'then');
        if (Object.getPrototypeOf(changed) !== nativePromisePrototype || Object.hasOwn(changed, 'constructor') || Object.hasOwn(changed, 'then') ||
            !constructor || !('value' in constructor) || constructor.value !== NativePromise ||
            !then || !('value' in then) || then.value !== nativePromiseThen) throw invalid();
        // Keep both database locks across asynchronous freshness checks. A
        // rejected promise uses the same rollback path as a synchronous throw.
        candidate = await changed;
      }
      assertEventQuoteRecord(candidate, owner, eventId);
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw invalid();
      const next = JSON.parse(serialized) as EventQuoteRecord;
      if (current && isDeepStrictEqual(current, next)) {
        await client.query('COMMIT');
        return next;
      }
      if (next.revision !== (current?.revision ?? 0) + 1 || next.revision > 100 || next.quotes.length > 20 ||
          next.audit.length !== next.revision || next.receipts.length !== next.revision) throw invalid();
      if (current) {
        for (const field of ['briefs', 'quotes', 'decisions', 'audit', 'receipts'] as const) {
          if (!isDeepStrictEqual(current[field], next[field].slice(0, current[field].length))) throw invalid();
        }
      }
      const last = next.audit.at(-1)!;
      if (last.previousDigest !== (current?.audit.at(-1)?.digest ?? null)) throw invalid();
      const payload = JSON.stringify(this.vault.seal(next, binding(key, next.revision)));
      const values = [key, next.revision, payload, last.digest, last.previousDigest, digest(next.receipts.at(-1)!)];
      if (current) {
        const updated = await client.query(`UPDATE ${this.schema}.events SET revision=$2,payload=$3::jsonb,
          audit_digest=$4,previous_audit_digest=$5,receipt_digest=$6 WHERE key=$1 AND revision=$7`, [...values, current.revision]);
        if (updated.rowCount !== 1) throw invalid();
      } else {
        await client.query(`INSERT INTO ${this.schema}.events(key,revision,payload,audit_digest,previous_audit_digest,receipt_digest)
          VALUES($1,$2,$3::jsonb,$4,$5,$6)`, values);
      }
      // SQL triggers append the immutable audit and receipt hashes atomically.
      await client.query('COMMIT');
      return next;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* Preserve a sanitized failure. */ } }
      throw safeError(error);
    } finally { client?.release(); }
  }
}

function safeError(error: unknown): EventQuoteError {
  return error instanceof EventQuoteError ? error : unavailable();
}
