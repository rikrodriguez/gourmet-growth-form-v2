import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { calculateQuoteTotals, QuoteCalculationError } from '../../operations/quote-calculation.mjs';
import { EventQuoteError, type BriefInput, type BriefVersion, type CatalogSnapshot, type EventQuoteRecord, type EventQuoteService, type EventQuoteStore, type EventQuoteView, type QuoteActor, type QuoteCommand, type QuoteScope, type QuoteVersion, type QuoteDecision, type PaymentLinkPreparation, type PaymentContractPreparationV2, type PaymentContractModeV2, type PaymentConfigurationV2, type PaymentDraftRegistrationV2, type PaymentConfigurationFactsV2, type TestPaymentDraftDependenciesV2 } from './event-quote-contracts';
import { renderQuoteArtifact } from './event-quote-renderer';
import { reviewValidatedPaymentPlanV2, snapshotInternalPaymentPreparationV2, type InternalPaymentPreparationV2 } from './gourmet-payments-agreement-v2';
import { prepareGourmetPaymentsV2Wire, decodeGourmetPaymentsV2Receipt, type GourmetPaymentsV2Receipt } from './gourmet-payments-v2-wire';

function fail(code: string, status = 400): never { throw new EventQuoteError(code, status); }
const MAX_BYTES = 512 * 1024;
function quoteTotals(input: Parameters<typeof calculateQuoteTotals>[0]) {
  try { return calculateQuoteTotals(input); }
  catch (error) { if (error instanceof QuoteCalculationError) fail(error.code === 'quote_total_limit' ? 'QUOTE_TOTAL_LIMIT' : 'INVALID_QUOTE', 422); throw error; }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
// Reject executable properties, exotic objects and lossy JSON before using input.
function plain(raw: unknown): unknown {
  let nodes = 0; const active = new Set<object>();
  const check = (value: unknown, depth: number): void => {
    if (++nodes > 50000 || depth > 32) fail('INVALID_INPUT');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || active.has(value)) fail('INVALID_INPUT');
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT');
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) fail('INVALID_INPUT');
    active.add(value);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !d || !('value' in d) || (!array || key !== 'length') && !d.enumerable || array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) fail('INVALID_INPUT');
      check(d.value, depth + 1);
    }
    active.delete(value);
  };
  check(raw, 0); const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded) > MAX_BYTES) fail('RECORD_LIMIT', 409);
  return JSON.parse(encoded);
}
function row(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail('INVALID_INPUT');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT'); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('INVALID_INPUT'); }
export function assertEventId(value: unknown): asserts value is string { text(value, 96); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('INVALID_ID'); }
export function assertQuoteScope(raw: unknown): asserts raw is QuoteScope {
  const s = row(plain(raw), ['organizationId', 'workspaceId', 'mode']); assertEventId(s.organizationId); assertEventId(s.workspaceId);
  if (!['test', 'commercial'].includes(s.mode as string)) fail('INVALID_SCOPE');
}
function actorCheck(raw: QuoteActor, scope: QuoteScope, now: number): void {
  const a = row(plain(raw), ['actorId', 'durable', 'expiresAtMs', 'canWrite', 'canApprove']); assertEventId(a.actorId);
  if (typeof a.durable !== 'boolean' || typeof a.canWrite !== 'boolean' || typeof a.canApprove !== 'boolean') fail('INVALID_ACTOR');
  integer(a.expiresAtMs); if (a.expiresAtMs <= now) fail('IDENTITY_EXPIRED', 403);
  if (scope.mode === 'commercial' && !a.durable) fail('DURABLE_IDENTITY_REQUIRED', 403);
}
function briefInput(raw: unknown): BriefInput {
  const b = row(plain(raw), ['contactName', 'recipient', 'originalMessage', 'attendees', 'proposedDate', 'proposedLocation', 'requirements']);
  text(b.contactName, 160); text(b.recipient, 254); if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(b.recipient)) fail('INVALID_RECIPIENT');
  text(b.originalMessage, 8000); integer(b.attendees, 1, 10000); text(b.proposedDate, 120); text(b.proposedLocation, 500); text(b.requirements, 8000);
  return b as BriefInput;
}
export function validateQuoteCatalog(raw: unknown, scope: QuoteScope, now: number): CatalogSnapshot {
  const c = row(plain(raw), ['id', 'version', 'authority', 'approvalRef', 'source', 'currency', 'validUntilMs', 'taxBps', 'depositBps', 'terms', 'items']);
  assertEventId(c.id); assertEventId(c.version); text(c.approvalRef, 200); text(c.source, 500); text(c.terms, 4000);
  if (c.currency !== 'USD') fail('UNSUPPORTED_CURRENCY');
  if (c.authority !== (scope.mode === 'test' ? 'test_only' : 'owner_authorized')) fail('CATALOG_NOT_AUTHORIZED', 503);
  integer(c.validUntilMs, 0, 8_640_000_000_000_000); if (c.validUntilMs <= now) fail('CATALOG_EXPIRED', 409);
  integer(c.taxBps, 0, 10000); integer(c.depositBps, 0, 10000);
  if (!Array.isArray(c.items) || !c.items.length || c.items.length > 100) fail('INVALID_CATALOG');
  const seen = new Set<string>();
  for (const rawItem of c.items) { const item = row(rawItem, ['id', 'label', 'unit', 'unitPriceCents']); assertEventId(item.id); text(item.label, 100); text(item.unit, 40); integer(item.unitPriceCents, 0, 1000000); if (seen.has(item.id)) fail('INVALID_CATALOG'); seen.add(item.id); }
  return c as CatalogSnapshot;
}
const withoutDigest = <T extends { digest: string }>(value: T): Omit<T, 'digest'> => { const { digest: _, ...rest } = value; return rest; };
export function assertEventQuoteRecord(raw: unknown, scope: QuoteScope, eventId: string): asserts raw is EventQuoteRecord {
  assertQuoteScope(scope); assertEventId(eventId);
  const clean = plain(raw);
  const version = (clean as { schemaVersion?: unknown } | null)?.schemaVersion;
  const r = row(clean, ['schemaVersion', 'scope', 'eventId', 'revision', 'briefs', 'quotes', 'decisions', 'audit', 'receipts', ...([2, 3, 4].includes(version as number) ? ['paymentPreparations'] : []), ...([3, 4].includes(version as number) ? ['paymentContractPreparationsV2'] : []), ...(version === 4 ? ['paymentConfigurationsV2', 'paymentDraftRegistrationsV2'] : [])]) as unknown as EventQuoteRecord;
  if (![1, 2, 3, 4].includes(r.schemaVersion) || canonical(r.scope) !== canonical(scope) || r.eventId !== eventId || r.schemaVersion === 4 && scope.mode !== 'test') fail('INVALID_RECORD');
  integer(r.revision, 1, 100);
  const preparations = r.paymentPreparations ?? [], preparationsV2 = r.paymentContractPreparationsV2 ?? [], configurations = r.paymentConfigurationsV2 ?? [], registrations = r.paymentDraftRegistrationsV2 ?? [];
  if (r.schemaVersion >= 2 && (!Array.isArray(r.paymentPreparations) || preparations.length > 20 || r.schemaVersion === 2 && !preparations.length)) fail('INVALID_RECORD');
  if (r.schemaVersion >= 3 && (!Array.isArray(preparationsV2) || !preparationsV2.length || preparationsV2.length > 20)) fail('INVALID_RECORD');
  if (r.schemaVersion === 4 && (!Array.isArray(r.paymentConfigurationsV2) || !configurations.length || configurations.length > 20 || !Array.isArray(r.paymentDraftRegistrationsV2) || registrations.length > 20)) fail('INVALID_RECORD');
  if (![r.briefs, r.quotes, r.decisions, r.audit, r.receipts].every(Array.isArray) || !r.briefs.length || r.briefs.length > 50 || r.quotes.length > 20 || r.decisions.length > 20 || r.audit.length !== r.revision || r.receipts.length !== r.revision) fail('INVALID_RECORD');
  r.briefs.forEach((b, i) => { row(b, ['contactName', 'recipient', 'originalMessage', 'attendees', 'proposedDate', 'proposedLocation', 'requirements', 'version', 'digest', 'actorId', 'createdAtMs', 'provenance', 'reservationStatus']); const { version, digest: hash, actorId, createdAtMs, provenance, reservationStatus, ...input } = b; briefInput(input); assertEventId(actorId); integer(createdAtMs); if (version !== i + 1 || provenance !== 'manual_intake' || reservationStatus !== 'unconfirmed' || hash !== digest(withoutDigest(b))) fail('INVALID_RECORD'); });
  r.quotes.forEach((q, i) => {
    row(q, ['version', 'eventId', 'briefVersion', 'briefDigest', 'catalog', 'catalogDigest', 'lines', 'currency', 'subtotalCents', 'taxCents', 'totalCents', 'depositCents', 'actorId', 'createdAtMs', 'digest', 'financialMeaning', 'artifact']);
    const b = r.briefs[q.briefVersion - 1]; assertEventId(q.actorId); integer(q.createdAtMs); validateQuoteCatalog(q.catalog, scope, q.createdAtMs);
    if (q.version !== i + 1 || q.eventId !== eventId || !b || q.briefDigest !== b.digest || q.catalogDigest !== digest(q.catalog) || q.currency !== q.catalog.currency || q.financialMeaning !== 'unaccepted_quote' || !Array.isArray(q.lines) || !q.lines.length || q.lines.length > 100) fail('INVALID_RECORD');
    const seen = new Set<string>();
    for (const line of q.lines) { row(line, ['catalogItemId', 'label', 'unit', 'qty', 'unitPriceCents']); const item = q.catalog.items.find(x => x.id === line.catalogItemId); if (!item || seen.has(item.id) || line.label !== item.label || line.unit !== item.unit || line.unitPriceCents !== item.unitPriceCents) fail('INVALID_RECORD'); seen.add(item.id); }
    const totals = calculateQuoteTotals({ lines: q.lines, taxBps: q.catalog.taxBps, depositBps: q.catalog.depositBps });
    if (Object.entries(totals).some(([key, value]) => q[key as keyof QuoteVersion] !== value)) fail('INVALID_RECORD');
    const { artifact, digest: hash, ...content } = q;
    if (hash !== digest(content) || canonical(artifact) !== canonical(renderQuoteArtifact({ ...content, digest: hash }, b))) fail('INVALID_RECORD');
  });
  r.decisions.forEach(d => { row(d, ['id', 'quoteVersion', 'quoteDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'intendedRecipient', 'actorId', 'atMs', 'status', 'digest']); assertEventId(d.id); assertEventId(d.actorId); integer(d.atMs); const q = r.quotes[d.quoteVersion - 1]; if (!q || d.status !== 'approved_internal_unsent' || d.digest !== digest(withoutDigest(d)) || d.quoteDigest !== q.digest || d.briefDigest !== q.briefDigest || d.catalogDigest !== q.catalogDigest || d.artifactSha256 !== q.artifact.sha256 || d.intendedRecipient !== r.briefs[q.briefVersion - 1].recipient) fail('INVALID_RECORD'); });
  const seen = new Set<string>();
  r.audit.forEach((a, i) => { row(a, ['sequence', 'action', 'actorId', 'atMs', 'commandKey', 'inputDigest', 'previousDigest', 'digest']); assertEventId(a.actorId); assertEventId(a.commandKey); integer(a.atMs); if (a.sequence !== i + 1 || !['create', 'brief', 'quote', 'approve', 'prepare_payment', 'prepare_payment_v2', 'configure_payment_v2', 'register_payment_draft_v2'].includes(a.action) || !/^[a-f0-9]{64}$/.test(a.inputDigest) || a.previousDigest !== (i ? r.audit[i - 1].digest : null) || a.digest !== digest(withoutDigest(a))) fail('INVALID_RECORD'); const receipt = r.receipts[i]; row(receipt, ['key', 'inputDigest', 'actorId', 'resultingRevision']); if (seen.has(receipt.key) || receipt.key !== a.commandKey || receipt.inputDigest !== a.inputDigest || receipt.actorId !== a.actorId || receipt.resultingRevision !== a.sequence) fail('INVALID_RECORD'); seen.add(receipt.key); });
  if (r.audit[0].action !== 'create' || r.audit.filter(x => x.action === 'create').length !== 1 || r.audit.filter(x => ['create', 'brief'].includes(x.action)).length !== r.briefs.length || r.audit.filter(x => x.action === 'quote').length !== r.quotes.length || r.audit.filter(x => x.action === 'approve').length !== r.decisions.length || r.audit.filter(x => x.action === 'prepare_payment').length !== preparations.length || r.audit.filter(x => x.action === 'prepare_payment_v2').length !== preparationsV2.length || r.audit.filter(x => x.action === 'configure_payment_v2').length !== configurations.length || r.audit.filter(x => x.action === 'register_payment_draft_v2').length !== registrations.length) fail('INVALID_RECORD');
  // Replay the bounded ledger: a self-consistent object hash alone is not proof
  // that this exact input was the command accepted at that revision.
  let briefIndex = 0, quoteIndex = 0, decisionIndex = 0, preparationIndex = 0, preparationV2Index = 0, configurationIndex = 0, registrationIndex = 0;
  const approved = new Set<number>(), prepared = new Set<number>(), preparedV2 = new Set<number>(), configured = new Set<string>(), registered = new Set<string>();
  r.audit.forEach((a, index) => {
    let command: QuoteCommand;
    if (index && a.atMs < r.audit[index - 1].atMs) fail('INVALID_RECORD');
    if (a.action === 'create' || a.action === 'brief') {
      const b = r.briefs[briefIndex++];
      if (b.actorId !== a.actorId || b.createdAtMs !== a.atMs) fail('INVALID_RECORD');
      const { version: _, digest: _d, actorId: _a, createdAtMs: _t, provenance: _p, reservationStatus: _s, ...brief } = b;
      command = { key: a.commandKey, expectedRevision: index, action: a.action, brief };
    } else if (a.action === 'quote') {
      const q = r.quotes[quoteIndex++];
      if (!briefIndex || q.briefVersion !== briefIndex || q.actorId !== a.actorId || q.createdAtMs !== a.atMs) fail('INVALID_RECORD');
      command = { key: a.commandKey, expectedRevision: index, action: 'quote', expectedBriefDigest: q.briefDigest, expectedCatalogDigest: q.catalogDigest, selections: q.lines.map(line => ({ itemId: line.catalogItemId, quantity: line.qty })) };
    } else if (a.action === 'approve') {
      const d = r.decisions[decisionIndex++], q = r.quotes[quoteIndex - 1];
      if (!q || approved.has(q.version) || d.id !== a.commandKey || d.quoteVersion !== quoteIndex || q.briefVersion !== briefIndex || d.actorId !== a.actorId || d.atMs !== a.atMs || q.catalog.validUntilMs <= a.atMs) fail('INVALID_RECORD');
      approved.add(q.version);
      command = { key: a.commandKey, expectedRevision: index, action: 'approve', quoteVersion: d.quoteVersion, quoteDigest: d.quoteDigest, artifactSha256: d.artifactSha256, intendedRecipient: d.intendedRecipient };
    } else if (a.action === 'prepare_payment') {
      const preparation = preparations[preparationIndex++], q = r.quotes[quoteIndex - 1];
      const d = r.decisions.slice(0, decisionIndex).find(decision => decision.quoteDigest === q?.digest);
      if (!q || !d || !approved.has(q.version) || prepared.has(q.version) || q.briefVersion !== briefIndex || q.catalog.validUntilMs <= a.atMs
        || canonical(preparation) !== canonical(paymentPreparation(scope, eventId, q, d, a.actorId, a.atMs))) fail('INVALID_RECORD');
      prepared.add(q.version);
      command = { key: a.commandKey, expectedRevision: index, action: 'prepare_payment', quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: d.digest, artifactSha256: q.artifact.sha256 };
    } else if (a.action === 'prepare_payment_v2') {
      const preparation = preparationsV2[preparationV2Index++], q = r.quotes[quoteIndex - 1];
      const d = r.decisions.slice(0, decisionIndex).find(decision => decision.quoteDigest === q?.digest);
      if (!preparation || !q || !d || !approved.has(q.version) || preparedV2.has(q.version)
        || !['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(preparation.paymentMode)
        || q.briefVersion !== briefIndex || q.catalog.validUntilMs <= a.atMs
        || canonical(preparation) !== canonical(paymentContractPreparationV2(scope, eventId, q, d, preparation.paymentMode, a.actorId, a.atMs))) fail('INVALID_RECORD');
      preparedV2.add(q.version);
      command = { key: a.commandKey, expectedRevision: index, action: 'prepare_payment_v2', quoteVersion: q.version,
        quoteDigest: q.digest, approvalDigest: d.digest, artifactSha256: q.artifact.sha256, paymentMode: preparation.paymentMode };
    } else if (a.action === 'configure_payment_v2') {
      const entry = configurations[configurationIndex++], q = r.quotes[quoteIndex - 1];
      const p = preparationsV2.slice(0, preparationV2Index).find(p => p.id === entry?.preparationId);
      if (!entry || !p || !q || configured.has(p.id) || q.digest !== p.quoteDigest || q.briefVersion !== briefIndex || q.catalog.validUntilMs <= a.atMs
        || entry.id !== a.commandKey || entry.preparationDigest !== p.digest || entry.atMs !== a.atMs || entry.actorId !== a.actorId || a.atMs < p.atMs)
        fail('INVALID_RECORD');
      const facts = configurationFacts(entry.configuration);
      if (canonical(entry) !== canonical(paymentConfiguration(scope, eventId, p, q, facts, entry.configuration.canonicalLeadId, a.actorId, a.atMs, a.commandKey))) fail('INVALID_RECORD');
      configured.add(p.id);
      command = { action: 'configure_payment_v2', key: a.commandKey, expectedRevision: index, preparationId: p.id, preparationDigest: p.digest, ...facts };
    } else {
      const entry = registrations[registrationIndex++], q = r.quotes[quoteIndex - 1];
      const c = configurations.slice(0, configurationIndex).find(c => c.id === entry?.configurationId);
      const p = preparationsV2.slice(0, preparationV2Index).find(p => p.id === c?.preparationId);
      if (!entry || !c || !p || !q || registered.has(c.id) || q.digest !== p.quoteDigest || q.briefVersion !== briefIndex || q.catalog.validUntilMs <= a.atMs
        || entry.id !== a.commandKey || entry.actorId !== a.actorId || entry.atMs !== a.atMs || a.atMs < c.atMs) fail('INVALID_RECORD');
      const review = reviewValidatedPaymentPlanV2({ scope, eventId, preparation: p, quote: q, configuration: c.configuration, nowMs: a.atMs });
      if (review.status !== 'review_required' || review.reviewDigest !== c.reviewDigest) fail('INVALID_RECORD');
      const snapshot = snapshotInternalPaymentPreparationV2(review, a.actorId, a.atMs);
      const receipt: GourmetPaymentsV2Receipt = { status: 'contract_validated_internal', prepared: snapshot, executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false };
      if (canonical(entry) !== canonical(paymentDraftRegistration(c, snapshot, receipt, a.actorId, a.atMs, a.commandKey))) fail('INVALID_RECORD');
      registered.add(c.id);
      command = { action: 'register_payment_draft_v2', key: a.commandKey, expectedRevision: index, configurationId: c.id, configurationDigest: c.digest, expectedReviewDigest: c.reviewDigest };
    }
    commandInput(command);
    if (a.inputDigest !== digest({ scope, eventId, actorId: a.actorId, command })) fail('INVALID_RECORD');
  });
}
function commandInput(raw: unknown): QuoteCommand {
  const clean = plain(raw) as QuoteCommand; if (!clean || typeof clean !== 'object') fail('INVALID_COMMAND');
  const fields = clean.action === 'create' || clean.action === 'brief' ? ['brief'] : clean.action === 'quote' ? ['expectedBriefDigest', 'expectedCatalogDigest', 'selections'] : clean.action === 'approve' ? ['quoteVersion', 'quoteDigest', 'artifactSha256', 'intendedRecipient'] : clean.action === 'prepare_payment' ? ['quoteVersion', 'quoteDigest', 'approvalDigest', 'artifactSha256'] : clean.action === 'prepare_payment_v2' ? ['quoteVersion', 'quoteDigest', 'approvalDigest', 'artifactSha256', 'paymentMode'] : clean.action === 'configure_payment_v2' ? ['preparationId', 'preparationDigest', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration'] : clean.action === 'register_payment_draft_v2' ? ['configurationId', 'configurationDigest', 'expectedReviewDigest'] : fail('INVALID_COMMAND');
  row(clean, ['key', 'expectedRevision', 'action', ...fields]); assertEventId(clean.key); integer(clean.expectedRevision, 0, 100);
  if (clean.action === 'create' || clean.action === 'brief') briefInput(clean.brief);
  else if (clean.action === 'quote') { for (const hash of [clean.expectedBriefDigest, clean.expectedCatalogDigest]) if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_COMMAND'); if (!Array.isArray(clean.selections) || !clean.selections.length || clean.selections.length > 100) fail('INVALID_COMMAND'); const seen = new Set<string>(); for (const selection of clean.selections) { row(selection, ['itemId', 'quantity']); assertEventId(selection.itemId); integer(selection.quantity, 1, 1000); if (seen.has(selection.itemId)) fail('DUPLICATE_ITEM'); seen.add(selection.itemId); } }
  else if (clean.action === 'configure_payment_v2') {
    assertEventId(clean.preparationId); hashField(clean.preparationDigest); text(clean.paymentTerms, 4000);
    if (clean.termsChangeReason !== null) text(clean.termsChangeReason, 2000);
  } else if (clean.action === 'register_payment_draft_v2') {
    assertEventId(clean.configurationId); hashField(clean.configurationDigest); hashField(clean.expectedReviewDigest);
  } else { integer(clean.quoteVersion, 1, 20); for (const hash of [clean.quoteDigest, clean.artifactSha256]) if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_COMMAND'); if (clean.action === 'approve') text(clean.intendedRecipient, 254); else if (typeof clean.approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(clean.approvalDigest)) fail('INVALID_COMMAND'); }
  if (clean.action === 'prepare_payment_v2' && !['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(clean.paymentMode)) fail('INVALID_COMMAND');
  return clean;
}
function view(record: EventQuoteRecord, catalog: CatalogSnapshot | null): EventQuoteView {
  const q = record.quotes.at(-1), b = record.briefs.at(-1)!;
  const status = !q ? 'missing' : q.briefDigest !== b.digest || !catalog || q.catalogDigest !== digest(catalog) ? 'obsolete' : record.decisions.some(d => d.quoteDigest === q.digest) ? 'approved_internal_unsent' : 'pending_internal_review';
  return { record: structuredClone(record), currentQuoteStatus: status, externalEffectsEnabled: false };
}
export function createEventQuoteService(deps: { store: EventQuoteStore; catalogFor: (scope: QuoteScope) => Promise<CatalogSnapshot | null>; clock?: () => number; testPaymentDrafts?: TestPaymentDraftDependenciesV2 }): EventQuoteService {
  const clock = deps.clock ?? Date.now;
  const drafts = deps.testPaymentDrafts;
  const validationTimeout = drafts?.validationTimeoutMs ?? 2000;
  if (drafts && (!Number.isFinite(validationTimeout) || validationTimeout <= 0 || validationTimeout > 5000
    || typeof drafts.resolveCanonicalLead !== 'function' || typeof drafts.validateContract !== 'function')) fail('INVALID_PAYMENT_VALIDATION_TIMEOUT', 500);
  async function catalog(scope: QuoteScope): Promise<CatalogSnapshot> { const raw = await deps.catalogFor(scope); if (!raw) fail('AUTHORIZED_CATALOG_REQUIRED', 503); return validateQuoteCatalog(raw, scope, clock()); }
  return {
    async status(scope, actor) { assertQuoteScope(scope); try { actorCheck(actor, scope, clock()); scope = structuredClone(scope); actor = structuredClone(actor); const c = await catalog(scope); actorCheck(actor, scope, clock()); return { enabled: actor.canWrite, reason: actor.canWrite ? null : 'READ_ONLY', catalog: c, catalogDigest: digest(c), ...(drafts && scope.mode === 'test' && c.authority === 'test_only' ? { paymentDraftsEnabled: true as const } : {}) }; } catch (error) { if (!(error instanceof EventQuoteError)) throw error; return { enabled: false, reason: error.code, catalog: null, catalogDigest: null }; } },
    async read(scope, actor, eventId) { assertQuoteScope(scope); actorCheck(actor, scope, clock()); assertEventId(eventId); scope = structuredClone(scope); actor = structuredClone(actor); const r = await deps.store.read(scope, eventId); actorCheck(actor, scope, clock()); if (!r) fail('EVENT_NOT_FOUND', 404); assertEventQuoteRecord(r, scope, eventId); let c: CatalogSnapshot | null = null; try { c = await catalog(scope); } catch (error) { if (!(error instanceof EventQuoteError)) throw error; } actorCheck(actor, scope, clock()); return view(r, c); },
    async execute(scope, actor, eventId, raw) {
      assertQuoteScope(scope); actorCheck(actor, scope, clock()); assertEventId(eventId); if (!actor.canWrite) fail('WRITE_FORBIDDEN', 403);
      scope = structuredClone(scope); actor = structuredClone(actor);
      const input = commandInput(raw);
      if (['approve', 'prepare_payment', 'prepare_payment_v2', 'configure_payment_v2', 'register_payment_draft_v2'].includes(input.action) && !actor.canApprove) fail('APPROVAL_FORBIDDEN', 403);
      const paymentDraftAction = input.action === 'configure_payment_v2' || input.action === 'register_payment_draft_v2';
      // This gate also applies to replay: stored evidence never turns an absent
      // synthetic test composition or commercial scope into an enabled feature.
      if (paymentDraftAction) {
        if (scope.mode !== 'test') fail('PAYMENT_DRAFTS_TEST_ONLY', 403);
        if (!drafts) fail('PAYMENT_DRAFTS_DISABLED', 503);
      }
      const hash = digest({ scope, eventId, actorId: actor.actorId, command: input });
      const result = await deps.store.transact(scope, eventId, async current => {
        // Catalogue, identity deadline and clock are checked after acquiring the
        // storage lock, never only at the start of a potentially queued request.
        const c = await catalog(scope); let now = clock(); integer(now);
        actorCheck(actor, scope, now); validateQuoteCatalog(c, scope, now);
        if (current) assertEventQuoteRecord(current, scope, eventId);
        const receipt = current?.receipts.find(x => x.key === input.key);
        if (receipt) { if (receipt.inputDigest !== hash || receipt.actorId !== actor.actorId) fail('IDEMPOTENCY_CONFLICT', 409); return current!; }
        if ((current?.revision ?? 0) !== input.expectedRevision) fail('REVISION_CONFLICT', 409);
        if (input.action === 'create' ? !!current : !current) fail(input.action === 'create' ? 'EVENT_EXISTS' : 'EVENT_NOT_FOUND', 409);
        const r: EventQuoteRecord = current ? structuredClone(current) : { schemaVersion: 1, scope: structuredClone(scope), eventId, revision: 0, briefs: [], quotes: [], decisions: [], audit: [], receipts: [] };
        if (r.revision >= 100) fail('RECORD_LIMIT', 409);
        if (current && now < current.audit.at(-1)!.atMs) fail('CLOCK_REGRESSION', 409);
        if (input.action === 'create' || input.action === 'brief') {
          if (r.briefs.length >= 50) fail('RECORD_LIMIT', 409);
          const content = { ...briefInput(input.brief), version: r.briefs.length + 1, actorId: actor.actorId, createdAtMs: now, provenance: 'manual_intake' as const, reservationStatus: 'unconfirmed' as const };
          r.briefs.push({ ...content, digest: digest(content) });
        } else if (input.action === 'quote') {
          const b = r.briefs.at(-1)!;
          if (b.digest !== input.expectedBriefDigest || digest(c) !== input.expectedCatalogDigest) fail('STALE_CONTEXT', 409);
          if (r.quotes.length >= 20) fail('RECORD_LIMIT', 409);
          const lines = input.selections.map(s => { const item = c.items.find(x => x.id === s.itemId); if (!item) fail('CATALOG_ITEM_MISSING', 409); return { catalogItemId: item.id, label: item.label, unit: item.unit, qty: s.quantity, unitPriceCents: item.unitPriceCents }; });
          const content = { version: r.quotes.length + 1, eventId, briefVersion: b.version, briefDigest: b.digest, catalog: structuredClone(c), catalogDigest: digest(c), lines, currency: c.currency, ...quoteTotals({ lines, taxBps: c.taxBps, depositBps: c.depositBps }), actorId: actor.actorId, createdAtMs: now, financialMeaning: 'unaccepted_quote' as const };
          const q = { ...content, digest: digest(content) }; r.quotes.push({ ...q, artifact: renderQuoteArtifact(q, b) });
        } else if (input.action === 'approve') {
          const q = r.quotes.at(-1), b = r.briefs.at(-1)!;
          if (!q || q.version !== input.quoteVersion || q.digest !== input.quoteDigest || q.artifact.sha256 !== input.artifactSha256 || input.intendedRecipient !== b.recipient || q.briefDigest !== b.digest || q.catalogDigest !== digest(c)) fail('STALE_REVIEW', 409);
          if (r.decisions.some(d => d.quoteDigest === q.digest)) fail('ALREADY_APPROVED', 409);
          const decision = { id: input.key, quoteVersion: q.version, quoteDigest: q.digest, briefDigest: b.digest, catalogDigest: q.catalogDigest, artifactSha256: q.artifact.sha256, intendedRecipient: b.recipient, actorId: actor.actorId, atMs: now, status: 'approved_internal_unsent' as const };
          r.decisions.push({ ...decision, digest: digest(decision) });
        } else if (input.action === 'configure_payment_v2' || input.action === 'register_payment_draft_v2') {
          let lastPaymentClock = now;
          const refresh = async (q: QuoteVersion): Promise<number> => {
            const fresh = await catalog(scope), checked = clock(); integer(checked); actorCheck(actor, scope, checked);
            validateQuoteCatalog(fresh, scope, checked);
            if (checked < lastPaymentClock) fail('CLOCK_REGRESSION', 409);
            lastPaymentClock = checked;
            if (fresh.authority !== 'test_only' || digest(fresh) !== q.catalogDigest) fail('STALE_PAYMENT_CONFIGURATION', 409);
            return checked;
          };
          const resolveLead = async (): Promise<string> => {
            let result: unknown;
            try { result = await drafts!.resolveCanonicalLead(structuredClone(scope), eventId); }
            catch { fail('SYNTHETIC_CANONICAL_LEAD_REQUIRED', 503); }
            if (!result) fail('SYNTHETIC_CANONICAL_LEAD_REQUIRED', 422);
            const lead = row(plain(result), ['source', 'canonicalLeadId']);
            if (lead.source !== 'synthetic_fixture') fail('SYNTHETIC_CANONICAL_LEAD_REQUIRED', 422);
            text(lead.canonicalLeadId, 180);
            if ((lead.canonicalLeadId as string).trim() !== lead.canonicalLeadId || /[\r\n\t]/.test(lead.canonicalLeadId as string)) fail('SYNTHETIC_CANONICAL_LEAD_REQUIRED', 422);
            return lead.canonicalLeadId as string;
          };
          if (input.action === 'configure_payment_v2') {
            const { p, q } = currentPaymentSource(r, input.preparationId, input.preparationDigest, digest(c));
            if (r.paymentConfigurationsV2?.some(entry => entry.preparationId === p.id)) fail('PAYMENT_CONFIGURATION_ALREADY_EXISTS', 409);
            if ((r.paymentConfigurationsV2?.length ?? 0) >= 20) fail('RECORD_LIMIT', 409);
            const lead = await resolveLead(); now = await refresh(q);
            const entry = paymentConfiguration(scope, eventId, p, q, input, lead, actor.actorId, now, input.key);
            r.schemaVersion = 4; r.paymentConfigurationsV2 ??= []; r.paymentDraftRegistrationsV2 ??= [];
            r.paymentConfigurationsV2.push(entry);
          } else {
            const configuration = r.paymentConfigurationsV2?.find(entry => entry.id === input.configurationId);
            if (!configuration || configuration.digest !== input.configurationDigest || configuration.reviewDigest !== input.expectedReviewDigest)
              fail('STALE_PAYMENT_CONFIGURATION', 409);
            const { p, q } = currentPaymentSource(r, configuration.preparationId, configuration.preparationDigest, digest(c));
            if (r.paymentDraftRegistrationsV2?.some(entry => entry.configurationId === configuration.id)) fail('PAYMENT_DRAFT_ALREADY_REGISTERED', 409);
            if ((r.paymentDraftRegistrationsV2?.length ?? 0) >= 20) fail('RECORD_LIMIT', 409);
            if (await resolveLead() !== configuration.configuration.canonicalLeadId) fail('STALE_PAYMENT_CONFIGURATION', 409);
            now = await refresh(q);
            const wire = prepareGourmetPaymentsV2Wire({ scope, eventId, record: r, preparationId: p.id,
              currentCatalogDigest: q.catalogDigest, configuration: configuration.configuration, nowMs: now },
            { actor, expectedReviewDigest: input.expectedReviewDigest });
            if (wire.status !== 'prepared_wire_internal') fail(wire.code, 422);
            const raw = await boundedContractValidation(drafts!, wire.body, now, validationTimeout);
            const receipt = decodeGourmetPaymentsV2Receipt(raw, wire);
            if (receipt.status !== 'contract_validated_internal') fail(receipt.code === 'INVALID_PAYMENT_PLAN_V2_RECEIPT' ? 'INVALID_PAYMENT_CONTRACT_RECEIPT' : 'PAYMENT_CONTRACT_REJECTED', 422);
            await refresh(q);
            if (await resolveLead() !== configuration.configuration.canonicalLeadId) fail('STALE_PAYMENT_CONFIGURATION', 409);
            const completedAt = await refresh(q);
            const finalReview = reviewValidatedPaymentPlanV2({ scope, eventId, preparation: p, quote: q, configuration: configuration.configuration, nowMs: completedAt });
            if (finalReview.status !== 'review_required' || finalReview.reviewDigest !== configuration.reviewDigest) fail('STALE_PAYMENT_CONFIGURATION', 409);
            r.paymentDraftRegistrationsV2!.push(paymentDraftRegistration(configuration, wire.prepared, receipt, actor.actorId, now, input.key));
          }
        } else {
          const q = r.quotes.at(-1), b = r.briefs.at(-1)!;
          const decision = r.decisions.find(d => d.quoteDigest === q?.digest);
          if (!q || !decision || input.quoteVersion !== q.version || input.quoteDigest !== q.digest
            || input.approvalDigest !== decision.digest || input.artifactSha256 !== q.artifact.sha256
            || q.briefDigest !== b.digest || q.catalogDigest !== digest(c)) fail('STALE_PAYMENT_PREPARATION', 409);
          if (input.action === 'prepare_payment') {
            if (r.paymentPreparations?.some(item => item.quoteDigest === q.digest)) fail('PAYMENT_ALREADY_PREPARED', 409);
            if (r.schemaVersion === 1) r.schemaVersion = 2;
            r.paymentPreparations ??= [];
            r.paymentPreparations.push(paymentPreparation(scope, eventId, q, decision, actor.actorId, now));
          } else {
            if (r.paymentContractPreparationsV2?.some(item => item.quoteDigest === q.digest)) fail('PAYMENT_V2_ALREADY_PREPARED', 409);
            const preparation = paymentContractPreparationV2(scope, eventId, q, decision, input.paymentMode, actor.actorId, now);
            if (r.schemaVersion < 3) r.schemaVersion = 3;
            r.paymentPreparations ??= [];
            r.paymentContractPreparationsV2 ??= [];
            r.paymentContractPreparationsV2.push(preparation);
          }
        }
        r.revision++;
        const audit = { sequence: r.revision, action: input.action, actorId: actor.actorId, atMs: now, commandKey: input.key, inputDigest: hash, previousDigest: r.audit.at(-1)?.digest ?? null };
        r.audit.push({ ...audit, digest: digest(audit) }); r.receipts.push({ key: input.key, inputDigest: hash, actorId: actor.actorId, resultingRevision: r.revision });
        assertEventQuoteRecord(r, scope, eventId); return r;
      });
      let latestCatalog: CatalogSnapshot | null = null;
      try { latestCatalog = await catalog(scope); } catch (error) { if (!(error instanceof EventQuoteError)) throw error; }
      actorCheck(actor, scope, clock());
      return view(result, latestCatalog);
    },
  };
}

function hashField(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_COMMAND');
}
function configurationFacts(value: PaymentConfigurationFactsV2): PaymentConfigurationFactsV2 {
  if (!value || typeof value !== 'object') fail('INVALID_RECORD');
  return { paymentTerms: value.paymentTerms, termsChangeReason: value.termsChangeReason,
    paymentSchedule: structuredClone(value.paymentSchedule), linkExpiration: structuredClone(value.linkExpiration) };
}
function currentPaymentSource(record: EventQuoteRecord, preparationId: string, preparationDigest: string, currentCatalogDigest: string) {
  const p = record.paymentContractPreparationsV2?.find(entry => entry.id === preparationId);
  const q = record.quotes.at(-1), b = record.briefs.at(-1);
  if (!p || !q || !b || p.digest !== preparationDigest || p.quoteDigest !== q.digest || q.briefDigest !== b.digest || q.catalogDigest !== currentCatalogDigest)
    fail('STALE_PAYMENT_CONFIGURATION', 409);
  return { p, q };
}
function paymentConfiguration(scope: QuoteScope, eventId: string, preparation: PaymentContractPreparationV2, quote: QuoteVersion,
  facts: PaymentConfigurationFactsV2, canonicalLeadId: string, actorId: string, atMs: number, id: string): PaymentConfigurationV2 {
  const configuration = { contractVersion: 2 as const, preparationId: preparation.id, paymentMode: preparation.paymentMode, canonicalLeadId,
    ...configurationFacts(facts) };
  const review = reviewValidatedPaymentPlanV2({ scope, eventId, preparation, quote, configuration, nowMs: atMs });
  if (review.status !== 'review_required') fail(review.code, 422);
  const content = { id, preparationId: preparation.id, preparationDigest: preparation.digest, configuration,
    leadSource: 'synthetic_fixture' as const, reviewDigest: review.reviewDigest, actorId, atMs, status: 'draft_configuration' as const };
  return { ...content, digest: digest(content) };
}
function paymentDraftRegistration(configuration: PaymentConfigurationV2, prepared: InternalPaymentPreparationV2,
  receipt: GourmetPaymentsV2Receipt, actorId: string, atMs: number, id: string): PaymentDraftRegistrationV2 {
  const content = { id, configurationId: configuration.id, configurationDigest: configuration.digest,
    preparationId: configuration.preparationId, preparationDigest: configuration.preparationDigest,
    reviewDigest: configuration.reviewDigest, receipt: structuredClone(receipt), bodySha256: digest(prepared), receiptDigest: digest(receipt),
    actorId, atMs, status: 'draft_internal' as const, executable: false as const, providerEnabled: false as const,
    publicPaymentUrl: null, authorizationVerified: false as const };
  return { ...content, digest: digest(content) };
}
async function boundedContractValidation(deps: TestPaymentDraftDependenciesV2, body: string, nowMs: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineAt = performance.now() + timeoutMs;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new EventQuoteError('PAYMENT_VALIDATION_TIMEOUT', 503)); controller.abort();
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => deps.validateContract(body, nowMs, controller.signal)), deadline]);
    // A synchronous test callback may block the timer's event-loop turn. The
    // monotonic deadline still prevents accepting its late result or appending.
    if (performance.now() >= deadlineAt) { controller.abort(); throw new EventQuoteError('PAYMENT_VALIDATION_TIMEOUT', 503); }
    return result;
  }
  catch (error) { if (error instanceof EventQuoteError && error.code === 'PAYMENT_VALIDATION_TIMEOUT') throw error; return fail('PAYMENT_CONTRACT_UNAVAILABLE', 503); }
  finally { if (timer) clearTimeout(timer); }
}

/** Reuses the original Payments quote/version/idempotency boundary without
 * pretending that its fixed reservation fee or schedules match this quote.
 * No transport, credentials, environment flag or external adapter is accepted. */
function paymentPreparation(scope: QuoteScope, eventId: string, quote: QuoteVersion, decision: QuoteDecision, actorId: string, atMs: number): PaymentLinkPreparation {
  const content = {
    id: `payment-preparation-${digest({ scope, eventId, quoteVersion: quote.version, quoteDigest: quote.digest, approvalDigest: decision.digest })}`,
    eventId, quoteVersion: quote.version, quoteDigest: quote.digest, approvalDigest: decision.digest,
    briefDigest: quote.briefDigest, catalogDigest: quote.catalogDigest, artifactSha256: quote.artifact.sha256,
    intendedRecipient: decision.intendedRecipient, currency: quote.currency, totalCents: quote.totalCents,
    depositCents: quote.depositCents, remainingCents: quote.totalCents - quote.depositCents, terms: quote.catalog.terms,
    actorId, atMs, status: 'pending_provider_review' as const, provider: 'gourmet_payments_legacy' as const,
    providerEnabled: false as const, publicPaymentUrl: null, financialMeaning: 'unaccepted_quote' as const,
    blockers: ['PROVIDER_DISABLED', 'LEGACY_TERMS_UNVERIFIED', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_SCHEDULE_REQUIRED'] as PaymentLinkPreparation['blockers'],
  };
  return { ...content, digest: digest(content) };
}

/** Records an explicit mode selection, never an approved payment agreement.
 * The original quote remains authoritative history; all new configuration and
 * terms approval are absent until a separately reviewed workflow supplies them. */
function paymentContractPreparationV2(scope: QuoteScope, eventId: string, quote: QuoteVersion, decision: QuoteDecision, paymentMode: PaymentContractModeV2, actorId: string, atMs: number): PaymentContractPreparationV2 {
  if (paymentMode === 'fixed_49_reservation' && quote.totalCents <= 4900) fail('FIXED_RESERVATION_TOTAL_REQUIRED', 422);
  const initialPaymentCents = paymentMode === 'retainer_50' ? Number((BigInt(quote.totalCents) + 1n) / 2n)
    : paymentMode === 'full_upfront' ? quote.totalCents : 4900;
  // This comparison only describes quoted arithmetic. It grants no authority
  // over the new mode, conditions, schedule, receiver or eventual dispatch.
  const quotedDepositMatchesMode = paymentMode !== 'fixed_49_reservation' && initialPaymentCents === quote.depositCents
    && quote.catalog.depositBps === (paymentMode === 'retainer_50' ? 5000 : 10000);
  const blockers: PaymentContractPreparationV2['blockers'] = ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE', 'CANONICAL_LEAD_REQUIRED', 'LINK_EXPIRATION_REQUIRED'];
  if (paymentMode !== 'full_upfront') blockers.push('PAYMENT_SCHEDULE_REQUIRED');
  blockers.push('PAYMENT_TERMS_REQUIRED', 'PAYMENT_TERMS_APPROVAL_REQUIRED');
  if (!quotedDepositMatchesMode) blockers.push('QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED');
  const content = {
    contractVersion: 2 as const,
    id: `payment-contract-v2-${digest({ contractVersion: 2, scope, eventId, quoteVersion: quote.version, quoteDigest: quote.digest, approvalDigest: decision.digest, paymentMode })}`,
    eventId, quoteVersion: quote.version, quoteDigest: quote.digest, approvalDigest: decision.digest,
    briefDigest: quote.briefDigest, catalogDigest: quote.catalogDigest, artifactSha256: quote.artifact.sha256,
    intendedRecipient: decision.intendedRecipient, currency: quote.currency, totalCents: quote.totalCents,
    depositCents: quote.depositCents, depositBasis: { kind: 'quoted_percentage' as const, basisPoints: quote.catalog.depositBps },
    remainingCents: quote.totalCents - quote.depositCents, terms: quote.catalog.terms,
    paymentMode, initialPaymentCents, paymentBalanceCents: quote.totalCents - initialPaymentCents, quotedDepositMatchesMode,
    paymentTerms: null, paymentSchedule: null, paymentTermsApproval: null, canonicalLeadId: null,
    actorId, atMs, status: 'pending_configuration' as const, provider: 'gourmet_payments_v2' as const,
    providerEnabled: false as const, publicPaymentUrl: null, financialMeaning: 'unaccepted_quote' as const, blockers,
  };
  return { ...content, digest: digest(content) };
}
