import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureLead,
  setCloserAvailability,
  reserveLead,
  acceptReservation,
  expireReservations,
  releaseAssignment,
} from '../../src/operations/assignment.mjs';

const NOW = 1_800_000_000_000;
const CLOSER = 'OFFICE_DEMO_OPERATOR';

function state() {
  return { leads: {}, closers: {}, assignments: {}, callEvents: {}, payments: {}, invoices: {}, exceptions: {} };
}

function profile(overrides = {}) {
  return {
    closerId: CLOSER,
    actorId: CLOSER,
    active: true,
    departmentIds: ['sales', 'coordinator', 'logistics'],
    shiftStartMs: NOW - 3_600_000,
    shiftEndMs: NOW + 3_600_000,
    capacity: 1,
    availableUntilMs: NOW + 60_000,
    nowMs: NOW,
    ...overrides,
  };
}

function capture(store, leadId = 'lead-synthetic-1', overrides = {}) {
  return captureLead(store, {
    leadId,
    departmentId: 'sales',
    captureSource: 'trusted-synthetic-fixture',
    capturedAtMs: NOW - 10_000,
    nowMs: NOW,
    ...overrides,
  });
}

function reserve(store, leadId = 'lead-synthetic-1', overrides = {}) {
  return reserveLead(store, { leadId, nowMs: NOW, acceptanceTimeoutMs: 15_000, ...overrides });
}

function ready() {
  const store = state();
  capture(store);
  setCloserAvailability(store, profile());
  return store;
}

function safeError(code) {
  return (error) => error instanceof Error && error.code === code && error.message === code;
}

test('first trusted capture replays without replacing capture or server timestamps', () => {
  const store = state();
  const first = capture(store);
  const retry = capture(store, 'lead-synthetic-1', { nowMs: NOW + 10_000 });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.lead, first.lead);
  assert.equal(retry.lead.capturedAtMs, NOW - 10_000);
  assert.equal(retry.lead.createdAtMs, NOW);
  retry.lead.departmentId = 'not-stored';
  assert.equal(store.leads['lead-synthetic-1'].departmentId, 'sales');
});

test('capture source, department or timestamp collision rejects and keeps original', () => {
  const store = state();
  capture(store);
  const original = structuredClone(store);
  for (const overrides of [
    { captureSource: 'different-source' },
    { departmentId: 'logistics' },
    { capturedAtMs: NOW - 9_999 },
  ]) {
    assert.throws(() => capture(store, 'lead-synthetic-1', overrides), safeError('LEAD_CAPTURE_CONFLICT'));
    assert.deepEqual(store, original);
  }
});

test('strict IDs, safe timestamps and explicit policy reject invalid inputs', () => {
  const store = state();
  assert.throws(() => capture(store, '__proto__'), safeError('INVALID_ID'));
  assert.throws(() => capture(store, 'bad id'), safeError('INVALID_ID'));
  assert.throws(() => capture(store, 'valid', { capturedAtMs: NOW + 1 }), safeError('CAPTURE_IN_FUTURE'));
  assert.throws(() => capture(store, 'valid', { nowMs: Number.MAX_SAFE_INTEGER + 1 }), safeError('INVALID_TIMESTAMP'));
  assert.throws(() => setCloserAvailability(store, profile({ active: 'true' })), safeError('INVALID_ACTIVE'));
  assert.throws(() => setCloserAvailability(store, profile({ departmentIds: [] })), safeError('INVALID_DEPARTMENTS'));
  assert.throws(() => setCloserAvailability(store, profile({ shiftEndMs: NOW - 3_600_000 })), safeError('INVALID_SHIFT_WINDOW'));
  assert.throws(() => setCloserAvailability(store, profile({ capacity: 1.5 })), safeError('INVALID_CAPACITY'));
  capture(store);
  assert.throws(() => reserveLead(store, { leadId: 'lead-synthetic-1', nowMs: NOW }), safeError('INVALID_ACCEPTANCE_TIMEOUT'));
  assert.throws(() => reserve(store, 'lead-synthetic-1', { acceptanceTimeoutMs: 0 }), safeError('INVALID_ACCEPTANCE_TIMEOUT'));
  assert.throws(() => reserve(store, 'lead-synthetic-1', { acceptanceTimeoutMs: Number.MAX_SAFE_INTEGER }), safeError('INVALID_ACCEPTANCE_TIMEOUT'));
  assert.equal(Object.hasOwn(store.leads, '__proto__'), false);
});

test('profile replay keeps explicit availability timestamp and one identity binding', () => {
  const store = state();
  const first = setCloserAvailability(store, profile());
  const replay = setCloserAvailability(store, profile({ nowMs: NOW + 1_000 }));
  assert.deepEqual(replay.closer, first.closer);
  assert.equal(replay.replayed, true);
  assert.throws(() => setCloserAvailability(store, profile({ closerId: 'other-profile' })), safeError('ACTOR_ALREADY_BOUND'));
  assert.throws(() => setCloserAvailability(store, profile({ actorId: 'other-actor' })), safeError('CLOSER_ACTOR_CONFLICT'));
});

test('no closer or presence-only input queues a single local escalation', () => {
  const store = state();
  capture(store);
  const first = reserve(store);
  const replay = reserve(store, 'lead-synthetic-1', { nowMs: NOW + 1_000 });
  assert.equal(first.queued, true);
  assert.equal(first.assignment, null);
  assert.equal(first.exception.status, 'escalation_pending');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.exception, first.exception);
  assert.equal(Object.keys(store.exceptions).length, 1);
  // Slack presence is intentionally not a policy field and cannot replace an
  // explicit profile with grant, turn window, capacity and expiry.
  assert.throws(() => setCloserAvailability(store, { closerId: CLOSER, actorId: CLOSER, presence: 'active', nowMs: NOW }), safeError('INVALID_ACTIVE'));
});

test('inactive, expired, out of shift, ungranted or zero capacity cannot reserve', () => {
  for (const overrides of [
    { active: false },
    { availableUntilMs: NOW },
    { shiftStartMs: NOW + 1 },
    { shiftStartMs: NOW - 1_000, shiftEndMs: NOW },
    { departmentIds: ['marketing'] },
    { capacity: 0 },
  ]) {
    const store = state();
    capture(store);
    setCloserAvailability(store, profile(overrides));
    const result = reserve(store);
    assert.equal(result.queued, true, JSON.stringify(overrides));
    assert.equal(result.lead.queueReason, 'NO_ELIGIBLE_CLOSER');
  }
});

test('explicit shift includes start, excludes end, and can cross midnight', () => {
  const store = state();
  capture(store);
  setCloserAvailability(store, profile({ shiftStartMs: NOW, shiftEndMs: NOW + 60_000 }));
  assert.equal(reserve(store).queued, false);
  const midnight = Date.UTC(2026, 9, 10, 0, 0, 0);
  const nightStore = state();
  capture(nightStore, 'night-lead', { capturedAtMs: midnight, nowMs: midnight });
  setCloserAvailability(nightStore, profile({
    shiftStartMs: midnight - 3_600_000,
    shiftEndMs: midnight + 3_600_000,
    availableUntilMs: midnight + 60_000,
    nowMs: midnight,
  }));
  assert.equal(reserve(nightStore, 'night-lead', { nowMs: midnight }).queued, false);
});

test('deterministic reservation and restart replay consume capacity once', () => {
  const store = ready();
  const first = reserve(store);
  const persisted = JSON.parse(JSON.stringify(store));
  const replay = reserve(persisted, 'lead-synthetic-1', { nowMs: NOW + 1_000 });
  assert.equal(first.assignment.reservationId, first.assignment.id);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.assignment, first.assignment);
  assert.equal(Object.keys(persisted.assignments).length, 1);
  const independent = ready();
  assert.equal(reserve(independent).assignment.id, first.assignment.id);
  capture(persisted, 'second-lead', { nowMs: NOW + 1_000 });
  assert.equal(reserve(persisted, 'second-lead', { nowMs: NOW + 1_000 }).queued, true);
});

test('pending plus accepted assignments share capacity across all roles', () => {
  const store = ready();
  const first = reserve(store);
  capture(store, 'coordinator-lead', { departmentId: 'coordinator' });
  assert.equal(reserve(store, 'coordinator-lead').queued, true);
  assert.equal(acceptReservation(store, { reservationId: first.assignment.id, closerId: CLOSER, nowMs: NOW + 1_000 }).accepted, true);
  capture(store, 'logistics-lead', { departmentId: 'logistics', nowMs: NOW + 1_000 });
  assert.equal(reserve(store, 'logistics-lead', { nowMs: NOW + 1_000 }).queued, true);
  assert.equal(Object.values(store.assignments).filter((a) => a.status === 'accepted').length, 1);
});

test('configured capacity of two permits two reservations, then queues third', () => {
  const store = ready();
  setCloserAvailability(store, profile({ capacity: 2 }));
  reserve(store);
  capture(store, 'second-lead');
  reserve(store, 'second-lead');
  capture(store, 'third-lead');
  assert.equal(reserve(store, 'third-lead').queued, true);
  assert.equal(Object.keys(store.assignments).length, 2);
});

test('closer selection uses deterministic IDs regardless of insertion order', () => {
  const store = state();
  capture(store);
  setCloserAvailability(store, profile({ closerId: 'z-closer', actorId: 'z-actor' }));
  setCloserAvailability(store, profile({ closerId: 'a-closer', actorId: 'a-actor' }));
  assert.equal(reserve(store).assignment.closerId, 'a-closer');
});

test('wrong closer cannot accept and produces no mutation', () => {
  const store = ready();
  const assignment = reserve(store).assignment;
  const before = structuredClone(store);
  assert.throws(() => acceptReservation(store, { reservationId: assignment.id, closerId: 'wrong-closer', nowMs: NOW + 1_000 }), safeError('RESERVATION_CLOSER_MISMATCH'));
  assert.deepEqual(store, before);
});

test('acceptance before deadline replays without consuming another capacity slot', () => {
  const store = ready();
  const assignment = reserve(store).assignment;
  const first = acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW + 14_999 });
  const replay = acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW + 90_000 });
  assert.equal(first.accepted, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.assignment, first.assignment);
  assert.equal(first.assignment.acceptedAtMs, NOW + 14_999);
  assert.equal(expireReservations(store, { nowMs: NOW + 90_000 }).expired.length, 0);
});

test('acceptance exactly at deadline expires, frees slot and queues escalation', () => {
  const store = ready();
  const assignment = reserve(store).assignment;
  const result = acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW + 15_000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'RESERVATION_EXPIRED');
  assert.equal(result.assignment.status, 'expired');
  assert.equal(result.assignment.releasedAtMs, NOW + 15_000);
  assert.equal(result.lead.activeReservationId, null);
  assert.equal(result.exception.status, 'escalation_pending');
  assert.equal(expireReservations(store, { nowMs: NOW + 16_000 }).expired.length, 0);
});

test('watchdog expiry is once and an old acceptance cannot take a reassigned slot', () => {
  const store = ready();
  const first = reserve(store).assignment;
  assert.equal(expireReservations(store, { nowMs: NOW + 14_999 }).expired.length, 0);
  assert.equal(expireReservations(store, { nowMs: NOW + 15_000 }).expired.length, 1);
  const second = reserve(store, 'lead-synthetic-1', { nowMs: NOW + 15_001 }).assignment;
  assert.notEqual(second.id, first.id);
  assert.equal(second.revision, 2);
  const before = structuredClone(store);
  assert.throws(() => acceptReservation(store, { reservationId: first.id, closerId: CLOSER, nowMs: NOW + 15_002 }), safeError('RESERVATION_NOT_ACTIVE'));
  assert.deepEqual(store, before);
  assert.equal(store.leads['lead-synthetic-1'].activeReservationId, second.id);
  assert.equal(Object.values(store.assignments).filter((a) => a.status === 'reserved_pending_acceptance').length, 1);
});

test('reserve expires timed out reservations before considering capacity', () => {
  const store = ready();
  const first = reserve(store).assignment;
  capture(store, 'second-lead', { nowMs: NOW + 15_000 });
  const second = reserve(store, 'second-lead', { nowMs: NOW + 15_000 });
  assert.equal(second.queued, false);
  assert.equal(store.assignments[first.id].status, 'expired');
  assert.equal(store.leads['lead-synthetic-1'].status, 'queued');
});

test('pausing the only closer queues new lead and invalidates pending acceptance', () => {
  const store = ready();
  const first = reserve(store).assignment;
  setCloserAvailability(store, profile({ availableUntilMs: NOW + 1_000, nowMs: NOW + 1_000 }));
  capture(store, 'second-lead', { nowMs: NOW + 1_000 });
  const noCloser = reserve(store, 'second-lead', { nowMs: NOW + 1_000 });
  assert.equal(noCloser.queued, true);
  assert.equal(noCloser.exception.status, 'escalation_pending');
  const result = acceptReservation(store, { reservationId: first.id, closerId: CLOSER, nowMs: NOW + 1_000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'CLOSER_NOT_ELIGIBLE');
  assert.equal(result.assignment.status, 'invalidated');
  assert.equal(result.lead.status, 'queued');
});

test('acceptance rechecks active flag, grant, expiry, shift and shared capacity', () => {
  for (const overrides of [
    { active: false },
    { departmentIds: ['logistics'] },
    { availableUntilMs: NOW + 1_000 },
    { shiftEndMs: NOW + 1_000 },
    { capacity: 0 },
  ]) {
    const store = ready();
    const assignment = reserve(store).assignment;
    setCloserAvailability(store, profile({ ...overrides, nowMs: NOW + 1_000 }));
    const result = acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW + 1_000 });
    assert.equal(result.accepted, false, JSON.stringify(overrides));
    assert.equal(result.assignment.status, 'invalidated');
  }
});

test('capacity reduced below reservations cannot accept over capacity', () => {
  const store = ready();
  setCloserAvailability(store, profile({ capacity: 2 }));
  const first = reserve(store).assignment;
  capture(store, 'second-lead');
  const second = reserve(store, 'second-lead').assignment;
  setCloserAvailability(store, profile({ capacity: 1, nowMs: NOW + 1_000 }));
  assert.equal(acceptReservation(store, { reservationId: first.id, closerId: CLOSER, nowMs: NOW + 1_000 }).accepted, false);
  assert.equal(acceptReservation(store, { reservationId: second.id, closerId: CLOSER, nowMs: NOW + 1_000 }).accepted, true);
  assert.equal(Object.values(store.assignments).filter((a) => a.status === 'accepted').length, 1);
});

test('release once frees shared capacity, closes lead, and conflicting retry rejects', () => {
  const store = ready();
  const assignment = reserve(store).assignment;
  acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW + 1_000 });
  const first = releaseAssignment(store, { reservationId: assignment.id, reason: 'completed', nowMs: NOW + 2_000 });
  const replay = releaseAssignment(store, { reservationId: assignment.id, reason: 'completed', nowMs: NOW + 3_000 });
  assert.deepEqual(replay.assignment, first.assignment);
  assert.equal(replay.replayed, true);
  assert.equal(replay.assignment.releasedAtMs, NOW + 2_000);
  assert.equal(store.leads['lead-synthetic-1'].status, 'released');
  assert.throws(() => releaseAssignment(store, { reservationId: assignment.id, reason: 'changed', nowMs: NOW + 3_000 }), safeError('RELEASE_CONFLICT'));
  assert.throws(() => reserve(store, 'lead-synthetic-1', { nowMs: NOW + 3_000 }), safeError('LEAD_CLOSED'));
  capture(store, 'second-lead', { nowMs: NOW + 3_000 });
  assert.equal(reserve(store, 'second-lead', { nowMs: NOW + 3_000 }).queued, false);
});

test('an earlier server clock cannot alter a later reservation or availability', () => {
  const store = ready();
  const assignment = reserve(store, 'lead-synthetic-1', { nowMs: NOW + 1_000 }).assignment;
  assert.throws(() => acceptReservation(store, { reservationId: assignment.id, closerId: CLOSER, nowMs: NOW }), safeError('CLOCK_REWIND'));
  setCloserAvailability(store, profile({ availableUntilMs: NOW + 120_000, nowMs: NOW + 1_000 }));
  assert.throws(() => setCloserAvailability(store, profile()), safeError('CLOCK_REWIND'));
});

test('inconsistent duplicate active assignment fails rather than double allocating', () => {
  const store = ready();
  const first = reserve(store).assignment;
  store.assignments['corrupt-duplicate'] = { ...first, id: 'corrupt-duplicate', reservationId: 'corrupt-duplicate' };
  assert.throws(() => reserve(store), safeError('STATE_CONFLICT'));
});
