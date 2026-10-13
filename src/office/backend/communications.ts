import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AccountData, Approval, Association, AttachmentData, Candidate, CommunicationsEvent, CommunicationsLedger, CommunicationsScope, CommunicationsStore, Coverage, ExactDraft, LeadData, Observation, SourceSnapshot, ThreadData } from './communications-contracts';

export class CommunicationsError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CommunicationsError'; }
}
function fail(code = 'invalid_request'): never { throw new CommunicationsError(code); }
const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 1000;
const POLICY = 'communications-exact-review-v1';
type Row = Record<string, unknown>;
type State = { snapshots: SourceSnapshot[]; associations: Association[]; drafts: ExactDraft[]; approvals: Approval[] };
export type WorkflowView = Omit<State, 'approvals'> & {
  revision: number; candidates: Candidate[];
  associationStates: Array<{ association: Association; current: boolean }>;
  approvals: Array<{ approval: Approval; current: boolean }>;
  outbox: Array<{ id: string; approvalId: string; draftId: string; draftRevision: number; draftDigest: string; status: 'approved_unsent' | 'stale'; dispatchEnabled: false }>;
  outboundEffects: 0;
};
// Copy inert JSON without evaluating getters, toJSON, custom iterators or cycles.
function inert(raw: unknown, maxBytes = MAX_BYTES): unknown {
  const ancestors = new Set<object>(); let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 32) fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object' || ancestors.has(v)) fail();
    const array = Array.isArray(v); const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
    const keys = Reflect.ownKeys(v); if (keys.length > 100000 || array && keys.length !== v.length + 1) fail();
    ancestors.add(v); const out: unknown[] | Row = array ? [] : Object.create(null);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== 'string' || !d || !('value' in d)) fail();
      if (array && key === 'length') continue;
      if (!d.enumerable || ['__proto__', 'prototype', 'constructor'].includes(key) || array && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
      Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(v); return out;
  };
  try { const v = copy(raw, 0); const encoded = JSON.stringify(v); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) fail(); return JSON.parse(encoded) as unknown; }
  catch { fail(); }
}
function row(v: unknown, required: string[], optional: string[] = []): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); const r = v as Row;
  if (required.some(k => !Object.hasOwn(r, k)) || Object.keys(r).some(k => !required.includes(k) && !optional.includes(k))) fail(); return r;
}
function str(v: unknown, max = 256, multiline = false, empty = false): string {
  if (typeof v !== 'string' || v.length > max || !empty && !v.trim() || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v)) fail(); return v;
}
function token(v: unknown): string { const s = str(v, 96); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s) || ['__proto__', 'prototype', 'constructor'].includes(s)) fail(); return s; }
function integer(v: unknown, minimum = 0): number { if (!Number.isSafeInteger(v) || (v as number) < minimum) fail(); return v as number; }
function time(v: unknown): number { const n = integer(v); if (n > 8_640_000_000_000_000) fail(); return n; }
function hash(v: unknown): string { const s = str(v, 64); if (!/^[a-f0-9]{64}$/.test(s)) fail(); return s; }
function canonical(v: unknown): string { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(',')}}`; return JSON.stringify(v); }
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function list<T>(v: unknown, parse: (item: unknown) => T, max = 100): T[] { if (!Array.isArray(v) || v.length > max) fail(); return v.map(parse); }
function unique<T>(v: T[]): T[] { if (new Set(v).size !== v.length) fail(); return v; }
export function normalizeContactEmail(v: unknown): string {
  const value = str(v, 320).trim().toLowerCase();
  const parts = value.split('@');
  if (value.length > 254 || parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || parts[0].includes('..') || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[1].split('.').length < 2 || parts[1].split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^[a-z]{2,63}$/.test(parts[1].split('.').at(-1)!)) fail(); return value;
}
const emails = (v: unknown) => unique(list(v, normalizeContactEmail, 30));
function date(v: unknown): string | null { if (v === null) return null; const s = str(v, 10); if (!/^\d{4}-\d\d-\d\d$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) fail(); return s; }
const nullable = (v: unknown, max = 500) => v === null ? null : str(v, max);
function coverage(v: unknown): Coverage { const r = row(v, ['scope', 'incoming', 'outgoing']); if (!['selected_thread', 'correspondence', 'incoming_notifications'].includes(r.scope as string) || !['complete', 'partial', 'unknown'].includes(r.incoming as string) || !['complete', 'partial', 'unknown'].includes(r.outgoing as string)) fail(); return r as Coverage; }
function attachment(v: unknown): AttachmentData { const r = row(v, ['id', 'filename', 'mimeType', 'sha256']); return { id: str(r.id, 256), filename: str(r.filename, 255), mimeType: str(r.mimeType, 128), sha256: r.sha256 === null ? null : hash(r.sha256) }; }
function attachments(v: unknown): AttachmentData[] { const result = list(v, attachment, 50); unique(result.map(a => a.id)); return result; }
function owner(raw: unknown): CommunicationsScope { try { const r = row(inert(raw, 1024), ['organizationId', 'actorId', 'partition', 'dataMode']); if (r.partition !== 'external' || !['fixture', 'live'].includes(r.dataMode as string)) fail(); return { organizationId: token(r.organizationId), actorId: token(r.actorId), partition: 'external', dataMode: r.dataMode as 'fixture' | 'live' }; } catch { fail('invalid_scope'); } }
const mailbox = (v: unknown): 'felipe' | 'info' => v === 'felipe' || v === 'info' ? v : fail();
function observation(raw: unknown): Observation {
  const r = row(inert(raw), ['kind', 'source', 'sourceKey', 'providerVersion', 'observedAtMs', 'data']);
  str(r.sourceKey, 512); str(r.providerVersion, 512); time(r.observedAtMs);
  if (r.kind === 'lead' && r.source === 'monday') {
    const d = row(r.data, ['boardId', 'itemId', 'displayName', 'email', 'phone', 'phoneCountry', 'eventDate', 'guestsText', 'eventTypeText', 'serviceStyleText', 'mappingVersion']);
    token(d.boardId); token(d.itemId); str(d.displayName, 500); nullable(d.phone, 40); nullable(d.phoneCountry, 2); date(d.eventDate); nullable(d.guestsText); nullable(d.eventTypeText); nullable(d.serviceStyleText); str(d.mappingVersion, 128);
    if (r.sourceKey !== `${d.boardId}:${d.itemId}` || d.phoneCountry !== null && !/^[A-Z]{2}$/.test(d.phoneCountry as string)) fail();
    d.email = d.email === null ? null : normalizeContactEmail(d.email);
  } else if (r.kind === 'event' && r.source === 'event_reference') {
    const d = row(r.data, ['eventId', 'leadItemId', 'eventDate', 'evidenceRef']); token(d.eventId); token(d.leadItemId); date(d.eventDate); str(d.evidenceRef, 256); if (r.sourceKey !== d.eventId) fail();
  } else if (r.kind === 'account' && r.source === 'gmail') {
    const d = row(r.data, ['mailbox', 'accountId', 'email', 'verified']); mailbox(d.mailbox); str(d.accountId, 256); d.email = normalizeContactEmail(d.email); if (d.verified !== true || r.sourceKey !== `${d.mailbox}:${d.accountId}`) fail();
  } else if (r.kind === 'thread' && r.source === 'gmail') {
    const d = row(r.data, ['mailbox', 'accountId', 'threadId', 'messages', 'coverage']); mailbox(d.mailbox); str(d.accountId, 256); str(d.threadId, 256); coverage(d.coverage);
    if (r.sourceKey !== `${d.mailbox}:${d.accountId}:${d.threadId}` || (d.coverage as Coverage).scope === 'incoming_notifications') fail();
    d.messages = list(d.messages, value => { const m = row(value, ['id', 'from', 'to', 'cc', 'subject', 'bodyText', 'attachments']); return { id: str(m.id, 256), from: emails(m.from), to: emails(m.to), cc: emails(m.cc), subject: str(m.subject, 8192, false, true), bodyText: str(m.bodyText, 128 * 1024, true, true), attachments: attachments(m.attachments) }; });
    if (!(d.messages as unknown[]).length) fail(); unique((d.messages as { id: string }[]).map(m => m.id));
  } else if (r.kind === 'voice' && r.source === 'voice_notification') {
    const d = row(r.data, ['mailbox', 'accountId', 'contactEmail', 'notificationId', 'incomingText', 'coverage']); mailbox(d.mailbox); str(d.accountId, 256); str(d.notificationId, 256); d.contactEmail = normalizeContactEmail(d.contactEmail); str(d.incomingText, 65536, true, true);
    if (r.sourceKey !== `${d.mailbox}:${d.accountId}:${d.notificationId}` || !isDeepStrictEqual(coverage(d.coverage), { scope: 'incoming_notifications', incoming: 'partial', outgoing: 'unknown' })) fail();
  } else fail();
  return r as Observation;
}
const sourceIdentity = (v: Observation) => canonical([v.kind, v.source, ...(v.kind === 'lead' ? [v.data.boardId, v.data.itemId] : v.kind === 'event' ? [v.data.eventId] : v.kind === 'account' ? [v.data.mailbox, v.data.accountId] : v.kind === 'thread' ? [v.data.mailbox, v.data.accountId, v.data.threadId] : [v.data.mailbox, v.data.accountId, v.data.notificationId])]);
type SourceIndex = { count: number; current: Map<string, SourceSnapshot>; byId: Map<string, SourceSnapshot>; candidates?: Candidate[]; candidateSets?: Map<string, string> };
const indexes = new WeakMap<State, SourceIndex>();
function sourceIndex(s: State): SourceIndex {
  let index = indexes.get(s); if (index?.count === s.snapshots.length) return index;
  const current = new Map<string, SourceSnapshot>(), byId = new Map<string, SourceSnapshot>();
  for (const v of s.snapshots) { current.set(sourceIdentity(v), v); byId.set(v.id, v); }
  index = { count: s.snapshots.length, current, byId }; indexes.set(s, index); return index;
}
function latestSources(s: State) { return [...sourceIndex(s).current.values()]; }
function latest<T extends { id: string }>(rows: T[], id: string): T | undefined { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === id) return rows[i]; return undefined; }
function source(s: State, id: string, kind: Observation['kind'], current = true): SourceSnapshot {
  const index = sourceIndex(s), v = index.byId.get(id); if (!v || v.kind !== kind) fail('association_mismatch');
  if (current && index.current.get(sourceIdentity(v))?.id !== id) fail('source_changed'); return v;
}
function candidates(s: State): Candidate[] {
  const index = sourceIndex(s); if (index.candidates) return index.candidates;
  const sources = [...index.current.values()]; const out: Candidate[] = [];
  const leads = sources.filter((v): v is SourceSnapshot & { kind: 'lead' } => v.kind === 'lead');
  const events = new Map<string, (SourceSnapshot & { kind: 'event' })[]>();
  const accounts = new Map<string, SourceSnapshot & { kind: 'account' }>();
  const threads = new Map<string, (SourceSnapshot & { kind: 'thread' })[]>();
  const leadBoards = new Map<string, Set<string>>(), counts = new Map<string, number>();
  for (const lead of leads) { const boards = leadBoards.get(lead.data.itemId) ?? new Set<string>(); boards.add(lead.data.boardId); leadBoards.set(lead.data.itemId, boards); }
  for (const value of sources) {
    if (value.kind === 'event') { const rows = events.get(value.data.leadItemId) ?? []; rows.push(value); events.set(value.data.leadItemId, rows); }
    if (value.kind === 'account') accounts.set(canonical([value.data.mailbox, value.data.accountId]), value);
    if (value.kind === 'thread') for (const email of new Set(value.data.messages.flatMap(m => [...m.from, ...m.to, ...m.cc]))) { const rows = threads.get(email) ?? []; rows.push(value); threads.set(email, rows); }
  }
  for (const lead of leads) if (lead.data.email && leadBoards.get(lead.data.itemId)?.size === 1) {
    for (const thread of threads.get(lead.data.email) ?? []) {
      const account = accounts.get(canonical([thread.data.mailbox, thread.data.accountId]));
      if (account && account.data.email !== lead.data.email) for (const event of events.get(lead.data.itemId) ?? []) {
        if (out.length >= 1000) fail('capacity_exceeded');
        out.push({ leadSnapshotId: lead.id, eventSnapshotId: event.id, accountSnapshotId: account.id, threadSnapshotId: thread.id, reason: 'exact_email', review: 'required' });
        counts.set(lead.data.email, (counts.get(lead.data.email) ?? 0) + 1);
      }
    }
  }
  const sets = new Map<string, string[]>();
  for (const c of out) { const email = (index.byId.get(c.leadSnapshotId)!.data as LeadData).email!; c.review = counts.get(email)! > 1 ? 'ambiguous' : 'required'; const rows = sets.get(email) ?? []; rows.push(canonical(c)); sets.set(email, rows); }
  index.candidates = out; index.candidateSets = new Map([...sets].map(([email, rows]) => [email, digest(rows.sort())])); return out;
}
const refs = ['leadSnapshotId', 'eventSnapshotId', 'accountSnapshotId', 'threadSnapshotId'] as const;
function candidateFor(s: State, r: Row): Candidate {
  for (const [index, key] of refs.entries()) source(s, token(r[key]), ['lead', 'event', 'account', 'thread'][index] as Observation['kind']);
  const match = candidates(s).find(c => refs.every(k => c[k] === r[k])); if (!match) fail('association_mismatch'); return match;
}
function relevantHistory(s: State, email: string | null): string[] {
  if (!email) return [];
  const leads = new Set(s.snapshots.filter(v => v.kind === 'lead' && v.data.email === email).map(v => (v.data as LeadData).itemId));
  const threads = s.snapshots.filter((v): v is SourceSnapshot & { kind: 'thread' } => v.kind === 'thread' && v.data.messages.some(m => [...m.from, ...m.to, ...m.cc].includes(email)));
  const accounts = new Set(threads.map(v => canonical([v.data.mailbox, v.data.accountId])));
  const threadIds = new Set(threads.map(v => v.id));
  return s.snapshots.filter(v => v.kind === 'lead' && v.data.email === email || v.kind === 'event' && leads.has(v.data.leadItemId) || v.kind === 'thread' && threadIds.has(v.id) || v.kind === 'account' && accounts.has(canonical([v.data.mailbox, v.data.accountId]))).map(v => v.digest);
}
function candidateSet(s: State, leadSnapshotId: string): string {
  const email = (source(s, leadSnapshotId, 'lead').data as LeadData).email; candidates(s);
  // Relevant evidence is append-only: making a later source irrelevant cannot
  // resurrect an approval that became stale before that change.
  return digest({ current: sourceIndex(s).candidateSets?.get(email ?? '') ?? digest([]), history: relevantHistory(s, email) });
}
function associationCurrent(s: State, a: Association): boolean { try { const c = candidateFor(s, a as unknown as Row); return latest(s.associations, a.id)?.digest === a.digest && a.candidateSetDigest === candidateSet(s, a.leadSnapshotId) && (c.review !== 'ambiguous' || a.ambiguityAcknowledged); } catch { return false; } }
function assertAssociation(s: State, a: Association) { if (!associationCurrent(s, a)) fail('source_changed'); }
function context(s: State, a: Association, policyVersion: string) {
  const lead = source(s, a.leadSnapshotId, 'lead').data as LeadData;
  const voice = s.snapshots.filter(v => v.kind === 'voice' && v.data.contactEmail === lead.email);
  return digest({ association: a, sources: refs.map(k => s.snapshots.find(v => v.id === a[k])), voice, policyVersion });
}
function fullCoverage(s: State, a: Association): boolean { const t = source(s, a.threadSnapshotId, 'thread').data as ThreadData; const lead = source(s, a.leadSnapshotId, 'lead').data as LeadData; return t.coverage.scope === 'correspondence' && t.coverage.incoming === 'complete' && t.coverage.outgoing === 'complete' && !s.snapshots.some(v => v.kind === 'voice' && v.data.contactEmail === lead.email); }
function draftCurrent(s: State, d: ExactDraft, policyVersion: string): boolean { const a = latest(s.associations, d.associationId); return !!a && associationCurrent(s, a) && a.digest === d.associationDigest && latest(s.drafts, d.id)?.digest === d.digest && d.policyVersion === policyVersion && d.contextDigest === context(s, a, policyVersion) && (d.purpose !== 'follow_up' || fullCoverage(s, a)); }
function associationValue(s: State, input: Row): Association {
  if (input.explicit !== true) fail('explicit_review_required'); const c = candidateFor(s, input);
  if (typeof input.ambiguityAcknowledged !== 'boolean') fail(); if (c.review === 'ambiguous' && !input.ambiguityAcknowledged) fail('ambiguous');
  const value = { id: token(input.id), revision: (latest(s.associations, token(input.id))?.revision ?? 0) + 1, candidateSetDigest: candidateSet(s, c.leadSnapshotId), leadSnapshotId: c.leadSnapshotId, eventSnapshotId: c.eventSnapshotId, accountSnapshotId: c.accountSnapshotId, threadSnapshotId: c.threadSnapshotId, evidenceRef: str(input.evidenceRef, 256), ambiguityAcknowledged: input.ambiguityAcknowledged };
  return { ...value, digest: digest(value) };
}
function draftValue(s: State, input: Row, policyVersion: string): ExactDraft {
  const id = token(input.id); const associationId = token(input.associationId); const a = latest(s.associations, associationId); if (!a) fail('association_mismatch'); assertAssociation(s, a);
  if (!['reply', 'follow_up'].includes(input.purpose as string)) fail(); if (input.purpose === 'follow_up' && !fullCoverage(s, a)) fail('coverage_incomplete');
  const to = emails(input.to), cc = emails(input.cc), bcc = input.bcc === undefined ? [] : emails(input.bcc); if (!to.length) fail(); unique([...to, ...cc, ...bcc]);
  const lead = source(s, a.leadSnapshotId, 'lead').data as LeadData; const thread = source(s, a.threadSnapshotId, 'thread').data as ThreadData; const account = source(s, a.accountSnapshotId, 'account').data as AccountData;
  const known = new Set(thread.messages.flatMap(m => [...m.from, ...m.to, ...m.cc]).filter(e => e !== account.email));
  if (!lead.email || !to.includes(lead.email) || [...to, ...cc, ...bcc].some(e => !known.has(e))) fail('recipient_mismatch');
  const value = { id, revision: (latest(s.drafts, id)?.revision ?? 0) + 1, associationId, associationDigest: a.digest, contextDigest: context(s, a, policyVersion), policyVersion, purpose: input.purpose as 'reply' | 'follow_up', to, cc, bcc, subject: str(input.subject, 8192), bodyText: str(input.bodyText, 65536, true), bodyHtml: input.bodyHtml === undefined || input.bodyHtml === null ? null : str(input.bodyHtml, 128 * 1024, true), attachments: attachments(input.attachments) };
  return { ...value, digest: digest(value) };
}
function sameVersioned(a: Association | ExactDraft, b: Association | ExactDraft): boolean { const { revision: _ar, digest: _ad, ...av } = a; const { revision: _br, digest: _bd, ...bv } = b; return isDeepStrictEqual(av, bv); }
function snapshotValue(s: State, input: Observation): SourceSnapshot | null {
  const prior = s.snapshots.filter(v => sourceIdentity(v) === sourceIdentity(input)); const same = prior.find(v => v.providerVersion === input.providerVersion);
  if (same) { const { id: _id, revision: _rev, digest: _dg, observedAtMs: _at, ...before } = same; const { observedAtMs: _now, ...after } = input; if (!isDeepStrictEqual(before, after)) fail('source_version_conflict'); return null; }
  const value = { ...input, id: `snapshot-${digest([sourceIdentity(input), input.providerVersion]).slice(0, 40)}`, revision: (prior.at(-1)?.revision ?? 0) + 1 };
  return { ...value, digest: digest(value) };
}
function project(s: State, revision: number, policyVersion: string): WorkflowView {
  const approvals = s.approvals.map(approval => { const d = latest(s.drafts, approval.draftId); return { approval, current: !!d && d.revision === approval.draftRevision && d.digest === approval.draftDigest && draftCurrent(s, d, policyVersion) }; });
  return structuredClone({ snapshots: s.snapshots, associations: s.associations, drafts: s.drafts, revision, candidates: candidates(s), associationStates: s.associations.map(association => ({ association, current: associationCurrent(s, association) })), approvals, outbox: approvals.map(({ approval, current }) => ({ id: `outbox-${digest([approval.draftId, approval.draftRevision, approval.draftDigest]).slice(0, 40)}`, approvalId: approval.id, draftId: approval.draftId, draftRevision: approval.draftRevision, draftDigest: approval.draftDigest, status: current ? 'approved_unsent' as const : 'stale' as const, dispatchEnabled: false as const })), outboundEffects: 0 as const });
}

export function createCommunicationsWorkflow(options: { scope: CommunicationsScope; store: CommunicationsStore; clock?: () => number; policyVersion?: string }) {
  const scope = owner(options.scope); const store = options.store; const policyVersion = token(options.policyVersion ?? POLICY); const clock = options.clock ?? Date.now;
  const empty = (): CommunicationsLedger => ({ version: 1, scope: structuredClone(scope), revision: 0, events: [] });
  function replay(ledger: CommunicationsLedger): State {
    const s: State = { snapshots: [], associations: [], drafts: [], approvals: [] };
    try {
      row(ledger, ['version', 'scope', 'revision', 'events']); if (ledger.version !== 1 || !isDeepStrictEqual(owner(ledger.scope), scope) || integer(ledger.revision) !== ledger.events.length || ledger.events.length > MAX_EVENTS) fail();
      for (const [index, event] of ledger.events.entries()) {
        row(event, ['revision', 'type', 'value']); if (event.revision !== index + 1) fail();
        const r = event.value as unknown as Row;
        if (event.type === 'snapshot') {
          row(r, ['kind', 'source', 'sourceKey', 'providerVersion', 'observedAtMs', 'data', 'id', 'revision', 'digest']); const { id: _id, revision: _rev, digest: _digest, ...o } = r; const expected = snapshotValue(s, observation(o)); if (!expected || !isDeepStrictEqual(expected, r)) fail(); s.snapshots.push(expected);
        } else if (event.type === 'association') {
          row(r, ['id', 'revision', 'digest', 'candidateSetDigest', ...refs, 'evidenceRef', 'ambiguityAcknowledged']); const expected = associationValue(s, { ...r, explicit: true }); if (!isDeepStrictEqual(expected, r)) fail(); s.associations.push(expected);
        } else if (event.type === 'draft') {
          row(r, ['id', 'revision', 'digest', 'associationId', 'associationDigest', 'contextDigest', 'policyVersion', 'purpose', 'to', 'cc', 'bcc', 'subject', 'bodyText', 'bodyHtml', 'attachments']); const expected = draftValue(s, r, token(r.policyVersion)); if (!isDeepStrictEqual(expected, r)) fail(); s.drafts.push(expected);
        } else if (event.type === 'approval') {
          row(r, ['id', 'draftId', 'draftRevision', 'draftDigest', 'approvedBy', 'approvedAtMs', 'status']); token(r.id); time(r.approvedAtMs);
          const d = latest(s.drafts, token(r.draftId)); if (!d || d.revision !== r.draftRevision || d.digest !== r.draftDigest || !draftCurrent(s, d, d.policyVersion) || d.attachments.some(a => a.sha256 === null) || r.approvedBy !== scope.actorId || r.status !== 'approved_unsent' || s.approvals.some(a => a.id === r.id || a.draftId === r.draftId && a.draftRevision === r.draftRevision && a.draftDigest === r.draftDigest)) fail(); s.approvals.push(r as unknown as Approval);
        } else fail();
      }
      return s;
    } catch { fail('invalid_state'); }
  }
  async function read() {
    let raw: unknown; try { raw = await store.read(); } catch { fail('store_unavailable'); }
    if (raw === null) { const ledger = empty(); return { physical: null, ledger, state: replay(ledger) }; }
    try { const r = row(inert(raw, MAX_BYTES + 1024), ['revision', 'ledger']); const ledger = inert(r.ledger) as CommunicationsLedger; return { physical: integer(r.revision, 1), ledger, state: replay(ledger) }; } catch { fail('invalid_state'); }
  }
  async function change(raw: unknown, fields: string[], optional: string[], operation: (s: State, r: Row) => Omit<CommunicationsEvent, 'revision'> | null) {
    const input = row(inert(raw), ['expectedRevision', ...fields], optional); const expected = integer(input.expectedRevision); const value = await read(); if (value.ledger.revision !== expected) fail('revision_conflict');
    const event = operation(value.state, input); if (!event) return project(value.state, value.ledger.revision, policyVersion);
    if (value.ledger.events.length >= MAX_EVENTS) fail('capacity_exceeded');
    const ledger: CommunicationsLedger = { ...value.ledger, revision: value.ledger.revision + 1, events: [...value.ledger.events, { ...event, revision: value.ledger.revision + 1 } as CommunicationsEvent] };
    const detached = inert(ledger) as CommunicationsLedger; const state = replay(detached); const view = project(state, detached.revision, policyVersion);
    let ok: boolean; try { ok = await store.compareAndSet(value.physical, detached); } catch { fail('store_unavailable'); } if (!ok) fail('revision_conflict'); return view;
  }
  return {
    async view(): Promise<WorkflowView> { const value = await read(); return project(value.state, value.ledger.revision, policyVersion); },
    recordObservation(input: unknown): Promise<WorkflowView> { return change(input, ['observation'], [], (s, r) => { const v = snapshotValue(s, observation(r.observation)); return v ? { type: 'snapshot', value: v } : null; }); },
    link(input: unknown): Promise<WorkflowView> { return change(input, ['id', ...refs, 'explicit', 'evidenceRef', 'ambiguityAcknowledged'], ['reason', 'review'], (s, r) => { if (r.reason !== undefined && r.reason !== 'exact_email' || r.review !== undefined && !['required', 'ambiguous'].includes(r.review as string)) fail(); const a = associationValue(s, r); const prior = latest(s.associations, a.id); return prior && sameVersioned(prior, a) ? null : { type: 'association', value: a }; }); },
    saveDraft(input: unknown): Promise<WorkflowView> { return change(input, ['id', 'associationId', 'purpose', 'to', 'cc', 'subject', 'bodyText', 'attachments'], ['bcc', 'bodyHtml'], (s, r) => { const d = draftValue(s, r, policyVersion); const prior = latest(s.drafts, d.id); return prior && sameVersioned(prior, d) ? null : { type: 'draft', value: d }; }); },
    approve(input: unknown): Promise<WorkflowView> { return change(input, ['id', 'draftId', 'draftRevision', 'draftDigest'], [], (s, r) => {
      const id = token(r.id); const draftId = token(r.draftId); integer(r.draftRevision, 1); hash(r.draftDigest); const d = latest(s.drafts, draftId); if (!d || d.revision !== r.draftRevision || d.digest !== r.draftDigest) fail('draft_changed');
      if (!draftCurrent(s, d, policyVersion)) fail('source_changed'); if (d.attachments.some(a => a.sha256 === null)) fail('attachment_unverified');
      const prior = s.approvals.find(a => a.id === id); if (prior && (prior.draftId !== draftId || prior.draftRevision !== d.revision || prior.draftDigest !== d.digest)) fail('idempotency_conflict');
      if (prior || s.approvals.some(a => a.draftId === draftId && a.draftRevision === d.revision && a.draftDigest === d.digest)) return null;
      return { type: 'approval', value: { id, draftId, draftRevision: d.revision, draftDigest: d.digest, approvedBy: scope.actorId, approvedAtMs: time(clock()), status: 'approved_unsent' } };
    }); },
  };
}
