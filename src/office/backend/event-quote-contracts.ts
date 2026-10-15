import type { GourmetPaymentsV2Receipt } from './gourmet-payments-v2-wire';
// Explicitly composed private workflow. No provider, payment, booking or sending authority.
export type QuoteScope = Readonly<{ organizationId: string; workspaceId: string; mode: 'test' | 'commercial' }>;
export type QuoteActor = Readonly<{ actorId: string; durable: boolean; expiresAtMs: number; canWrite: boolean; canApprove: boolean }>;
export type BriefInput = { contactName: string; recipient: string; originalMessage: string; attendees: number; proposedDate: string; proposedLocation: string; requirements: string };
export type BriefVersion = BriefInput & { version: number; digest: string; actorId: string; createdAtMs: number; provenance: 'manual_intake'; reservationStatus: 'unconfirmed' };
export type CatalogSnapshot = { id: string; version: string; authority: 'test_only' | 'owner_authorized'; approvalRef: string; source: string; currency: 'USD'; validUntilMs: number; taxBps: number; depositBps: number; terms: string; items: { id: string; label: string; unit: string; unitPriceCents: number }[] };
export type QuoteSelection = { itemId: string; quantity: number };
export type QuoteVersion = { version: number; eventId: string; briefVersion: number; briefDigest: string; catalog: CatalogSnapshot; catalogDigest: string; lines: { catalogItemId: string; label: string; unit: string; qty: number; unitPriceCents: number }[]; currency: 'USD'; subtotalCents: number; taxCents: number; totalCents: number; depositCents: number; actorId: string; createdAtMs: number; digest: string; financialMeaning: 'unaccepted_quote'; artifact: { mediaType: 'text/html; charset=utf-8'; html: string; sha256: string; bytes: number } };
export type QuoteDecision = { id: string; quoteVersion: number; quoteDigest: string; briefDigest: string; catalogDigest: string; artifactSha256: string; intendedRecipient: string; actorId: string; atMs: number; status: 'approved_internal_unsent'; digest: string };
export type QuoteAudit = { sequence: number; action: 'create' | 'brief' | 'quote' | 'approve' | 'prepare_payment' | 'prepare_payment_v2' | 'configure_payment_v2' | 'register_payment_draft_v2'; actorId: string; atMs: number; commandKey: string; inputDigest: string; previousDigest: string | null; digest: string };
export type QuoteReceipt = { key: string; inputDigest: string; actorId: string; resultingRevision: number };
/** Internal preparation only. No executable provider payload, payment URL or payment assertion. */
export type PaymentLinkPreparation = {
  id: string; eventId: string; quoteVersion: number; quoteDigest: string; approvalDigest: string;
  briefDigest: string; catalogDigest: string; artifactSha256: string; intendedRecipient: string;
  currency: 'USD'; totalCents: number; depositCents: number; remainingCents: number; terms: string;
  actorId: string; atMs: number; status: 'pending_provider_review'; provider: 'gourmet_payments_legacy';
  providerEnabled: false; publicPaymentUrl: null; financialMeaning: 'unaccepted_quote';
  blockers: ['PROVIDER_DISABLED', 'LEGACY_TERMS_UNVERIFIED', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_SCHEDULE_REQUIRED'];
  digest: string;
};
export type PreparePaymentCommand = { key: string; expectedRevision: number; action: 'prepare_payment'; quoteVersion: number; quoteDigest: string; approvalDigest: string; artifactSha256: string };
export type PaymentContractModeV2 = 'retainer_50' | 'full_upfront' | 'fixed_49_reservation';
export type PaymentContractPreparationV2 = {
  contractVersion: 2; id: string; eventId: string; quoteVersion: number; quoteDigest: string; approvalDigest: string;
  briefDigest: string; catalogDigest: string; artifactSha256: string; intendedRecipient: string;
  currency: 'USD'; totalCents: number; depositCents: number; depositBasis: { kind: 'quoted_percentage'; basisPoints: number };
  remainingCents: number; terms: string; paymentMode: PaymentContractModeV2; initialPaymentCents: number;
  paymentBalanceCents: number; quotedDepositMatchesMode: boolean;
  paymentTerms: null; paymentSchedule: null; paymentTermsApproval: null; canonicalLeadId: null;
  actorId: string; atMs: number; status: 'pending_configuration'; provider: 'gourmet_payments_v2';
  providerEnabled: false; publicPaymentUrl: null; financialMeaning: 'unaccepted_quote';
  blockers: Array<'PROVIDER_DISABLED' | 'RECEIVER_V2_UNAVAILABLE' | 'CANONICAL_LEAD_REQUIRED' | 'LINK_EXPIRATION_REQUIRED' | 'PAYMENT_SCHEDULE_REQUIRED'
    | 'PAYMENT_TERMS_REQUIRED' | 'PAYMENT_TERMS_APPROVAL_REQUIRED' | 'QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED'>;
  digest: string;
};
export type PreparePaymentV2Command = Omit<PreparePaymentCommand, 'action'> & { action: 'prepare_payment_v2'; paymentMode: PaymentContractModeV2 };
export type PaymentScheduleConfigurationV2 = null
  | { kind: 'retainer_50'; eventDate: string; eventTime: string; timezone: string; balanceDate: string; balanceTime: string; timingExceptionReason: string | null }
  | { kind: 'fixed_49_reservation'; balanceDate: string; balanceTime: string; timezone: string; agreedBalanceCents: number };
export type PaymentLinkExpirationV2 = { kind: 'never' } | { kind: 'at'; date: string; time: string; timezone: string };
export type PaymentConfigurationFactsV2 = { paymentTerms: string; termsChangeReason: string | null; paymentSchedule: PaymentScheduleConfigurationV2; linkExpiration: PaymentLinkExpirationV2 };
export type PaymentConfigurationV2 = {
  id: string; digest: string; preparationId: string; preparationDigest: string;
  configuration: PaymentConfigurationFactsV2 & { contractVersion: 2; preparationId: string; paymentMode: PaymentContractModeV2; canonicalLeadId: string };
  leadSource: 'synthetic_fixture'; reviewDigest: string; actorId: string; atMs: number; status: 'draft_configuration';
};
export type PaymentDraftRegistrationV2 = {
  id: string; digest: string; configurationId: string; configurationDigest: string; preparationId: string; preparationDigest: string;
  reviewDigest: string; receipt: GourmetPaymentsV2Receipt; bodySha256: string; receiptDigest: string;
  actorId: string; atMs: number; status: 'draft_internal'; executable: false; providerEnabled: false; publicPaymentUrl: null; authorizationVerified: false;
};
export type ConfigurePaymentV2Command = PaymentConfigurationFactsV2 & { action: 'configure_payment_v2'; key: string; expectedRevision: number; preparationId: string; preparationDigest: string };
export type RegisterPaymentDraftV2Command = { action: 'register_payment_draft_v2'; key: string; expectedRevision: number; configurationId: string; configurationDigest: string; expectedReviewDigest: string };
/** Explicit synthetic-only composition. Neither callback supplies browser authority or a payment transport. */
export type TestPaymentDraftDependenciesV2 = {
  resolveCanonicalLead(scope: QuoteScope, eventId: string): Promise<{ source: 'synthetic_fixture'; canonicalLeadId: string } | null>;
  validateContract(body: string, nowMs: number, signal: AbortSignal): Promise<string>;
  validationTimeoutMs?: number;
};
// Schemas 1 and 2 retain their exact shapes. Only the first v2 preparation
// upgrades an aggregate to schema 3; old readers reject it closed.
export type EventQuoteRecord = { schemaVersion: 1 | 2 | 3 | 4; paymentPreparations?: PaymentLinkPreparation[]; paymentContractPreparationsV2?: PaymentContractPreparationV2[]; paymentConfigurationsV2?: PaymentConfigurationV2[]; paymentDraftRegistrationsV2?: PaymentDraftRegistrationV2[]; scope: QuoteScope; eventId: string; revision: number; briefs: BriefVersion[]; quotes: QuoteVersion[]; decisions: QuoteDecision[]; audit: QuoteAudit[]; receipts: QuoteReceipt[] };
export interface EventQuoteStore {
  read(scope: QuoteScope, eventId: string): Promise<EventQuoteRecord | null>;
  // Callback + record + audit + command receipt commit atomically. A throw rolls back.
  transact(scope: QuoteScope, eventId: string, change: (current: EventQuoteRecord | null) => EventQuoteRecord | Promise<EventQuoteRecord>): Promise<EventQuoteRecord>;
}
export type EventQuoteView = { record: EventQuoteRecord; currentQuoteStatus: 'missing' | 'pending_internal_review' | 'approved_internal_unsent' | 'obsolete'; externalEffectsEnabled: false };
export type QuoteCommand = ConfigurePaymentV2Command | RegisterPaymentDraftV2Command | PreparePaymentCommand | PreparePaymentV2Command | { key: string; expectedRevision: number; action: 'create'; brief: BriefInput } | { key: string; expectedRevision: number; action: 'brief'; brief: BriefInput } | { key: string; expectedRevision: number; action: 'quote'; expectedBriefDigest: string; expectedCatalogDigest: string; selections: QuoteSelection[] } | { key: string; expectedRevision: number; action: 'approve'; quoteVersion: number; quoteDigest: string; artifactSha256: string; intendedRecipient: string };
export class EventQuoteError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = 'EventQuoteError'; }
}
export interface EventQuoteService {
  status(scope: QuoteScope, actor: QuoteActor): Promise<{ enabled: boolean; reason: string | null; catalog: CatalogSnapshot | null; catalogDigest: string | null; paymentDraftsEnabled?: true }>;
  read(scope: QuoteScope, actor: QuoteActor, eventId: string): Promise<EventQuoteView>;
  execute(scope: QuoteScope, actor: QuoteActor, eventId: string, command: unknown): Promise<EventQuoteView>;
}
