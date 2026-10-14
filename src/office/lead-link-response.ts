import type { LeadLinkView, VerifiedLeadAgreement } from './lead-link-view-contracts';

export type LeadLinkResponseScope = { organizationId: string; workspaceId: string; mode: 'test' | 'commercial' };
export type LeadLinkResponse = {
  identityKey: string;
  scope: LeadLinkResponseScope;
  leadId: string;
  history: LeadLinkView;
  agreement: VerifiedLeadAgreement | null;
  openingSession: { canOpen: boolean; csrfToken: string | null; expiresAtMs: number };
};

const CATEGORIES = new Set(['calculator', 'lead_notes', 'sales_closer', 'landing_attribution', 'quote', 'keyword', 'update_link', 'unmapped']);
const STATUSES = new Set(['missing', 'historical', 'quarantined']);
const INDICATORS = new Set(['utm', 'google_click_id', 'google_campaign_id']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
function invalid(): never { throw new Error('Invalid lead link response'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  // Reject sparse arrays, accessor entries and attached metadata before inspecting values.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  return value;
}
function id(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || RESERVED.has(value)) invalid();
  return value;
}
function provenanceId(value: unknown): string {
  const result = id(value);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  return result;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')) invalid();
  return value;
}
function label(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)
    // Labels come from trusted catalogues/evidence. They must never carry provider URLs or query fragments.
    || /[a-z][a-z0-9+.-]*:\/\/|(?:https?|javascript|data|file|blob):|(?:^|\s)\/\/|www\.|[?&][A-Za-z0-9_%-]+=/i.test(value)) invalid();
  return value;
}
function guests(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 99_999) invalid();
  return value;
}
function scope(raw: unknown): LeadLinkResponseScope {
  const value = object(raw, ['organizationId', 'workspaceId', 'mode']);
  if (value.mode !== 'test' && value.mode !== 'commercial') invalid();
  return { organizationId: id(value.organizationId), workspaceId: id(value.workspaceId), mode: value.mode };
}
function link(raw: unknown): LeadLinkView['links'][number] {
  const value = object(raw, ['opening', 'category', 'status', 'accountId', 'boardId', 'itemId', 'columnId', 'updateId', 'observedAt', 'changedAt', 'campaignLabel', 'recordedGuests', 'evidenceKind', 'attributionIndicators']);
  if (typeof value.category !== 'string' || !CATEGORIES.has(value.category) || typeof value.status !== 'string' || !STATUSES.has(value.status)) invalid();
  const columnId = value.columnId === null ? null : provenanceId(value.columnId);
  const updateId = value.updateId === null ? null : provenanceId(value.updateId);
  if ((columnId === null) === (updateId === null)) invalid();
  const evidenceKind = updateId === null ? 'column_snapshot' : 'historical_update_link';
  if (value.evidenceKind !== evidenceKind || (value.category === 'update_link') !== (updateId !== null)) invalid();
  const attributionIndicators = array(value.attributionIndicators, 3).map(indicator => {
    if (typeof indicator !== 'string' || !INDICATORS.has(indicator)) invalid();
    return indicator as 'utm' | 'google_click_id' | 'google_campaign_id';
  });
  if (new Set(attributionIndicators).size !== attributionIndicators.length) invalid();
  const recordedGuests = value.recordedGuests === null ? null : guests(value.recordedGuests);
  const campaignLabel = value.campaignLabel === null ? null : label(value.campaignLabel);
  if (value.status !== 'historical' && (recordedGuests !== null || campaignLabel !== null || attributionIndicators.length !== 0)) invalid();
  if (updateId !== null && recordedGuests !== null) invalid();
  let opening: LeadLinkView['links'][number]['opening'] = null;
  if (value.opening !== null) {
    const o = object(value.opening, ['referenceId', 'revision']);
    if (value.status !== 'historical' || updateId !== null || !['calculator','lead_notes','sales_closer','quote'].includes(value.category)) invalid();
    opening = { referenceId: id(o.referenceId), revision: id(o.revision) };
  }
  return {
    opening, category: value.category, status: value.status as LeadLinkView['links'][number]['status'],
    accountId: provenanceId(value.accountId), boardId: provenanceId(value.boardId), itemId: provenanceId(value.itemId),
    columnId, updateId, observedAt: timestamp(value.observedAt), changedAt: value.changedAt === null ? null : timestamp(value.changedAt),
    campaignLabel, recordedGuests, evidenceKind, attributionIndicators,
  };
}

/** Closed wire contract shared by the server and client; never return source objects or extra fields. */
export function validateLeadLinkResponse(raw: unknown): LeadLinkResponse {
  const value = object(raw, ['identityKey', 'scope', 'leadId', 'history', 'agreement', 'openingSession']);
  const leadId = id(value.leadId, 96);
  const rawHistory = object(value.history, ['leadId', 'links']);
  if (id(rawHistory.leadId, 96) !== leadId) invalid();
  const history: LeadLinkView = { leadId, links: array(rawHistory.links, 2_000).map(link) };
  let agreement: VerifiedLeadAgreement | null = null;
  if (value.agreement !== null) {
    const a = object(value.agreement, ['leadId', 'guests', 'menu', 'amountLabel', 'verifiedAt', 'evidenceLabel']);
    if (id(a.leadId, 96) !== leadId) invalid();
    agreement = { leadId, guests: guests(a.guests), menu: label(a.menu, 2_000), amountLabel: label(a.amountLabel),
      verifiedAt: timestamp(a.verifiedAt), evidenceLabel: label(a.evidenceLabel) };
  }
  const session = object(value.openingSession, ['canOpen','csrfToken','expiresAtMs']);
  if (typeof session.canOpen !== 'boolean' || !Number.isSafeInteger(session.expiresAtMs) || (session.expiresAtMs as number) <= 0
    || (session.canOpen ? typeof session.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(session.csrfToken) : session.csrfToken !== null)
    || !session.canOpen && history.links.some(link => link.opening !== null)) invalid();
  return { identityKey: id(value.identityKey, 256), scope: scope(value.scope), leadId, history, agreement,
    openingSession: { canOpen: session.canOpen, csrfToken: session.csrfToken as string | null, expiresAtMs: session.expiresAtMs as number } };

}
