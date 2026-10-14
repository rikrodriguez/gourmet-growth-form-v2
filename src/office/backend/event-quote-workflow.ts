import { createHash } from 'node:crypto';
import { calculateQuoteTotals, QuoteCalculationError } from '../../operations/quote-calculation.mjs';
import { EventQuoteError, type BriefInput, type BriefVersion, type CatalogSnapshot, type EventQuoteRecord, type EventQuoteService, type EventQuoteStore, type EventQuoteView, type QuoteActor, type QuoteCommand, type QuoteScope, type QuoteVersion, type QuoteDecision, type PaymentLinkPreparation, type PaymentContractPreparationV2, type PaymentContractModeV2 } from './event-quote-contracts';
import { renderQuoteArtifact } from './event-quote-renderer';

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
  const r = row(clean, ['schemaVersion', 'scope', 'eventId', 'revision', 'briefs', 'quotes', 'decisions', 'audit', 'receipts', ...([2, 3].includes(version as number) ? ['paymentPreparations'] : []), ...(version === 3 ? ['paymentContractPreparationsV2'] : [])]) as unknown as EventQuoteRecord;
  if (![1, 2, 3].includes(r.schemaVersion) || canonical(r.scope) !== canonical(scope) || r.eventId !== eventId) fail('INVALID_RECORD');
  integer(r.revision, 1, 100);
  const preparations = r.paymentPreparations ?? [], preparationsV2 = r.paymentContractPreparationsV2 ?? [];
  if (r.schemaVersion >= 2 && (!Array.isArray(r.paymentPreparations) || preparations.length > 20 || r.schemaVersion === 2 && !preparations.length)) fail('INVALID_RECORD');
  if (r.schemaVersion === 3 && (!Array.isArray(preparationsV2) || !preparationsV2.length || preparationsV2.length > 20)) fail('INVALID_RECORD');
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
  r.audit.forEach((a, i) => { row(a, ['sequence', 'action', 'actorId', 'atMs', 'commandKey', 'inputDigest', 'previousDigest', 'digest']); assertEventId(a.actorId); assertEventId(a.commandKey); integer(a.atMs); if (a.sequence !== i + 1 || !['create', 'brief', 'quote', 'approve', 'prepare_payment', 'prepare_payment_v2'].includes(a.action) || !/^[a-f0-9]{64}$/.test(a.inputDigest) || a.previousDigest !== (i ? r.audit[i - 1].digest : null) || a.digest !== digest(withoutDigest(a))) fail('INVALID_RECORD'); const receipt = r.receipts[i]; row(receipt, ['key', 'inputDigest', 'actorId', 'resultingRevision']); if (seen.has(receipt.key) || receipt.key !== a.commandKey || receipt.inputDigest !== a.inputDigest || receipt.actorId !== a.actorId || receipt.resultingRevision !== a.sequence) fail('INVALID_RECORD'); seen.add(receipt.key); });
  if (r.audit[0].action !== 'create' || r.audit.filter(x => x.action === 'create').length !== 1 || r.audit.filter(x => ['create', 'brief'].includes(x.action)).length !== r.briefs.length || r.audit.filter(x => x.action === 'quote').length !== r.quotes.length || r.audit.filter(x => x.action === 'approve').length !== r.decisions.length || r.audit.filter(x => x.action === 'prepare_payment').length !== preparations.length || r.audit.filter(x => x.action === 'prepare_payment_v2').length !== preparationsV2.length) fail('INVALID_RECORD');
  // Replay the bounded ledger: a self-consistent object hash alone is not proof
  // that this exact input was the command accepted at that revision.
  let briefIndex = 0, quoteIndex = 0, decisionIndex = 0, preparationIndex = 0, preparationV2Index = 0;
  const approved = new Set<number>(), prepared = new Set<number>(), preparedV2 = new Set<number>();
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
    } else {
      const preparation = preparationsV2[preparationV2Index++], q = r.quotes[quoteIndex - 1];
      const d = r.decisions.slice(0, decisionIndex).find(decision => decision.quoteDigest === q?.digest);
      if (!preparation || !q || !d || !approved.has(q.version) || preparedV2.has(q.version)
        || !['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(preparation.paymentMode)
        || q.briefVersion !== briefIndex || q.catalog.validUntilMs <= a.atMs
        || canonical(preparation) !== canonical(paymentContractPreparationV2(scope, eventId, q, d, preparation.paymentMode, a.actorId, a.atMs))) fail('INVALID_RECORD');
      preparedV2.add(q.version);
      command = { key: a.commandKey, expectedRevision: index, action: 'prepare_payment_v2', quoteVersion: q.version,
        quoteDigest: q.digest, approvalDigest: d.digest, artifactSha256: q.artifact.sha256, paymentMode: preparation.paymentMode };
    }
    commandInput(command);
    if (a.inputDigest !== digest({ scope, eventId, actorId: a.actorId, command })) fail('INVALID_RECORD');
  });
}
function commandInput(raw: unknown): QuoteCommand {
  const clean = plain(raw) as QuoteCommand; if (!clean || typeof clean !== 'object') fail('INVALID_COMMAND');
  const fields = clean.action === 'create' || clean.action === 'brief' ? ['brief'] : clean.action === 'quote' ? ['expectedBriefDigest', 'expectedCatalogDigest', 'selections'] : clean.action === 'approve' ? ['quoteVersion', 'quoteDigest', 'artifactSha256', 'intendedRecipient'] : clean.action === 'prepare_payment' ? ['quoteVersion', 'quoteDigest', 'approvalDigest', 'artifactSha256'] : clean.action === 'prepare_payment_v2' ? ['quoteVersion', 'quoteDigest', 'approvalDigest', 'artifactSha256', 'paymentMode'] : fail('INVALID_COMMAND');
  row(clean, ['key', 'expectedRevision', 'action', ...fields]); assertEventId(clean.key); integer(clean.expectedRevision, 0, 100);
  if (clean.action === 'create' || clean.action === 'brief') briefInput(clean.brief);
  else if (clean.action === 'quote') { for (const hash of [clean.expectedBriefDigest, clean.expectedCatalogDigest]) if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_COMMAND'); if (!Array.isArray(clean.selections) || !clean.selections.length || clean.selections.length > 100) fail('INVALID_COMMAND'); const seen = new Set<string>(); for (const selection of clean.selections) { row(selection, ['itemId', 'quantity']); assertEventId(selection.itemId); integer(selection.quantity, 1, 1000); if (seen.has(selection.itemId)) fail('DUPLICATE_ITEM'); seen.add(selection.itemId); } }
  else { integer(clean.quoteVersion, 1, 20); for (const hash of [clean.quoteDigest, clean.artifactSha256]) if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_COMMAND'); if (clean.action === 'approve') text(clean.intendedRecipient, 254); else if (typeof clean.approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(clean.approvalDigest)) fail('INVALID_COMMAND'); }
  if (clean.action === 'prepare_payment_v2' && !['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(clean.paymentMode)) fail('INVALID_COMMAND');
  return clean;
}
function view(record: EventQuoteRecord, catalog: CatalogSnapshot | null): EventQuoteView {
  const q = record.quotes.at(-1), b = record.briefs.at(-1)!;
  const status = !q ? 'missing' : q.briefDigest !== b.digest || !catalog || q.catalogDigest !== digest(catalog) ? 'obsolete' : record.decisions.some(d => d.quoteDigest === q.digest) ? 'approved_internal_unsent' : 'pending_internal_review';
  return { record: structuredClone(record), currentQuoteStatus: status, externalEffectsEnabled: false };
}
export function createEventQuoteService(deps: { store: EventQuoteStore; catalogFor: (scope: QuoteScope) => Promise<CatalogSnapshot | null>; clock?: () => number }): EventQuoteService {
  const clock = deps.clock ?? Date.now;
  async function catalog(scope: QuoteScope): Promise<CatalogSnapshot> { const raw = await deps.catalogFor(scope); if (!raw) fail('AUTHORIZED_CATALOG_REQUIRED', 503); return validateQuoteCatalog(raw, scope, clock()); }
  return {
    async status(scope, actor) { assertQuoteScope(scope); try { actorCheck(actor, scope, clock()); scope = structuredClone(scope); actor = structuredClone(actor); const c = await catalog(scope); actorCheck(actor, scope, clock()); return { enabled: actor.canWrite, reason: actor.canWrite ? null : 'READ_ONLY', catalog: c, catalogDigest: digest(c) }; } catch (error) { if (!(error instanceof EventQuoteError)) throw error; return { enabled: false, reason: error.code, catalog: null, catalogDigest: null }; } },
    async read(scope, actor, eventId) { assertQuoteScope(scope); actorCheck(actor, scope, clock()); assertEventId(eventId); scope = structuredClone(scope); actor = structuredClone(actor); const r = await deps.store.read(scope, eventId); actorCheck(actor, scope, clock()); if (!r) fail('EVENT_NOT_FOUND', 404); assertEventQuoteRecord(r, scope, eventId); let c: CatalogSnapshot | null = null; try { c = await catalog(scope); } catch (error) { if (!(error instanceof EventQuoteError)) throw error; } actorCheck(actor, scope, clock()); return view(r, c); },
    async execute(scope, actor, eventId, raw) {
      assertQuoteScope(scope); actorCheck(actor, scope, clock()); assertEventId(eventId); if (!actor.canWrite) fail('WRITE_FORBIDDEN', 403);
      scope = structuredClone(scope); actor = structuredClone(actor);
      const input = commandInput(raw);
      if (['approve', 'prepare_payment', 'prepare_payment_v2'].includes(input.action) && !actor.canApprove) fail('APPROVAL_FORBIDDEN', 403);
      const hash = digest({ scope, eventId, actorId: actor.actorId, command: input });
      const result = await deps.store.transact(scope, eventId, async current => {
        // Catalogue, identity deadline and clock are checked after acquiring the
        // storage lock, never only at the start of a potentially queued request.
        const c = await catalog(scope), now = clock(); integer(now);
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
            r.schemaVersion = 3;
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
