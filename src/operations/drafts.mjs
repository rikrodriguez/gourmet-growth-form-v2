import { createHash } from 'node:crypto';
import { calculateQuoteTotals, QuoteCalculationError } from './quote-calculation.mjs';

// Pure local pilot functions. The caller authenticates actors and authorizes each
// event before invoking these functions. This module has no sending or publishing
// adapter, and simulation approvals can never authorize a live effect.
const MAX_CENTS = 1_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

export class DraftError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DraftError';
    this.code = code;
  }
}

function fail(code) { throw new DraftError(code); }
function integer(value, min, max, code = 'invalid_integer') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function string(value, max, code = 'invalid_string') {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) fail(code);
  return value;
}
function id(value) {
  string(value, 100, 'invalid_id');
  if (!ID_PATTERN.test(value) || RESERVED_IDS.has(value)) fail('invalid_id');
  return value;
}
function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail('unknown_field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid_object');
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail('missing_field');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function timestamp(options) { return integer(options?.nowMs, 0, Number.MAX_SAFE_INTEGER, 'invalid_timestamp'); }
function stateCheck(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('invalid_state');
  for (const name of ['drafts', 'approvals']) {
    if (state[name] !== undefined && (!state[name] || typeof state[name] !== 'object' || Array.isArray(state[name]))) fail('invalid_state');
  }
}
function identity(input) {
  return { draftId: id(input.draftId), gourmetEventId: id(input.gourmetEventId), actorId: id(input.actorId) };
}
function container(state, draftId) {
  return Object.hasOwn(state.drafts ?? {}, draftId) ? state.drafts[draftId] : undefined;
}
function currentRecord(state, draftId, revision, gourmetEventId) {
  id(draftId);
  integer(revision, 1, 1_000_000, 'invalid_revision');
  const draft = container(state, draftId);
  if (!draft) fail('reference_not_found');
  if (draft.gourmetEventId !== gourmetEventId) fail('cross_event_reference');
  if (draft.currentRevision !== revision) fail('stale_reference');
  const record = draft.revisions[revision];
  if (!record) fail('reference_not_found');
  return record;
}
function quoteReference(state, input) {
  const quote = currentRecord(state, input.quoteDraftId, input.quoteRevision, input.gourmetEventId);
  if (quote.kind !== 'quote') fail('invalid_quote_reference');
  return quote;
}
function persistedRecord(content, input, nowMs) {
  const record = { ...content, createdAtMs: nowMs, inputDigest: digest(input) };
  record.contentDigest = digest(content);
  return freeze(record);
}
function addDraft(state, input, kind, content, nowMs) {
  const existing = container(state, input.draftId);
  if (existing) {
    if (existing.kind !== kind || existing.revisions[1].inputDigest !== digest(input)) fail('draft_id_conflict');
    return existing.revisions[1];
  }
  const record = persistedRecord({ ...content, kind, revision: 1 }, input, nowMs);
  state.drafts ??= {};
  state.drafts[input.draftId] = { kind, gourmetEventId: input.gourmetEventId, currentRevision: 1, revisions: { 1: record } };
  return record;
}
function refsFor(record) {
  if (record.kind === 'page_spec' || record.kind === 'payment_request') {
    return [{ draftId: record.quoteDraftId, revision: record.quoteRevision }];
  }
  return record.artifactRefs ?? [];
}
function usesDraft(state, record, targetId, visited = new Set()) {
  if (record.draftId === targetId) return true;
  if (visited.has(record.draftId)) return false;
  visited.add(record.draftId);
  return refsFor(record).some(ref => {
    if (ref.draftId === targetId) return true;
    const related = container(state, ref.draftId)?.revisions[ref.revision];
    return related ? usesDraft(state, related, targetId, visited) : false;
  });
}
function invalidateApprovals(state, draftId, nowMs) {
  for (const [approvalId, approval] of Object.entries(state.approvals ?? {})) {
    const record = container(state, approval.draftId)?.revisions[approval.revision];
    if (approval.valid && record && usesDraft(state, record, draftId)) {
      state.approvals[approvalId] = freeze({ ...approval, valid: false, invalidatedAtMs: nowMs, invalidationReason: 'material_revision' });
    }
  }
}
function revise(state, input, kind, content, nowMs) {
  const existing = container(state, input.draftId);
  if (!existing || existing.kind !== kind) fail('draft_not_found');
  if (existing.gourmetEventId !== input.gourmetEventId) fail('cross_event_reference');
  const nextRevision = input.expectedRevision + 1;
  const previousRetry = existing.revisions[nextRevision];
  if (previousRetry) {
    if (previousRetry.inputDigest !== digest(input)) fail('revision_conflict');
    return previousRetry;
  }
  if (existing.currentRevision !== input.expectedRevision) fail('revision_conflict');
  if (nextRevision > 1_000_000) fail('revision_limit');
  const record = persistedRecord({ ...content, kind, revision: nextRevision }, input, nowMs);
  existing.revisions[nextRevision] = record;
  existing.currentRevision = nextRevision;
  invalidateApprovals(state, input.draftId, nowMs);
  return record;
}
function quoteContent(input, revision = false) {
  exactKeys(input, ['draftId', 'gourmetEventId', 'actorId', 'currency', 'catalogVersion', 'lines', 'taxBps', 'depositBps', ...(revision ? ['expectedRevision'] : [])]);
  const who = identity(input);
  if (input.currency !== 'USD') fail('unsupported_currency');
  id(input.catalogVersion);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) fail('invalid_lines');
  const lines = input.lines.map(line => {
    exactKeys(line, ['catalogItemId', 'label', 'qty', 'unitPriceCents']);
    return { catalogItemId: id(line.catalogItemId), label: string(line.label, 100), qty: integer(line.qty, 1, 1_000), unitPriceCents: integer(line.unitPriceCents, 0, 1_000_000) };
  });
  const taxBps = integer(input.taxBps, 0, 10_000);
  const depositBps = integer(input.depositBps, 0, 10_000);
  if (revision) integer(input.expectedRevision, 1, 1_000_000, 'invalid_revision');
  let totals;
  try {
    totals = calculateQuoteTotals({ lines, taxBps, depositBps });
  } catch (error) {
    if (error instanceof QuoteCalculationError) fail(error.code);
    throw error;
  }
  return { ...who, currency: 'USD', catalogVersion: input.catalogVersion, lines, taxBps, depositBps, ...totals, status: 'pending_approval', financialMeaning: 'unaccepted_quote_scenario', syntheticOnly: true };
}

export function createQuoteDraft(state, input, options) {
  stateCheck(state);
  const content = quoteContent(input);
  return addDraft(state, input, 'quote', content, timestamp(options));
}

export function reviseQuoteDraft(state, input, options) {
  stateCheck(state);
  const content = quoteContent(input, true);
  return revise(state, input, 'quote', content, timestamp(options));
}

export function createPageSpec(state, input, options) {
  stateCheck(state);
  exactKeys(input, ['draftId', 'gourmetEventId', 'actorId', 'quoteDraftId', 'quoteRevision']);
  const who = identity(input);
  const quote = quoteReference(state, input);
  return addDraft(state, input, 'page_spec', { ...who, quoteDraftId: quote.draftId, quoteRevision: quote.revision, quoteDigest: quote.contentDigest, currency: 'USD', rendererStatus: 'blocked_missing_generator', status: 'blocked_missing_generator', html: null, url: null, syntheticOnly: true }, timestamp(options));
}

export function createPaymentRequestDraft(state, input, options) {
  stateCheck(state);
  exactKeys(input, ['draftId', 'gourmetEventId', 'actorId', 'quoteDraftId', 'quoteRevision', 'amountCents']);
  const who = identity(input);
  const quote = quoteReference(state, input);
  const amountCents = integer(input.amountCents, 1, MAX_CENTS);
  const remaining = options?.remainingQuoteCents;
  if (remaining !== undefined) integer(remaining, 0, quote.totalCents, 'invalid_remaining_quote_cents');
  if (amountCents > (remaining ?? quote.totalCents)) fail('payment_request_exceeds_cap');
  // remainingQuoteCents is server-owned context, never accepted from the payload.
  // A missing financial value stays null; the quote total is only a draft ceiling.
  const content = { ...who, quoteDraftId: quote.draftId, quoteRevision: quote.revision, quoteDigest: quote.contentDigest, currency: 'USD', amountCents, quoteCeilingCents: quote.totalCents, remainingQuoteCents: remaining ?? null, balanceStatus: remaining === undefined ? 'unverified' : 'verified_by_caller', status: 'pending_approval', dependencyStatus: 'quote_approval_pending', invoiceId: null, paymentUrl: null, syntheticOnly: true };
  const existing = container(state, input.draftId);
  if (existing && existing.revisions[1].remainingQuoteCents !== content.remainingQuoteCents) fail('draft_context_conflict');
  return addDraft(state, input, 'payment_request', content, timestamp(options));
}

function recipient(channel, value) {
  string(value, 100, 'invalid_recipient');
  if (channel === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
  if (channel === 'sms' && /^\+[1-9]\d{7,14}$/.test(value)) return value;
  if (channel === 'slack' && /^[CGDU][A-Z0-9]{2,99}$/.test(value)) return value;
  fail('invalid_recipient');
}
function referenceInput(state, gourmetEventId, refs) {
  if (!Array.isArray(refs) || refs.length > 100) fail('invalid_artifact_refs');
  const seen = new Set();
  return refs.map(ref => {
    exactKeys(ref, ['draftId', 'revision']);
    const record = currentRecord(state, ref.draftId, ref.revision, gourmetEventId);
    if (record.kind === 'message') fail('message_reference_forbidden');
    if (seen.has(ref.draftId)) fail('duplicate_artifact_reference');
    seen.add(ref.draftId);
    return { draftId: record.draftId, revision: record.revision, contentDigest: record.contentDigest };
  });
}
function messageContent(state, input, revision = false) {
  exactKeys(input, ['draftId', 'gourmetEventId', 'actorId', 'channel', 'recipient', 'text', 'artifactRefs', ...(revision ? ['expectedRevision'] : [])]);
  const who = identity(input);
  if (!['email', 'sms', 'slack'].includes(input.channel)) fail('unsupported_channel');
  const target = recipient(input.channel, input.recipient);
  const text = string(input.text, 10_000, 'invalid_message_text');
  if (revision) integer(input.expectedRevision, 1, 1_000_000, 'invalid_revision');
  const artifactRefs = referenceInput(state, input.gourmetEventId, input.artifactRefs);
  if (artifactRefs.some(ref => ref.draftId === input.draftId)) fail('self_reference');
  return { ...who, channel: input.channel, recipient: target, text, artifactRefs, status: 'pending_approval', syntheticOnly: true };
}

export function prepareMessageDraft(state, input, options) {
  stateCheck(state);
  const content = messageContent(state, input);
  return addDraft(state, input, 'message', content, timestamp(options));
}

export function reviseMessageDraft(state, input, options) {
  stateCheck(state);
  const content = messageContent(state, input, true);
  return revise(state, input, 'message', content, timestamp(options));
}

function checkDependencies(state, record, visited = new Set()) {
  if (visited.has(record.draftId)) fail('cyclic_reference');
  visited.add(record.draftId);
  const { createdAtMs, inputDigest, contentDigest, ...content } = record;
  if (contentDigest !== digest(content)) fail('artifact_digest_mismatch');
  if (record.kind === 'page_spec' && record.rendererStatus !== 'ready') fail('blocked_missing_generator');
  for (const ref of refsFor(record)) {
    const dependency = currentRecord(state, ref.draftId, ref.revision, record.gourmetEventId);
    if (ref.contentDigest && ref.contentDigest !== dependency.contentDigest) fail('artifact_digest_mismatch');
    if (record.quoteDigest && record.quoteDigest !== dependency.contentDigest) fail('artifact_digest_mismatch');
    checkDependencies(state, dependency, new Set(visited));
  }
}
function review(state, draftId, revision) {
  const draft = container(state, draftId);
  if (!draft || draft.kind !== 'message') fail('message_not_found');
  const record = currentRecord(state, draftId, revision, draft.gourmetEventId);
  let blockedReason = null;
  try { checkDependencies(state, record); }
  catch (error) {
    if (!(error instanceof DraftError) || error.code !== 'blocked_missing_generator') throw error;
    blockedReason = error.code;
  }
  const reviewed = { draftId, revision, gourmetEventId: record.gourmetEventId, channel: record.channel, recipient: record.recipient, text: record.text, artifactRefs: record.artifactRefs };
  return freeze({ ...reviewed, reviewDigest: digest(reviewed), blockedReason, scope: 'local_simulation_only', allowsLiveEffect: false });
}

export function reviewMessageDraft(state, input) {
  stateCheck(state);
  exactKeys(input, ['draftId', 'revision']);
  id(input.draftId);
  integer(input.revision, 1, 1_000_000, 'invalid_revision');
  return review(state, input.draftId, input.revision);
}

export function approveMessageDraft(state, input, options) {
  stateCheck(state);
  exactKeys(input, ['approvalId', 'draftId', 'revision', 'reviewDigest']);
  id(input.approvalId);
  id(input.draftId);
  integer(input.revision, 1, 1_000_000, 'invalid_revision');
  if (typeof input.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.reviewDigest)) fail('invalid_review_digest');
  if (options?.simulation !== true || options?.explicitApproval !== true) fail('simulation_approval_required');
  const authenticatedActorId = id(options?.authenticatedActorId);
  const nowMs = timestamp(options);
  const reviewed = review(state, input.draftId, input.revision);
  if (reviewed.blockedReason) fail(reviewed.blockedReason);
  if (reviewed.reviewDigest !== input.reviewDigest) fail('approval_digest_mismatch');
  const existing = Object.hasOwn(state.approvals ?? {}, input.approvalId) ? state.approvals[input.approvalId] : undefined;
  const inputDigest = digest({ ...input, authenticatedActorId });
  if (existing) {
    if (existing.inputDigest !== inputDigest) fail('approval_id_conflict');
    if (!existing.valid) fail('approval_invalidated');
    return existing;
  }
  const approval = freeze({ approvalId: input.approvalId, draftId: input.draftId, revision: input.revision, gourmetEventId: reviewed.gourmetEventId, authenticatedActorId, reviewDigest: reviewed.reviewDigest, inputDigest, approvedAtMs: nowMs, valid: true, scope: 'local_simulation_only', allowsLiveEffect: false });
  state.approvals ??= {};
  state.approvals[input.approvalId] = approval;
  return approval;
}

export function verifyApproval(state, input, options = {}) {
  stateCheck(state);
  exactKeys(input, ['approvalId']);
  id(input.approvalId);
  if (options.simulation !== true) return false;
  const approval = Object.hasOwn(state.approvals ?? {}, input.approvalId) ? state.approvals[input.approvalId] : undefined;
  if (!approval?.valid || approval.scope !== 'local_simulation_only' || approval.allowsLiveEffect !== false) return false;
  try {
    const reviewed = review(state, approval.draftId, approval.revision);
    return !reviewed.blockedReason && reviewed.reviewDigest === approval.reviewDigest;
  } catch (error) {
    if (error instanceof DraftError) return false;
    throw error;
  }
}
