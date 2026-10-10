import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { applyTelnyxEvent, registerCallBinding, verifyTelnyxWebhook } from '../../src/operations/telephony.mjs';

// Synthetic fixtures only. Keys are generated in process memory, never written,
// imported into a service, read from environment, or used for actual calls.
const T = Date.parse('2026-10-10T12:00:00.000Z');
const CALL = 'SYNTHETIC_CALL_CONTROL_1';
const ACTOR = 'OFFICE_DEMO_OPERATOR';
function stateFixture() {
  const state = {
    leads: { lead1: { leadId: 'lead1', capturedAtMs: T, departmentId: 'sales', status: 'accepted' } },
    closers: { closer1: { closerId: 'closer1', actorId: ACTOR, active: true } },
    assignments: { reservation1: {
      id: 'reservation1', reservationId: 'reservation1', leadId: 'lead1', closerId: 'closer1',
      departmentId: 'sales', status: 'accepted', acceptedAtMs: T + 1000, revision: 1,
    } },
    callEvents: {}, payments: {}, invoices: {}, exceptions: {},
  };
  registerCallBinding(state, { callControlId: CALL, reservationId: 'reservation1', actorId: ACTOR, registeredAtMs: T + 1000 });
  return state;
}
function eventFixture(id = 'event1', type = 'call.initiated', delayMs = 10_000, payload = {}) {
  return { data: {
    record_type: 'event', id, event_type: type, occurred_at: new Date(T + delayMs).toISOString(),
    payload: { call_control_id: CALL, ...(type === 'call.initiated' ? { direction: 'outgoing' } : {}), ...payload },
  } };
}
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  function signed(raw, timestamp = String((T + 60_000) / 1000)) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const signature = sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), bytes]), privateKey).toString('base64');
    return { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature };
  }
  return { publicKey, privateKey, signed };
}
const verificationOptions = (publicKey, extra = {}) => ({ publicKey, nowMs: T + 60_000, toleranceMs: 1000, ...extra });
const apply = (state, event, nowMs = T + 60_000) => applyTelnyxEvent(state, event, { nowMs });

test('verifies exact raw UTF-8 bytes and parses only after valid signature', () => {
  const { publicKey, signed } = signer();
  const raw = Buffer.from(JSON.stringify({ ...eventFixture(), extra: 'fixture ñ' }), 'utf8');
  const parsed = verifyTelnyxWebhook(raw, signed(raw), verificationOptions(publicKey));
  assert.equal(parsed.data.event_type, 'call.initiated');
  assert.equal(parsed.extra, 'fixture ñ');
});

test('accepts public KeyObject, public PEM, and Telnyx raw Base64 public key', () => {
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  for (const key of [publicKey, publicKey.export({ format: 'pem', type: 'spki' }), rawKey]) {
    assert.equal(verifyTelnyxWebhook(raw, signed(raw), verificationOptions(key)).data.id, 'event1');
  }
});

test('case-insensitive headers accepted; duplicate/multivalued headers rejected', () => {
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  const headers = signed(raw);
  const upper = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toUpperCase(), value]));
  assert.equal(verifyTelnyxWebhook(raw, upper, verificationOptions(publicKey)).data.id, 'event1');
  assert.throws(() => verifyTelnyxWebhook(raw, { ...headers, 'Telnyx-Timestamp': headers['telnyx-timestamp'] }, verificationOptions(publicKey)), { code: 'TELNYX_HEADERS_INVALID' });
  assert.throws(() => verifyTelnyxWebhook(raw, { ...headers, 'telnyx-timestamp': [headers['telnyx-timestamp']] }, verificationOptions(publicKey)), { code: 'TELNYX_HEADERS_INVALID' });
});

test('altered or reserialized body fails even when parsed JSON is equivalent', () => {
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  for (const altered of [raw.replace('outgoing', 'incoming'), ` ${raw}`, JSON.stringify(JSON.parse(raw), null, 2)]) {
    assert.throws(() => verifyTelnyxWebhook(altered, signed(raw), verificationOptions(publicKey)), { code: 'TELNYX_SIGNATURE_INVALID' });
  }
});

test('invalid signature, malformed Base64, wrong public key and private key fail safely', () => {
  const first = signer();
  const second = signer();
  const raw = JSON.stringify(eventFixture());
  assert.throws(() => verifyTelnyxWebhook(raw, first.signed(raw), verificationOptions(second.publicKey)), { code: 'TELNYX_SIGNATURE_INVALID' });
  assert.throws(() => verifyTelnyxWebhook(raw, { ...first.signed(raw), 'telnyx-signature-ed25519': '!!!' }, verificationOptions(first.publicKey)), { code: 'TELNYX_SIGNATURE_INVALID' });
  assert.throws(() => verifyTelnyxWebhook(raw, first.signed(raw), verificationOptions(first.privateKey)), { code: 'TELNYX_PUBLIC_KEY_INVALID' });
  assert.throws(() => verifyTelnyxWebhook(raw, first.signed(raw), verificationOptions('invalid')), { code: 'TELNYX_PUBLIC_KEY_INVALID' });
});

test('replay tolerance boundary accepted; older and future signature timestamps rejected', () => {
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  const epochSeconds = (T + 60_000) / 1000;
  assert.equal(verifyTelnyxWebhook(raw, signed(raw, String(epochSeconds - 1)), verificationOptions(publicKey)).data.id, 'event1');
  for (const timestamp of [String(epochSeconds - 2), String(epochSeconds + 2)]) {
    assert.throws(() => verifyTelnyxWebhook(raw, signed(raw, timestamp), verificationOptions(publicKey)), { code: 'TELNYX_TIMESTAMP_OUTSIDE_TOLERANCE' });
  }
});

test('negative, fractional, unsafe and noncanonical header timestamps rejected', () => {
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  for (const timestamp of ['-1', '1.5', '9007199254740991', '00001', '1e3']) {
    assert.throws(() => verifyTelnyxWebhook(raw, signed(raw, timestamp), verificationOptions(publicKey)), { code: 'TELNYX_TIMESTAMP_INVALID' });
  }
  for (const extra of [{ nowMs: -1 }, { nowMs: Number.MAX_SAFE_INTEGER + 1 }, { toleranceMs: -1 }, { toleranceMs: undefined }]) {
    assert.throws(() => verifyTelnyxWebhook(raw, signed(raw), verificationOptions(publicKey, extra)), { code: 'TELNYX_CLOCK_INVALID' });
  }
});

test('a valid signature does not allow malformed JSON or UTF-8', () => {
  const { publicKey, signed } = signer();
  for (const raw of ['{not json}', 'null', '{}', Buffer.from([0xc3, 0x28])]) {
    assert.throws(() => verifyTelnyxWebhook(raw, signed(raw), verificationOptions(publicKey)), { code: 'TELNYX_EVENT_INVALID' });
  }
});

test('start at 10s received at 60s meets SLA with 50s webhook delay', () => {
  const state = stateFixture();
  const { publicKey, signed } = signer();
  const raw = JSON.stringify(eventFixture());
  const result = apply(state, verifyTelnyxWebhook(raw, signed(raw), verificationOptions(publicKey)));
  assert.equal(result.status, 'applied');
  assert.equal(result.measurement.timeToFirstCallMs, 10_000);
  assert.equal(result.measurement.slaStatus, 'target_met');
  assert.equal(state.callEvents.event1.webhookDelayMs, 50_000);
  assert.equal(state.callEvents.event1.webhookReceivedAtMs, T + 60_000);
});

test('exact 30s boundary passes; 30.001s and 30s+1us miss', () => {
  for (const [delay, expected] of [[30_000, 'target_met'], [30_001, 'target_missed']]) {
    const state = stateFixture();
    assert.equal(apply(state, eventFixture('event1', 'call.initiated', delay)).measurement.slaStatus, expected);
  }
  const event = eventFixture('microsecond');
  event.data.occurred_at = '2026-10-10T12:00:30.000001Z';
  const result = apply(stateFixture(), event);
  assert.equal(result.measurement.timeToFirstCallMs, 30_001);
  assert.equal(result.measurement.slaStatus, 'target_missed');
});

test('answered is separate; never implies human contact or an initiated event', () => {
  const state = stateFixture();
  const result = apply(state, eventFixture('answered', 'call.answered', 20_000));
  assert.equal(result.measurement.firstCallInitiatedAtMs, null);
  assert.equal(result.measurement.timeToFirstCallMs, null);
  assert.equal(result.measurement.slaStatus, 'awaiting_verified_initiation');
  assert.equal(result.measurement.timeToFirstAnswerMs, 20_000);
  assert.equal(result.measurement.humanContactVerified, false);
  assert.equal(result.measurement.answerSemantics, 'provider_call_leg_answered');
});

test('late initiated after answered arrival reconciles using provider occurrence times', () => {
  const state = stateFixture();
  apply(state, eventFixture('answered', 'call.answered', 20_000));
  const result = apply(state, eventFixture('started', 'call.initiated', 10_000), T + 120_000);
  assert.equal(result.measurement.timeToFirstCallMs, 10_000);
  assert.equal(result.measurement.timeToFirstAnswerMs, 20_000);
  assert.equal(result.measurement.slaStatus, 'target_met');
  assert.equal(state.callEvents.started.webhookDelayMs, 110_000);
});

test('duplicate ID+same data is idempotent despite delivery meta or JSON key order', () => {
  const state = stateFixture();
  const original = eventFixture();
  apply(state, original);
  const before = JSON.stringify(state);
  const reordered = { data: Object.fromEntries(Object.entries(original.data).reverse()), meta: { attempt: 2 } };
  assert.equal(apply(state, reordered, T + 120_000).status, 'duplicate');
  assert.equal(JSON.stringify(state), before);
});

test('conflicting same event ID creates immediate durable exception without overwriting original', () => {
  const state = stateFixture();
  apply(state, eventFixture());
  const firstDigest = state.callEvents.event1.digest;
  const result = apply(state, eventFixture('event1', 'call.initiated', 45_000));
  assert.equal(result.code, 'TELNYX_EVENT_ID_CONFLICT');
  assert.equal(state.callEvents.event1.digest, firstDigest);
  assert.equal(state.leads.lead1.telephony.slaStatus, 'measurement_unverified');
  assert.equal(state.exceptions[result.exceptionId].severity, 'immediate');
  assert.equal(state.exceptions[result.exceptionId].status, 'pending_human_review');
  apply(state, eventFixture('event1', 'call.initiated', 45_000));
  assert.equal(Object.keys(state.exceptions).length, 1);
});

test('unbound webhook cannot attribute SLA from client_state or Monday labels', () => {
  const state = stateFixture();
  delete state.callBindings;
  const result = apply(state, eventFixture('unbound', 'call.initiated', 10_000, {
    client_state: Buffer.from(JSON.stringify({ leadId: 'lead1', actorId: ACTOR, closerId: 'closer1' })).toString('base64'),
    assigned_closer: 'Operador DEMO',
  }));
  assert.equal(result.code, 'CALL_UNBOUND');
  assert.equal(state.leads.lead1.telephony, undefined);
  assert.equal(Object.keys(state.exceptions).length, 1);
  assert.equal(apply(state, eventFixture('unbound', 'call.initiated', 10_000, {
    client_state: Buffer.from(JSON.stringify({ leadId: 'lead1', actorId: ACTOR, closerId: 'closer1' })).toString('base64'),
    assigned_closer: 'Operador DEMO',
  })).status, 'duplicate');
});

test('incoming or unknown direction never counts as outbound SLA', () => {
  for (const direction of ['incoming', 'outbound', null]) {
    const state = stateFixture();
    assert.equal(apply(state, eventFixture('direction', 'call.initiated', 10_000, { direction })).code, 'CALL_NOT_OUTGOING');
    assert.equal(state.leads.lead1.telephony, undefined);
  }
});

test('first verified initiation uses earliest occurrence across out-of-order events', () => {
  const state = stateFixture();
  apply(state, eventFixture('later', 'call.initiated', 40_000));
  const result = apply(state, eventFixture('earlier', 'call.initiated', 5_000));
  assert.equal(result.measurement.firstCallInitiatedEventId, 'earlier');
  assert.equal(result.measurement.timeToFirstCallMs, 5000);
  assert.equal(result.measurement.slaStatus, 'target_met');
});

test('invalid, negative, impossible, future provider times become exceptions', () => {
  for (const occurred of ['not a timestamp', '-1', -1, Number.MAX_SAFE_INTEGER + 1, '1969-12-31T23:59:59.000Z', '2026-02-30T12:00:00Z', '2026-10-10T12:01:01.000Z']) {
    const state = stateFixture();
    const event = eventFixture();
    event.data.occurred_at = occurred;
    assert.equal(apply(state, event).code, 'CALL_TIMESTAMP_INVALID');
    assert.equal(state.leads.lead1.telephony, undefined);
  }
});

test('before capture/acceptance and unsafe capture timestamps cannot pass measurement', () => {
  const beforeAcceptance = stateFixture();
  assert.equal(apply(beforeAcceptance, eventFixture('early', 'call.initiated', 500)).code, 'CALL_ATTRIBUTION_INVALID');
  for (const captured of [-1, Number.MAX_SAFE_INTEGER + 1, T + 11_000]) {
    const state = stateFixture(); state.leads.lead1.capturedAtMs = captured;
    assert.equal(apply(state, eventFixture()).code, 'CALL_ATTRIBUTION_INVALID');
    assert.equal(state.leads.lead1.telephony, undefined);
  }
});

test('answered before initiated occurrence is unverified, regardless of arrival order', () => {
  for (const order of [['answer', 'start'], ['start', 'answer']]) {
    const state = stateFixture();
    const fixtures = { answer: eventFixture('answered', 'call.answered', 5000), start: eventFixture('initiated', 'call.initiated', 10_000) };
    apply(state, fixtures[order[0]]);
    assert.equal(apply(state, fixtures[order[1]]).code, 'CALL_TIMELINE_INVALID');
    assert.equal(state.leads.lead1.telephony.slaStatus, 'measurement_unverified');
    assert.equal(state.leads.lead1.telephony.firstCallInitiatedAtMs, null);
  }
});

test('unresolved timeline conflict cannot be bypassed by retrying with another event ID', () => {
  const state = stateFixture();
  apply(state, eventFixture('answered', 'call.answered', 5000));
  apply(state, eventFixture('initiated', 'call.initiated', 10_000));
  const result = apply(state, eventFixture('another_initiated', 'call.initiated', 3000));
  assert.equal(result.code, 'CALL_MEASUREMENT_QUARANTINED');
  assert.equal(state.leads.lead1.telephony.slaStatus, 'measurement_unverified');
  assert.equal(state.leads.lead1.telephony.firstCallInitiatedAtMs, null);
});

test('released assignment accepts only event that occurred before release', () => {
  const state = stateFixture();
  state.assignments.reservation1.status = 'released';
  state.assignments.reservation1.releasedAtMs = T + 15_000;
  assert.equal(apply(state, eventFixture('valid', 'call.initiated', 10_000)).status, 'applied');
  assert.equal(apply(state, eventFixture('invalid', 'call.initiated', 15_000)).code, 'CALL_ATTRIBUTION_INVALID');
});

test('binding checks accepted assignment and server actor mapping; never a label', () => {
  const state = stateFixture();
  const input = { callControlId: 'new_call', reservationId: 'reservation1', actorId: 'Other', registeredAtMs: T + 1000 };
  assert.throws(() => registerCallBinding(state, input), { code: 'CALL_ACTOR_FORBIDDEN' });
  state.assignments.reservation1.status = 'reserved_pending_acceptance';
  assert.throws(() => registerCallBinding(state, { ...input, actorId: ACTOR }), { code: 'CALL_ASSIGNMENT_NOT_ACCEPTED' });
});

test('binding registration retry preserves original; conflicting reservation cannot replace it', () => {
  const state = stateFixture();
  const result = registerCallBinding(state, { callControlId: CALL, reservationId: 'reservation1', actorId: ACTOR, registeredAtMs: T + 2000 });
  assert.equal(result.status, 'duplicate');
  assert.equal(result.binding.registeredAtMs, T + 1000);
  state.assignments.reservation2 = { ...state.assignments.reservation1, id: 'reservation2', reservationId: 'reservation2' };
  assert.throws(() => registerCallBinding(state, { callControlId: CALL, reservationId: 'reservation2', actorId: ACTOR, registeredAtMs: T + 2000 }), { code: 'CALL_BINDING_CONFLICT' });
});

test('saved call records exclude phone numbers, client_state and recording URLs', () => {
  const state = stateFixture();
  apply(state, eventFixture('privacy', 'call.initiated', 10_000, {
    from: '+15550000001', to: '+15550000002', client_state: 'synthetic_sensitive_content',
    recording_url: 'https://fixture.invalid/recording',
  }));
  const persisted = JSON.stringify(state);
  for (const sensitive of ['+15550000001', '+15550000002', 'synthetic_sensitive_content', 'https://fixture.invalid/recording']) {
    assert.equal(persisted.includes(sensitive), false);
  }
});

test('unsupported events are durably ignored and do not invent initiation', () => {
  const state = stateFixture();
  assert.equal(apply(state, eventFixture('hangup', 'call.hangup')).status, 'ignored');
  assert.equal(apply(state, eventFixture('hangup', 'call.hangup')).status, 'duplicate');
  assert.equal(state.leads.lead1.telephony, undefined);
});

test('invalid event IDs and invalid processing clock fail without content exposure', () => {
  const state = stateFixture();
  const event = eventFixture('__proto__');
  assert.throws(() => apply(state, event), { code: 'TELNYX_EVENT_INVALID' });
  assert.throws(() => apply(state, eventFixture(), -1), { code: 'TELEPHONY_STATE_INVALID' });
  assert.equal(Object.keys(state.callEvents).length, 0);
});
