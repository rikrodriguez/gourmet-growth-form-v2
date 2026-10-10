import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callTiming, deriveAreaStatus, readyForExecution } from '../../src/office/model';
import { executeDemoCommand, loadDemoSnapshot, loadLiveSnapshot, OfficeReadError, validateOfficeSnapshot } from '../../src/office/adapter';
import type { Evidence, OfficeCase, OfficeCommand, OfficeSnapshot, WorkStatus } from '../../src/office/contracts';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { projectOfficeSnapshot } from '../../src/office/backend/state';

const AT = '2026-10-10T16:05:00.000Z';
const LEAD_ID = '00000000-0000-4000-8000-000000000001';
function evidence(reference = 'demo:demo-aurora:fixture'): Evidence {
  return { source: 'fixture:office-demo', at: AT, simulated: true, reference };
}
function fixture(): OfficeCase {
  return {
    id: 'demo-aurora', title: 'Aurora · caso sintético', subtitle: 'Demostración explícita', evidence: evidence(),
    payment: 'verified', paymentEvidence: evidence('demo:demo-aurora:payment'), supplier: 'pending', supplierEvidence: evidence('demo:demo-aurora:supplier'),
    capturedAt: '2026-10-10T16:00:00.000Z', attemptedAt: '2026-10-10T16:00:08.000Z', connectedAt: '2026-10-10T16:00:24.000Z', humanContactVerified: true, callEvidence: evidence('demo:demo-aurora:call'),
    closerAvailable: true, assignment: 'assigned', saleClosed: true,
    tasks: [{ id: 'approval-task', area: 'sales', functionId: 'proposals', title: 'Cotización', detail: 'Pendiente', status: 'awaiting_approval', evidence: evidence() }],
    results: [], messages: [], history: [],
    approvals: [{ id: 'quote-demo', area: 'sales', functionId: 'proposals', title: 'Cotización demo', body: 'Texto exacto sintético', recipient: 'Cliente sintético', account: 'Gourmet demo', attachments: ['Ficha sintética'], channel: 'demo', revision: 1, digest: 'a'.repeat(64), status: 'pending', evidence: evidence() }],
  };
}
function snapshot(): OfficeSnapshot { return { mode: 'demo', asOf: AT, cases: [fixture()], note: 'Solo demostración.', outboundEffects: 0, mondayWrites: 0 }; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function staff() { return { user: { staff_user_id: LEAD_ID, email: 'staff@example.test', role: 'viewer' }, expires_at: '2099-10-11T12:00:00.000Z' }; }
function lead(overrides: Record<string, unknown> = {}) { return { lead_id: LEAD_ID, status: 'completed', created_at: '2026-10-10T16:00:00.000Z', updated_at: AT, is_qa: false, completed: true, phone_captured: true, ...overrides }; }
function leadPayload(rows: unknown[] = [lead()]) { return { range: { from: '2026-10-04T07:00:00.000Z', to: '2026-10-11T07:00:00.000Z', label: 'Last 7 days', timezone: 'America/Los_Angeles', include_qa: false }, rows, next_cursor: null }; }
function hasCode(code: OfficeReadError['code']) { return (error: unknown) => error instanceof OfficeReadError && error.code === code; }

describe('office evidence and operational invariants', () => {
  it('accepts the actual backend fixture projection with independent case states and all seven statuses', () => {
    const atMs = Date.parse(AT);
    const projected = projectOfficeSnapshot(createOfficeFixtureState(atMs), atMs);
    const parsed = validateOfficeSnapshot(projected, 'demo');
    assert.deepEqual(parsed, projected);
    const [aurora, cedar, harbor] = parsed.cases;
    assert.equal(aurora.payment, 'verified'); assert.equal(aurora.supplier, 'pending');
    assert.equal(cedar.payment, 'pending'); assert.equal(cedar.supplier, 'accepted');
    assert.equal(harbor.assignment, 'queued'); assert.equal(harbor.closerAvailable, false);
    assert(parsed.cases.every(c => !readyForExecution(c)));
    assert.deepEqual(callTiming(aurora), { attemptSeconds: 20, connectedSeconds: 35, met: false });
    assert.deepEqual(callTiming(cedar), { attemptSeconds: 25, connectedSeconds: null, met: null });
    assert.deepEqual(callTiming(harbor), { attemptSeconds: null, connectedSeconds: null, met: null });
    assert.deepEqual(new Set(parsed.cases.flatMap(c => c.tasks.map(task => task.status))), new Set(['queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'stale']));
    assert.equal(new Set(parsed.cases.flatMap(c => c.tasks.map(task => task.functionId))).size, 9);
  });

  it('measures connected human contact separately from an attempted call', () => {
    assert.deepEqual(callTiming(fixture()), { attemptSeconds: 8, connectedSeconds: 24, met: true });
    const answeredLeg = { ...fixture(), attemptedAt: '2026-10-10T16:00:18.000Z', connectedAt: null, humanContactVerified: false };
    assert.deepEqual(callTiming(answeredLeg), { attemptSeconds: 18, connectedSeconds: null, met: null });
    assert.deepEqual(callTiming({ ...fixture(), attemptedAt: null, connectedAt: null, humanContactVerified: false, callEvidence: null }), { attemptSeconds: null, connectedSeconds: null, met: null });
  });

  it('uses the exact 30 second connection boundary and rejects invalid chronology or evidence', () => {
    assert.equal(callTiming({ ...fixture(), connectedAt: '2026-10-10T16:00:30.000Z' }).met, true);
    assert.equal(callTiming({ ...fixture(), connectedAt: '2026-10-10T16:00:30.001Z' }).met, false);
    assert.equal(callTiming({ ...fixture(), connectedAt: '2026-10-10T15:59:59.000Z' }).met, null);
    assert.equal(callTiming({ ...fixture(), connectedAt: '2026-10-10T16:00:07.000Z' }).met, null);
    assert.equal(callTiming({ ...fixture(), capturedAt: '2026-02-30T16:00:00.000Z' }).met, null);
    assert.equal(callTiming({ ...fixture(), callEvidence: { ...evidence(), simulated: false } }).met, null);
    assert.equal(callTiming({ ...fixture(), callEvidence: evidence('demo:demo-cedar:call') }).met, null);
    assert.equal(callTiming({ ...fixture(), humanContactVerified: false }).met, null);
  });

  it('requires sale closure plus independent evidence of payment and supplier', () => {
    const paidSupplierPending = fixture();
    const paymentPendingSupplierAccepted: OfficeCase = { ...fixture(), payment: 'pending', supplier: 'accepted' };
    assert.equal(readyForExecution(paidSupplierPending), false);
    assert.equal(readyForExecution(paymentPendingSupplierAccepted), false);
    const ready = { ...fixture(), supplier: 'accepted' as const };
    assert.equal(readyForExecution(ready), true);
    assert.equal(readyForExecution({ ...ready, saleClosed: false }), false);
    assert.equal(readyForExecution({ ...ready, saleClosed: null }), false);
    assert.equal(readyForExecution({ ...ready, paymentEvidence: null }), false);
    assert.equal(readyForExecution({ ...ready, supplierEvidence: { ...evidence(), simulated: false } }), false);
    assert.equal(readyForExecution({ ...ready, supplierEvidence: evidence('demo:demo-harbor:supplier') }), false);
  });

  it('does not infer queue, completed work or availability from an empty area', () => {
    assert.equal(deriveAreaStatus(fixture(), 'kitchen'), 'blocked');
    assert.equal(deriveAreaStatus(fixture(), 'sales'), 'awaiting_approval');
    for (const status of ['queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'stale'] as WorkStatus[]) {
      const c = fixture(); c.tasks[0].status = status;
      assert.equal(deriveAreaStatus(c, 'sales'), status);
    }
    const c = fixture(); c.tasks.push({ ...c.tasks[0], id: 'failed-task', status: 'failed' });
    assert.equal(deriveAreaStatus(c, 'sales'), 'failed');
    assert.equal(deriveAreaStatus({ ...fixture(), closerAvailable: false }, 'sales'), 'awaiting_approval');
  });

  it('rejects duplicated IDs, foreign case references and mixed demo/live provenance', () => {
    const valid = snapshot(); assert.deepEqual(validateOfficeSnapshot(valid, 'demo'), valid);
    const duplicateCases = snapshot(); duplicateCases.cases.push(fixture());
    assert.throws(() => validateOfficeSnapshot(duplicateCases, 'demo'), hasCode('incompatible'));
    const duplicateTasks = snapshot(); duplicateTasks.cases[0].tasks.push(duplicateTasks.cases[0].tasks[0]);
    assert.throws(() => validateOfficeSnapshot(duplicateTasks, 'demo'), hasCode('incompatible'));
    const mixed = snapshot(); mixed.cases[0].approvals[0].evidence.simulated = false;
    assert.throws(() => validateOfficeSnapshot(mixed, 'demo'), hasCode('incompatible'));
    const foreign = snapshot(); foreign.cases[0].paymentEvidence = evidence('demo:demo-cedar:payment');
    assert.throws(() => validateOfficeSnapshot(foreign, 'demo'), hasCode('incompatible'));
    const misleading = snapshot(); misleading.cases[0].paymentEvidence!.source = 'stripe:live-confirmation';
    assert.throws(() => validateOfficeSnapshot(misleading, 'demo'), hasCode('incompatible'));
    assert.throws(() => validateOfficeSnapshot({ ...snapshot(), mode: 'live' }, 'demo'), hasCode('incompatible'));
    assert.throws(() => validateOfficeSnapshot({ ...snapshot(), outboundEffects: 1 }, 'demo'), hasCode('incompatible'));
    assert.throws(() => validateOfficeSnapshot({ ...snapshot(), mondayWrites: 1 }, 'demo'), hasCode('incompatible'));
    assert.throws(() => validateOfficeSnapshot({ ...snapshot(), extra: 'unexpected' }, 'demo'), hasCode('incompatible'));
  });
});

describe('office transport with isolated fetch mocks', () => {
  it('reads and validates the local demo without manufacturing a fallback', async t => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => { calls.push({ url: input, init }); return json(snapshot()); });
    assert.deepEqual(await loadDemoSnapshot(), snapshot());
    assert.equal(calls[0].url, '/office-api/snapshot');
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(calls[0].init?.body, undefined);
  });

  it('returns only the authoritative command result and preserves replay identity', async t => {
    const c = snapshot(); c.cases[0].approvals[0].status = 'approved_demo';
    const seen: OfficeCommand[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      assert.equal(input, '/office-api/command'); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin');
      seen.push(JSON.parse(init.body as string));
      return json({ snapshot: c, replayed: seen.length > 1 });
    });
    const command: OfficeCommand = { idempotencyKey: 'approval-command-1', caseId: 'demo-aurora', functionId: 'proposals', action: 'approve', approvalId: 'quote-demo', revision: 1, digest: 'a'.repeat(64) };
    assert.equal((await executeDemoCommand(command)).replayed, false);
    const repeated = await executeDemoCommand(command); assert.equal(repeated.replayed, true);
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(repeated.snapshot.cases[0].tasks[0].status, 'awaiting_approval');
    assert.equal(repeated.snapshot.cases[0].payment, 'verified');
    assert.equal(repeated.snapshot.cases[0].supplier, 'pending');
    assert.equal(readyForExecution(repeated.snapshot.cases[0]), false);
    assert.equal(snapshot().cases[0].approvals[0].status, 'pending');
  });

  it('validates commands before issuing requests and refuses foreign response scopes', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests += 1; return json({ snapshot: snapshot(), replayed: false }); });
    const command: OfficeCommand = { idempotencyKey: 'cancel-1', caseId: 'demo-aurora', functionId: 'sales', action: 'cancel' };
    await assert.rejects(executeDemoCommand(command), hasCode('validation')); assert.equal(requests, 0);
    await assert.rejects(executeDemoCommand({ ...command, caseId: 'demo-cedar', action: 'draft' }), hasCode('incompatible'));
  });

  it('exposes fixed safe status errors without reflecting server body or network details', async t => {
    const handle = t.mock.method(globalThis, 'fetch', async () => json({ error: 'private credentials must never be echoed' }, 401));
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [409, 'conflict'], [400, 'validation'], [503, 'offline']] as const) {
      handle.mock.mockImplementation(async () => json({ error: 'private provider detail' }, status));
      await assert.rejects(loadDemoSnapshot(), error => hasCode(code)(error) && !(error as Error).message.includes('private'));
    }
    handle.mock.mockImplementation(async () => { throw new Error('secret URL / password'); });
    await assert.rejects(loadDemoSnapshot(), error => hasCode('offline')(error) && !(error as Error).message.includes('secret'));
    handle.mock.mockImplementation(async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }));
    await assert.rejects(loadDemoSnapshot(), hasCode('incompatible'));
    handle.mock.mockImplementation(async () => new Response(JSON.stringify(snapshot()), { headers: { 'Content-Type': 'application/jsonp' } }));
    await assert.rejects(loadDemoSnapshot(), hasCode('incompatible'));
    handle.mock.mockImplementation(async () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(loadDemoSnapshot(), hasCode('incompatible'));
  });

  it('honors cancellation before fetch and after a late response', async t => {
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    const handle = t.mock.method(globalThis, 'fetch', async () => { calls += 1; return json(snapshot()); });
    await assert.rejects(loadDemoSnapshot(controller.signal), { name: 'AbortError' }); assert.equal(calls, 0);
    const late = new AbortController();
    handle.mock.mockImplementation(async () => { late.abort(); return json(snapshot()); });
    await assert.rejects(loadDemoSnapshot(late.signal), { name: 'AbortError' });
  });

  it('reads real leads GET only, excludes QA and never equates form completion with an event', async t => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      return json(input === '/v1/admin/auth/me' ? staff() : leadPayload([lead(), lead({ lead_id: '00000000-0000-4000-8000-000000000002', is_qa: true })]));
    });
    const loaded = await loadLiveSnapshot();
    assert.equal(loaded.mode, 'live'); assert.equal(loaded.cases.length, 1);
    assert.deepEqual(calls.map(call => call.url), ['/v1/admin/auth/me', '/v1/admin/leads?range=7d&include_qa=false&limit=50']);
    assert(calls.every(call => call.init?.method === 'GET' && call.init.credentials === 'same-origin' && call.init.body === undefined));
    const c = loaded.cases[0];
    assert.equal(c.assignment, 'unknown'); assert.equal(c.closerAvailable, null); assert.equal(c.payment, 'unknown'); assert.equal(c.supplier, 'unknown'); assert.equal(c.saleClosed, null);
    assert.equal(c.tasks[0].status, 'blocked'); assert.equal(c.history[0].title, 'Lead registrado');
    assert.deepEqual(callTiming(c), { attemptSeconds: null, connectedSeconds: null, met: null });
    assert.equal(readyForExecution(c), false);
    assert.equal(c.evidence.simulated, false); assert.equal(c.capturedAt, '2026-10-10T16:00:00.000Z');
    assert.equal(c.messages.length, 0); assert.equal(c.approvals.length, 0);
    assert(!JSON.stringify(c).includes('staff@example.test'));
    assert.equal(loaded.outboundEffects, 0); assert.equal(loaded.mondayWrites, 0);
  });

  it('fails closed for malformed dates, duplicate leads, missing QA flags and PII fields', async t => {
    let rows: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string) => json(input === '/v1/admin/auth/me' ? staff() : leadPayload(rows)));
    for (const invalid of [
      [lead({ created_at: '2026-02-30T16:00:00.000Z' })],
      [lead(), lead()],
      [lead({ is_qa: undefined })],
      [lead({ phone: '+12025550123' })],
      [lead({ status: 'event_completed' })],
      [lead({ updated_at: '2026-10-10T15:00:00.000Z' })],
    ]) { rows = invalid; await assert.rejects(loadLiveSnapshot(), hasCode('incompatible')); }
  });

  it('does not request leads when authentication fails', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests += 1; return json({ error: 'unauthorized' }, 401); });
    await assert.rejects(loadLiveSnapshot(), hasCode('unauthorized')); assert.equal(requests, 1);
  });

  it('does not request leads for an expired session or disguise an empty live feed as demo', async t => {
    let requests = 0;
    const handle = t.mock.method(globalThis, 'fetch', async () => { requests += 1; return json({ ...staff(), expires_at: '2000-01-01T00:00:00.000Z' }); });
    await assert.rejects(loadLiveSnapshot(), hasCode('unauthorized')); assert.equal(requests, 1);
    handle.mock.mockImplementation(async (input: string) => json(input === '/v1/admin/auth/me' ? staff() : leadPayload([])));
    const empty = await loadLiveSnapshot(); assert.equal(empty.mode, 'live'); assert.deepEqual(empty.cases, []); assert.equal(empty.hasMore, false);
  });
});
