import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { CanonicalBridge, CanonicalBridgeError, validateCanonicalBridgeStoredValue } from './canonical-bridge';
import type { BridgeSourcePolicy, CanonicalBridgeStore } from '../canonical-bridge-contracts';

type ValidatedLedger = Awaited<ReturnType<typeof validateCanonicalBridgeStoredValue>>;
type DatabaseRow = {
  key: string; organization_id: string; actor_id: string; partition: string;
  revision: number; payload: unknown; audit: unknown;
};
const unavailable = () => new CanonicalBridgeError('BRIDGE_STORE_UNAVAILABLE');
const invalid = () => new CanonicalBridgeError('BRIDGE_STATE_INVALID');
const validKey = (key: string) => typeof key === 'string' && /^bridge-[a-f0-9]{64}$/.test(key);
const validRevision = (value: number | null) => value === null || Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;

// Uses a caller-owned, already configured Pool. It neither applies migrations
// nor imports data, chooses source policy, opens a second DB or closes the pool.
export class PostgresCanonicalBridgeStore implements CanonicalBridgeStore {
  private readonly schema: string;
  private readonly sources: readonly BridgeSourcePolicy[];
  constructor(private readonly pool: Pool, options: { sources: readonly BridgeSourcePolicy[]; schema?: string }) {
    this.schema = options.schema ?? 'office_canonical_bridge';
    if (!/^(office_canonical_bridge|bridge_test_[a-f0-9]{32})$/.test(this.schema)) throw unavailable();
    // Reuse the core's strict source-registry validation before detaching it.
    // The synthetic schema override is confined to isolated loopback tests.
    new CanonicalBridge({ read: async () => null, compareAndSet: async () => false }, { sources: options.sources });
    this.sources = JSON.parse(JSON.stringify(options.sources)) as BridgeSourcePolicy[];
  }

  private selectSql(lock = false): string {
    return `SELECT w.key,w.organization_id,w.actor_id,w.partition,w.revision,w.payload,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'organizationId',a.organization_id,'actorId',a.actor_id,'partition',a.partition,
        'revision',a.revision,'logicalRevision',a.logical_revision,'digest',a.digest,
        'eventAtMs',a.event_at_ms::text,'committedAt',a.committed_at,'event',a.event_record
      ) ORDER BY a.revision) FROM ${this.schema}.audit_events a WHERE a.workspace_key=w.key),'[]'::jsonb) AS audit
      FROM ${this.schema}.workspaces w WHERE w.key=$1${lock ? ' FOR UPDATE OF w' : ''}`;
  }

  private async validateRow(key: string, row: DatabaseRow): Promise<ValidatedLedger> {
    const value = await validateCanonicalBridgeStoredValue(key, row.payload, { sources: this.sources });
    if (row.key !== key || row.organization_id !== value.scope.organizationId || row.actor_id !== value.scope.actorId || row.partition !== value.scope.partition || row.revision !== value.revision || !Array.isArray(row.audit) || row.audit.length !== value.revision) throw invalid();
    for (let index = 0; index < row.audit.length; index++) {
      const audit = row.audit[index] as Record<string, unknown>;
      if (!audit || typeof audit !== 'object' || Array.isArray(audit) ||
        audit.organizationId !== value.scope.organizationId || audit.actorId !== value.scope.actorId || audit.partition !== value.scope.partition ||
        audit.revision !== index + 1 || audit.logicalRevision !== index + 1 || audit.digest !== value.events[index].digest ||
        audit.eventAtMs !== String(value.events[index].atMs) || typeof audit.committedAt !== 'string' || !Number.isFinite(Date.parse(audit.committedAt)) ||
        !isDeepStrictEqual(audit.event, value.events[index])) throw invalid();
    }
    return value;
  }

  async read(key: string): Promise<{ revision: number; value: unknown } | null> {
    if (!validKey(key)) throw unavailable();
    try {
      const result = await this.pool.query<DatabaseRow>(this.selectSql(), [key]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw invalid();
      const value = await this.validateRow(key, result.rows[0]);
      return { revision: result.rows[0].revision, value: value.value };
    } catch (error) { throw safeError(error); }
  }

  async compareAndSet(key: string, expectedRevision: number | null, value: unknown): Promise<boolean> {
    if (!validKey(key) || !validRevision(expectedRevision)) throw unavailable();
    // Detach and replay the entire candidate before acquiring a connection.
    // In particular, getters and executable serializers never reach pg.
    const candidate = await validateCanonicalBridgeStoredValue(key, value, { sources: this.sources });
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Serialize the absent-row case as well as updates, across independent
      // pools. Hash collisions only serialize unrelated keys; they cannot join.
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [47001904, key]);
      const stored = await client.query<DatabaseRow>(this.selectSql(true), [key]);
      if (stored.rows.length > 1) throw invalid();
      const current = stored.rows[0];
      if ((current?.revision ?? null) !== expectedRevision) {
        await client.query('ROLLBACK');
        return false;
      }
      if (current) {
        const previous = await this.validateRow(key, current);
        if (candidate.revision !== previous.revision + 1 || !isDeepStrictEqual(previous.events, candidate.events.slice(0, previous.events.length))) throw invalid();
        await client.query(`UPDATE ${this.schema}.workspaces SET revision=revision+1,payload=$2::jsonb WHERE key=$1 AND revision=$3`, [key, JSON.stringify(candidate.value), expectedRevision]);
      } else {
        if (candidate.revision !== 1) throw invalid();
        await client.query(`INSERT INTO ${this.schema}.workspaces(key,organization_id,actor_id,partition,revision,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)`, [key, candidate.scope.organizationId, candidate.scope.actorId, candidate.scope.partition, JSON.stringify(candidate.value)]);
      }
      // The SQL trigger appends scope/revision/digest/time and exact event to
      // immutable audit in this transaction. Audit failure rolls back the CAS.
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* Keep only the sanitized original failure. */ } }
      throw safeError(error);
    } finally { client?.release(); }
  }
}

function safeError(error: unknown): CanonicalBridgeError {
  return error instanceof CanonicalBridgeError && ['BRIDGE_STATE_INVALID', 'BRIDGE_STORE_UNAVAILABLE'].includes(error.code) ? error : unavailable();
}
