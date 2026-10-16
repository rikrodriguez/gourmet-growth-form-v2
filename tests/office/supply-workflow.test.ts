import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { assertOfficeState } from '../../src/office/backend/state';
import type { OfficeSnapshot } from '../../src/office/contracts';
import type { SupplyOperation, SupplyWorkflow } from '../../src/office/supply-contracts';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createOfficeApi } from '../../src/office/backend/http';
import { OfficeReadError, validateOfficeSnapshot } from '../../src/office/adapter';
import { readOperationalWorkflow } from '../../src/office/operational-contracts';
import { getSupplyFixtures } from '../../src/office/backend/supply-fixtures';
import { parseSupplyOperation, projectSupplyWorkflow } from '../../src/office/backend/supply-workflow';
import { DevelopmentSessions, scopeSnapshot, SESSION_TTL_MS } from '../../src/office/backend/session';
import { OfficeError, canonical, projectOfficeSnapshot, sha256 } from '../../src/office/backend/state';
import type { ApprovalLink, DemoCaseId, OfficeState, OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-11T16:00:00.000Z');
const PROCUREMENT_STEPS = new Set(['validate_menu', 'build_purchase_list', 'choose_purchase_option', 'review_purchase']);

// A transactional copy and aggregate queue match the durable command boundary.
// Rejected work never commits part of a supply operation.
class SerializedStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  private tail: Promise<void> = Promise.resolve();
  async snapshot() { await this.tail; return structuredClone(this.state); }
  transact<T>(fn: (state: OfficeState) => T | Promise<T>): Promise<T> {
    const transaction = this.tail.then(async () => {
      const copy = structuredClone(this.state);
      const result = await fn(copy);
      this.state = copy;
      return result;
    });
    this.tail = transaction.then(() => undefined, () => undefined);
    return transaction;
  }
}

function supplyCommand(operation: SupplyOperation, key: string, caseId: DemoCaseId = 'demo-aurora') {
  return { idempotencyKey: key, caseId, functionId: PROCUREMENT_STEPS.has(operation.step) ? 'logistics' : 'suppliers', action: 'draft', supply: operation };
}
function error(code: string) { return (value: unknown) => value instanceof OfficeError && value.code === code; }
function operationalCommand(state: OfficeState, detail: Record<string, unknown>, key: string, caseId: DemoCaseId = 'demo-aurora') {
  const v = projectOfficeSnapshot(state, AT).cases.find(c => c.id === caseId)!.operationalWorkflow!;
  return { idempotencyKey: key, caseId, functionId: ['set_policy', 'record_receipt', 'confirm_milestone'].includes(detail.step as string) ? 'logistics' : 'quality', action: 'draft', operational: { ...detail, eventId: v.eventId, revision: v.revision, contextDigest: v.contextDigest } };
}
async function preparedOperational(store: SerializedStore, prefix: string) {
  const selection = await prepareSelection(store, prefix);
  await executeOfficeCommand(store, decision(selection.link, 'approve', `${prefix}-approve`), () => AT);
  await run(store, { step: 'assign_demo', selectionId: selection.selection.id, revision: 1 }, `${prefix}-assign`);
  const purchase = await preparePurchase(store, prefix);
  await executeOfficeCommand(store, decision(purchase.link, 'approve', `${prefix}-buy-approve`), () => AT);
  const apply = (detail: Record<string, unknown>, suffix: string) => executeOfficeCommand(store, operationalCommand(store.state, detail, `${prefix}-${suffix}`), () => AT);
  await apply({ step: 'set_policy', policyFixtureId: 'ops-policy-synthetic-v1' }, 'policy');
  await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-complete' }, 'receipt');
  for (const milestone of ['preparation', 'assembly', 'service', 'delivery']) await apply({ step: 'confirm_milestone', milestone, fixtureId: `ops-demo-aurora-${milestone}` }, milestone);
  return { apply, selection, purchase };
}

describe('operational journal in the existing Office aggregate', () => {
  for (const boundary of ['contract', 'snapshot adapter'] as const) it(`rejects a status-only forged closure on the real initial projection at the ${boundary} boundary`, () => {
    const snapshot = projectOfficeSnapshot(createOfficeFixtureState(AT), AT);
    validateOfficeSnapshot(snapshot, 'demo');
    const view = snapshot.cases[0].operationalWorkflow!;
    assert.equal(view.closure.status, 'blocked');
    assert.equal(view.revision, 0);
    assert.equal(view.closure.recordId, null);
    assert.equal(view.policy, null);
    assert.equal(view.summary.receipt, 'pending');
    assert(view.summary.milestones.every(m => !m.current && m.recordId === null));
    const altered = structuredClone(snapshot);
    altered.cases[0].operationalWorkflow!.closure.status = 'closed_demo';
    if (boundary === 'contract') assert.throws(() => readOperationalWorkflow(altered.cases[0].operationalWorkflow, snapshot.cases[0].id), /INVALID_OPERATIONAL_WORKFLOW/);
    else assert.throws(() => validateOfficeSnapshot(altered, 'demo'), value => value instanceof OfficeReadError && value.code === 'incompatible');
  });
  it('accepts legitimate scoped closure states and rejects contradictions in a closed projection', async () => {
    const store = new SerializedStore();
    const validateScopes = () => {
      const snapshot = projectOfficeSnapshot(store.state, AT);
      for (const functionIds of [['logistics'], ['quality'], ['logistics', 'quality']] as const) {
        const { session } = new DevelopmentSessions(() => AT).create({ caseIds: ['demo-aurora'], functionIds: [...functionIds] });
        validateOfficeSnapshot(scopeSnapshot(snapshot, session), 'demo');
      }
      return snapshot;
    };
    validateScopes();
    const { apply } = await preparedOperational(store, 'ops-response');
    assert.equal(validateScopes().cases[0].operationalWorkflow!.closure.status, 'review_ready');
    await apply({ step: 'close_demo', reviewDigest: projectOfficeSnapshot(store.state, AT).cases[0].operationalWorkflow!.closure.reviewDigest }, 'close');
    const closed = validateScopes();
    assert.equal(closed.cases[0].operationalWorkflow!.closure.status, 'closed_demo');
    for (const change of ['revision', 'record', 'policy', 'blockers', 'assignment', 'option', 'receipt', 'milestone', 'close_context', 'close_record', 'close_revision', 'incident'] as const) {
      const altered = structuredClone(closed), v = altered.cases[0].operationalWorkflow!;
      if (change === 'revision') v.revision = 0;
      if (change === 'record') v.closure.recordId = null;
      if (change === 'policy') v.policy = null;
      if (change === 'blockers') v.blockers.push('Pendiente sintético');
      if (change === 'assignment') v.summary.activeAssignmentId = null;
      if (change === 'option') v.summary.selectedOptionId = null;
      if (change === 'receipt') v.summary.receipt = 'reference_only';
      if (change === 'milestone') v.summary.milestones[0].current = false;
      if (change === 'close_context') v.quality!.records.at(-1)!.operation.contextDigest = '0'.repeat(64);
      if (change === 'close_record') v.closure.recordId = v.logistics!.records[0].id;
      if (change === 'close_revision') v.revision++;
      if (change === 'incident') v.quality!.incidents.push({ id: 'ops-unresolved', description: 'Pendiente sintético', owner: 'quality_demo', milestone: null, status: 'open', current: false, resolutionId: null });
      assert.throws(() => validateOfficeSnapshot(altered, 'demo'), value => value instanceof OfficeReadError && value.code === 'incompatible', change);
    }
    await apply({ step: 'confirm_milestone', milestone: 'delivery', fixtureId: 'ops-demo-aurora-delivery' }, 'new-evidence');
    assert.equal(validateScopes().cases[0].operationalWorkflow!.closure.status, 'stale');
    await apply({ step: 'set_policy', policyFixtureId: null }, 'remove-policy');
    assert.equal(validateScopes().cases[0].operationalWorkflow!.closure.status, 'stale');
  });
  it('shows an explicit missing-policy closure gate before any operational record exists', () => {
    const store = new SerializedStore();
    const view = projectOfficeSnapshot(store.state, AT).cases[0].operationalWorkflow;
    assert(view, 'the existing case must expose its operational workflow');
    assert.equal(view.revision, 0);
    assert.equal(view.policy, null);
    assert.equal(view.closure.status, 'blocked');
    assert(view.blockers.includes('Falta política operativa; no se infieren mínimos ni firmante.'));
  });
  it('completes reception, milestones, incident and resolution under an explicit rehearsal policy only', async () => {
    const store = new SerializedStore(), before = facts(store.state);
    const assigned = await prepareSelection(store, 'ops-flow');
    await executeOfficeCommand(store, decision(assigned.link, 'approve', 'ops-flow-approved'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: assigned.selection.id, revision: 1 }, 'ops-flow-assigned');
    const purchase = await preparePurchase(store, 'ops-flow');
    await executeOfficeCommand(store, decision(purchase.link, 'approve', 'ops-purchase-approved'), () => AT);
    const view = () => projectOfficeSnapshot(store.state, AT).cases[0].operationalWorkflow!;
    let seq = 0;
    const apply = async (detail: Record<string, unknown>) => {
      const v = view();
      return executeOfficeCommand(store, { idempotencyKey: `ops-step-${++seq}`, caseId: 'demo-aurora', functionId: ['set_policy', 'record_receipt', 'confirm_milestone'].includes(detail.step as string) ? 'logistics' : 'quality', action: 'draft', operational: { ...detail, eventId: v.eventId, revision: v.revision, contextDigest: v.contextDigest } }, () => AT);
    };
    await apply({ step: 'set_policy', policyFixtureId: 'ops-policy-synthetic-v1' });
    await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-reference' });
    assert.equal(view().summary.receipt, 'reference_only');
    assert.equal(view().logistics!.records.at(-1)!.proof!.contentHash, null);
    await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-partial' });
    assert.equal(view().summary.receipt, 'partial_demo');
    await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-complete' });
    for (const milestone of ['preparation', 'assembly', 'service', 'delivery']) await apply({ step: 'confirm_milestone', milestone, fixtureId: `ops-demo-aurora-${milestone}` });
    await apply({ step: 'open_incident', description: 'Falta material sintético de montaje', owner: 'coordination_demo', milestone: 'assembly' });
    const incident = view().quality!.incidents[0];
    assert.equal(incident.milestone, 'assembly');
    await assert.rejects(apply({ step: 'close_demo', reviewDigest: view().closure.reviewDigest }), error('OPERATIONAL_CLOSE_BLOCKED'));
    await apply({ step: 'acknowledge_incident', incidentId: incident.id });
    await apply({ step: 'resolve_incident', incidentId: incident.id, resolution: 'Material de fixture comprobado', fixtureId: 'ops-demo-aurora-resolution' });
    assert.equal(view().closure.status, 'review_ready');
    const reviewDigest = view().closure.reviewDigest;
    await apply({ step: 'close_demo', reviewDigest });
    assert.equal(view().closure.status, 'closed_demo');
    const closed = structuredClone(view());
    await executeOfficeCommand(store, { idempotencyKey: 'ops-quality-draft', caseId: 'demo-aurora', functionId: 'quality', action: 'draft', text: 'DEMO — Un borrador no es una incidencia ni una resolución.' }, () => AT);
    assert.deepEqual(view(), closed);
    await apply({ step: 'set_policy', policyFixtureId: null });
    assert.equal(view().closure.status, 'stale');
    assert.match(view().blockers.join(' '), /Falta política/);
    assert.deepEqual(facts(store.state), before);
    validateOfficeSnapshot(projectOfficeSnapshot(store.state, AT), 'demo');
  });
  it('rejects stale and contradictory identities, unknown policies/fixtures and forged payloads without mutation', async () => {
    const store = new SerializedStore();
    const valid = operationalCommand(store.state, { step: 'set_policy', policyFixtureId: 'ops-policy-synthetic-v1' }, 'ops-input');
    const before = canonical(store.state);
    for (const raw of [
      { ...valid, operational: { ...valid.operational, proof: { content: 'forged' } } },
      { ...valid, operational: { ...valid.operational, revision: -1 } },
      { ...valid, operational: { ...valid.operational, contextDigest: 'bad' } },
      { ...valid, operational: { ...valid.operational, step: 'close_real' } },
      { ...valid, text: 'DEMO' }, { ...valid, supply: { step: 'queue_sourcing' } },
      { ...valid, operational: { ...valid.operational, description: 'unexpected' } },
      { ...valid, functionId: 'quality', operational: { eventId: valid.operational.eventId, revision: 0, contextDigest: valid.operational.contextDigest, step: 'open_incident', description: 'Fixture', owner: 'quality_demo', milestone: 'unknown-real-step' } },
    ]) await assert.rejects(executeOfficeCommand(store, raw, () => AT), error('INVALID_OPERATIONAL_COMMAND'));
    await assert.rejects(executeOfficeCommand(store, { ...valid, operational: { ...valid.operational, eventId: 'supply-event-demo-cedar' } }, () => AT), error('OPERATIONAL_EVENT_MISMATCH'));
    await assert.rejects(executeOfficeCommand(store, { ...valid, caseId: 'demo-cedar' }, () => AT), error('OPERATIONAL_EVENT_MISMATCH'));
    await assert.rejects(executeOfficeCommand(store, { ...valid, functionId: 'quality' }, () => AT), error('INVALID_OPERATIONAL_FUNCTION'));
    await assert.rejects(executeOfficeCommand(store, { ...valid, operational: { ...valid.operational, policyFixtureId: 'commercial-policy' } }, () => AT), error('OPERATIONAL_POLICY_UNKNOWN'));
    assert.equal(canonical(store.state), before);
    await executeOfficeCommand(store, valid, () => AT);
    await assert.rejects(executeOfficeCommand(store, { ...valid, idempotencyKey: 'ops-old-view' }, () => AT), error('OPERATIONAL_REVISION_CONFLICT'));
    const wrongSource = operationalCommand(store.state, { step: 'confirm_milestone', milestone: 'delivery', fixtureId: 'ops-demo-cedar-delivery' }, 'ops-other-fixture');
    await assert.rejects(executeOfficeCommand(store, wrongSource, () => AT), error('OPERATIONAL_FIXTURE_NOT_FOUND'));
    const incident = operationalCommand(store.state, { step: 'resolve_incident', incidentId: 'ops-other-case', fixtureId: 'ops-demo-aurora-resolution', resolution: 'No existe' }, 'ops-other-incident');
    await assert.rejects(executeOfficeCommand(store, incident, () => AT), error('OPERATIONAL_INCIDENT_NOT_FOUND'));
    await executeOfficeCommand(store, operationalCommand(store.state, { step: 'open_incident', description: 'Incidencia sintética\nSegunda línea de evidencia', owner: 'quality_demo' }, 'ops-multiline'), () => AT);
  });
  it('keeps content hashes and history immutable and invalidates the exact closure on changed dependencies', async () => {
    const base = new SerializedStore(); await preparedOperational(base, 'ops-invalidate');
    let v = projectOfficeSnapshot(base.state, AT).cases[0].operationalWorkflow!;
    const close = operationalCommand(base.state, { step: 'close_demo', reviewDigest: v.closure.reviewDigest }, 'ops-close-exact');
    const receipt = v.logistics!.records.find(r => r.operation.step === 'record_receipt')!;
    assert.equal(receipt.proof!.contentHash, createHash('sha256').update(receipt.proof!.content!, 'utf8').digest('hex'));
    await executeOfficeCommand(base, close, () => AT);
    const frozen = structuredClone(base.state);
    for (const change of ['brief', 'event', 'menu', 'assignment', 'selection_approval', 'purchase_approval', 'new_evidence', 'new_incident']) {
      const store = new SerializedStore(); store.state = structuredClone(frozen);
      const late = operationalCommand(store.state, { step: 'confirm_milestone', milestone: 'delivery', fixtureId: 'ops-demo-aurora-delivery' }, `ops-late-${change}`);
      if (change === 'brief') store.state.office.cases['demo-aurora'].subtitle += ' · brief de fixture revisado';
      if (change === 'event') store.state.office.supply!.cases['demo-aurora'].event.window.endAt = new Date(AT + 10 * 86400000).toISOString();
      if (change === 'menu') await run(store, { step: 'validate_menu', fixtureId: 'supply-menu-demo-aurora-missing-quantity' }, 'ops-menu-change');
      if (change === 'assignment') {
        const a = Object.values(store.state.office.supply!.assignments)[0];
        await run(store, { step: 'withdraw_assignment', assignmentId: a.id, revision: 1, reason: 'Retirada sintética' }, 'ops-withdraw-change');
      }
      if (change.endsWith('_approval')) {
        const link = Object.values(store.state.office.approvals).find(l => l.supplyContext?.kind === (change === 'selection_approval' ? 'selection' : 'purchase'))!;
        store.state.approvals[link.coreApprovalId!].valid = false;
      }
      if (change === 'new_evidence') await executeOfficeCommand(store, late, () => AT);
      if (change === 'new_incident') await executeOfficeCommand(store, operationalCommand(store.state, { step: 'open_incident', description: 'Incidencia posterior al cierre', owner: 'quality_demo' }, 'ops-post-close'), () => AT);
      v = projectOfficeSnapshot(store.state, AT).cases[0].operationalWorkflow!;
      assert.equal(v.closure.status, 'stale', change);
      assert.deepEqual(store.state.office.operational!.cases['demo-aurora'].records.slice(0, frozen.office.operational!.cases['demo-aurora'].records.length), frozen.office.operational!.cases['demo-aurora'].records);
      if (!['new_evidence', 'new_incident'].includes(change)) assert(v.summary.milestones.every(m => !m.current), change);
      const replay = await executeOfficeCommand(store, close, () => AT);
      assert.equal(replay.replayed, true); assert.equal(replay.snapshot.cases[0].operationalWorkflow!.closure.status, 'stale');
      await assert.rejects(executeOfficeCommand(store, { ...close, idempotencyKey: `ops-reclose-${change}` }, () => AT), error('OPERATIONAL_REVISION_CONFLICT'));
      if (!['new_evidence', 'new_incident'].includes(change)) await assert.rejects(executeOfficeCommand(store, late, () => AT), error('OPERATIONAL_REVISION_CONFLICT'));
    }
    const corrupted = structuredClone(frozen); corrupted.office.operational!.cases['demo-aurora'].records[1].proof!.content += 'tampered';
    assert.throws(() => assertOfficeState(corrupted), error('OPERATIONAL_STATE_INVALID'));
    const malformed = structuredClone(v); malformed.eventId = 'another-event';
    assert.throws(() => validateOfficeSnapshot({ ...projectOfficeSnapshot(base.state, AT), cases: [{ ...projectOfficeSnapshot(base.state, AT).cases[0], operationalWorkflow: malformed }] }, 'demo'));
  });
  it('enforces existing server scopes, revocation and expiry before operational writes/replay', async t => {
    let now = AT; const { api, store, login, post, baseHeaders } = await apiFixture(t, () => now);
    const c = operationalCommand(store.state, { step: 'set_policy', policyFixtureId: 'ops-policy-synthetic-v1' }, 'ops-http');
    for (const scope of [{ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['logistics'] }, { role: 'operator', caseIds: ['demo-cedar'], functionIds: ['logistics'] }, { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['quality'] }]) {
      const headers = await login(scope); assert.equal((await post(headers, c)).statusCode, 403);
    }
    const q = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['quality'] });
    let response = await api.inject({ method: 'GET', url: '/office-api/snapshot', headers: q });
    const scoped = response.json().cases[0].operationalWorkflow;
    assert.equal(scoped.logistics, undefined); assert(scoped.quality); assert.equal(response.json().cases.length, 1);
    const closed = operationalCommand(store.state, { step: 'close_demo', reviewDigest: scoped.closure.reviewDigest }, 'ops-scoped-close');
    assert.equal((await post(q, closed)).statusCode, 403);
    const headers = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['logistics', 'quality'] });
    assert.equal((await post(headers, c)).statusCode, 200);
    response = await api.inject({ method: 'DELETE', url: '/office-api/session', headers }); assert.equal(response.statusCode, 204);
    assert.equal((await post(headers, c)).statusCode, 401);
    const expiring = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['logistics', 'quality'] });
    now += 4 * 3600000 + 1; assert.equal((await post(expiring, c)).statusCode, 401);
    assert.equal(Object.keys(store.state.office.commands).length, 1);
    const viewer = await api.inject({ method: 'POST', url: '/office-api/session', headers: baseHeaders, payload: { role: 'viewer', caseIds: ['demo-cedar'], functionIds: ['sales'] } });
    const snap = await api.inject({ method: 'GET', url: '/office-api/snapshot', headers: { ...baseHeaders, cookie: String(viewer.headers['set-cookie']).split(';')[0] } });
    assert.equal(snap.json().cases[0].operationalWorkflow, undefined);
  });
  it('cannot rehabilitate an old reservation by recording new evidence after the event window changes', async () => {
    const store = new SerializedStore(); await preparedOperational(store, 'ops-event-shift');
    const row = store.state.office.supply!.cases['demo-aurora'];
    row.event.window = { startAt: new Date(Date.parse(row.event.window.startAt) + 3600000).toISOString(), endAt: new Date(Date.parse(row.event.window.endAt) + 3600000).toISOString() };
    const apply = (detail: Record<string, unknown>, key: string) => executeOfficeCommand(store, operationalCommand(store.state, detail, key), () => AT);
    await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-complete' }, 'ops-shift-new-receipt');
    for (const milestone of ['preparation', 'assembly', 'service', 'delivery']) await apply({ step: 'confirm_milestone', milestone, fixtureId: `ops-demo-aurora-${milestone}` }, `ops-shift-${milestone}`);
    const v = projectOfficeSnapshot(store.state, AT).cases[0].operationalWorkflow!;
    assert(v.blockers.some(b => /reserva interna/.test(b)), 'new proof cannot repair the stale selection/availability/window');
    await assert.rejects(apply({ step: 'close_demo', reviewDigest: v.closure.reviewDigest }, 'ops-shift-close'), error('OPERATIONAL_CLOSE_BLOCKED'));
  });
});
async function run(store: OfficeStore, operation: SupplyOperation, key: string, caseId: DemoCaseId = 'demo-aurora', atMs = AT) {
  return executeOfficeCommand(store, supplyCommand(operation, key, caseId), () => atMs);
}
function decision(link: ApprovalLink, action: 'approve' | 'reject' | 'cancel', key: string) {
  return { idempotencyKey: key, caseId: link.caseId, functionId: link.functionId, action, approvalId: link.id, revision: link.revision, digest: link.digest };
}
function assertNoEffects(snapshot: OfficeSnapshot) {
  assert.equal(snapshot.mode, 'demo'); assert.equal(snapshot.outboundEffects, 0); assert.equal(snapshot.mondayWrites, 0);
}
function assertMoneyText(text: string, amounts: readonly string[]) {
  for (const amount of amounts) assert.match(text, new RegExp(`(?<![\\d.])${amount.replace('.', '\\.')} USD\\b`, 'u'));
  assert.doesNotMatch(text, /\b(?:2500|3500|14000|2000|4000|500|400|4900)(?:\.00)?\s*USD\b|\bUSD\s*(?:2500|3500|14000|2000|4000|500|400|4900)(?:\.00)?\b/u);
}
function facts(state: OfficeState) {
  return structuredClone({ leads: state.leads, assignments: state.assignments, payments: state.payments, invoices: state.invoices,
    reconciliations: state.reconciliations,
    cases: Object.fromEntries(Object.entries(state.office.cases).map(([id, row]) => [id, { supplier: row.supplier, supplierEvidence: row.supplierEvidence, payment: row.payment, paymentEvidence: row.paymentEvidence, saleClosed: row.saleClosed }])) });
}
function workflow(store: SerializedStore, caseId: DemoCaseId = 'demo-aurora'): SupplyWorkflow {
  return projectSupplyWorkflow(store.state, caseId, AT);
}
async function ingest(store: OfficeStore, prefix = 'supply', caseId: DemoCaseId = 'demo-aurora') {
  const fixture = getSupplyFixtures(caseId, AT).digestFixtures[0];
  await run(store, { step: 'ingest_digest', fixtureId: fixture.id }, `${prefix}-ingest`, caseId);
  return fixture;
}
async function readyCandidate(store: OfficeStore, prefix = 'supply', caseId: DemoCaseId = 'demo-aurora', candidateIndex = 0) {
  const fixtures = getSupplyFixtures(caseId, AT);
  await ingest(store, prefix, caseId);
  const id = fixtures.digestFixtures[0].entries[candidateIndex].candidateId;
  let current = projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === id)!;
  await run(store, { step: 'evaluate_candidate', candidateId: id, revision: current.revision, verdict: 'eligible' }, `${prefix}-evaluate`, caseId);
  current = projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === id)!;
  await run(store, { step: 'verify_availability', candidateId: id, revision: current.revision, status: 'available' }, `${prefix}-available`, caseId);
  current = projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === id)!;
  const terms = fixtures.termsFixtures.find(row => row.candidateId === id && row.totalCents !== null)!;
  await run(store, { step: 'approve_terms', candidateId: id, revision: current.revision, termsFixtureId: terms.id }, `${prefix}-terms`, caseId);
  return projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === id)!;
}
async function prepareSelection(store: OfficeStore, prefix = 'supply', caseId: DemoCaseId = 'demo-aurora', candidateIndex = 0) {
  const current = await readyCandidate(store, prefix, caseId, candidateIndex);
  await run(store, { step: 'select_candidate', candidateId: current.id, revision: current.revision }, `${prefix}-select`, caseId);
  const state = await store.snapshot();
  const selection = projectSupplyWorkflow(state, caseId, AT).sourcing!.selections.find(row => row.candidateId === current.id && row.snapshot.candidate.revision === current.revision)!;
  assert(selection); assert(selection.approvalId);
  return { selection, link: state.office.approvals[selection.approvalId] };
}
async function preparePurchase(store: OfficeStore, prefix = 'supply', caseId: DemoCaseId = 'demo-aurora') {
  const fixtures = getSupplyFixtures(caseId, AT);
  await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, `${prefix}-menu`, caseId);
  await run(store, { step: 'build_purchase_list' }, `${prefix}-list`, caseId);
  const list = projectSupplyWorkflow(await store.snapshot(), caseId, AT).procurement!.list!;
  await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: list.revision }, `${prefix}-option`, caseId);
  const option = projectSupplyWorkflow(await store.snapshot(), caseId, AT).procurement!.options[0];
  assert(option);
  await run(store, { step: 'review_purchase', optionId: option.id, revision: option.revision }, `${prefix}-review`, caseId);
  const state = await store.snapshot();
  const reviewed = projectSupplyWorkflow(state, caseId, AT).procurement!.options.find(row => row.id === option.id)!;
  assert(reviewed.approvalId);
  return { option: reviewed, link: state.office.approvals[reviewed.approvalId] };
}
async function apiFixture(t: TestContext, clock: () => number = () => AT) {
  const store = new SerializedStore();
  const api = createOfficeApi(store, { clock });
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('UNEXPECTED_SUPPLY_NETWORK_CALL'); });
  t.after(() => api.close());
  t.after(() => assert.equal(network.mock.callCount(), 0, 'synthetic sourcing and procurement never call a source or checkout'));
  await api.ready();
  const baseHeaders = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
  async function login(scope: object = { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['suppliers', 'logistics'] }) {
    const result = await api.inject({ method: 'POST', url: '/office-api/session', headers: baseHeaders, payload: scope });
    assert.equal(result.statusCode, 200);
    return { ...baseHeaders, cookie: String(result.headers['set-cookie']).split(';')[0] };
  }
  const post = (headers: Record<string, string>, command: object) => api.inject({ method: 'POST', url: '/office-api/commands', headers, payload: command });
  return { store, api, baseHeaders, login, post };
}

describe('persistent synthetic supplier workflow', () => {
  it('projects sold events with an unaccepted supplier into a human sourcing queue without mutating a read', async () => {
    const store = new SerializedStore();
    const before = canonical(store.state);
    const sourcing = workflow(store).sourcing!;
    assert.equal(sourcing.queue?.status, 'queued');
    assert.equal(sourcing.queue?.reason, 'sold_without_accepted_supplier');
    assert.equal(sourcing.queue?.externalResolved, false);
    assert.equal(workflow(store, 'demo-cedar').sourcing!.queue, null);
    assert.equal(workflow(store, 'demo-harbor').sourcing!.queue, null);
    assert.equal(canonical(store.state), before);
    await run(store, { step: 'queue_sourcing' }, 'supply-queue');
    const after = workflow(store).sourcing!.queue!;
    assert.equal(after.id, sourcing.queue!.id);
    assert.equal(after.externalResolved, false);
    assert.equal(store.state.office.cases['demo-aurora'].supplier, 'pending');
    const blocked = canonical(store.state);
    await assert.rejects(run(store, { step: 'queue_sourcing' }, 'supply-sale-open', 'demo-harbor'), error('SALE_NOT_CLOSED'));
    assert.equal(canonical(store.state), blocked);
  });

  it('retains the announced/extracted/unique discrepancy, all source provenance and unknown facts', async () => {
    const store = new SerializedStore();
    const fixture = await ingest(store);
    const sourcing = workflow(store).sourcing!;
    assert.equal(sourcing.digests.length, 1);
    const digest = sourcing.digests[0];
    assert.equal(digest.announcedCount, 3); assert.equal(digest.extractedCount, 5);
    assert.equal(digest.uniqueCount, 4); assert.equal(digest.duplicateCount, 1); assert.equal(digest.countMismatch, true);
    assert.equal(digest.entries.length, 5);
    assert.equal(sourcing.candidates.length, 4);
    const sources = new Set(sourcing.candidates.flatMap(row => row.announcements.map(announcement => announcement.source)));
    assert.deepEqual(sources, new Set(['facebook_marketplace', 'facebook_groups', 'outreach_forms', 'meetachef']));
    const first = sourcing.candidates.find(row => row.id === fixture.entries[0].candidateId)!;
    assert.equal(first.announcements.length, 2); assert.equal(first.announcedRateCents, 2500); assert.equal(first.announcedRateUnit, 'hour');
    assert.equal(first.readAt, fixture.entries[0].readAt); assert.equal(first.evaluation.checkedAt, null);
    assert.equal(first.availability.status, 'unknown'); assert.equal(first.availability.checkedAt, null); assert.equal(first.terms, null); assert.equal(first.externalHired, false);
    for (const row of sourcing.candidates) {
      assert.match(row.contact, /@invalid\.test$/); assert.match(new URL(row.sourceLink).hostname, /\.invalid\.test$/);
      assert.equal(row.evidence.simulated, true);
    }
    const missingCity = sourcing.candidates.find(row => row.city === null)!;
    assert.equal(missingCity.coverage, null);
    const missingRate = sourcing.candidates.find(row => row.announcedRateCents === null)!;
    assert.equal(missingRate.announcedRateUnit, null); assert.equal(missingRate.currency, null);
    assertNoEffects(projectOfficeSnapshot(store.state, AT));
  });

  it('deduplicates a fixture through different transport keys while rejecting changed-key reuse atomically', async () => {
    const store = new SerializedStore();
    const fixture = await ingest(store, 'supply-dedupe');
    const before = structuredClone(workflow(store).sourcing);
    await Promise.all(Array.from({ length: 4 }, (_, index) => run(store, { step: 'ingest_digest', fixtureId: fixture.id }, `supply-dedupe-again-${index}`)));
    assert.deepEqual(workflow(store).sourcing, before);
    const committed = canonical(store.state);
    await assert.rejects(run(store, { step: 'queue_sourcing' }, 'supply-dedupe-ingest'), error('IDEMPOTENCY_CONFLICT'));
    assert.equal(canonical(store.state), committed);
  });

  it('records evaluation, checked availability and negotiated terms separately from an advertised rate', async () => {
    const store = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await ingest(store, 'supply-separation');
    const initial = workflow(store).sourcing!.candidates.find(row => row.id === fixtures.digestFixtures[0].entries[0].candidateId)!;
    await run(store, { step: 'evaluate_candidate', candidateId: initial.id, revision: initial.revision, verdict: 'eligible' }, 'supply-separation-evaluate');
    let current = workflow(store).sourcing!.candidates.find(row => row.id === initial.id)!;
    assert.equal(current.evaluation.verdict, 'eligible'); assert.equal(current.availability.status, 'unknown'); assert.equal(current.terms, null);
    assert.equal(current.evaluation.checkedAt, new Date(AT).toISOString()); assert.notEqual(current.readAt, current.evaluation.checkedAt);
    await run(store, { step: 'verify_availability', candidateId: current.id, revision: current.revision, status: 'available' }, 'supply-separation-availability');
    current = workflow(store).sourcing!.candidates.find(row => row.id === initial.id)!;
    assert.equal(current.availability.status, 'available'); assert.deepEqual(current.availability.window, workflow(store).event.window); assert.equal(current.terms, null);
    const approved = fixtures.termsFixtures.find(row => row.candidateId === current.id && row.totalCents !== null)!;
    const termsResult = await run(store, { step: 'approve_terms', candidateId: current.id, revision: current.revision, termsFixtureId: approved.id }, 'supply-separation-terms');
    current = workflow(store).sourcing!.candidates.find(row => row.id === initial.id)!;
    assert.equal(current.announcedRateCents, 2500); assert.equal(current.terms!.rateCents, 3500); assert.equal(current.terms!.totalCents, 14000);
    assert.equal(current.externalHired, false); assert.equal(store.state.office.cases['demo-aurora'].supplier, 'pending');
    assert.equal(current.revision, initial.revision + 3);
    const title = 'Condiciones humanas registradas · DEMO';
    const item = termsResult.snapshot.cases[0];
    for (const text of [item.tasks.find(row => row.title === title)!.detail, item.results.find(row => row.title === title)!.detail, item.history.find(row => row.title === title)!.detail]) {
      assertMoneyText(text, ['25.00', '35.00', '140.00']); assert.match(text, /35\.00 USD\/hour/u);
    }
  });

  it('does not select an unreviewed or unavailable candidate and never interprets missing data as zero', async () => {
    const store = new SerializedStore();
    await ingest(store, 'supply-not-ready');
    for (const row of workflow(store).sourcing!.candidates) {
      const before = canonical(store.state);
      await assert.rejects(run(store, { step: 'select_candidate', candidateId: row.id, revision: row.revision }, `supply-not-ready-${row.id}`), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
      assert.equal(canonical(store.state), before);
    }
    const current = await readyCandidate(store, 'supply-unavailable');
    await run(store, { step: 'verify_availability', candidateId: current.id, revision: current.revision, status: 'unavailable' }, 'supply-unavailable-mark');
    const unavailable = workflow(store).sourcing!.candidates.find(row => row.id === current.id)!;
    const before = canonical(store.state);
    await assert.rejects(run(store, { step: 'select_candidate', candidateId: current.id, revision: unavailable.revision }, 'supply-unavailable-select'), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
    assert.equal(canonical(store.state), before);
  });

  it('creates an exact pending selection and requires explicit assignment after a DEMO approval', async () => {
    const store = new SerializedStore();
    const unchanged = facts(store.state);
    const { selection, link } = await prepareSelection(store, 'supply-approve');
    assert.equal(selection.reviewStatus, 'pending'); assert.equal(selection.assignedDemo, false); assert.equal(link.status, 'pending');
    assert.equal(workflow(store).sourcing!.assignments.length, 0);
    assert.equal(link.supplyContext?.kind, 'selection'); assert.equal(link.supplyContext?.digest, selection.digest);
    const preview = projectOfficeSnapshot(store.state, AT).cases[0].approvals.find(row => row.id === link.id)!;
    assertMoneyText(preview.body, ['25.00', '35.00', '140.00']);
    assert.match(preview.body, /35\.00 USD\/hour/u);
    const before = canonical(store.state);
    await assert.rejects(run(store, { step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, 'supply-before-approval'), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
    assert.equal(canonical(store.state), before);
    const approvalResult = await executeOfficeCommand(store, decision(link, 'approve', 'supply-approve-exact'), () => AT + 1);
    const approvedBody = approvalResult.snapshot.cases[0].approvals.find(row => row.id === link.id)!;
    assert.equal(approvedBody.body, preview.body); assert.equal(approvedBody.digest, preview.digest);
    assertMoneyText(approvedBody.body, ['25.00', '35.00', '140.00']);
    let sourcing = workflow(store).sourcing!;
    assert.equal(sourcing.selections[0].reviewStatus, 'approved_demo'); assert.equal(sourcing.assignments.length, 0);
    assert.deepEqual(facts(store.state), unchanged);
    await run(store, { step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, 'supply-explicit-assignment', 'demo-aurora', AT + 2);
    sourcing = workflow(store).sourcing!;
    assert.equal(sourcing.assignments.length, 1); assert.equal(sourcing.assignments[0].status, 'assigned_demo'); assert.equal(sourcing.assignments[0].externalHired, false);
    assert.equal(sourcing.selections[0].assignedDemo, true);
    assert.deepEqual(facts(store.state), unchanged);
    const snapshot = projectOfficeSnapshot(store.state, AT + 2);
    assert(snapshot.cases[0].tasks.some(row => row.id === 'workflow-demo-aurora-paid-without-supplier' && row.status === 'blocked'));
    assertNoEffects(snapshot);
  });

  it('invalidates a pending selection when facts change before an exact approval', async () => {
    const store = new SerializedStore();
    const { selection, link } = await prepareSelection(store, 'supply-stale');
    const current = workflow(store).sourcing!.candidates.find(row => row.id === selection.candidateId)!;
    await run(store, { step: 'verify_availability', candidateId: current.id, revision: current.revision, status: 'unavailable' }, 'supply-stale-availability');
    const before = canonical(store.state);
    await assert.rejects(executeOfficeCommand(store, decision(link, 'approve', 'supply-stale-approve'), () => AT + 1), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
    assert.equal(canonical(store.state), before);
    assert.equal(workflow(store).sourcing!.assignments.length, 0);
    assert.equal(store.state.office.cases['demo-aurora'].supplier, 'pending');
  });

  it('keeps rejected and cancelled supplier reviews unassigned', async () => {
    for (const status of ['reject', 'cancel'] as const) {
      const store = new SerializedStore();
      const { selection, link } = await prepareSelection(store, `supply-${status}`);
      await executeOfficeCommand(store, decision(link, status, `supply-${status}-decision`), () => AT);
      assert.equal(workflow(store).sourcing!.selections[0].reviewStatus, status === 'reject' ? 'rejected_demo' : 'cancelled_demo');
      const before = canonical(store.state);
      await assert.rejects(run(store, { step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, `supply-${status}-assign`), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
      assert.equal(canonical(store.state), before);
      assert.equal(workflow(store).sourcing!.assignments.length, 0);
    }
  });

  it('cannot add a second candidate to an event after its explicit DEMO assignment', async () => {
    const store = new SerializedStore();
    const { selection, link } = await prepareSelection(store, 'supply-single-assignment');
    await executeOfficeCommand(store, decision(link, 'approve', 'supply-single-assignment-approve'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, 'supply-single-assignment-assign');
    const alternate = await prepareSelection(store, 'supply-single-alternate', 'demo-aurora', 1);
    assert.notEqual(alternate.selection.candidateId, selection.candidateId);
    await executeOfficeCommand(store, decision(alternate.link, 'approve', 'supply-single-alternate-approved'), () => AT);
    const before = canonical(store.state);
    await assert.rejects(run(store, { step: 'assign_demo', selectionId: alternate.selection.id, revision: alternate.selection.revision }, 'supply-single-alternate-assign'), error('SUPPLY_CASE_ALREADY_ASSIGNED'));
    assert.equal(canonical(store.state), before);
    assert.equal(workflow(store).sourcing!.assignments.length, 1);
  });
});

describe('explicit internal assignment withdrawal', () => {
  it('accepts legacy active snapshots and rejects contradictory withdrawal metadata or multiple active reservations', async () => {
    const store = new SerializedStore(), first = await prepareSelection(store, 'withdraw-adapter');
    await executeOfficeCommand(store, decision(first.link, 'approve', 'withdraw-adapter-approved'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'withdraw-adapter-assigned');
    const legacy = projectOfficeSnapshot(store.state, AT); delete legacy.cases[0].supplyWorkflow!.sourcing!.assignments[0].revision;
    assert.equal(validateOfficeSnapshot(legacy, 'demo').cases[0].supplyWorkflow!.sourcing!.assignments[0].revision, 1);
    const duplicate = structuredClone(legacy), active = duplicate.cases[0].supplyWorkflow!.sourcing!.assignments;
    active.push({ ...active[0], id: 'other-assignment' }); assert.throws(() => validateOfficeSnapshot(duplicate, 'demo'));
    const id = workflow(store).sourcing!.assignments[0].id;
    await run(store, { step: 'withdraw_assignment', assignmentId: id, revision: 1, reason: 'Retirada sintética validada' }, 'withdraw-adapter-retired');
    const valid = projectOfficeSnapshot(store.state, AT);
    for (const patch of [{ revision: 1 }, { withdrawal: null }, { status: 'assigned_demo' }]) {
      const altered = structuredClone(valid); Object.assign(altered.cases[0].supplyWorkflow!.sourcing!.assignments[0], patch);
      assert.throws(() => validateOfficeSnapshot(altered, 'demo'));
    }
  });
  it('keeps an unavailable reservation until explicit withdrawal, then replaces it without reviving old replays', async () => {
    const store = new SerializedStore();
    const first = await prepareSelection(store, 'withdraw-first');
    await executeOfficeCommand(store, decision(first.link, 'approve', 'withdraw-first-approve'), () => AT);
    const assign = supplyCommand({ step: 'assign_demo', selectionId: first.selection.id, revision: first.selection.revision }, 'withdraw-first-assign');
    await executeOfficeCommand(store, assign, () => AT);
    const original = workflow(store).sourcing!.assignments[0];
    const candidate = workflow(store).sourcing!.candidates.find(row => row.id === first.selection.candidateId)!;
    await run(store, { step: 'verify_availability', candidateId: candidate.id, revision: candidate.revision, status: 'unavailable' }, 'withdraw-unavailable');
    assert.equal(workflow(store).sourcing!.assignments[0].status, 'assigned_demo');
    assert.equal(workflow(store).sourcing!.selections[0].reviewStatus, 'stale');
    const second = await prepareSelection(store, 'withdraw-second', 'demo-aurora', 1);
    await executeOfficeCommand(store, decision(second.link, 'approve', 'withdraw-second-approve'), () => AT);
    await assert.rejects(run(store, { step: 'assign_demo', selectionId: second.selection.id, revision: second.selection.revision }, 'withdraw-before-explicit'), error('SUPPLY_CASE_ALREADY_ASSIGNED'));
    const withdraw = supplyCommand({ step: 'withdraw_assignment', assignmentId: original.id, revision: 1, reason: 'Chef sintético no disponible' }, 'withdraw-explicit');
    await executeOfficeCommand(store, withdraw, () => AT + 1);
    let sourcing = workflow(store).sourcing!;
    const retired = sourcing.assignments[0]; assert.equal(retired.status, 'withdrawn_demo'); assert.equal(retired.revision, 2);
    assert.equal(retired.withdrawal!.reason, 'Chef sintético no disponible'); assert.deepEqual(retired.evidence, original.evidence);
    assert.equal(retired.approvalId, original.approvalId); assert.deepEqual(retired.window, original.window);
    assert.equal(sourcing.selections[0].digest, first.selection.digest); assert.equal(sourcing.selections[0].assignedDemo, false);
    await run(store, { step: 'assign_demo', selectionId: second.selection.id, revision: second.selection.revision }, 'withdraw-replacement', 'demo-aurora', AT + 2);
    const before = canonical(store.state);
    for (const old of [assign, withdraw, decision(first.link, 'approve', 'withdraw-first-approve')]) assert.equal((await executeOfficeCommand(store, old, () => AT + 3)).replayed, true);
    assert.equal(canonical(store.state), before);
    await assert.rejects(executeOfficeCommand(store, { ...withdraw, supply: { ...withdraw.supply, reason: 'Otro motivo' } }, () => AT + 3), error('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'withdraw-fresh-key-old-selection'), error('SUPPLY_REVIEW_STALE'));
    sourcing = workflow(store).sourcing!; assert.equal(sourcing.assignments.length, 2); assert.equal(sourcing.assignments.filter(row => row.status === 'assigned_demo').length, 1);
    assert.equal(store.state.office.cases['demo-aurora'].supplier, 'pending'); assertNoEffects(projectOfficeSnapshot(store.state, AT + 3));
    validateOfficeSnapshot(projectOfficeSnapshot(store.state, AT + 3), 'demo');
  });
  it('requires a new selection and human approval even when retiring a currently valid assignment', async () => {
    const store = new SerializedStore(), first = await prepareSelection(store, 'withdraw-valid');
    await executeOfficeCommand(store, decision(first.link, 'approve', 'withdraw-valid-approved'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'withdraw-valid-assigned');
    await run(store, { step: 'withdraw_assignment', assignmentId: workflow(store).sourcing!.assignments[0].id, revision: 1, reason: 'Replanificación sintética' }, 'withdraw-valid-retired');
    const candidate = workflow(store).sourcing!.candidates.find(row => row.id === first.selection.candidateId)!;
    await run(store, { step: 'select_candidate', candidateId: candidate.id, revision: candidate.revision }, 'withdraw-valid-new-selection');
    const next = workflow(store).sourcing!.selections.find(row => row.id !== first.selection.id)!;
    assert.equal(next.revision, 2); assert.equal(next.reviewStatus, 'pending'); assert.deepEqual(next.snapshot, first.selection.snapshot);
    await assert.rejects(run(store, { step: 'assign_demo', selectionId: next.id, revision: next.revision }, 'withdraw-valid-unapproved'), error('SUPPLY_REVIEW_NOT_APPROVED'));
    await executeOfficeCommand(store, decision(store.state.office.approvals[next.approvalId!], 'approve', 'withdraw-valid-reapproved'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: next.id, revision: next.revision }, 'withdraw-valid-reassigned');
    assert.equal(workflow(store).sourcing!.assignments.filter(row => row.status === 'assigned_demo').length, 1);
    assert.equal(store.state.office.supply!.cases['demo-aurora'].selections[first.selection.id].digest, first.selection.digest);
  });
  it('rejects missing reasons, stale revisions, other cases and existing permission failures without mutation', async t => {
    for (const reason of ['', '   ', 'x'.repeat(501), 'bad\nreason']) assert.throws(() => parseSupplyOperation({ step: 'withdraw_assignment', assignmentId: 'assignment', revision: 1, reason }));
    const store = new SerializedStore(), first = await prepareSelection(store, 'withdraw-guards');
    await executeOfficeCommand(store, decision(first.link, 'approve', 'withdraw-guards-approved'), () => AT);
    await run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'withdraw-guards-assigned');
    const id = workflow(store).sourcing!.assignments[0].id, before = canonical(store.state);
    await assert.rejects(run(store, { step: 'withdraw_assignment', assignmentId: id, revision: 2, reason: 'Motivo DEMO' }, 'withdraw-stale'), error('SUPPLY_REVISION_CONFLICT'));
    await assert.rejects(run(store, { step: 'withdraw_assignment', assignmentId: id, revision: 1, reason: 'Motivo DEMO' }, 'withdraw-other-case', 'demo-cedar'), error('SUPPLY_ASSIGNMENT_NOT_FOUND'));
    assert.equal(canonical(store.state), before);
    const api = await apiFixture(t);
    for (const scope of [{ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['suppliers'] }, { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['logistics'] }]) {
      const headers = await api.login(scope);
      assert.equal((await api.post(headers, supplyCommand({ step: 'withdraw_assignment', assignmentId: id, revision: 1, reason: 'Motivo DEMO' }, 'withdraw-forbidden'))).statusCode, 403);
    }
  });
});

describe('persistent synthetic procurement workflow', () => {
  it('blocks lists from unvalidated recipes or quantities and retains missing evidence explicitly', async () => {
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    for (const fixture of fixtures.menuFixtures.slice(1)) {
      const store = new SerializedStore();
      await run(store, { step: 'validate_menu', fixtureId: fixture.id }, `supply-${fixture.id}-validate`);
      const menu = workflow(store).procurement!.menu!;
      assert.equal(menu.validation, 'blocked'); assert.equal(menu.validatedAt, null); assert.equal(menu.validatedBy, null); assert(menu.missingFacts.length > 0);
      const before = structuredClone(workflow(store).procurement);
      const approvals = structuredClone(store.state.office.approvals);
      const blocked = await run(store, { step: 'build_purchase_list' }, `supply-${fixture.id}-build`);
      assert.deepEqual(workflow(store).procurement, before); assert.equal(workflow(store).procurement!.list, null);
      assert.deepEqual(store.state.office.approvals, approvals);
      assert(blocked.snapshot.cases[0].tasks.some(row => row.functionId === 'logistics' && row.status === 'blocked' && /Lista bloqueada/.test(row.title)));
      if (fixture.items[0].servings === null) assert.equal(menu.items[0].servings, null);
    }
  });

  it('derives a versioned list only after human validation and preserves quantities and units', async () => {
    const store = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, 'supply-menu-validate');
    const menu = workflow(store).procurement!.menu!;
    assert.equal(menu.validation, 'validated_demo'); assert.equal(menu.validatedAt, new Date(AT).toISOString()); assert(menu.validatedBy);
    await run(store, { step: 'build_purchase_list' }, 'supply-menu-list');
    const list = workflow(store).procurement!.list!;
    assert.equal(list.menuRevision, menu.revision); assert.equal(list.menuDigest, menu.digest);
    assert.equal(list.items.length, 2); assert(list.items.every(row => row.quantity === 1000 && row.unit === 'g'));
    const original = structuredClone(list);
    await run(store, { step: 'build_purchase_list' }, 'supply-menu-list-again');
    assert.deepEqual(workflow(store).procurement!.list, original);
    assertNoEffects(projectOfficeSnapshot(store.state, AT));
  });

  it('does not allow an incomplete option to be reviewed or reduce unknown totals to zero', async () => {
    const store = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, 'supply-incomplete-menu');
    await run(store, { step: 'build_purchase_list' }, 'supply-incomplete-list');
    const list = workflow(store).procurement!.list!;
    await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[1].id, listRevision: list.revision }, 'supply-incomplete-option');
    const option = workflow(store).procurement!.options[0];
    for (const value of [option.totalCents, option.itemsTotalCents, option.deliveryFeeCents, option.taxCents, option.currency, option.deliveryAddress, option.deliveryWindow]) assert.equal(value, null);
    assert(option.missingFacts.length > 0); assert.equal(option.approvalId, null);
    const before = structuredClone(workflow(store).procurement);
    const approvals = structuredClone(store.state.office.approvals);
    const blocked = await run(store, { step: 'review_purchase', optionId: option.id, revision: option.revision }, 'supply-incomplete-review');
    assert.deepEqual(workflow(store).procurement, before);
    assert.deepEqual(store.state.office.approvals, approvals);
    assert(blocked.snapshot.cases[0].tasks.some(row => row.functionId === 'logistics' && row.status === 'blocked' && /revisi[oó]n|Opción/i.test(row.title)));
  });

  it('binds the full menu/list/delivery/cost review and records approval without ordering, paying or receiving', async () => {
    const store = new SerializedStore();
    const unchanged = facts(store.state);
    const { option, link } = await preparePurchase(store, 'supply-buy-review');
    assert.equal(option.itemsTotalCents, 4000); assert.equal(option.deliveryFeeCents, 500); assert.equal(option.taxCents, 400); assert.equal(option.totalCents, 4900); assert.equal(option.currency, 'USD');
    assert(option.deliveryAddress); assert(option.deliveryWindow); assert.equal(option.reviewStatus, 'pending'); assert.equal(link.supplyContext?.kind, 'purchase');
    const context = link.supplyContext;
    assert(context?.kind === 'purchase');
    assert.equal(context.digest, option.digest); assert.equal(context.snapshot.list.revision, option.listRevision);
    assert.equal(context.snapshot.menu.revision, option.menuRevision); assert.equal(context.snapshot.option.totalCents, option.totalCents);
    const preview = projectOfficeSnapshot(store.state, AT).cases[0].approvals.find(row => row.id === link.id)!;
    assertMoneyText(preview.body, ['20.00', '40.00', '5.00', '4.00', '49.00']);
    assert.equal(preview.body.match(/subtotal 20\.00 USD/gu)?.length, 2);
    assert.equal(preview.body.match(/0\.02 USD\/g/gu)?.length, 2);
    assert.match(preview.body, /Artículos 40\.00 USD; entrega 5\.00 USD; impuestos 4\.00 USD; total 49\.00 USD/u);
    const choice = projectOfficeSnapshot(store.state, AT).cases[0];
    for (const text of [choice.tasks.find(row => row.title === 'Opción de compra elegida · DEMO')!.detail, choice.history.find(row => row.title === 'Opción de compra elegida · DEMO')!.detail]) assertMoneyText(text, ['40.00', '5.00', '4.00', '49.00']);
    const approvalResult = await executeOfficeCommand(store, decision(link, 'approve', 'supply-buy-approved'), () => AT + 1);
    const approvedBody = approvalResult.snapshot.cases[0].approvals.find(row => row.id === link.id)!;
    assert.equal(approvedBody.body, preview.body); assert.equal(approvedBody.digest, preview.digest);
    assertMoneyText(approvedBody.body, ['20.00', '40.00', '5.00', '4.00', '49.00']);
    const approved = workflow(store).procurement!.options.find(row => row.id === option.id)!;
    assert.equal(approved.reviewStatus, 'approved_demo');
    assert.equal(approved.externalOrdered, false); assert.equal(approved.externalPaid, false); assert.equal(approved.externalReceived, false);
    assert.deepEqual(facts(store.state), unchanged); assertNoEffects(projectOfficeSnapshot(store.state, AT + 1));
  });

  it('rejects a stale purchase approval after menu revalidation changes the list binding', async () => {
    const store = new SerializedStore();
    const { link } = await preparePurchase(store, 'supply-buy-stale');
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[1].id }, 'supply-buy-stale-menu-revalidate');
    const before = canonical(store.state);
    await assert.rejects(executeOfficeCommand(store, decision(link, 'approve', 'supply-buy-stale-decision'), () => AT + 1), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
    assert.equal(canonical(store.state), before);
    assert(workflow(store).procurement!.options.every(row => !row.externalOrdered && !row.externalPaid && !row.externalReceived));
  });

  it('keeps list revisions monotonic and rejects a saved revision after menu revalidation', async () => {
    const store = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, 'supply-list-version-menu-first');
    await run(store, { step: 'build_purchase_list' }, 'supply-list-version-first');
    const original = workflow(store).procurement!.list!;
    await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, 'supply-list-version-menu-second');
    await run(store, { step: 'build_purchase_list' }, 'supply-list-version-second');
    const current = workflow(store).procurement!.list!;
    assert(current.revision > original.revision); assert.notEqual(current.menuDigest, original.menuDigest);
    const before = canonical(store.state);
    await assert.rejects(run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: original.revision }, 'supply-list-version-old-choice'), error('SUPPLY_REVISION_CONFLICT'));
    assert.equal(canonical(store.state), before);
  });

  it('requires a fresh review when returning to a previously approved purchase option', async () => {
    const store = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    const { option, link } = await preparePurchase(store, 'supply-reselect');
    const approvedInput = decision(link, 'approve', 'supply-reselect-approved');
    await executeOfficeCommand(store, approvedInput, () => AT);
    await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[1].id, listRevision: option.listRevision }, 'supply-reselect-alternate');
    await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: option.listRevision }, 'supply-reselect-original-again');
    const procurement = workflow(store).procurement!;
    const fresh = procurement.options.find(row => row.id === procurement.selectedOptionId)!;
    assert.notEqual(fresh.id, option.id); assert(fresh.revision > option.revision);
    assert.equal(fresh.reviewStatus, 'pending'); assert.equal(fresh.approvalId, null);
    assert.equal(procurement.options.find(row => row.id === option.id)!.reviewStatus, 'stale');
    const replay = await executeOfficeCommand(store, approvedInput, () => AT + 1);
    assert.equal(replay.replayed, true);
    assert.equal(workflow(store).procurement!.options.find(row => row.id === fresh.id)!.reviewStatus, 'pending');
    const before = canonical(store.state);
    await assert.rejects(executeOfficeCommand(store, decision(link, 'approve', 'supply-reselect-old-decision-again'), () => AT + 1), error('APPROVAL_TERMINAL'));
    assert.equal(canonical(store.state), before);
    await run(store, { step: 'review_purchase', optionId: fresh.id, revision: fresh.revision }, 'supply-reselect-new-review');
    const reviewed = workflow(store).procurement!.options.find(row => row.id === fresh.id)!;
    assert(reviewed.approvalId); assert.notEqual(reviewed.approvalId, link.id); assert.equal(reviewed.reviewStatus, 'pending');
    assert.equal(reviewed.externalOrdered, false); assert.equal(reviewed.externalPaid, false); assert.equal(reviewed.externalReceived, false);
  });

  it('blocks expired delivery windows before creating or approving a purchase review', async () => {
    const reviewed = new SerializedStore();
    const { option, link } = await preparePurchase(reviewed, 'supply-expiry-reviewed');
    const expiredAt = Date.parse(option.deliveryWindow!.endAt) + 1;
    const before = canonical(reviewed.state);
    await assert.rejects(executeOfficeCommand(reviewed, decision(link, 'approve', 'supply-expiry-late-approve'), () => expiredAt), error('SUPPLY_PURCHASE_WINDOW_EXPIRED'));
    assert.equal(canonical(reviewed.state), before);

    const unreviewed = new SerializedStore();
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    await run(unreviewed, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, 'supply-expiry-menu');
    await run(unreviewed, { step: 'build_purchase_list' }, 'supply-expiry-list');
    const list = workflow(unreviewed).procurement!.list!;
    await run(unreviewed, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: list.revision }, 'supply-expiry-option');
    const pending = workflow(unreviewed).procurement!.options[0];
    const approvals = structuredClone(unreviewed.state.office.approvals);
    const result = await run(unreviewed, { step: 'review_purchase', optionId: pending.id, revision: pending.revision }, 'supply-expiry-first-review', 'demo-aurora', expiredAt);
    assert.deepEqual(unreviewed.state.office.approvals, approvals);
    assert.equal(workflow(unreviewed).procurement!.options[0].approvalId, null);
    assert(result.snapshot.cases[0].tasks.some(row => row.functionId === 'logistics' && row.status === 'blocked' && /vencida/.test(row.title)));
  });
});

describe('supply HTTP permissions and DEMO boundary', () => {
  it('authorizes role, case, function and expiration before a sourcing command or replay', async t => {
    let now = AT;
    const { store, baseHeaders, login, post } = await apiFixture(t, () => now);
    const command = supplyCommand({ step: 'queue_sourcing' }, 'supply-http-scope');
    const before = canonical(store.state);
    assert.equal((await post(baseHeaders, command)).statusCode, 401);
    for (const scope of [
      { role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['suppliers'] },
      { role: 'operator', caseIds: ['demo-harbor'], functionIds: ['suppliers'] },
      { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['finance'] },
    ]) {
      const headers = await login(scope);
      assert.equal((await post(headers, command)).statusCode, 403);
      assert.equal(canonical(store.state), before);
    }
    const headers = await login();
    assert.equal((await post(headers, command)).statusCode, 200);
    const committed = canonical(store.state);
    const viewer = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['suppliers'] });
    assert.equal((await post(viewer, command)).statusCode, 403);
    now += SESSION_TTL_MS;
    assert.equal((await post(headers, command)).statusCode, 401);
    assert.equal(canonical(store.state), committed);
  });

  it('rejects client-owned candidate data and cross-function operations without reflecting it', async t => {
    const { store, login, post } = await apiFixture(t);
    const headers = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['suppliers', 'logistics', 'finance'] });
    const before = canonical(store.state);
    const foreign = 'SYNTHETIC_CANDIDATE_PRIVATE_INPUT_NEVER_REFLECT';
    for (const operation of [
      { step: 'queue_sourcing', candidate: foreign },
      { step: 'ingest_digest', fixtureId: 'unknown-fixture', entries: [{ contact: foreign }] },
      { step: 'queue_sourcing', provider: 'live-source' },
    ]) {
      const result = await post(headers, { ...supplyCommand({ step: 'queue_sourcing' }, 'supply-invalid'), supply: operation });
      assert.equal(result.statusCode, 400); assert(!result.body.includes(foreign));
      assert.equal(canonical(store.state), before);
    }
    for (const [functionId, supply, statusCode, code] of [
      ['logistics', { step: 'queue_sourcing' }, 403, 'INVALID_SUPPLY_FUNCTION'],
      ['suppliers', { step: 'build_purchase_list' }, 403, 'INVALID_SUPPLY_FUNCTION'],
      ['finance', { step: 'queue_sourcing' }, 400, 'INVALID_SUPPLY_COMMAND'],
    ] as const) {
      const result = await post(headers, { ...supplyCommand({ step: 'queue_sourcing' }, 'supply-wrong-function'), functionId, supply });
      assert.equal(result.statusCode, statusCode); assert.deepEqual(result.json(), { error: code });
      assert.equal(canonical(store.state), before);
    }
  });

  it('filters supplier and procurement snapshots independently while sales sees neither', async t => {
    const { store, api, login } = await apiFixture(t);
    await ingest(store, 'supply-scope-data');
    await preparePurchase(store, 'supply-scope-purchase');
    for (const functionIds of [['sales'], ['suppliers'], ['logistics']] as const) {
      const headers = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds });
      const response = await api.inject({ url: '/office-api/snapshot', headers });
      assert.equal(response.statusCode, 200);
      const snapshot = response.json();
      assert.equal(snapshot.cases.length, 1);
      const item = snapshot.cases[0];
      if (functionIds[0] === 'sales') assert.equal(item.supplyWorkflow, undefined);
      if (functionIds[0] === 'suppliers') { assert(item.supplyWorkflow.sourcing); assert.equal(item.supplyWorkflow.procurement, undefined); }
      if (functionIds[0] === 'logistics') { assert(item.supplyWorkflow.procurement); assert.equal(item.supplyWorkflow.sourcing, undefined); }
      assert.deepEqual(validateOfficeSnapshot(snapshot, 'demo'), snapshot);
      for (const rows of [item.tasks, item.approvals, item.results, item.history, item.messages]) assert(rows.every((row: { functionId: string }) => functionIds.includes(row.functionId as never)));
    }
  });

  it('rejects mixed supply/commercial/text envelopes before any domain mutation', async t => {
    const { store, login, post } = await apiFixture(t);
    const headers = await login();
    const before = canonical(store.state);
    const base = supplyCommand({ step: 'queue_sourcing' }, 'supply-mixed-envelope');
    for (const extra of [
      { text: 'SYNTHETIC_ALIEN_DRAFT_TEXT' },
      { commercialThreadId: 'commercial-demo-aurora', commercialThreadRevision: 1, commercialThreadDigest: 'a'.repeat(64) },
      { action: 'approve', approvalId: 'approval-demo-aurora-proposals-fixture', revision: 1, digest: 'a'.repeat(64) },
    ]) {
      const result = await post(headers, { ...base, ...extra });
      assert.equal(result.statusCode, 400);
      assert.equal(canonical(store.state), before);
    }
  });
});

describe('supply data contracts', () => {
  it('preserves valid snapshots at 1000 review records, rejects record 1001 atomically and permits existing reuse', async () => {
    const selections = new SerializedStore();
    const { selection } = await prepareSelection(selections, 'supply-limit-selection');
    const alternate = await readyCandidate(selections, 'supply-limit-alternate', 'demo-aurora', 1);
    await selections.transact(state => {
      const rows = state.office.supply!.cases['demo-aurora'].selections;
      for (let index = 1; index < 1000; index += 1) {
        const copy = structuredClone(selection);
        copy.id = `supply-selection-limit-${index}`;
        copy.approvalId = null;
        copy.digest = sha256({ kind: 'selection', caseId: copy.caseId, id: copy.id, revision: copy.revision, snapshot: copy.snapshot });
        rows[copy.id] = copy;
      }
    });
    const atLimit = projectOfficeSnapshot(selections.state, AT);
    assert.equal(atLimit.cases[0].supplyWorkflow!.sourcing!.selections.length, 1000);
    assert.deepEqual(validateOfficeSnapshot(atLimit, 'demo'), atLimit);
    const selectionBefore = canonical(selections.state);
    await assert.rejects(run(selections, { step: 'select_candidate', candidateId: alternate.id, revision: alternate.revision }, 'supply-limit-selection-overflow'), (failure: unknown) => failure instanceof OfficeError && failure.code === 'SUPPLY_RECORD_LIMIT' && failure.statusCode === 409);
    assert.equal(canonical(selections.state), selectionBefore);
    const current = workflow(selections).sourcing!.candidates.find(row => row.id === selection.candidateId)!;
    const reused = await run(selections, { step: 'select_candidate', candidateId: current.id, revision: current.revision }, 'supply-limit-selection-reuse');
    assert.equal(reused.replayed, true);
    assert.equal(workflow(selections).sourcing!.selections.length, 1000);
    assert.equal(Object.keys(selections.state.office.approvals).length, atLimit.cases.reduce((sum, item) => sum + item.approvals.length, 0));
    assert.deepEqual(validateOfficeSnapshot(reused.snapshot, 'demo'), reused.snapshot);

    const options = new SerializedStore();
    const { option } = await preparePurchase(options, 'supply-limit-option');
    await options.transact(state => {
      const rows = state.office.supply!.cases['demo-aurora'].options;
      for (let index = 1; index < 1000; index += 1) {
        const copy = structuredClone(option);
        copy.id = `supply-option-limit-${index}`;
        copy.approvalId = null;
        copy.snapshot!.option.id = copy.id;
        copy.digest = sha256({ kind: 'purchase', caseId: copy.caseId, id: copy.id, revision: copy.revision, snapshot: copy.snapshot });
        rows[copy.id] = copy;
      }
    });
    const optionsAtLimit = projectOfficeSnapshot(options.state, AT);
    assert.equal(optionsAtLimit.cases[0].supplyWorkflow!.procurement!.options.length, 1000);
    assert.deepEqual(validateOfficeSnapshot(optionsAtLimit, 'demo'), optionsAtLimit);
    const fixtures = getSupplyFixtures('demo-aurora', AT);
    const optionBefore = canonical(options.state);
    await assert.rejects(run(options, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[1].id, listRevision: option.listRevision }, 'supply-limit-option-overflow'), (failure: unknown) => failure instanceof OfficeError && failure.code === 'SUPPLY_RECORD_LIMIT' && failure.statusCode === 409);
    assert.equal(canonical(options.state), optionBefore);
    const existing = await run(options, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: option.listRevision }, 'supply-limit-option-reuse');
    const procurement = existing.snapshot.cases[0].supplyWorkflow!.procurement!;
    assert.equal(procurement.options.length, 1000); assert.equal(procurement.selectedOptionId, option.id);
    assert.deepEqual(procurement.options.find(row => row.id === option.id), option);
    assert.deepEqual(validateOfficeSnapshot(existing.snapshot, 'demo'), existing.snapshot);
    assertNoEffects(existing.snapshot);
  });

  it('checks descriptors and plain data before reading untrusted operation fields', () => {
    let getterReads = 0;
    const getter = Object.defineProperty({}, 'step', { enumerable: true, get() { getterReads += 1; return 'queue_sourcing'; } });
    const hidden = Object.defineProperty({ step: 'queue_sourcing' }, 'candidateId', { enumerable: false, value: 'candidate-demo-alba' });
    const symbol = { step: 'queue_sourcing', [Symbol('untrusted')]: true };
    const inherited = Object.create({ step: 'queue_sourcing' });
    const subclass = new (class Operation { step = 'queue_sourcing'; })();
    for (const raw of [getter, hidden, symbol, inherited, subclass, [], null, { step: 'queue_sourcing', extra: 'unexpected' }, { step: 'evaluate_candidate', candidateId: 'candidate-demo-alba', revision: NaN, verdict: 'eligible' }, { step: 'evaluate_candidate', candidateId: 'candidate-demo-alba', revision: '1', verdict: 'eligible' }]) {
      assert.throws(() => parseSupplyOperation(raw), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 400);
    }
    assert.equal(getterReads, 0);
    assert.deepEqual(parseSupplyOperation(Object.assign(Object.create(null), { step: 'queue_sourcing' })), { step: 'queue_sourcing' });
  });

  it('validates projected snapshots and rejects extra fields, real destinations and malformed quantities or dates', async () => {
    const store = new SerializedStore();
    await ingest(store, 'supply-adapter-data');
    await preparePurchase(store, 'supply-adapter-purchase');
    const snapshot = projectOfficeSnapshot(store.state, AT);
    assert.deepEqual(validateOfficeSnapshot(snapshot, 'demo'), snapshot);
    const corruptions: Array<(copy: OfficeSnapshot) => void> = [
      copy => { Object.assign(copy.cases[0].supplyWorkflow!, { apiToken: 'SYNTHETIC_UNKNOWN_SECRET_FIELD' }); },
      copy => { copy.cases[0].supplyWorkflow!.sourcing!.candidates[0].sourceLink = 'https://source.example.com/synthetic'; },
      copy => { copy.cases[0].supplyWorkflow!.sourcing!.candidates[0].contact = 'synthetic@example.com'; },
      copy => { copy.cases[0].supplyWorkflow!.sourcing!.candidates[0].readAt = 'not-a-date'; },
      copy => { copy.cases[0].supplyWorkflow!.sourcing!.candidates[0].announcedRateCents = NaN; },
      copy => { Object.assign(copy.cases[0].supplyWorkflow!.procurement!.list!.items[0], { quantity: '1000' }); },
      copy => { copy.cases[0].supplyWorkflow!.procurement!.options[0].totalCents = NaN; },
      copy => { copy.cases[0].supplyWorkflow!.procurement!.options[0].deliveryWindow!.endAt = 'not-a-date'; },
      copy => { const link = copy.cases[0].approvals.find(row => row.supplyContext?.kind === 'purchase')!; link.supplyContext!.caseId = 'demo-cedar'; },
      copy => { const link = copy.cases[0].approvals.find(row => row.supplyContext?.kind === 'purchase')!; link.functionId = 'suppliers'; },
    ];
    for (const corrupt of corruptions) {
      const copy = structuredClone(snapshot); corrupt(copy);
      assert.throws(() => validateOfficeSnapshot(copy, 'demo'));
    }
  });
});
