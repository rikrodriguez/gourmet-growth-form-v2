import { createHash } from 'node:crypto';
import { captureLead, setCloserAvailability, reserveLead, acceptReservation, releaseAssignment, expireReservations } from './assignment.mjs';
import { registerCallBinding, verifyTelnyxWebhook, applyTelnyxEvent } from './telephony.mjs';
import { registerInvoice, applyConfirmedPayment, buildReconciliationReport } from './payments.mjs';
import { createQuoteDraft, reviseQuoteDraft, createPageSpec, createPaymentRequestDraft, prepareMessageDraft, reviseMessageDraft, reviewMessageDraft, approveMessageDraft, verifyApproval } from './drafts.mjs';

// Composition for isolated fixtures only. No Slack/Telnyx/Monday/payment client,
// real webhook route, credentials, public renderer or outbound effect exists.
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const grants = {
  capture_lead: 'sales', set_availability: 'sales', reserve_lead: 'sales', accept_reservation: 'sales', release_assignment: 'sales', tick: 'sales', register_call: 'sales',
  quote: 'sales', revise_quote: 'sales', page_spec: 'sales', payment_request: 'finance', message: 'sales', revise_message: 'sales', review_message: 'sales', approve_message: 'sales',
  register_invoice: 'finance', payment_event: 'finance', reconciliation: 'finance',
};
const fields = {
  capture_lead: ['sourceLeadId', 'departmentId'], set_availability: ['active', 'shiftStartMs', 'shiftEndMs', 'availableUntilMs', 'capacity'], reserve_lead: ['leadId'],
  accept_reservation: ['reservationId'], release_assignment: ['reservationId', 'reason'], tick: [], register_call: ['reservationId', 'callControlId'],
  quote: ['draftId', 'currency', 'catalogVersion', 'lines', 'taxBps', 'depositBps'], revise_quote: ['draftId', 'currency', 'catalogVersion', 'lines', 'taxBps', 'depositBps', 'expectedRevision'],
  page_spec: ['draftId', 'quoteDraftId', 'quoteRevision'], payment_request: ['draftId', 'quoteDraftId', 'quoteRevision', 'amountCents'],
  message: ['draftId', 'channel', 'recipient', 'text', 'artifactRefs'], revise_message: ['draftId', 'channel', 'recipient', 'text', 'artifactRefs', 'expectedRevision'],
  review_message: ['draftId', 'revision'], approve_message: ['approvalId', 'draftId', 'revision', 'reviewDigest'],
  register_invoice: ['invoiceId', 'provider', 'providerInvoiceId', 'currency', 'totalCents'],
  payment_event: ['provider', 'eventId', 'transactionId', 'providerInvoiceId', 'invoiceId', 'amountCents', 'currency', 'status', 'occurredAtMs'], reconciliation: ['fromMs', 'toMs'],
};
function fail(code) { throw Object.assign(new Error(code), { code }); }
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) || reserved.has(value)) fail('INVALID_ID');
  return value;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function exact(value, required, optional = []) {
  if (!plain(value)) fail('INVALID_OBJECT');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !descriptor?.enumerable || !('value' in descriptor)) fail('INVALID_FIELD');
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail('MISSING_FIELD');
}
function json(value, depth = 0) {
  if (depth > 30) fail('INVALID_PAYLOAD');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) json(child, depth + 1); return; }
  if (!plain(value)) fail('INVALID_PAYLOAD');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || reserved.has(key) || !descriptor?.enumerable || !('value' in descriptor)) fail('INVALID_PAYLOAD');
    json(descriptor.value, depth + 1);
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function now(clock) { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK'); return value; }
function own(table, key) { return Object.hasOwn(table, key) ? table[key] : undefined; }
function requireEvent(record, eventId) { if (!record || record.gourmetEventId !== eventId) fail('FORBIDDEN_EVENT_REFERENCE'); return record; }

export function createPilotAdapter({ store, mode, policy, clock = Date.now, telnyxVerification } = {}) {
  if (mode !== 'simulation') fail('SIMULATION_ONLY');
  if (typeof store?.transact !== 'function' || typeof store?.snapshot !== 'function') fail('INVALID_STORE');
  json(policy);
  const rules = structuredClone(policy);
  // The pilot has one operator with one shared closer/capacity across all roles.
  if (!plain(rules?.actors) || Object.keys(rules.actors).length !== 1 || !Array.isArray(rules.threadBindings) || !Array.isArray(rules.paymentProviders) || !plain(rules.catalog?.items)) fail('INVALID_POLICY');
  id(rules.teamId);
  const actorId = id(Object.keys(rules.actors)[0]);
  const operator = rules.actors[actorId];
  id(operator.closerId);
  for (const name of ['roles', 'eventIds', 'departmentIds']) if (!Array.isArray(operator[name]) || !operator[name].length || operator[name].some(value => id(value) !== value)) fail('INVALID_POLICY');
  if (!Number.isSafeInteger(rules.acceptanceTimeoutMs) || rules.acceptanceTimeoutMs < 1 || !Number.isSafeInteger(rules.maxCapacity) || rules.maxCapacity < 1) fail('INVALID_POLICY');
  for (const binding of rules.threadBindings) {
    exact(binding, ['channelId', 'threadTs', 'gourmetEventId']); id(binding.channelId); id(binding.threadTs); id(binding.gourmetEventId);
    if (!operator.eventIds.includes(binding.gourmetEventId)) fail('INVALID_POLICY');
  }
  if (new Set(rules.threadBindings.map(binding => `${binding.channelId}/${binding.threadTs}`)).size !== rules.threadBindings.length) fail('INVALID_POLICY');
  for (const provider of rules.paymentProviders) id(provider);
  id(rules.catalog.version);
  const scopeDigest = digest({ actorId, closerId: operator.closerId, eventIds: [...operator.eventIds].sort(), departmentIds: [...operator.departmentIds].sort() });
  function assertStoreScope(state, bind = false) {
    if (state.mode !== 'simulation') fail('SIMULATION_ONLY');
    const binding = own(state.audit, 'scope-binding');
    if (binding && binding.scopeDigest !== scopeDigest) fail('FORBIDDEN_STORE_SCOPE');
    for (const name of ['leads', 'drafts', 'commands', 'invoices']) {
      for (const record of Object.values(state[name])) {
        if (!operator.eventIds.includes(name === 'invoices' ? record.eventId : record.gourmetEventId)) fail('FORBIDDEN_STORE_SCOPE');
        if (name === 'leads' && !operator.departmentIds.includes(record.departmentId)) fail('FORBIDDEN_STORE_SCOPE');
      }
    }
    if (Object.values(state.closers).some(closer => closer.actorId !== actorId || closer.closerId !== operator.closerId)) fail('FORBIDDEN_STORE_SCOPE');
    if (bind && !binding) state.audit['scope-binding'] = { actorId, scopeDigest, mode: 'simulation' };
  }

  function authenticate(context) {
    if (context?.simulation !== true) fail('SIMULATION_ONLY');
    if (context.authenticatedActorId !== actorId) fail('FORBIDDEN_ACTOR');
    return operator;
  }
  function validate(envelope, context) {
    authenticate(context); json(envelope);
    if (canonical(envelope).length > 32_768) fail('INVALID_PAYLOAD_SIZE');
    exact(envelope, ['schemaVersion', 'source', 'sourceId', 'sourceEventId', 'actorId', 'gourmetEventId', 'operation', 'input'], ['teamId', 'channelId', 'threadTs']);
    if (envelope.schemaVersion !== 1 || envelope.actorId !== actorId) fail('FORBIDDEN_ACTOR');
    for (const name of ['sourceId', 'sourceEventId', 'gourmetEventId']) id(envelope[name]);
    if (!operator.eventIds.includes(envelope.gourmetEventId)) fail('FORBIDDEN_EVENT');
    if (!Object.hasOwn(grants, envelope.operation)) fail('UNKNOWN_COMMAND');
    if (!operator.roles.includes(grants[envelope.operation])) fail('FORBIDDEN_PERMISSION');
    exact(envelope.input, fields[envelope.operation]);
    if (envelope.source === 'slack_simulation') {
      if (envelope.teamId !== rules.teamId || !rules.threadBindings.some(binding => binding.channelId === envelope.channelId && binding.threadTs === envelope.threadTs && binding.gourmetEventId === envelope.gourmetEventId)) fail('FORBIDDEN_SLACK_THREAD');
      if (['capture_lead', 'payment_event', 'register_call'].includes(envelope.operation)) fail('FORBIDDEN_SOURCE');
    } else if (envelope.source === 'lead_fixture') {
      if (envelope.operation !== 'capture_lead') fail('FORBIDDEN_SOURCE');
    } else if (envelope.source === 'payment_fixture') {
      if (envelope.operation !== 'payment_event') fail('FORBIDDEN_SOURCE');
    } else if (envelope.source === 'telnyx_fixture') {
      if (envelope.operation !== 'register_call') fail('FORBIDDEN_SOURCE');
    } else fail('FORBIDDEN_SOURCE');
    if (envelope.operation === 'approve_message' && context.explicitApproval !== true) fail('FORBIDDEN_EXPLICIT_APPROVAL_REQUIRED');
    return structuredClone(envelope);
  }
  function pendingAlerts(state, atMs) {
    for (const lead of Object.values(state.leads)) {
      if (lead.status === 'released' || lead.telephony?.firstCallInitiatedAtMs != null || atMs - lead.capturedAtMs < 30_000) continue;
      const key = `sla:${lead.leadId}`;
      state.exceptions[key] ??= { type: 'telephony', code: 'INITIATION_NOT_VERIFIED_WITHIN_30S', leadId: lead.leadId, gourmetEventId: lead.gourmetEventId, recordedAtMs: atMs, status: 'pending_human_review', severity: 'immediate', requiresHumanReview: true };
    }
  }
  function dispatch(state, envelope, context, atMs) {
    const { operation, input, gourmetEventId } = envelope;
    const draftInput = { ...input, actorId, gourmetEventId };
    const options = { nowMs: atMs };
    const leadFor = leadId => requireEvent(own(state.leads, id(leadId)), gourmetEventId);
    const assignmentFor = reservationId => { const assignment = own(state.assignments, id(reservationId)); if (!assignment) fail('RESERVATION_NOT_FOUND'); leadFor(assignment.leadId); return assignment; };
    const draftFor = draftId => requireEvent(own(state.drafts, id(draftId)), gourmetEventId);
    switch (operation) {
      case 'capture_lead': {
        id(input.sourceLeadId); id(input.departmentId);
        if (!operator.departmentIds.includes(input.departmentId)) fail('FORBIDDEN_DEPARTMENT');
        const origin = digest([envelope.source, envelope.sourceId, input.sourceLeadId]);
        const fingerprint = digest({ gourmetEventId, departmentId: input.departmentId });
        const binding = own(state.sourceLeadBindings, origin);
        if (binding && binding.digest !== fingerprint) fail('LEAD_BINDING_CONFLICT');
        const leadId = binding?.leadId ?? `lead-${origin.slice(0, 32)}`;
        captureLead(state, { leadId, departmentId: input.departmentId, captureSource: envelope.sourceId, capturedAtMs: binding?.capturedAtMs ?? atMs, nowMs: atMs });
        state.leads[leadId].gourmetEventId = gourmetEventId;
        state.sourceLeadBindings[origin] ??= { leadId, capturedAtMs: atMs, digest: fingerprint };
        return reserveLead(state, { leadId, nowMs: atMs, acceptanceTimeoutMs: rules.acceptanceTimeoutMs });
      }
      case 'set_availability': {
        if (!Number.isSafeInteger(input.capacity) || input.capacity > rules.maxCapacity) fail('INVALID_CAPACITY');
        const result = setCloserAvailability(state, { ...input, closerId: operator.closerId, actorId, departmentIds: operator.departmentIds, nowMs: atMs });
        if (!input.active || input.availableUntilMs <= atMs || input.shiftStartMs > atMs || input.shiftEndMs <= atMs || input.capacity === 0) {
          for (const assignment of Object.values(state.assignments)) {
            if (assignment.closerId !== operator.closerId) continue;
            if (assignment.status === 'reserved_pending_acceptance') acceptReservation(state, { reservationId: assignment.reservationId, closerId: operator.closerId, nowMs: atMs });
            else if (assignment.status === 'accepted') state.exceptions[`paused:${assignment.id}`] ??= { type: 'assignment', code: 'OPERATOR_PAUSED_WITH_ACTIVE_ASSIGNMENT', leadId: assignment.leadId, gourmetEventId: state.leads[assignment.leadId].gourmetEventId, status: 'pending_human_review', recordedAtMs: atMs, severity: 'immediate', requiresHumanReview: true };
          }
        }
        return result;
      }
      case 'reserve_lead': leadFor(input.leadId); return reserveLead(state, { ...input, nowMs: atMs, acceptanceTimeoutMs: rules.acceptanceTimeoutMs });
      case 'accept_reservation': assignmentFor(input.reservationId); return acceptReservation(state, { ...input, closerId: operator.closerId, nowMs: atMs });
      case 'release_assignment': assignmentFor(input.reservationId); return releaseAssignment(state, { ...input, nowMs: atMs });
      case 'tick': {
        const expired = expireReservations(state, { nowMs: atMs });
        const queued = Object.values(state.leads).filter(lead => lead.status === 'queued').sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.leadId.localeCompare(b.leadId));
        const reservations = queued.map(lead => reserveLead(state, { leadId: lead.leadId, nowMs: atMs, acceptanceTimeoutMs: rules.acceptanceTimeoutMs }));
        return { ...expired, reservations };
      }
      case 'register_call': assignmentFor(input.reservationId); return registerCallBinding(state, { ...input, actorId, registeredAtMs: atMs });
      case 'quote': case 'revise_quote': {
        if (input.catalogVersion !== rules.catalog.version || !Array.isArray(input.lines)) fail('INVALID_CATALOG');
        for (const line of input.lines) {
          exact(line, ['catalogItemId', 'label', 'qty', 'unitPriceCents']);
          const item = own(rules.catalog.items, id(line.catalogItemId));
          if (!item || line.unitPriceCents !== item.unitPriceCents || line.label !== item.label) fail('INVALID_CATALOG_PRICE');
        }
        if (operation === 'revise_quote') draftFor(input.draftId);
        return (operation === 'quote' ? createQuoteDraft : reviseQuoteDraft)(state, draftInput, options);
      }
      case 'page_spec': return createPageSpec(state, draftInput, options);
      case 'payment_request': return createPaymentRequestDraft(state, draftInput, options);
      case 'message': return prepareMessageDraft(state, draftInput, options);
      case 'revise_message': draftFor(input.draftId); return reviseMessageDraft(state, draftInput, options);
      case 'review_message': draftFor(input.draftId); return reviewMessageDraft(state, input);
      case 'approve_message': draftFor(input.draftId); return approveMessageDraft(state, input, { ...options, authenticatedActorId: actorId, simulation: true, explicitApproval: context.explicitApproval });
      case 'register_invoice':
        if (!rules.paymentProviders.includes(input.provider)) fail('FORBIDDEN_PROVIDER');
        return registerInvoice(state, { ...input, eventId: gourmetEventId });
      case 'payment_event':
        if (!rules.paymentProviders.includes(input.provider)) fail('FORBIDDEN_PROVIDER');
        return applyConfirmedPayment(state, { ...input, gourmetEventId }, options);
      case 'reconciliation': {
        // Reconciliation has an explicit event scope even though one operator
        // owns the pilot. Do not expose another event through a thread command.
        const scoped = structuredClone(state);
        scoped.invoices = Object.fromEntries(Object.entries(state.invoices).filter(([, invoice]) => invoice.eventId === gourmetEventId));
        scoped.payments.transactions = Object.fromEntries(Object.entries(state.payments.transactions ?? {}).filter(([, receipt]) => receipt.gourmetEventId === gourmetEventId));
        scoped.exceptions = Object.fromEntries(Object.entries(state.exceptions).filter(([, exception]) => exception.gourmetEventId === gourmetEventId));
        return buildReconciliationReport(scoped, input);
      }
      default: fail('UNKNOWN_COMMAND');
    }
  }
  return Object.freeze({
    async execute(envelope, context) {
      const command = validate(envelope, context);
      const commandId = `command-${digest([command.source, command.sourceId, command.sourceEventId])}`;
      const commandDigest = digest(command);
      return store.transact(state => {
        assertStoreScope(state, true);
        const previous = own(state.commands, commandId);
        if (previous) {
          if (previous.digest !== commandDigest) fail('COMMAND_CONFLICT');
          if (command.operation === 'approve_message' && !verifyApproval(state, { approvalId: command.input.approvalId }, { simulation: true })) fail('approval_invalidated');
          return { ...previous.result, replayed: true };
        }
        const atMs = now(clock);
        const data = dispatch(state, command, context, atMs);
        pendingAlerts(state, atMs);
        const result = { commandId, data, replayed: false, scope: 'local_simulation_only', allowsLiveEffect: false };
        state.commands[commandId] = { digest: commandDigest, actorId, gourmetEventId: command.gourmetEventId, recordedAtMs: atMs, result: structuredClone(result) };
        state.audit[commandId] = { commandId, actorId, operation: command.operation, gourmetEventId: command.gourmetEventId, recordedAtMs: atMs, mode: 'simulation' };
        return result;
      });
    },
    async receiveTelnyx(rawBody, headers, context) {
      authenticate(context);
      if (!telnyxVerification) fail('INVALID_TELNYX_VERIFICATION');
      const atMs = now(clock);
      const event = verifyTelnyxWebhook(rawBody, headers, { ...telnyxVerification, nowMs: atMs });
      return store.transact(state => {
        assertStoreScope(state, true);
        const result = applyTelnyxEvent(state, event, { nowMs: atMs });
        pendingAlerts(state, atMs);
        return { data: result, scope: 'local_simulation_only', allowsLiveEffect: false };
      });
    },
    async visibility(context) {
      authenticate(context);
      const state = await store.snapshot();
      assertStoreScope(state);
      return {
        scope: 'local_simulation_only', actorId, roles: operator.roles, allowsLiveEffect: false,
        closer: own(state.closers, operator.closerId) ?? null,
        leads: Object.values(state.leads).map(lead => ({ ...lead, telephony: lead.telephony ?? null })),
        assignments: Object.values(state.assignments), drafts: Object.values(state.drafts), approvals: Object.values(state.approvals),
        events: operator.eventIds.map(gourmetEventId => ({ gourmetEventId, supplierStatus: 'unverified', financial: Object.values(state.invoices).filter(invoice => invoice.eventId === gourmetEventId).map(invoice => ({ invoiceId: invoice.invoiceId, totalCents: invoice.totalCents, paidCents: invoice.paidCents, balanceCents: invoice.balanceCents })), financialStatus: Object.values(state.invoices).some(invoice => invoice.eventId === gourmetEventId) ? 'fixture_ledger_only' : 'missing', balanceCents: null })),
        exceptions: Object.values(state.exceptions).map(exception => ({ ...exception, deliveryStatus: 'local_record_only', urgent: exception.status !== 'resolved' })),
        mondayWrites: 0, outboundEffects: 0,
      };
    },
  });
}
