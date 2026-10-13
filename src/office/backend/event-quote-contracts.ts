// Explicitly composed private workflow. No provider, payment, booking or sending authority.
export type QuoteScope = Readonly<{ organizationId: string; workspaceId: string; mode: 'test' | 'commercial' }>;
export type QuoteActor = Readonly<{ actorId: string; durable: boolean; expiresAtMs: number; canWrite: boolean; canApprove: boolean }>;
export type BriefInput = { contactName: string; recipient: string; originalMessage: string; attendees: number; proposedDate: string; proposedLocation: string; requirements: string };
export type BriefVersion = BriefInput & { version: number; digest: string; actorId: string; createdAtMs: number; provenance: 'manual_intake'; reservationStatus: 'unconfirmed' };
export type CatalogSnapshot = { id: string; version: string; authority: 'test_only' | 'owner_authorized'; approvalRef: string; source: string; currency: 'USD'; validUntilMs: number; taxBps: number; depositBps: number; terms: string; items: { id: string; label: string; unit: string; unitPriceCents: number }[] };
export type QuoteSelection = { itemId: string; quantity: number };
export type QuoteVersion = { version: number; eventId: string; briefVersion: number; briefDigest: string; catalog: CatalogSnapshot; catalogDigest: string; lines: { catalogItemId: string; label: string; unit: string; qty: number; unitPriceCents: number }[]; currency: 'USD'; subtotalCents: number; taxCents: number; totalCents: number; depositCents: number; actorId: string; createdAtMs: number; digest: string; financialMeaning: 'unaccepted_quote'; artifact: { mediaType: 'text/html; charset=utf-8'; html: string; sha256: string; bytes: number } };
export type QuoteDecision = { id: string; quoteVersion: number; quoteDigest: string; briefDigest: string; catalogDigest: string; artifactSha256: string; intendedRecipient: string; actorId: string; atMs: number; status: 'approved_internal_unsent'; digest: string };
export type QuoteAudit = { sequence: number; action: 'create' | 'brief' | 'quote' | 'approve'; actorId: string; atMs: number; commandKey: string; inputDigest: string; previousDigest: string | null; digest: string };
export type QuoteReceipt = { key: string; inputDigest: string; actorId: string; resultingRevision: number };
export type EventQuoteRecord = { schemaVersion: 1; scope: QuoteScope; eventId: string; revision: number; briefs: BriefVersion[]; quotes: QuoteVersion[]; decisions: QuoteDecision[]; audit: QuoteAudit[]; receipts: QuoteReceipt[] };
export interface EventQuoteStore {
  read(scope: QuoteScope, eventId: string): Promise<EventQuoteRecord | null>;
  // Callback + record + audit + command receipt commit atomically. A throw rolls back.
  transact(scope: QuoteScope, eventId: string, change: (current: EventQuoteRecord | null) => EventQuoteRecord | Promise<EventQuoteRecord>): Promise<EventQuoteRecord>;
}
export type EventQuoteView = { record: EventQuoteRecord; currentQuoteStatus: 'missing' | 'pending_internal_review' | 'approved_internal_unsent' | 'obsolete'; externalEffectsEnabled: false };
export type QuoteCommand = { key: string; expectedRevision: number; action: 'create'; brief: BriefInput } | { key: string; expectedRevision: number; action: 'brief'; brief: BriefInput } | { key: string; expectedRevision: number; action: 'quote'; expectedBriefDigest: string; expectedCatalogDigest: string; selections: QuoteSelection[] } | { key: string; expectedRevision: number; action: 'approve'; quoteVersion: number; quoteDigest: string; artifactSha256: string; intendedRecipient: string };
export class EventQuoteError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = 'EventQuoteError'; }
}
export interface EventQuoteService {
  status(scope: QuoteScope, actor: QuoteActor): Promise<{ enabled: boolean; reason: string | null; catalog: CatalogSnapshot | null; catalogDigest: string | null }>;
  read(scope: QuoteScope, actor: QuoteActor, eventId: string): Promise<EventQuoteView>;
  execute(scope: QuoteScope, actor: QuoteActor, eventId: string, command: unknown): Promise<EventQuoteView>;
}
