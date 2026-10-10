import { createHash, createPublicKey, KeyObject, verify } from 'node:crypto';

// Local/importable core; no network, dialing, STT, credentials, or side effects.
// References checked 2026-10-10:
// https://developers.telnyx.com/docs/development/sdk/node/webhooks
// https://developers.telnyx.com/api-reference/callbacks/call-initiated
// https://developers.telnyx.com/api-reference/callbacks/call-answered
// https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks
// Telnyx signs exact `${timestamp}|${rawBody}` bytes with Ed25519. A plain SIP
// connection is not evidence of a configured programmable Call Control route.

export class TelephonyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TelephonyError';
    this.code = code;
  }
}

const fail = (code) => { throw new TelephonyError(code); };
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const validMs = (value) => Number.isSafeInteger(value) && value >= 0;
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !['__proto__', 'constructor', 'prototype'].includes(value) && !/[\u0000-\u001f]/u.test(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function getHeader(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name);
  if (!isObject(headers)) fail('TELNYX_HEADERS_INVALID');
  const matches = Object.keys(headers).filter((key) => key.toLowerCase() === name);
  if (matches.length !== 1 || typeof headers[matches[0]] !== 'string') fail('TELNYX_HEADERS_INVALID');
  return headers[matches[0]];
}

function publicEd25519Key(value) {
  try {
    let key;
    if (value instanceof KeyObject) key = value;
    else if (typeof value === 'string' && value.includes('-----BEGIN PUBLIC KEY-----')) key = createPublicKey(value);
    else {
      // Telnyx portal public key is Base64-encoded 32-byte raw Ed25519 material.
      let bytes;
      if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/u.test(value)) {
        bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value) fail('TELNYX_PUBLIC_KEY_INVALID');
      } else if (Buffer.isBuffer(value)) bytes = value;
      else fail('TELNYX_PUBLIC_KEY_INVALID');
      if (bytes.length !== 32) fail('TELNYX_PUBLIC_KEY_INVALID');
      key = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
        format: 'der', type: 'spki',
      });
    }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('TELNYX_PUBLIC_KEY_INVALID');
    return key;
  } catch { fail('TELNYX_PUBLIC_KEY_INVALID'); }
}

/** Verify before parsing. Replay tolerance and clock must be set by the caller.
 * Re-delivery within tolerance is handled durably by applyTelnyxEvent, not here.
 * Never use JSON.stringify(parsedBody) as the signed request body.
 */
export function verifyTelnyxWebhook(rawBody, headers, { publicKey, nowMs, toleranceMs } = {}) {
  if (!validMs(nowMs) || !validMs(toleranceMs)) fail('TELNYX_CLOCK_INVALID');
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) fail('TELNYX_BODY_INVALID');
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  if (bytes.length === 0 || bytes.length > 1_048_576) fail('TELNYX_BODY_INVALID');
  const timestamp = getHeader(headers, 'telnyx-timestamp');
  const signature = getHeader(headers, 'telnyx-signature-ed25519');
  if (typeof timestamp !== 'string' || !/^(0|[1-9][0-9]{0,12})$/u.test(timestamp)) fail('TELNYX_TIMESTAMP_INVALID');
  const timestampMs = Number(timestamp) * 1000;
  if (!validMs(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceMs) fail('TELNYX_TIMESTAMP_OUTSIDE_TOLERANCE');
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) fail('TELNYX_SIGNATURE_INVALID');
  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) fail('TELNYX_SIGNATURE_INVALID');
  const signedBytes = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), bytes]);
  let verified = false;
  try { verified = verify(null, signedBytes, publicEd25519Key(publicKey), signatureBytes); }
  catch (error) {
    if (error instanceof TelephonyError) throw error;
    fail('TELNYX_SIGNATURE_INVALID');
  }
  if (!verified) fail('TELNYX_SIGNATURE_INVALID');
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isObject(parsed) || !isObject(parsed.data)) fail('TELNYX_EVENT_INVALID');
    return parsed;
  } catch { fail('TELNYX_EVENT_INVALID'); }
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!isObject(value) && !Array.isArray(value)) fail('TELNYX_EVENT_INVALID');
  if (seen.has(value)) fail('TELNYX_EVENT_INVALID');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => canonical(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function map(state, name) {
  if (!own(state, name)) state[name] = {};
  if (!isObject(state[name])) fail('TELEPHONY_STATE_INVALID');
  return state[name];
}

/** Internal trusted operation, never an unauthenticated webhook field.
 * Gateway authenticates input.actorId. closer.actorId is server identity policy,
 * not editable actor input or Monday's Assigned Closer status. CallControlId must
 * come from a trusted outbound Call Control route, not arbitrary client_state.
 * Persist registration before webhook processing in the transactional store.
 */
export function registerCallBinding(state, input) {
  if (!isObject(state) || !isObject(input)) fail('CALL_BINDING_INVALID');
  const { callControlId, reservationId, actorId, registeredAtMs } = input;
  if (![callControlId, reservationId, actorId].every(validId) || !validMs(registeredAtMs)) fail('CALL_BINDING_INVALID');
  const assignment = own(state.assignments, reservationId) ? state.assignments[reservationId] : null;
  if (!assignment || assignment.status !== 'accepted' || !validMs(assignment.acceptedAtMs)
    || assignment.acceptedAtMs > registeredAtMs) fail('CALL_ASSIGNMENT_NOT_ACCEPTED');
  const { leadId, closerId } = assignment;
  if (![leadId, closerId].every(validId) || !own(state.leads, leadId) || !own(state.closers, closerId)) fail('CALL_BINDING_INVALID');
  const identity = state.closers[closerId];
  if (!identity || identity.active !== true || identity.actorId !== actorId) fail('CALL_ACTOR_FORBIDDEN');
  const binding = { callControlId, reservationId, executionId: reservationId, leadId, closerId, actorId, registeredAtMs, direction: 'outgoing' };
  const bindings = map(state, 'callBindings');
  if (own(bindings, callControlId)) {
    const previous = bindings[callControlId];
    if (canonical({ ...previous, registeredAtMs }) !== canonical(binding)) fail('CALL_BINDING_CONFLICT');
    return { status: 'duplicate', binding: bindings[callControlId] };
  }
  bindings[callControlId] = binding;
  return { status: 'registered', binding };
}

function providerTimestamp(value) {
  // UTC-only provider timestamp, including Telnyx's microsecond precision.
  if (typeof value !== 'string') return null;
  const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!matched) return null;
  const wholeMs = Date.parse(`${matched[1]}.000Z`);
  if (!validMs(wholeMs) || new Date(wholeMs).toISOString() !== `${matched[1]}.000Z`) return null;
  const fraction = (matched[2] ?? '').padEnd(3, '0');
  const floorMs = wholeMs + Number(fraction.slice(0, 3));
  // Round upward conservatively so +1us after the 30s boundary cannot pass.
  const occurredAtMs = floorMs + (/[1-9]/u.test(fraction.slice(3)) ? 1 : 0);
  return validMs(occurredAtMs) ? { occurredAtMs, occurredAt: value } : null;
}

function exception(state, record, code, nowMs) {
  const exceptionId = `telnyx:${record.eventId}:${code}:${record.digest}`;
  const exceptions = map(state, 'exceptions');
  if (!own(exceptions, exceptionId)) exceptions[exceptionId] = {
    exceptionId, source: 'telnyx', code, eventId: record.eventId,
    createdAtMs: nowMs, severity: 'immediate', status: 'pending_human_review',
  };
  return { status: 'exception', eventId: record.eventId, exceptionId, code };
}

function refreshMeasurement(state, leadId) {
  const lead = state.leads[leadId];
  const events = Object.values(state.callEvents).filter((entry) => entry.status === 'applied' && entry.leadId === leadId);
  const earliest = (type) => events.filter((entry) => entry.eventType === type)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventId.localeCompare(b.eventId))[0];
  const initiated = earliest('call.initiated');
  const answered = earliest('call.answered');
  const duration = initiated ? initiated.occurredAtMs - lead.capturedAtMs : null;
  const unresolvedMeasurementException = Object.values(state.callEvents).some((entry) =>
    entry.leadId === leadId && entry.status === 'exception'
    && ['CALL_TIMELINE_INVALID', 'TELNYX_EVENT_ID_CONFLICT', 'CALL_MEASUREMENT_QUARANTINED'].includes(entry.code));
  lead.telephony = {
    firstCallInitiatedAtMs: initiated?.occurredAtMs ?? null,
    firstCallInitiatedEventId: initiated?.eventId ?? null,
    firstCallAnsweredAtMs: answered?.occurredAtMs ?? null,
    firstCallAnsweredEventId: answered?.eventId ?? null,
    timeToFirstCallMs: duration,
    timeToFirstAnswerMs: answered ? answered.occurredAtMs - lead.capturedAtMs : null,
    targetMs: 30_000,
    slaStatus: unresolvedMeasurementException ? 'measurement_unverified'
      : duration === null ? 'awaiting_verified_initiation' : duration <= 30_000 ? 'target_met' : 'target_missed',
    answerSemantics: 'provider_call_leg_answered', humanContactVerified: false,
    timestampRounding: 'ceiling_to_millisecond',
  };
  return lead.telephony;
}

/** Apply only after trusted transport verification (or isolated synthetic tests).
 * Mutates JSON state; the caller must serialize the whole operation + commit
 * before acknowledging. This function itself is not a persistence/HTTP layer.
 * Digest covers data, excluding delivery meta which can change across retries.
 * Stores IDs/timing/digest only: no phone numbers, recording URL or client_state.
 */
export function applyTelnyxEvent(state, event, { nowMs } = {}) {
  if (!isObject(state) || !validMs(nowMs)) fail('TELEPHONY_STATE_INVALID');
  const data = event?.data;
  if (!isObject(data) || !validId(data.id) || !validId(data.event_type)) fail('TELNYX_EVENT_INVALID');
  const events = map(state, 'callEvents');
  const digest = hash(canonical(data));
  if (own(events, data.id)) {
    if (events[data.id].digest !== digest) {
      // A signed ID collision makes previously attributed measurement ambiguous.
      // Preserve the original digest/timing, quarantine measurement until review.
      const previous = events[data.id];
      if (previous.leadId) {
        previous.status = 'exception'; previous.code = 'TELNYX_EVENT_ID_CONFLICT';
        refreshMeasurement(state, previous.leadId);
      }
      return exception(state, { eventId: data.id, digest }, 'TELNYX_EVENT_ID_CONFLICT', nowMs);
    }
    return { status: 'duplicate', eventId: data.id, originalStatus: events[data.id].status };
  }
  const record = { eventId: data.id, eventType: data.event_type, digest, webhookReceivedAtMs: nowMs, status: 'received' };
  events[data.id] = record;
  const reject = (code) => {
    record.status = 'exception'; record.code = code;
    if (record.leadId) refreshMeasurement(state, record.leadId);
    return exception(state, record, code, nowMs);
  };
  if (!['call.initiated', 'call.answered'].includes(data.event_type)) {
    record.status = 'ignored';
    return { status: 'ignored', eventId: data.id };
  }
  const timestamp = providerTimestamp(data.occurred_at);
  if (!timestamp || timestamp.occurredAtMs > nowMs) return reject('CALL_TIMESTAMP_INVALID');
  Object.assign(record, timestamp, { webhookDelayMs: nowMs - timestamp.occurredAtMs });
  if (!isObject(data.payload) || !validId(data.payload.call_control_id)) return reject('CALL_CONTROL_ID_INVALID');
  const callControlId = data.payload.call_control_id;
  record.callControlId = callControlId;
  const binding = own(state.callBindings, callControlId) ? state.callBindings[callControlId] : null;
  if (!binding || binding.direction !== 'outgoing' || !validMs(binding.registeredAtMs)
    || binding.registeredAtMs > nowMs) return reject('CALL_UNBOUND');
  if (data.event_type === 'call.initiated' && data.payload.direction !== 'outgoing') return reject('CALL_NOT_OUTGOING');
  if (own(data.payload, 'direction') && data.payload.direction !== 'outgoing') return reject('CALL_NOT_OUTGOING');
  const assignment = own(state.assignments, binding.reservationId) ? state.assignments[binding.reservationId] : null;
  const lead = own(state.leads, binding.leadId) ? state.leads[binding.leadId] : null;
  if (!assignment || !lead || assignment.leadId !== binding.leadId || assignment.closerId !== binding.closerId
    || !['accepted', 'released'].includes(assignment.status) || !validMs(assignment.acceptedAtMs)
    || !validMs(lead.capturedAtMs) || timestamp.occurredAtMs < lead.capturedAtMs
    || timestamp.occurredAtMs < assignment.acceptedAtMs
    || (assignment.status === 'released' && (!validMs(assignment.releasedAtMs) || timestamp.occurredAtMs >= assignment.releasedAtMs))) {
    return reject('CALL_ATTRIBUTION_INVALID');
  }
  Object.assign(record, { leadId: binding.leadId, closerId: binding.closerId, reservationId: binding.reservationId, actorId: binding.actorId });
  if (Object.values(events).some((entry) => entry.callControlId === callControlId && entry.status === 'exception'
    && ['CALL_TIMELINE_INVALID', 'TELNYX_EVENT_ID_CONFLICT', 'CALL_MEASUREMENT_QUARANTINED'].includes(entry.code))) {
    return reject('CALL_MEASUREMENT_QUARANTINED');
  }
  const sameCall = Object.values(events).filter((entry) => entry.status === 'applied' && entry.callControlId === callControlId);
  const chronologyConflict = sameCall.filter((entry) =>
    (data.event_type === 'call.initiated' && entry.eventType === 'call.answered' && entry.occurredAtMs < timestamp.occurredAtMs)
    || (data.event_type === 'call.answered' && entry.eventType === 'call.initiated' && entry.occurredAtMs > timestamp.occurredAtMs));
  if (chronologyConflict.length) {
    for (const previous of chronologyConflict) { previous.status = 'exception'; previous.code = 'CALL_TIMELINE_INVALID'; }
    return reject('CALL_TIMELINE_INVALID');
  }
  record.status = 'applied';
  const measurement = refreshMeasurement(state, binding.leadId);
  return { status: 'applied', eventId: data.id, measurement };
}
