import { createHash } from 'node:crypto';

// Local pilot domain only. The caller must authenticate adapters/actors and run
// each command inside its durable serialized transaction. This module does not
// send notifications, call providers, or infer availability from Slack presence.
// Shift windows and all timestamps are explicit UTC epoch milliseconds; there
// are no live policy defaults. Never pass a client's clock as nowMs.

const ACTIVE_STATUSES = new Set(['reserved_pending_acceptance', 'accepted']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function id(value, code = 'INVALID_ID') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(code);
  return value;
}

function timestamp(value, code = 'INVALID_TIMESTAMP') {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function stateTables(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('INVALID_STATE');
  for (const name of ['leads', 'closers', 'assignments', 'exceptions']) {
    const table = state[name];
    if (!table || typeof table !== 'object' || Array.isArray(table)) fail('INVALID_STATE');
    const prototype = Object.getPrototypeOf(table);
    if (prototype !== Object.prototype && prototype !== null) fail('INVALID_STATE');
  }
}

function record(table, key) {
  return Object.hasOwn(table, key) ? table[key] : null;
}

function copy(value) {
  return structuredClone(value);
}

function byId(a, b) {
  // Code-unit ordering is stable across server locale settings.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function currentLead(state, leadId) {
  const lead = record(state.leads, leadId);
  if (!lead) fail('LEAD_NOT_FOUND');
  return lead;
}

function checkClock(nowMs, recordValue) {
  if (nowMs < recordValue.updatedAtMs) fail('CLOCK_REWIND');
}

function activeAssignments(state, nowMs, closerId) {
  return Object.values(state.assignments).filter((assignment) =>
    assignment.closerId === closerId &&
    (assignment.status === 'accepted' ||
      (assignment.status === 'reserved_pending_acceptance' && assignment.acceptByMs > nowMs)));
}

function eligible(state, closer, departmentId, nowMs, accepting = false) {
  if (!closer || closer.active !== true || !closer.departmentIds.includes(departmentId)) return false;
  if (closer.availableUntilMs <= nowMs || closer.shiftStartMs > nowMs || closer.shiftEndMs <= nowMs) return false;
  if (closer.capacity <= 0) return false;
  const used = activeAssignments(state, nowMs, closer.id).length;
  return accepting ? used <= closer.capacity : used < closer.capacity;
}

function queueException(state, lead, reason, nowMs) {
  const exceptionId = `assignment:${lead.id}:${lead.assignmentRevision}:${reason}`;
  let exception = record(state.exceptions, exceptionId);
  if (!exception) {
    exception = {
      id: exceptionId,
      type: 'assignment_exception',
      leadId: lead.id,
      departmentId: lead.departmentId,
      revision: lead.assignmentRevision,
      reason,
      status: 'escalation_pending',
      createdAtMs: nowMs,
      resolvedAtMs: null,
    };
    state.exceptions[exceptionId] = exception;
  }
  return exception;
}

function queue(state, lead, reason, nowMs) {
  const changed = lead.status !== 'queued' || lead.queueReason !== reason || lead.activeReservationId !== null;
  lead.status = 'queued';
  lead.activeReservationId = null;
  lead.queueReason = reason;
  if (changed) {
    lead.queuedAtMs = nowMs;
    lead.updatedAtMs = nowMs;
  }
  return queueException(state, lead, reason, nowMs);
}

function resolveQueueExceptions(state, leadId, nowMs) {
  for (const exception of Object.values(state.exceptions)) {
    if (exception.type === 'assignment_exception' && exception.leadId === leadId && exception.status === 'escalation_pending') {
      exception.status = 'resolved';
      exception.resolvedAtMs = nowMs;
    }
  }
}

function finishPending(state, assignment, status, reason, nowMs) {
  assignment.status = status;
  assignment.releasedAtMs = nowMs;
  assignment.releaseReason = reason;
  const lead = currentLead(state, assignment.leadId);
  if (lead.activeReservationId !== assignment.id) fail('STATE_CONFLICT');
  const exception = queue(state, lead, reason, nowMs);
  return { assignment, lead, exception };
}

/**
 * Trusted adapter input: {leadId, departmentId, capturedAtMs, captureSource, nowMs}.
 * The first capture is immutable. Equal retries replay it; collisions reject.
 */
export function captureLead(state, input) {
  stateTables(state);
  const leadId = id(input?.leadId);
  const departmentId = id(input?.departmentId);
  const captureSource = id(input?.captureSource);
  const capturedAtMs = timestamp(input?.capturedAtMs);
  const nowMs = timestamp(input?.nowMs);
  if (capturedAtMs > nowMs) fail('CAPTURE_IN_FUTURE');
  const existing = record(state.leads, leadId);
  if (existing) {
    if (existing.departmentId !== departmentId || existing.captureSource !== captureSource || existing.capturedAtMs !== capturedAtMs) {
      fail('LEAD_CAPTURE_CONFLICT');
    }
    return { lead: copy(existing), replayed: true };
  }
  const lead = {
    id: leadId,
    leadId,
    departmentId,
    captureSource,
    capturedAtMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    status: 'queued',
    assignmentRevision: 0,
    activeReservationId: null,
    queuedAtMs: nowMs,
    queueReason: 'AWAITING_ASSIGNMENT',
  };
  state.leads[leadId] = lead;
  return { lead: copy(lead), replayed: false };
}

/**
 * Full explicit profile: {closerId,actorId,active,departmentIds,shiftStartMs,
 * shiftEndMs,capacity,availableUntilMs,nowMs}. Pausing uses availableUntilMs=nowMs.
 * One actor has one profile; roles/departments share capacity. Identity binding
 * is immutable and is never derived from Monday's editable closer status.
 */
export function setCloserAvailability(state, input) {
  stateTables(state);
  const closerId = id(input?.closerId);
  const actorId = id(input?.actorId);
  if (typeof input?.active !== 'boolean') fail('INVALID_ACTIVE');
  if (!Array.isArray(input?.departmentIds) || input.departmentIds.length === 0) fail('INVALID_DEPARTMENTS');
  const departmentIds = [...new Set(input.departmentIds.map((value) => id(value)))].sort();
  const shiftStartMs = timestamp(input?.shiftStartMs);
  const shiftEndMs = timestamp(input?.shiftEndMs);
  const availableUntilMs = timestamp(input?.availableUntilMs);
  const nowMs = timestamp(input?.nowMs);
  if (shiftEndMs <= shiftStartMs) fail('INVALID_SHIFT_WINDOW');
  if (!Number.isSafeInteger(input?.capacity) || input.capacity < 0) fail('INVALID_CAPACITY');
  const existing = record(state.closers, closerId);
  if (existing && existing.actorId !== actorId) fail('CLOSER_ACTOR_CONFLICT');
  if (Object.values(state.closers).some((closer) => closer.id !== closerId && closer.actorId === actorId)) fail('ACTOR_ALREADY_BOUND');
  if (existing) checkClock(nowMs, existing);
  const policy = { active: input.active, departmentIds, shiftStartMs, shiftEndMs, capacity: input.capacity, availableUntilMs };
  if (existing && Object.keys(policy).every((key) => JSON.stringify(existing[key]) === JSON.stringify(policy[key]))) {
    return { closer: copy(existing), replayed: true };
  }
  const closer = {
    id: closerId,
    closerId,
    actorId,
    ...policy,
    policyRevision: (existing?.policyRevision ?? 0) + 1,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    availabilitySetAtMs: nowMs,
  };
  state.closers[closerId] = closer;
  return { closer: copy(closer), replayed: false };
}

/** Expire at nowMs >= acceptByMs, deterministically, once per reservation. */
export function expireReservations(state, { nowMs }) {
  stateTables(state);
  timestamp(nowMs);
  const pending = Object.values(state.assignments)
    .filter((assignment) => assignment.status === 'reserved_pending_acceptance' && assignment.acceptByMs <= nowMs)
    .sort(byId);
  // Validate every transition before mutating; an inconsistent store must abort.
  for (const assignment of pending) {
    const lead = currentLead(state, assignment.leadId);
    if (lead.activeReservationId !== assignment.id) fail('STATE_CONFLICT');
    checkClock(nowMs, lead);
  }
  const expired = [];
  for (const assignment of pending) {
    finishPending(state, assignment, 'expired', 'RESERVATION_EXPIRED', nowMs);
    expired.push(copy(assignment));
  }
  return { expired, queuedLeadIds: expired.map((assignment) => assignment.leadId) };
}

/**
 * {leadId,nowMs,acceptanceTimeoutMs}. Call in one durable transaction. Existing
 * active reservations replay unchanged. Selection is sorted closer ID; timeout
 * policy is mandatory. No eligible closer means queue + local escalation record.
 */
export function reserveLead(state, input) {
  stateTables(state);
  const leadId = id(input?.leadId);
  const nowMs = timestamp(input?.nowMs);
  const timeout = input?.acceptanceTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(nowMs + timeout)) fail('INVALID_ACCEPTANCE_TIMEOUT');
  const lead = currentLead(state, leadId);
  checkClock(nowMs, lead);
  if (lead.status === 'released') fail('LEAD_CLOSED');
  expireReservations(state, { nowMs });
  const active = Object.values(state.assignments).filter((assignment) => assignment.leadId === leadId && ACTIVE_STATUSES.has(assignment.status));
  if (active.length > 1) fail('STATE_CONFLICT');
  if (active.length === 1) {
    if (lead.activeReservationId !== active[0].id) fail('STATE_CONFLICT');
    return { lead: copy(lead), assignment: copy(active[0]), queued: false, exception: null, replayed: true };
  }
  if (lead.activeReservationId !== null) fail('STATE_CONFLICT');
  const closer = Object.values(state.closers)
    .filter((candidate) => eligible(state, candidate, lead.departmentId, nowMs))
    .sort(byId)[0];
  if (!closer) {
    const replayed = lead.status === 'queued' && lead.queueReason === 'NO_ELIGIBLE_CLOSER';
    const exception = queue(state, lead, 'NO_ELIGIBLE_CLOSER', nowMs);
    return { lead: copy(lead), assignment: null, queued: true, exception: copy(exception), replayed };
  }
  const revision = lead.assignmentRevision + 1;
  if (!Number.isSafeInteger(revision)) fail('REVISION_LIMIT');
  const reservationId = `reservation:${createHash('sha256').update(leadId).digest('hex')}:${revision}`;
  if (record(state.assignments, reservationId)) fail('STATE_CONFLICT');
  const assignment = {
    id: reservationId,
    reservationId,
    leadId,
    closerId: closer.id,
    departmentId: lead.departmentId,
    revision,
    status: 'reserved_pending_acceptance',
    reservedAtMs: nowMs,
    acceptByMs: nowMs + timeout,
    acceptedAtMs: null,
    releasedAtMs: null,
    releaseReason: null,
    eligibilitySnapshot: {
      actorId: closer.actorId,
      policyRevision: closer.policyRevision,
      shiftStartMs: closer.shiftStartMs,
      shiftEndMs: closer.shiftEndMs,
      availableUntilMs: closer.availableUntilMs,
      capacity: closer.capacity,
    },
  };
  state.assignments[reservationId] = assignment;
  lead.assignmentRevision = revision;
  lead.activeReservationId = reservationId;
  lead.status = 'reserved_pending_acceptance';
  lead.queueReason = null;
  lead.updatedAtMs = nowMs;
  resolveQueueExceptions(state, leadId, nowMs);
  return { lead: copy(lead), assignment: copy(assignment), queued: false, exception: null, replayed: false };
}

/**
 * {reservationId,closerId,nowMs}; gateway verifies actor→closer. At/after deadline
 * or eligibility loss, return accepted:false AND persist expiry/queue transition.
 * Invalid identity/obsolete reservation throws without an acceptance transition.
 */
export function acceptReservation(state, input) {
  stateTables(state);
  const reservationId = id(input?.reservationId);
  const closerId = id(input?.closerId);
  const nowMs = timestamp(input?.nowMs);
  const assignment = record(state.assignments, reservationId);
  if (!assignment) fail('RESERVATION_NOT_FOUND');
  if (assignment.closerId !== closerId) fail('RESERVATION_CLOSER_MISMATCH');
  const lead = currentLead(state, assignment.leadId);
  if (assignment.status === 'accepted' && lead.activeReservationId === reservationId) {
    return { accepted: true, assignment: copy(assignment), lead: copy(lead), exception: null, replayed: true };
  }
  if (assignment.status !== 'reserved_pending_acceptance' || lead.activeReservationId !== reservationId) fail('RESERVATION_NOT_ACTIVE');
  checkClock(nowMs, lead);
  if (assignment.acceptByMs <= nowMs) {
    const result = finishPending(state, assignment, 'expired', 'RESERVATION_EXPIRED', nowMs);
    return { accepted: false, reason: 'RESERVATION_EXPIRED', ...copy(result), replayed: false };
  }
  const closer = record(state.closers, closerId);
  if (!eligible(state, closer, lead.departmentId, nowMs, true)) {
    const result = finishPending(state, assignment, 'invalidated', 'CLOSER_NOT_ELIGIBLE', nowMs);
    return { accepted: false, reason: 'CLOSER_NOT_ELIGIBLE', ...copy(result), replayed: false };
  }
  assignment.status = 'accepted';
  assignment.acceptedAtMs = nowMs;
  lead.status = 'accepted';
  lead.updatedAtMs = nowMs;
  return { accepted: true, assignment: copy(assignment), lead: copy(lead), exception: null, replayed: false };
}

/** {reservationId,nowMs,reason}. Release once; completing work closes the lead. */
export function releaseAssignment(state, input) {
  stateTables(state);
  const reservationId = id(input?.reservationId);
  const nowMs = timestamp(input?.nowMs);
  const reason = id(input?.reason, 'INVALID_RELEASE_REASON');
  const assignment = record(state.assignments, reservationId);
  if (!assignment) fail('RESERVATION_NOT_FOUND');
  const lead = currentLead(state, assignment.leadId);
  if (assignment.status === 'released') {
    if (assignment.releaseReason !== reason) fail('RELEASE_CONFLICT');
    return { assignment: copy(assignment), lead: copy(lead), replayed: true };
  }
  if (!ACTIVE_STATUSES.has(assignment.status) || lead.activeReservationId !== reservationId) fail('RESERVATION_NOT_ACTIVE');
  checkClock(nowMs, lead);
  assignment.status = 'released';
  assignment.releasedAtMs = nowMs;
  assignment.releaseReason = reason;
  lead.activeReservationId = null;
  lead.status = 'released';
  lead.queueReason = null;
  lead.updatedAtMs = nowMs;
  resolveQueueExceptions(state, lead.id, nowMs);
  return { assignment: copy(assignment), lead: copy(lead), replayed: false };
}
