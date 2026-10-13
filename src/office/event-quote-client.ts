import type { BriefInput, CatalogSnapshot, EventQuoteView, QuoteCommand, QuoteVersion } from './backend/event-quote-contracts';
import type { EventQuoteStatusResponse } from './backend/event-quote-http';
export type { EventQuoteStatusResponse } from './backend/event-quote-http';

// Browser-only transport. Identity, scope and catalogue prices are never supplied by the caller.
export const EVENT_QUOTE_API = '/api/office/event-quotes';
export const EVENT_QUOTE_CSRF_HEADER = 'x-event-quote-csrf';
export class EventQuoteClientError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) { super(code); this.name = 'EventQuoteClientError'; }
}
const invalid = (): never => { throw new EventQuoteClientError('INVALID_RESPONSE'); };
function row(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, max = 16_384): void { if (typeof value !== 'string' || value.length > max) invalid(); }
function integer(value: unknown, min = 0): void { if (!Number.isSafeInteger(value) || (value as number) < min) invalid(); }
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function list(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 10_000) invalid(); return value as unknown[]; }
function catalog(value: unknown): void {
  const c = row(value); ['id', 'version', 'approvalRef', 'source', 'terms'].forEach(key => text(c[key]));
  if (!['test_only', 'owner_authorized'].includes(c.authority as string) || c.currency !== 'USD') invalid();
  integer(c.validUntilMs); integer(c.taxBps); integer(c.depositBps);
  if ((c.taxBps as number) > 10_000 || (c.depositBps as number) > 10_000) invalid();
  list(c.items).forEach(value => { const item = row(value); ['id', 'label', 'unit'].forEach(key => text(item[key], 512)); integer(item.unitPriceCents); });
}
export function validateQuoteStatus(value: unknown): EventQuoteStatusResponse {
  const s = row(value), session = row(s.session);
  if (typeof s.enabled !== 'boolean' || s.externalEffectsEnabled !== false || (s.reason !== null && typeof s.reason !== 'string')) invalid();
  if (s.catalog !== null) catalog(s.catalog);
  if (s.catalogDigest !== null) digest(s.catalogDigest);
  if (s.enabled && (!s.catalog || !s.catalogDigest)) invalid();
  if (!['test', 'commercial'].includes(session.mode as string) || typeof session.canWrite !== 'boolean' || typeof session.canApprove !== 'boolean') invalid();
  if (typeof session.csrfToken !== 'string' || !/^[a-zA-Z0-9_-]{16,512}$/.test(session.csrfToken)) invalid();
  integer(session.expiresAtMs, 1);
  if (session.mode === 'commercial' && s.catalog !== null && (s.catalog as CatalogSnapshot).authority !== 'owner_authorized') invalid();
  return value as EventQuoteStatusResponse;
}
export function validateQuoteView(value: unknown, expectedEventId: string): EventQuoteView {
  const v = row(value), record = row(v.record), scope = row(record.scope);
  if (v.externalEffectsEnabled !== false || !['missing', 'pending_internal_review', 'approved_internal_unsent', 'obsolete'].includes(v.currentQuoteStatus as string)) invalid();
  if (record.schemaVersion !== 1 || record.eventId !== expectedEventId || !['test', 'commercial'].includes(scope.mode as string)) invalid();
  text(scope.organizationId, 128); text(scope.workspaceId, 128); integer(record.revision, 1);
  list(record.briefs).forEach(value => {
    const b = row(value); ['contactName', 'recipient', 'originalMessage', 'proposedDate', 'proposedLocation', 'requirements', 'actorId'].forEach(key => text(b[key]));
    integer(b.attendees, 1); integer(b.version, 1); integer(b.createdAtMs); digest(b.digest);
    if (b.provenance !== 'manual_intake' || b.reservationStatus !== 'unconfirmed') invalid();
  });
  list(record.quotes).forEach(value => {
    const q = row(value); integer(q.version, 1); integer(q.briefVersion, 1); integer(q.createdAtMs); text(q.actorId);
    if (q.eventId !== expectedEventId || q.financialMeaning !== 'unaccepted_quote' || q.currency !== 'USD') invalid();
    ['briefDigest', 'catalogDigest', 'digest'].forEach(key => digest(q[key])); catalog(q.catalog);
    ['subtotalCents', 'taxCents', 'totalCents', 'depositCents'].forEach(key => integer(q[key]));
    list(q.lines).forEach(value => { const line = row(value); ['catalogItemId', 'label', 'unit'].forEach(key => text(line[key], 512)); integer(line.qty, 1); integer(line.unitPriceCents); });
    const a = row(q.artifact); text(a.html, 1_048_576); digest(a.sha256); integer(a.bytes, 1);
    if (a.mediaType !== 'text/html; charset=utf-8') invalid();
  });
  list(record.decisions).forEach(value => { const d = row(value); if (d.status !== 'approved_internal_unsent') invalid(); integer(d.quoteVersion, 1); integer(d.atMs); ['id', 'actorId', 'intendedRecipient'].forEach(key => text(d[key])); ['quoteDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'digest'].forEach(key => digest(d[key])); });
  list(record.audit); list(record.receipts);
  return value as EventQuoteView;
}
function path(eventId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(eventId) || ['status', 'constructor', 'prototype', '__proto__'].includes(eventId)) throw new EventQuoteClientError('INVALID_EVENT_ID');
  return `${EVENT_QUOTE_API}/${encodeURIComponent(eventId)}`;
}
export function quoteArtifactUrl(eventId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new EventQuoteClientError('INVALID_VERSION');
  return `${path(eventId)}/quotes/${version}/artifact`;
}
async function request(url: string, signal: AbortSignal, command?: QuoteCommand, csrfToken?: string): Promise<unknown> {
  const body = command === undefined ? undefined : JSON.stringify(command);
  if (body && new TextEncoder().encode(body).byteLength > 65_536) throw new EventQuoteClientError('PAYLOAD_TOO_LARGE', 413);
  let response: Response;
  try {
    response = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', [EVENT_QUOTE_CSRF_HEADER]: csrfToken ?? '' } : {}) }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  } catch (error) { if (signal.aborted) throw error; throw new EventQuoteClientError('REQUEST_UNCERTAIN'); }
  if (!response.ok) throw new EventQuoteClientError(response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'REVISION_CONFLICT' : 'REQUEST_REJECTED', response.status);
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) invalid();
    const body = await response.text(); if (body.length > 2_097_152) invalid(); return JSON.parse(body);
  } catch { return invalid(); }
}
export interface EventQuoteClient {
  status(signal: AbortSignal): Promise<EventQuoteStatusResponse>;
  read(eventId: string, signal: AbortSignal): Promise<EventQuoteView>;
  execute(eventId: string, command: QuoteCommand, csrfToken: string, signal: AbortSignal): Promise<EventQuoteView>;
}
export const eventQuoteClient: EventQuoteClient = {
  async status(signal) { return validateQuoteStatus(await request(`${EVENT_QUOTE_API}/status`, signal)); },
  async read(eventId, signal) { return validateQuoteView(await request(path(eventId), signal), eventId); },
  async execute(eventId, command, csrf, signal) { return validateQuoteView(await request(`${path(eventId)}/commands`, signal, command, csrf), eventId); },
};
export function latestBriefInput(view: EventQuoteView | null): BriefInput {
  const b = view?.record.briefs.at(-1);
  return { contactName: b?.contactName ?? '', recipient: b?.recipient ?? '', originalMessage: b?.originalMessage ?? '', attendees: b?.attendees ?? 1,
    proposedDate: b?.proposedDate ?? '', proposedLocation: b?.proposedLocation ?? '', requirements: b?.requirements ?? '' };
}
export function exactQuoteReviewKey(view: EventQuoteView): string {
  const q = view.record.quotes.at(-1), b = view.record.briefs.at(-1);
  return JSON.stringify([view.record.eventId, view.record.revision, b?.digest, b?.recipient, q?.version, q?.digest, q?.catalogDigest, q?.artifact.sha256]);
}
export function quoteApprovalBlocked(view: EventQuoteView | null, status: EventQuoteStatusResponse | null, now = Date.now()): boolean {
  const q = view?.record.quotes.at(-1), b = view?.record.briefs.at(-1);
  return !view || !status?.enabled || !status.session.canWrite || !status.session.canApprove || status.session.expiresAtMs <= now
    || !status.catalog || status.catalog.validUntilMs <= now || view.record.scope.mode !== status.session.mode
    || view.currentQuoteStatus !== 'pending_internal_review' || !q || !b || q.briefVersion !== b.version || q.briefDigest !== b.digest || q.catalogDigest !== status.catalogDigest;
}
export function exactQuoteApproval(view: EventQuoteView, status: EventQuoteStatusResponse, key: string, now = Date.now()): QuoteCommand {
  if (quoteApprovalBlocked(view, status, now)) throw new EventQuoteClientError('REVIEW_OBSOLETE');
  const q = view.record.quotes.at(-1)!;
  return { action: 'approve', key, expectedRevision: view.record.revision, quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: view.record.briefs.at(-1)!.recipient };
}
export async function verifyQuoteArtifact(quote: QuoteVersion): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return false;
  const bytes = new TextEncoder().encode(quote.artifact.html);
  if (bytes.byteLength !== quote.artifact.bytes) return false;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('') === quote.artifact.sha256;
}
