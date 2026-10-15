import type { PaymentAgreementOperationCommandV2, PaymentAgreementOperationSummaryV2 } from './backend/payment-agreement-operations-v2';
import type { BriefInput, CatalogSnapshot, EventQuoteView, QuoteCommand, QuoteVersion, PreparePaymentCommand, PaymentLinkPreparation, PreparePaymentV2Command, PaymentContractModeV2, PaymentConfigurationV2, PaymentConfigurationFactsV2, ConfigurePaymentV2Command, RegisterPaymentDraftV2Command } from './backend/event-quote-contracts';
import { proposeRetainerBalanceDateV2, resolveApprovedLocalMinuteV2 } from './backend/payment-calendar-v2';
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
  if (s.paymentAgreementsEnabled !== undefined && (s.paymentAgreementsEnabled !== true || session.mode !== 'test')) invalid();
  if (s.paymentDraftsEnabled !== undefined && (s.paymentDraftsEnabled !== true || session.mode !== 'test')) invalid();
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
  if (![1, 2, 3, 4].includes(record.schemaVersion as number) || record.eventId !== expectedEventId || !['test', 'commercial'].includes(scope.mode as string)) invalid();
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
  if (record.schemaVersion === 1 && record.paymentPreparations !== undefined) invalid();
  if (![3, 4].includes(record.schemaVersion as number) && record.paymentContractPreparationsV2 !== undefined) invalid();
  if (record.schemaVersion !== 4 && (record.paymentConfigurationsV2 !== undefined || record.paymentDraftRegistrationsV2 !== undefined)) invalid();
  if ([2, 3, 4].includes(record.schemaVersion as number)) {
    const preparations = list(record.paymentPreparations); if ((record.schemaVersion === 2 && !preparations.length) || preparations.length > 20) invalid();
    const seen = new Set<number>();
    for (const value of preparations) {
      const p = row(value); ['id', 'actorId', 'intendedRecipient', 'terms'].forEach(key => text(p[key]));
      ['quoteDigest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'digest'].forEach(key => digest(p[key]));
      integer(p.quoteVersion, 1); integer(p.atMs); ['totalCents', 'depositCents', 'remainingCents'].forEach(key => integer(p[key]));
      if (p.eventId !== expectedEventId || p.currency !== 'USD' || p.status !== 'pending_provider_review' || p.provider !== 'gourmet_payments_legacy'
        || p.providerEnabled !== false || p.publicPaymentUrl !== null || p.financialMeaning !== 'unaccepted_quote'
        || JSON.stringify(p.blockers) !== JSON.stringify(['PROVIDER_DISABLED', 'LEGACY_TERMS_UNVERIFIED', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_SCHEDULE_REQUIRED'])
        || seen.has(p.quoteVersion as number)) invalid();
      seen.add(p.quoteVersion as number);
      const q = (record.quotes as QuoteVersion[]).find(q => q.version === p.quoteVersion);
      const d = (record.decisions as EventQuoteView['record']['decisions']).find(d => d.digest === p.approvalDigest);
      if (!q || !d || q.digest !== p.quoteDigest || q.briefDigest !== p.briefDigest || q.catalogDigest !== p.catalogDigest
        || q.artifact.sha256 !== p.artifactSha256 || q.totalCents !== p.totalCents || q.depositCents !== p.depositCents
        || q.totalCents - q.depositCents !== p.remainingCents || q.catalog.terms !== p.terms
        || d.quoteDigest !== q.digest || d.intendedRecipient !== p.intendedRecipient || d.atMs > (p.atMs as number)) invalid();
    }
  }
  if ([3, 4].includes(record.schemaVersion as number)) {
    const preparations = list(record.paymentContractPreparationsV2); if (!preparations.length || preparations.length > 20) invalid();
    const seen = new Set<number>();
    const keys = ['id', 'eventId', 'quoteVersion', 'quoteDigest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'intendedRecipient',
      'currency', 'totalCents', 'depositCents', 'remainingCents', 'terms', 'depositBasis', 'paymentMode', 'initialPaymentCents', 'paymentBalanceCents',
      'quotedDepositMatchesMode', 'paymentTerms', 'paymentSchedule', 'paymentTermsApproval', 'canonicalLeadId', 'actorId', 'atMs', 'status', 'provider',
      'providerEnabled', 'publicPaymentUrl', 'financialMeaning', 'blockers', 'digest', 'contractVersion'];
    for (const value of preparations) {
      const p = row(value), basis = row(p.depositBasis);
      if (Object.keys(p).length !== keys.length || Object.keys(p).some(key => !keys.includes(key))
        || Object.keys(basis).length !== 2 || basis.kind !== 'quoted_percentage') invalid();
      ['id', 'actorId', 'intendedRecipient', 'terms'].forEach(key => text(p[key]));
      ['quoteDigest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'digest'].forEach(key => digest(p[key]));
      integer(p.quoteVersion, 1); integer(p.atMs); integer(basis.basisPoints);
      ['totalCents', 'depositCents', 'remainingCents', 'initialPaymentCents', 'paymentBalanceCents'].forEach(key => integer(p[key]));
      if (p.eventId !== expectedEventId || p.contractVersion !== 2 || p.currency !== 'USD' || p.status !== 'pending_configuration'
        || p.provider !== 'gourmet_payments_v2' || p.providerEnabled !== false || p.publicPaymentUrl !== null || p.financialMeaning !== 'unaccepted_quote'
        || p.paymentTerms !== null || p.paymentSchedule !== null || p.paymentTermsApproval !== null || p.canonicalLeadId !== null
        || !isPaymentContractModeV2(p.paymentMode) || seen.has(p.quoteVersion as number)) invalid();
      seen.add(p.quoteVersion as number);
      const q = (record.quotes as QuoteVersion[]).find(q => q.version === p.quoteVersion);
      const d = (record.decisions as EventQuoteView['record']['decisions']).find(d => d.digest === p.approvalDigest);
      if (!q || !d) return invalid();
      if (q.digest !== p.quoteDigest || q.briefDigest !== p.briefDigest || q.catalogDigest !== p.catalogDigest
        || q.artifact.sha256 !== p.artifactSha256 || q.totalCents !== p.totalCents || q.depositCents !== p.depositCents
        || q.totalCents - q.depositCents !== p.remainingCents || q.catalog.terms !== p.terms || q.catalog.depositBps !== basis.basisPoints
        || d.quoteVersion !== q.version || d.quoteDigest !== q.digest || d.briefDigest !== q.briefDigest || d.catalogDigest !== q.catalogDigest
        || d.artifactSha256 !== q.artifact.sha256 || d.intendedRecipient !== p.intendedRecipient || d.atMs > (p.atMs as number)) invalid();
      const initial = p.paymentMode === 'retainer_50' ? Number((BigInt(q.totalCents) + 1n) / 2n)
        : p.paymentMode === 'full_upfront' ? q.totalCents : 4900;
      const quotedDepositMatchesMode = p.paymentMode === 'retainer_50' ? q.catalog.depositBps === 5000 && q.depositCents === initial
        : p.paymentMode === 'full_upfront' && q.catalog.depositBps === 10000 && q.depositCents === initial;
      const blockers = ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE', 'CANONICAL_LEAD_REQUIRED', 'LINK_EXPIRATION_REQUIRED',
        ...(p.paymentMode !== 'full_upfront' ? ['PAYMENT_SCHEDULE_REQUIRED'] : []), 'PAYMENT_TERMS_REQUIRED', 'PAYMENT_TERMS_APPROVAL_REQUIRED',
        ...(!quotedDepositMatchesMode ? ['QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED'] : [])];
      if ((p.paymentMode === 'fixed_49_reservation' && q.totalCents <= 4900) || p.initialPaymentCents !== initial
        || p.paymentBalanceCents !== q.totalCents - initial || p.quotedDepositMatchesMode !== quotedDepositMatchesMode
        || JSON.stringify(p.blockers) !== JSON.stringify(blockers)) invalid();
    }
  }
  if (record.schemaVersion === 4) validatePaymentDraftLedgersV2(record);
  if (v.paymentAgreementOperationsV2 !== undefined) validatePaymentAgreementOperationsV2(v.paymentAgreementOperationsV2, record);
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
async function request(url: string, signal: AbortSignal, command?: QuoteCommand | PaymentAgreementOperationCommandV2, csrfToken?: string, accessRevision?: string): Promise<unknown> {
  if (command !== undefined) { if ('operation' in command) assertPaymentAgreementOperationCommandV2(command); else assertPaymentDraftCommandV2(command); }
  const body = command === undefined ? undefined : JSON.stringify(command);
  if (body && new TextEncoder().encode(body).byteLength > 65_536) throw new EventQuoteClientError('PAYLOAD_TOO_LARGE', 413);
  let response: Response;
  try {
    response = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(accessRevision !== undefined ? { 'x-event-quote-access-revision': accessRevision } : {}),
        ...(command ? { 'Content-Type': 'application/json', [EVENT_QUOTE_CSRF_HEADER]: csrfToken ?? '' } : {}) }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  } catch (error) { if (signal.aborted) throw error; throw new EventQuoteClientError('REQUEST_UNCERTAIN'); }
  if (!response.ok) throw new EventQuoteClientError(response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'REVISION_CONFLICT' : 'REQUEST_REJECTED', response.status);
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) invalid();
    const body = await response.text(); if (body.length > 2_097_152) invalid(); return JSON.parse(body);
  } catch { return invalid(); }
}
export interface EventQuoteClient {
  status(signal: AbortSignal, accessRevision?: string): Promise<EventQuoteStatusResponse>;
  read(eventId: string, signal: AbortSignal, accessRevision?: string): Promise<EventQuoteView>;
  execute(eventId: string, command: QuoteCommand, csrfToken: string, signal: AbortSignal, accessRevision?: string): Promise<EventQuoteView>;
  executePaymentAgreement?(eventId: string, command: PaymentAgreementOperationCommandV2, csrfToken: string, signal: AbortSignal, accessRevision?: string): Promise<EventQuoteView>;
}
export const eventQuoteClient: EventQuoteClient = {
  async status(signal, revision) { return validateQuoteStatus(await request(`${EVENT_QUOTE_API}/status`, signal, undefined, undefined, revision)); },
  async read(eventId, signal, revision) { return validateQuoteView(await request(path(eventId), signal, undefined, undefined, revision), eventId); },
  async execute(eventId, command, csrf, signal, revision) { return validateQuoteView(await request(`${path(eventId)}/commands`, signal, command, csrf, revision), eventId); },
  async executePaymentAgreement(eventId, command, csrf, signal, revision) { assertPaymentAgreementOperationCommandV2(command); return validateQuoteView(await request(`${path(eventId)}/payment-agreements/v2`, signal, command, csrf, revision), eventId); },
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

/** A saved internal request is never a usable payment link or proof of payment. */
export function paymentPreparationIsCurrent(preparation: PaymentLinkPreparation, view: EventQuoteView, now = Date.now(), currentCatalogDigest?: string | null): boolean {
  const q = view.record.quotes.at(-1), b = view.record.briefs.at(-1);
  return view.currentQuoteStatus === 'approved_internal_unsent' && !!q && q.catalog.validUntilMs > now
    && (currentCatalogDigest === undefined || currentCatalogDigest === q.catalogDigest) && preparation.eventId === view.record.eventId
    && preparation.quoteDigest === q?.digest && preparation.briefDigest === b?.digest
    && view.record.decisions.some(d => d.digest === preparation.approvalDigest && d.quoteDigest === q?.digest);
}
export function paymentPreparationBlocked(view: EventQuoteView | null, status: EventQuoteStatusResponse | null, now = Date.now()): boolean {
  const q = view?.record.quotes.at(-1), b = view?.record.briefs.at(-1);
  return !view || !status?.enabled || !status.session.canWrite || !status.session.canApprove || status.session.expiresAtMs <= now
    || !status.catalog || status.catalog.validUntilMs <= now || view.record.scope.mode !== status.session.mode
    || view.currentQuoteStatus !== 'approved_internal_unsent' || !q || !b || q.briefVersion !== b.version || q.briefDigest !== b.digest
    || q.catalogDigest !== status.catalogDigest || !view.record.decisions.some(d => d.quoteDigest === q.digest)
    || !!view.record.paymentPreparations?.some(item => item.quoteDigest === q.digest);
}
export function exactPaymentPreparation(view: EventQuoteView, status: EventQuoteStatusResponse, key: string, now = Date.now()): PreparePaymentCommand {
  if (paymentPreparationBlocked(view, status, now)) throw new EventQuoteClientError('PAYMENT_PREPARATION_BLOCKED');
  const q = view.record.quotes.at(-1)!, decision = view.record.decisions.find(d => d.quoteDigest === q.digest)!;
  return { action: 'prepare_payment', key, expectedRevision: view.record.revision, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: decision.digest, artifactSha256: q.artifact.sha256 };
}

/** A V2 mode is chosen explicitly; numerical similarity never selects a contract. */
export function isPaymentContractModeV2(value: unknown): value is PaymentContractModeV2 {
  return typeof value === 'string' && ['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(value);
}
export function paymentContractV2PreparationBlocked(view: EventQuoteView | null, status: EventQuoteStatusResponse | null, now = Date.now()): boolean {
  const q = view?.record.quotes.at(-1), b = view?.record.briefs.at(-1);
  return !view || !status?.enabled || !status.session.canWrite || !status.session.canApprove || status.session.expiresAtMs <= now
    || !status.catalog || status.catalog.validUntilMs <= now || view.record.scope.mode !== status.session.mode
    || view.currentQuoteStatus !== 'approved_internal_unsent' || !q || !b || q.briefVersion !== b.version || q.briefDigest !== b.digest
    || q.catalogDigest !== status.catalogDigest || !view.record.decisions.some(d => d.quoteDigest === q.digest)
    || !!view.record.paymentContractPreparationsV2?.some(item => item.quoteDigest === q.digest);
}
export function exactPaymentContractV2Preparation(view: EventQuoteView, status: EventQuoteStatusResponse, key: string, mode: PaymentContractModeV2, now = Date.now()): PreparePaymentV2Command {
  if (!isPaymentContractModeV2(mode) || paymentContractV2PreparationBlocked(view, status, now)) throw new EventQuoteClientError('PAYMENT_PREPARATION_BLOCKED');
  const q = view.record.quotes.at(-1)!, decision = view.record.decisions.find(d => d.quoteDigest === q.digest)!;
  if (mode === 'fixed_49_reservation' && q.totalCents <= 4900) throw new EventQuoteClientError('PAYMENT_PREPARATION_BLOCKED');
  return { action: 'prepare_payment_v2', key, expectedRevision: view.record.revision, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: decision.digest, artifactSha256: q.artifact.sha256, paymentMode: mode };
}

// Browser checks are conservative presentation/transport checks. The server and
// durable store verify the actual hashes and authenticated identity before use.
function exactRow(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = row(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(r)) || Reflect.ownKeys(r).length !== keys.length
    || keys.some(key => { const d = Object.getOwnPropertyDescriptor(r, key); return !d || !('value' in d) || !d.enumerable; })) return invalid();
  return r;
}
function requiredText(value: unknown, max: number, identifier = false): string {
  if (typeof value !== 'string' || value.length > max || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || identifier && (value.trim() !== value || /[\r\n\t]/.test(value))) return invalid();
  return value;
}
function token(value: unknown): string {
  const valueText = requiredText(value, 96, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(valueText) || ['constructor', 'prototype', '__proto__'].includes(valueText)) return invalid();
  return valueText;
}
function nullableText(value: unknown, max: number): void { if (value !== null) requiredText(value, max); }
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) return invalid();
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const r = exactRow(value, Object.keys(value));
    return `{${Object.keys(r).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(r[key], depth + 1)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  return invalid();
}
function sameJson(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function futureConfiguredMinute(date: unknown, time: unknown, timezone: unknown, atMs: number): string {
  if (typeof date !== 'string' || typeof time !== 'string' || typeof timezone !== 'string') return invalid();
  const result = resolveApprovedLocalMinuteV2(date, time, timezone);
  if (!result || !/:00Z$/.test(result) || Date.parse(result) <= atMs) return invalid();
  return result;
}
function configurationFactsV2(config: Record<string, unknown>, preparation: Record<string, unknown>, atMs: number) {
  requiredText(config.paymentTerms, 4000); nullableText(config.termsChangeReason, 2000);
  if ((!preparation.quotedDepositMatchesMode || config.paymentTerms !== preparation.terms) && config.termsChangeReason === null) return invalid();
  const expiration = row(config.linkExpiration);
  let linkExpiration: { configured: Record<string, unknown>; instant: string | null };
  if (expiration.kind === 'never') { exactRow(expiration, ['kind']); linkExpiration = { configured: expiration, instant: null }; }
  else {
    exactRow(expiration, ['kind', 'date', 'time', 'timezone']); if (expiration.kind !== 'at') return invalid();
    linkExpiration = { configured: expiration, instant: futureConfiguredMinute(expiration.date, expiration.time, expiration.timezone, atMs) };
  }
  if (preparation.paymentMode === 'full_upfront') {
    if (config.paymentSchedule !== null || preparation.paymentBalanceCents !== 0) return invalid();
    return { paymentSchedule: null, linkExpiration };
  }
  const schedule = row(config.paymentSchedule);
  if (preparation.paymentMode === 'fixed_49_reservation') {
    exactRow(schedule, ['kind', 'balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']);
    if (schedule.kind !== preparation.paymentMode || schedule.agreedBalanceCents !== preparation.paymentBalanceCents) return invalid();
    const balanceInstant = futureConfiguredMinute(schedule.balanceDate, schedule.balanceTime, schedule.timezone, atMs);
    return { paymentSchedule: { configured: schedule, balanceInstant, eventInstant: null, proposedBalanceDate: null, timingReviewReason: null }, linkExpiration };
  }
  exactRow(schedule, ['kind', 'eventDate', 'eventTime', 'timezone', 'balanceDate', 'balanceTime', 'timingExceptionReason']);
  if (schedule.kind !== 'retainer_50') return invalid();
  nullableText(schedule.timingExceptionReason, 2000);
  const eventInstant = futureConfiguredMinute(schedule.eventDate, schedule.eventTime, schedule.timezone, atMs);
  const balanceInstant = futureConfiguredMinute(schedule.balanceDate, schedule.balanceTime, schedule.timezone, atMs);
  const proposal = proposeRetainerBalanceDateV2({ eventDate: schedule.eventDate as string, eventTime: schedule.eventTime as string,
    timezone: schedule.timezone as string, nowMs: atMs });
  if (!proposal.proposedBalanceDate || Date.parse(balanceInstant) >= Date.parse(eventInstant)) return invalid();
  const needsReview = schedule.balanceDate !== proposal.proposedBalanceDate
    || proposal.codes.some(code => ['EVENT_DATE_NOT_FUTURE', 'EVENT_WITHIN_SEVEN_DAYS', 'PROPOSED_BALANCE_DATE_PAST'].includes(code));
  if (needsReview && schedule.timingExceptionReason === null) return invalid();
  return { paymentSchedule: { configured: schedule, balanceInstant, eventInstant, proposedBalanceDate: proposal.proposedBalanceDate,
    timingReviewReason: schedule.timingExceptionReason }, linkExpiration };
}
function validatePaymentDraftLedgersV2(record: Record<string, unknown>): void {
  exactRow(record, ['schemaVersion', 'scope', 'eventId', 'revision', 'briefs', 'quotes', 'decisions', 'audit', 'receipts',
    'paymentPreparations', 'paymentContractPreparationsV2', 'paymentConfigurationsV2', 'paymentDraftRegistrationsV2']);
  const scope = exactRow(record.scope, ['organizationId', 'workspaceId', 'mode']);
  if (scope.mode !== 'test') return invalid();
  const configs = list(record.paymentConfigurationsV2), registrations = list(record.paymentDraftRegistrationsV2);
  if (!configs.length || configs.length > 20 || registrations.length > 20) return invalid();
  const preparations = list(record.paymentContractPreparationsV2).map(row), audits = list(record.audit).map(row), receipts = list(record.receipts).map(row);
  if (record.revision !== audits.length || receipts.length !== audits.length) return invalid();
  const ids = new Set<string>(), configuredPreparations = new Set<string>(), registeredConfigurations = new Set<string>();
  function evidence(entry: Record<string, unknown>, action: string) {
    token(entry.id); token(entry.actorId); integer(entry.atMs); digest(entry.digest);
    if ((entry.atMs as number) > 8_640_000_000_000_000 || ids.has(entry.id as string)) return invalid(); ids.add(entry.id as string);
    const found = audits.map((audit, index) => ({ audit, index })).filter(({ audit }) => audit.commandKey === entry.id);
    if (found.length !== 1) return invalid();
    const { audit, index } = found[0];
    exactRow(audit, ['sequence', 'action', 'actorId', 'atMs', 'commandKey', 'inputDigest', 'previousDigest', 'digest']);
    digest(audit.inputDigest); digest(audit.digest);
    if (audit.action !== action || audit.actorId !== entry.actorId || audit.atMs !== entry.atMs || audit.sequence !== index + 1
      || audit.previousDigest !== (index ? audits[index - 1].digest : null)) return invalid();
    const stored = receipts.filter(receipt => receipt.key === entry.id); if (stored.length !== 1) return invalid();
    const receipt = exactRow(stored[0], ['key', 'inputDigest', 'actorId', 'resultingRevision']);
    if (receipt.inputDigest !== audit.inputDigest || receipt.actorId !== entry.actorId || receipt.resultingRevision !== index + 1) return invalid();
    return index;
  }
  const configById = new Map<string, { row: Record<string, unknown>; config: Record<string, unknown>; preparation: Record<string, unknown>; auditIndex: number }>();
  for (const raw of configs) {
    const c = exactRow(raw, ['id', 'digest', 'preparationId', 'preparationDigest', 'configuration', 'leadSource', 'reviewDigest', 'actorId', 'atMs', 'status']);
    const auditIndex = evidence(c, 'configure_payment_v2'); digest(c.preparationDigest); digest(c.reviewDigest);
    const p = preparations.find(p => p.id === c.preparationId);
    if (!p || p.digest !== c.preparationDigest || c.status !== 'draft_configuration' || c.leadSource !== 'synthetic_fixture'
      || (c.atMs as number) < (p.atMs as number) || configuredPreparations.has(c.preparationId as string)) return invalid();
    configuredPreparations.add(c.preparationId as string);
    const config = exactRow(c.configuration, ['contractVersion', 'preparationId', 'paymentMode', 'canonicalLeadId', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']);
    if (config.contractVersion !== 2 || config.preparationId !== c.preparationId || config.paymentMode !== p.paymentMode) return invalid();
    requiredText(config.canonicalLeadId, 180, true);
    configurationFactsV2(config, p, c.atMs as number);
    configById.set(c.id as string, { row: c, config, preparation: p, auditIndex });
  }
  for (const raw of registrations) {
    const r = exactRow(raw, ['id', 'digest', 'configurationId', 'configurationDigest', 'preparationId', 'preparationDigest', 'reviewDigest',
      'receipt', 'bodySha256', 'receiptDigest', 'actorId', 'atMs', 'status', 'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified']);
    const auditIndex = evidence(r, 'register_payment_draft_v2');
    ['configurationDigest', 'preparationDigest', 'reviewDigest', 'bodySha256', 'receiptDigest'].forEach(key => digest(r[key]));
    const found = configById.get(r.configurationId as string); if (!found) return invalid();
    const { row: c, config, preparation: p } = found;
    if (registeredConfigurations.has(r.configurationId as string) || r.configurationDigest !== c.digest || r.preparationId !== p.id
      || r.preparationDigest !== p.digest || r.reviewDigest !== c.reviewDigest || (r.atMs as number) < (c.atMs as number)
      || auditIndex <= found.auditIndex || r.status !== 'draft_internal' || r.executable !== false || r.providerEnabled !== false
      || r.publicPaymentUrl !== null || r.authorizationVerified !== false) return invalid();
    registeredConfigurations.add(r.configurationId as string);
    const expectedPlan = { contractVersion: 2, scope, eventId: record.eventId, preparationId: p.id, preparationDigest: p.digest,
      sourceQuote: { version: p.quoteVersion, digest: p.quoteDigest, approvalDigest: p.approvalDigest, briefDigest: p.briefDigest,
        catalogDigest: p.catalogDigest, artifactSha256: p.artifactSha256, intendedRecipient: p.intendedRecipient, currency: p.currency,
        totalCents: p.totalCents, depositCents: p.depositCents, depositBasis: p.depositBasis, terms: p.terms },
      paymentMode: p.paymentMode, initialPaymentCents: p.initialPaymentCents, paymentBalanceCents: p.paymentBalanceCents,
      canonicalLeadId: config.canonicalLeadId, paymentTerms: config.paymentTerms, termsChangeReason: config.termsChangeReason,
      ...configurationFactsV2(config, p, r.atMs as number) };
    const expectedPrepared = { status: 'prepared_internal', contractVersion: 2, plan: expectedPlan, reviewDigest: c.reviewDigest,
      internalApproval: { actorId: r.actorId, atMs: r.atMs, purpose: 'internal_payment_plan_only', reviewDigest: c.reviewDigest },
      executable: false, providerEnabled: false, publicPaymentUrl: null, blockers: ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE'] };
    if (!sameJson(r.receipt, { status: 'contract_validated_internal', prepared: expectedPrepared,
      executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false })) return invalid();
  }
  if (audits.filter(a => a.action === 'configure_payment_v2').length !== configs.length
    || audits.filter(a => a.action === 'register_payment_draft_v2').length !== registrations.length) return invalid();
}

/** Reject caller identity/configuration extensions before either browser transport. */
export function assertPaymentDraftCommandV2(command: QuoteCommand): void {
  if (command.action !== 'configure_payment_v2' && command.action !== 'register_payment_draft_v2') return;
  try {
    const value = exactRow(command, command.action === 'configure_payment_v2'
      ? ['action', 'key', 'expectedRevision', 'preparationId', 'preparationDigest', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']
      : ['action', 'key', 'expectedRevision', 'configurationId', 'configurationDigest', 'expectedReviewDigest']);
    token(value.key); integer(value.expectedRevision, 1);
    if (command.action === 'register_payment_draft_v2') {
      token(value.configurationId); digest(value.configurationDigest); digest(value.expectedReviewDigest);
    } else {
      token(value.preparationId); digest(value.preparationDigest); requiredText(value.paymentTerms, 4000); nullableText(value.termsChangeReason, 2000);
      if (value.paymentSchedule !== null) {
        const schedule = row(value.paymentSchedule);
        if (schedule.kind === 'retainer_50') {
          exactRow(schedule, ['kind', 'eventDate', 'eventTime', 'timezone', 'balanceDate', 'balanceTime', 'timingExceptionReason']); nullableText(schedule.timingExceptionReason, 2000);
        } else if (schedule.kind === 'fixed_49_reservation') {
          exactRow(schedule, ['kind', 'balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']); integer(schedule.agreedBalanceCents, 1);
        } else return invalid();
      }
      const expiration = row(value.linkExpiration); exactRow(expiration, expiration.kind === 'never' ? ['kind'] : ['kind', 'date', 'time', 'timezone']);
      if (!['never', 'at'].includes(expiration.kind as string)) return invalid();
      canonicalJson(value);
    }
  } catch { throw new EventQuoteClientError('INVALID_COMMAND', 400); }
}

/** Display-only currency, source and calendar freshness; grants no authority. */
export function paymentConfigurationV2IsCurrent(configuration: PaymentConfigurationV2, view: EventQuoteView, currentCatalogDigest: string | null, now = Date.now()): boolean {
  const preparation = view.record.paymentContractPreparationsV2?.find(p => p.id === configuration.preparationId && p.digest === configuration.preparationDigest);
  const quote = view.record.quotes.at(-1), brief = view.record.briefs.at(-1);
  if (!preparation || !quote || !brief || view.currentQuoteStatus !== 'approved_internal_unsent' || quote.catalog.validUntilMs <= now
    || quote.digest !== preparation.quoteDigest || quote.briefDigest !== brief.digest || preparation.briefDigest !== brief.digest
    || currentCatalogDigest !== quote.catalogDigest || preparation.catalogDigest !== quote.catalogDigest
    || !view.record.decisions.some(d => d.digest === preparation.approvalDigest && d.quoteDigest === quote.digest)) return false;
  try { configurationFactsV2(row(configuration.configuration), row(preparation), now); return true; }
  catch { return false; }
}

function currentPaymentDraftPreparation(view: EventQuoteView, status: EventQuoteStatusResponse, preparationId: string, now: number) {
  const p = view.record.paymentContractPreparationsV2?.find(p => p.id === preparationId);
  const q = view.record.quotes.at(-1), b = view.record.briefs.at(-1);
  if (!p || !q || !b || !status.enabled || status.paymentDraftsEnabled !== true && status.paymentAgreementsEnabled !== true || status.session.mode !== 'test' || view.record.scope.mode !== 'test'
    || !status.session.canWrite || !status.session.canApprove || status.session.expiresAtMs <= now || !status.catalog || status.catalog.validUntilMs <= now
    || view.currentQuoteStatus !== 'approved_internal_unsent' || q.catalog.validUntilMs <= now || q.briefDigest !== b.digest
    || q.catalogDigest !== status.catalogDigest || p.quoteDigest !== q.digest || p.briefDigest !== b.digest
    || p.catalogDigest !== q.catalogDigest || p.artifactSha256 !== q.artifact.sha256
    || !view.record.decisions.some(d => d.digest === p.approvalDigest && d.quoteDigest === q.digest)) throw new EventQuoteClientError('PAYMENT_DRAFT_BLOCKED');
  return p;
}
export function exactPaymentConfigurationV2Command(view: EventQuoteView, status: EventQuoteStatusResponse, key: string, preparationId: string,
  facts: PaymentConfigurationFactsV2, now = Date.now()): ConfigurePaymentV2Command {
  const p = currentPaymentDraftPreparation(view, status, preparationId, now);
  if (view.record.paymentConfigurationsV2?.some(c => c.preparationId === p.id)) throw new EventQuoteClientError('PAYMENT_DRAFT_BLOCKED');
  exactRow(facts, ['paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']);
  configurationFactsV2(row(facts), row(p), now);
  const command: ConfigurePaymentV2Command = { action: 'configure_payment_v2', key, expectedRevision: view.record.revision,
    preparationId: p.id, preparationDigest: p.digest, ...structuredClone(facts) };
  assertPaymentDraftCommandV2(command); return command;
}
export function exactPaymentDraftRegistrationV2Command(view: EventQuoteView, status: EventQuoteStatusResponse, key: string,
  configurationId: string, now = Date.now()): RegisterPaymentDraftV2Command {
  const c = view.record.paymentConfigurationsV2?.find(c => c.id === configurationId);
  if (status.paymentDraftsEnabled !== true || !c) throw new EventQuoteClientError('PAYMENT_DRAFT_BLOCKED');
  currentPaymentDraftPreparation(view, status, c.preparationId, now);
  if (!paymentConfigurationV2IsCurrent(c, view, status.catalogDigest, now)
    || view.record.paymentDraftRegistrationsV2?.some(r => r.configurationId === c.id)) throw new EventQuoteClientError('PAYMENT_DRAFT_BLOCKED');
  const command: RegisterPaymentDraftV2Command = { action: 'register_payment_draft_v2', key, expectedRevision: view.record.revision,
    configurationId: c.id, configurationDigest: c.digest, expectedReviewDigest: c.reviewDigest };
  assertPaymentDraftCommandV2(command); return command;
}

function validatePaymentAgreementOperationsV2(value: unknown, record: Record<string, unknown>): void {
  const operations = list(value); if (operations.length > 20) return invalid();
  const configs = record.schemaVersion === 4 ? list(record.paymentConfigurationsV2).map(row) : [];
  const ids = new Set<string>(), configurationIds = new Set<string>();
  for (const raw of operations) {
    const operation = exactRow(raw, ['operationId', 'operationDigest', 'configurationId', 'configurationDigest', 'status', 'agreementId',
      'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified', 'serviceAuthenticated', 'updatedAtMs']);
    digest(operation.operationId); digest(operation.operationDigest); token(operation.configurationId); digest(operation.configurationDigest); integer(operation.updatedAtMs);
    const configuration = configs.find(c => c.id === operation.configurationId && c.digest === operation.configurationDigest);
    if (!configuration || ids.has(operation.operationId as string) || configurationIds.has(operation.configurationId as string)
      || !['pending', 'reconciliation_required', 'draft_persisted', 'rejected'].includes(operation.status as string)
      || operation.executable !== false || operation.providerEnabled !== false || operation.publicPaymentUrl !== null || operation.authorizationVerified !== false
      || (operation.updatedAtMs as number) < (configuration.atMs as number) || (operation.updatedAtMs as number) > 8_640_000_000_000_000) return invalid();
    ids.add(operation.operationId as string); configurationIds.add(operation.configurationId as string);
    if (operation.status === 'draft_persisted') {
      if (operation.serviceAuthenticated !== true || typeof operation.agreementId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation.agreementId)) return invalid();
    } else if (operation.agreementId !== null || operation.serviceAuthenticated !== false) return invalid();
  }
}
/** No source, lead, service credential, payload or authority is accepted from the browser. */
export function assertPaymentAgreementOperationCommandV2(command: unknown): asserts command is PaymentAgreementOperationCommandV2 {
  try {
    const c = exactRow(command, ['key', 'configurationId', 'configurationDigest', 'expectedReviewDigest', 'operation']);
    token(c.key); token(c.configurationId); digest(c.configurationDigest); digest(c.expectedReviewDigest);
    if (c.operation !== 'create' && c.operation !== 'reconcile') return invalid();
  } catch { throw new EventQuoteClientError('INVALID_COMMAND', 400); }
}
export function exactPaymentAgreementOperationV2Command(view: EventQuoteView, status: EventQuoteStatusResponse, key: string,
  configurationId: string, operation: PaymentAgreementOperationCommandV2['operation'], now = Date.now()): PaymentAgreementOperationCommandV2 {
  const c = view.record.paymentConfigurationsV2?.find(c => c.id === configurationId);
  if (!c || status.paymentAgreementsEnabled !== true || !status.enabled || status.session.mode !== 'test' || view.record.scope.mode !== 'test'
    || !status.session.canWrite || !status.session.canApprove || status.session.expiresAtMs <= now) throw new EventQuoteClientError('PAYMENT_AGREEMENT_BLOCKED');
  const existing = view.paymentAgreementOperationsV2?.find(item => item.configurationId === c.id && item.configurationDigest === c.digest);
  if (operation === 'create') {
    currentPaymentDraftPreparation(view, status, c.preparationId, now);
    if (existing && existing.status !== 'reconciliation_required' || !paymentConfigurationV2IsCurrent(c, view, status.catalogDigest, now)) throw new EventQuoteClientError('PAYMENT_AGREEMENT_BLOCKED');
  } else if (operation !== 'reconcile' || !existing || !['pending', 'reconciliation_required'].includes(existing.status)) throw new EventQuoteClientError('PAYMENT_AGREEMENT_BLOCKED');
  const command: PaymentAgreementOperationCommandV2 = { key, configurationId: c.id, configurationDigest: c.digest, expectedReviewDigest: c.reviewDigest, operation };
  assertPaymentAgreementOperationCommandV2(command); return command;
}
export type { PaymentAgreementOperationCommandV2, PaymentAgreementOperationSummaryV2 };
