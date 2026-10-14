import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { EventQuoteError } from './event-quote-contracts';
import { assertEventId } from './event-quote-workflow';
import type { EventQuoteIdentity, QuoteAccessTarget } from './event-quote-http';

/** Proof from an existing server-owned session adapter. This module never issues credentials. */
export type ExistingQuoteSession = Readonly<{ sessionToken: string; csrfToken: string }>;
const denied = () => new EventQuoteError('ACCESS_DENIED', 403);
const unauthenticated = () => new EventQuoteError('AUTHENTICATION_REQUIRED', 401);
const unavailable = () => new EventQuoteError('QUOTE_ACCESS_UNAVAILABLE', 503);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value);
const safe = (error: unknown) => error instanceof EventQuoteError ? error : unavailable();
type SessionRow = { organization_id: string; workspace_id: string; mode: string; actor_id: string; role: string;
  enabled: boolean; revoked: boolean; session_version: number; current_session_version: number;
  membership_version: number; current_membership_version: number; csrf_hash: string;
  expires_ms: string; membership_from_ms: string; membership_to_ms: string | null };
type GrantRow = { assigned_actor_id: string; version: number; assignment_version: number; active: boolean;
  enabled: boolean; can_write: boolean; can_approve: boolean; grant_from_ms: string; grant_to_ms: string | null };
function millis(value: unknown): number {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) throw unavailable();
  const number = Number(value); if (!Number.isSafeInteger(number)) throw unavailable(); return number;
}
function windowCheck(from: string, to: string | null, now: number): number {
  const start = millis(from), end = to === null ? Number.MAX_SAFE_INTEGER : millis(to);
  if (now < start || now >= end) throw denied(); return end;
}

/** Durable test_only access; no account/permission mutation methods and no automatic startup migration. */
export class PostgresQuoteAccessRepository {
  readonly schema: string;
  constructor(private readonly pool: Pool, options: { schema?: string; clock?: () => number } = {}) {
    this.schema = options.schema ?? 'gourmet_quote_access';
    if (!/^(gourmet_quote_access|quote_access_test_[a-f0-9]{32})$/.test(this.schema)) throw unavailable();
    this.clock = options.clock ?? Date.now;
  }
  private readonly clock: () => number;

  /** Only a fresh loopback test namespace; never the deployed/default schema. */
  async initializeTestSchema(): Promise<void> {
    if (!/^quote_access_test_[a-f0-9]{32}$/.test(this.schema)) throw unavailable();
    let host: string | undefined;
    try {
      if (this.pool.options.connectionString) {
        const url = new URL(this.pool.options.connectionString);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw unavailable();
        host = url.hostname;
      } else host = this.pool.options.host;
    } catch { throw unavailable(); }
    if (!host || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw unavailable();
    let client: PoolClient | undefined;
    try {
      const sql = (await readFile(new URL('../../../migrations/office/006_quote_access.up.sql', import.meta.url), 'utf8')).replaceAll('gourmet_quote_access', this.schema);
      client = await this.pool.connect(); await client.query('BEGIN'); await client.query(sql); await client.query('COMMIT');
    } catch { if (client) { try { await client.query('ROLLBACK'); } catch {} } throw unavailable(); }
    finally { client?.release(); }
  }

  async run<T>(proof: ExistingQuoteSession | null, target: QuoteAccessTarget,
    operation: (identity: EventQuoteIdentity, client: PoolClient) => Promise<T>): Promise<T> {
    if (!proof || !validToken(proof.sessionToken) || !validToken(proof.csrfToken)) throw unauthenticated();
    // Never retain mutable adapter inputs across an await, or store/log raw tokens.
    const tokenHash = hash(proof.sessionToken), csrfToken = proof.csrfToken, csrfHash = hash(csrfToken);
    const access = structuredClone(target);
    if (access.kind !== 'status') assertEventId(access.eventId);
    if (!['status', 'read', 'artifact', 'create', 'write', 'approve'].includes(access.kind)) throw denied();
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect(); await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await client.query<SessionRow>(`SELECT s.organization_id,s.workspace_id,s.mode,s.actor_id,u.role,u.enabled,
        (s.revoked_at IS NOT NULL) AS revoked,s.session_version,u.session_version AS current_session_version,
        s.membership_version,m.version AS current_membership_version,s.csrf_hash,
        (extract(epoch FROM s.expires_at)*1000)::bigint::text AS expires_ms,
        (extract(epoch FROM m.effective_from)*1000)::bigint::text AS membership_from_ms,
        (extract(epoch FROM m.effective_to)*1000)::bigint::text AS membership_to_ms
        FROM ${this.schema}.sessions s
        JOIN ${this.schema}.users u USING (organization_id,workspace_id,mode,actor_id)
        JOIN ${this.schema}.memberships m ON m.id=s.membership_id AND m.organization_id=s.organization_id
          AND m.workspace_id=s.workspace_id AND m.mode=s.mode AND m.actor_id=s.actor_id
        WHERE s.token_hash=$1 FOR SHARE OF s,u,m`, [tokenHash]);
      const row = result.rows[0], startedAt = this.clock();
      if (!Number.isSafeInteger(startedAt)) throw unavailable();
      if (result.rows.length !== 1 || !row || row.mode !== 'test' || row.enabled !== true || row.revoked !== false
        || row.session_version !== row.current_session_version || row.membership_version !== row.current_membership_version
        || !Number.isSafeInteger(row.session_version) || row.session_version < 1
        || !Number.isSafeInteger(row.membership_version) || row.membership_version < 1
        || !/^[a-f0-9]{64}$/.test(row.csrf_hash) || !timingSafeEqual(Buffer.from(csrfHash), Buffer.from(row.csrf_hash))) throw unauthenticated();
      for (const value of [row.organization_id, row.workspace_id, row.actor_id]) assertEventId(value);
      let deadline = Math.min(millis(row.expires_ms), windowCheck(row.membership_from_ms, row.membership_to_ms, startedAt));
      if (deadline <= startedAt) throw unauthenticated();
      if (!['ADMIN','MANAGER','OPERATIONS','CLOSER'].includes(row.role)) throw denied();
      let canWrite = true, canApprove = ['ADMIN','MANAGER'].includes(row.role);
      if (access.kind !== 'status') {
        const grants = await client.query<GrantRow>(`SELECT a.assigned_actor_id,a.version,a.active,
          g.assignment_version,g.enabled,g.can_write,g.can_approve,
          (extract(epoch FROM g.effective_from)*1000)::bigint::text AS grant_from_ms,
          (extract(epoch FROM g.effective_to)*1000)::bigint::text AS grant_to_ms
          FROM ${this.schema}.assignments a JOIN ${this.schema}.event_grants g USING (organization_id,workspace_id,mode,event_id)
          WHERE a.organization_id=$1 AND a.workspace_id=$2 AND a.mode=$3 AND a.event_id=$4 AND g.actor_id=$5
          FOR SHARE OF a,g`, [row.organization_id, row.workspace_id, row.mode, access.eventId, row.actor_id]);
        const grant = grants.rows[0];
        if (grants.rows.length !== 1 || !grant || grant.active !== true || grant.enabled !== true
          || !Number.isSafeInteger(grant.version) || grant.version < 1 || grant.assignment_version !== grant.version
          || row.role === 'CLOSER' && grant.assigned_actor_id !== row.actor_id) throw denied();
        deadline = Math.min(deadline, windowCheck(grant.grant_from_ms, grant.grant_to_ms, this.clock()));
        canWrite = grant.can_write === true; canApprove = canApprove && grant.can_approve === true && canWrite;
        if (['create', 'write', 'approve'].includes(access.kind) && !canWrite || access.kind === 'approve' && !canApprove) throw denied();
      }
      const identity: EventQuoteIdentity = { scope: { organizationId: row.organization_id, workspaceId: row.workspace_id, mode: 'test' },
        actor: { actorId: row.actor_id, durable: true, canWrite, canApprove }, csrfToken, expiresAtMs: deadline };
      const value = await operation(identity, client);
      // Mutable authority rows remain locked through commit. Temporal expiry is
      // checked again after every business await, including queued event locks.
      const completedAt = this.clock();
      if (!Number.isSafeInteger(completedAt) || completedAt < startedAt || completedAt >= deadline) throw denied();
      await client.query('COMMIT'); return value;
    } catch (error) { if (client) { try { await client.query('ROLLBACK'); } catch {} } throw safe(error); }
    finally { client?.release(); }
  }
}
