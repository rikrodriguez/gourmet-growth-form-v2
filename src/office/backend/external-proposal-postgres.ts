import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { QuoteScope } from './event-quote-contracts';
import { assertEventId, assertQuoteScope } from './event-quote-workflow';
import type { MondayVault } from './monday-store';
import { ExternalProposalError, type ProposalAuthority, type ProposalRecord, type SyntheticProposalDocument } from './external-proposal';
import type { ProposalTarget } from '../external-proposal-contracts';
import { verifyExternalProposalResponse } from '../external-proposal-response';
import { historicalLeadKey, normalizeHistoricalLink } from './lead-link-history';

export type ProposalMapping = Pick<ProposalAuthority, 'bindingId' | 'leadVersionId' | 'eventVersionId' | 'source'>;
export type DurableProposalCase = {
  schemaVersion: 1; revision: number; scope: QuoteScope; actorId: string; target: ProposalTarget;
  mapping: ProposalMapping; documents: SyntheticProposalDocument[]; record: ProposalRecord | null;
};
export const proposalCaseKey = (scope: QuoteScope, actorId: string, target: ProposalTarget) => createHash('sha256').update(JSON.stringify([scope, actorId, target.leadId, target.eventId])).digest('hex');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = (key: string, revision: number) => `external-proposal:test:v1:${key}:${revision}`;
const fail = (): never => { throw new ExternalProposalError('PROPOSAL_STORE_INVALID'); };
const same = isDeepStrictEqual;
function exact(raw: unknown, keys: string[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !same(Object.keys(raw).sort(), [...keys].sort())) fail();
}

/** Encrypted synthetic cases only. All operations borrow the authorization
 * transaction's PoolClient; they never begin, commit, release or open a pool. */
export class PostgresExternalProposalRepository {
  readonly schema: string;
  constructor(private readonly pool: Pool, private readonly vault: Pick<MondayVault, 'seal' | 'open'>, schema: string) {
    if (!/^proposal_test_[a-f0-9]{32}$/.test(schema)) fail();
    this.schema = schema;
  }
  async initializeTestSchema(): Promise<void> {
    const url = new URL(this.pool.options.connectionString ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash) fail();
    // Reuse the existing encrypted aggregate + immutable audit layout, without
    // accepting EventQuoteRecord or changing any existing consumer/migration.
    const sql = (await readFile(new URL('../../../migrations/office/005_event_quotes.up.sql', import.meta.url), 'utf8'))
      .replaceAll('gourmet_quotes', this.schema).replaceAll('event-quote-', 'external-proposal-');
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query(sql); await client.query('COMMIT'); }
    catch { await client.query('ROLLBACK'); fail(); }
    finally { client.release(); }
  }
  async validate(value: DurableProposalCase): Promise<void> {
    exact(value, ['schemaVersion', 'revision', 'scope', 'actorId', 'target', 'mapping', 'documents', 'record']);
    assertQuoteScope(value.scope); assertEventId(value.actorId);
    exact(value.target, ['leadId', 'eventId', 'proposalId']);
    for (const id of Object.values(value.target)) assertEventId(id);
    if (value.schemaVersion !== 1 || value.scope.mode !== 'test' || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 100
      || !Array.isArray(value.documents) || !value.documents.length || value.documents.length > 20 || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) fail();
    exact(value.mapping, ['bindingId', 'leadVersionId', 'eventVersionId', 'source']);
    const versions = new Set<string>();
    for (const doc of value.documents) {
      exact(doc, ['scope', 'leadId', 'eventId', 'proposalId', 'provider', 'sourceVersion', 'content', 'evidenceRef', 'historicalLink']);
      const link = normalizeHistoricalLink(doc.historicalLink);
      if (doc.provider !== 'synthetic' || !same(doc.scope, value.scope) || doc.leadId !== value.target.leadId || doc.eventId !== value.target.eventId || doc.proposalId !== value.target.proposalId
        || typeof doc.sourceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(doc.sourceVersion) || versions.has(doc.sourceVersion)
        || typeof doc.evidenceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(doc.evidenceRef)
        || doc.content !== null && (typeof doc.content !== 'string' || !doc.content.trim() || Buffer.byteLength(doc.content) > 262144)
        || link.category !== 'quote' || link.status === 'quarantined' || historicalLeadKey(link.provenance) !== historicalLeadKey(value.mapping.source)) fail();
      versions.add(doc.sourceVersion);
    }
    const record = value.record;
    if (record === null) return;
    exact(record, ['revision', 'snapshots', 'approvals', 'receipts']);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > value.revision || !Array.isArray(record.receipts) || record.receipts.length !== record.revision
      || !Array.isArray(record.snapshots) || !record.snapshots.length || record.snapshots.length > record.revision || !Array.isArray(record.approvals) || record.approvals.length > record.revision) fail();
    const keys = new Set<string>(), reviews = new Set<string>();
    for (const receipt of record.receipts) {
      exact(receipt, ['key', 'inputDigest']);
      if (typeof receipt.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(receipt.key) || typeof receipt.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.inputDigest) || keys.has(receipt.key)) fail();
      keys.add(receipt.key);
    }
    let association = 0;
    for (const snapshot of record.snapshots) {
      if (snapshot.associationRevision <= association || !value.documents.some(d => d.sourceVersion === snapshot.sourceVersion && d.content === snapshot.content)) fail();
      association = snapshot.associationRevision; reviews.add(snapshot.reviewKey);
      await verifyExternalProposalResponse({ ...value.target, identityKey: value.actorId, scope: value.scope, revision: record.revision,
        expiresAtMs: Number.MAX_SAFE_INTEGER, canWrite: false, canApprove: false, snapshot,
        status: snapshot.content === null ? 'reference_only' : 'pending_internal_review', approval: null, externalEffectsEnabled: false },
      { target: value.target, identityKey: value.actorId, scope: value.scope }, () => Number.MAX_SAFE_INTEGER - 1);
    }
    const decisions = new Set<string>();
    for (const approval of record.approvals) {
      exact(approval, ['reviewKey', 'actorId', 'atMs', 'status']);
      if (!reviews.has(approval.reviewKey) || decisions.has(approval.reviewKey) || approval.actorId !== value.actorId || approval.status !== 'approved_internal_unsent'
        || !Number.isSafeInteger(approval.atMs) || approval.atMs < 0 || !record.snapshots.some(s => s.reviewKey === approval.reviewKey && s.sha256 !== null)) fail();
      decisions.add(approval.reviewKey);
    }
  }
  async load(client: PoolClient, scope: QuoteScope, actorId: string, target: ProposalTarget): Promise<DurableProposalCase | null> {
    const key = proposalCaseKey(scope, actorId, target), dbKey = `external-proposal-${key}`;
    await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [47001907, key]);
    const rows = await client.query(`SELECT e.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',a.revision,'digest',a.digest,'previousDigest',a.previous_digest,'receiptDigest',a.receipt_digest) ORDER BY a.revision)
      FROM ${this.schema}.audit_events a WHERE a.event_key=e.key),'[]'::jsonb) AS audit FROM ${this.schema}.events e WHERE key=$1 FOR UPDATE OF e`, [dbKey]);
    if (!rows.rows.length) return null;
    if (rows.rows.length !== 1) fail();
    const row = rows.rows[0], value = this.vault.open(row.payload, binding(key, row.revision)) as DurableProposalCase;
    await this.validate(value);
    if (!same(value.scope, scope) || value.actorId !== actorId || !same(value.target, target) || value.revision !== row.revision || row.audit_digest !== hash(value)
      || !Array.isArray(row.audit) || row.audit.length !== value.revision || row.audit.at(-1).digest !== row.audit_digest
      || row.audit.at(-1).receiptDigest !== row.receipt_digest || row.receipt_digest !== hash([value.documents.map(d => d.sourceVersion), value.record?.receipts ?? []])) fail();
    for (let i = 0; i < row.audit.length; i++) if (row.audit[i].revision !== i + 1 || row.audit[i].previousDigest !== (row.audit[i - 1]?.digest ?? null)) fail();
    return structuredClone(value);
  }
  async save(client: PoolClient, prior: DurableProposalCase | null, value: DurableProposalCase): Promise<void> {
    await this.validate(value);
    if (value.revision !== (prior?.revision ?? 0) + 1) fail();
    if (!prior && (value.documents.length !== 1 || value.record !== null)) fail();
    if (prior) {
      for (const field of ['scope', 'actorId', 'target', 'mapping'] as const) if (!same(value[field], prior[field])) fail();
      if (!same(prior.documents, value.documents.slice(0, prior.documents.length))) fail();
      if (prior.record) {
        const nextRecord = value.record;
        if (!nextRecord || nextRecord.revision < prior.record.revision) return fail();
        for (const field of ['snapshots', 'approvals', 'receipts'] as const) if (!same(prior.record[field], nextRecord[field].slice(0, prior.record[field].length))) fail();
      }
      const sourceChange = value.documents.length === prior.documents.length + 1 && same(value.record, prior.record);
      const reviewChange = same(value.documents, prior.documents) && value.record?.revision === (prior.record?.revision ?? 0) + 1;
      if (!sourceChange && !reviewChange) fail();
    }
    const key = proposalCaseKey(value.scope, value.actorId, value.target), dbKey = `external-proposal-${key}`;
    const payload = JSON.stringify(this.vault.seal(value, binding(key, value.revision)));
    // The reused trigger requires a new receipt digest on every source revision
    // too; bind the durable source generation without exposing any document.
    const values = [dbKey, value.revision, payload, hash(value), prior ? hash(prior) : null, hash([value.documents.map(d => d.sourceVersion), value.record?.receipts ?? []])];
    if (prior) {
      const result = await client.query(`UPDATE ${this.schema}.events SET revision=$2,payload=$3::jsonb,audit_digest=$4,previous_audit_digest=$5,receipt_digest=$6 WHERE key=$1 AND revision=$7`, [...values, prior.revision]);
      if (result.rowCount !== 1) throw new ExternalProposalError('PROPOSAL_SOURCE_CHANGED');
    } else await client.query(`INSERT INTO ${this.schema}.events(key,revision,payload,audit_digest,previous_audit_digest,receipt_digest) VALUES($1,$2,$3::jsonb,$4,$5,$6)`, values);
  }
  async assertCurrent(client: PoolClient, value: DurableProposalCase): Promise<void> {
    const key = proposalCaseKey(value.scope, value.actorId, value.target);
    const result = await client.query(`SELECT revision,audit_digest FROM ${this.schema}.events WHERE key=$1`, [`external-proposal-${key}`]);
    if (result.rows.length !== 1 || result.rows[0].revision !== value.revision || result.rows[0].audit_digest !== hash(value)) throw new ExternalProposalError('PROPOSAL_SOURCE_CHANGED');
  }
}
