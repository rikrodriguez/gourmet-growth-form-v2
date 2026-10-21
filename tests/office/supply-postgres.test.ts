import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { SupplyOperation } from '../../src/office/supply-contracts';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { getSupplyFixtures } from '../../src/office/backend/supply-fixtures';
import { projectSupplyWorkflow } from '../../src/office/backend/supply-workflow';
import { OfficeError, canonical, projectOfficeSnapshot, sha256 } from '../../src/office/backend/state';
import type { ApprovalLink, DemoCaseId, OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-11T16:00:00.000Z');
const PROCUREMENT_STEPS = new Set(['validate_menu', 'build_purchase_list', 'choose_purchase_option', 'review_purchase']);
const command = (operation: SupplyOperation, key: string, caseId: DemoCaseId = 'demo-aurora') => ({
  idempotencyKey: key, caseId, functionId: PROCUREMENT_STEPS.has(operation.step) ? 'logistics' : 'suppliers', action: 'draft', supply: operation,
});
const run = (store: OfficeStore, operation: SupplyOperation, key: string, caseId: DemoCaseId = 'demo-aurora') => executeOfficeCommand(store, command(operation, key, caseId), () => AT);
const approve = (store: OfficeStore, link: ApprovalLink, key: string) => executeOfficeCommand(store, {
  idempotencyKey: key, caseId: link.caseId, functionId: link.functionId, action: 'approve', approvalId: link.id, revision: link.revision, digest: link.digest,
}, () => AT);

async function database(t: TestContext) {
  const stateId = `supply_test_${randomUUID()}`;
  const open = new Set<PostgresOfficeStore>();
  async function disconnect(pool: PostgresOfficeStore) { if (open.delete(pool)) await pool.close(); }
  t.after(async () => { for (const pool of [...open]) await disconnect(pool); });
  async function connect() {
    const pool = new PostgresOfficeStore({ stateId });
    open.add(pool);
    await pool.initialize(AT);
    return pool;
  }
  const store = await connect();
  // All fixtures use unique aggregate IDs. History is deliberately retained:
  // the database enforces append-only events, including synthetic test events.
  return { stateId, store, connect, disconnect };
}

async function prepareSelection(store: OfficeStore, prefix: string, caseId: DemoCaseId = 'demo-aurora', candidateIndex = 0) {
  const fixtures = getSupplyFixtures(caseId, AT);
  await run(store, { step: 'ingest_digest', fixtureId: fixtures.digestFixtures[0].id }, `${prefix}-ingest`, caseId);
  const candidateId = fixtures.digestFixtures[0].entries[candidateIndex].candidateId;
  const current = async () => projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === candidateId)!;
  await run(store, { step: 'evaluate_candidate', candidateId, revision: (await current()).revision, verdict: 'eligible' }, `${prefix}-evaluate`, caseId);
  await run(store, { step: 'verify_availability', candidateId, revision: (await current()).revision, status: 'available' }, `${prefix}-available`, caseId);
  const terms = fixtures.termsFixtures.find(row => row.candidateId === candidateId && row.totalCents !== null)!;
  await run(store, { step: 'approve_terms', candidateId, revision: (await current()).revision, termsFixtureId: terms.id }, `${prefix}-terms`, caseId);
  await run(store, { step: 'select_candidate', candidateId, revision: (await current()).revision }, `${prefix}-select`, caseId);
  const state = await store.snapshot();
  const selection = projectSupplyWorkflow(state, caseId, AT).sourcing!.selections.find(row => row.candidateId === candidateId && row.snapshot.candidate.revision === state.office.supply!.cases[caseId].candidates[candidateId].revision)!;
  assert(selection.approvalId);
  return { selection, link: state.office.approvals[selection.approvalId] };
}

async function preparePurchase(store: OfficeStore, prefix: string) {
  const fixtures = getSupplyFixtures('demo-aurora', AT);
  await run(store, { step: 'validate_menu', fixtureId: fixtures.menuFixtures[0].id }, `${prefix}-menu`);
  await run(store, { step: 'build_purchase_list' }, `${prefix}-list`);
  const list = projectSupplyWorkflow(await store.snapshot(), 'demo-aurora', AT).procurement!.list!;
  await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[0].id, listRevision: list.revision }, `${prefix}-option`);
  const option = projectSupplyWorkflow(await store.snapshot(), 'demo-aurora', AT).procurement!.options[0];
  await run(store, { step: 'review_purchase', optionId: option.id, revision: option.revision }, `${prefix}-review`);
  const state = await store.snapshot();
  const reviewed = projectSupplyWorkflow(state, 'demo-aurora', AT).procurement!.options.find(row => row.id === option.id)!;
  assert(reviewed.approvalId);
  return { option: reviewed, link: state.office.approvals[reviewed.approvalId] };
}

describe('operational records on the existing PostgreSQL aggregate', () => {
  const exec = promisify(execFile);
  const view = async (store: OfficeStore) => projectOfficeSnapshot(await store.snapshot(), AT).cases[0].operationalWorkflow!;
  async function opCommand(store: OfficeStore, detail: Record<string, unknown>, key: string) {
    const v = await view(store);
    return { idempotencyKey: key, caseId: 'demo-aurora', functionId: ['set_policy', 'record_receipt', 'confirm_milestone'].includes(detail.step as string) ? 'logistics' : 'quality', action: 'draft', operational: { ...detail, eventId: v.eventId, revision: v.revision, contextDigest: v.contextDigest } };
  }
  async function ready(store: OfficeStore, prefix: string) {
    const selection = await prepareSelection(store, prefix); await approve(store, selection.link, `${prefix}-approve`);
    await run(store, { step: 'assign_demo', selectionId: selection.selection.id, revision: 1 }, `${prefix}-assign`);
    const purchase = await preparePurchase(store, prefix); await approve(store, purchase.link, `${prefix}-purchase-approved`);
    const apply = async (detail: Record<string, unknown>, key: string) => executeOfficeCommand(store, await opCommand(store, detail, key), () => AT);
    await apply({ step: 'set_policy', policyFixtureId: 'ops-policy-synthetic-v1' }, `${prefix}-policy`);
    await apply({ step: 'record_receipt', fixtureId: 'ops-demo-aurora-receipt-complete' }, `${prefix}-receipt`);
    for (const milestone of ['preparation', 'assembly', 'service', 'delivery']) await apply({ step: 'confirm_milestone', milestone, fixtureId: `ops-demo-aurora-${milestone}` }, `${prefix}-${milestone}`);
    return { apply };
  }
  it('persists the complete journey across independent backend processes and replays a lost close result', async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const old = await store.snapshot(); assert.equal(old.office.operational, undefined);
    const { apply } = await ready(store, 'ops-pg-restart');
    await apply({ step: 'open_incident', description: 'Material sintético pendiente', owner: 'coordination_demo' }, 'ops-pg-open');
    const incident = (await view(store)).quality!.incidents[0];
    await apply({ step: 'acknowledge_incident', incidentId: incident.id }, 'ops-pg-ack');
    await apply({ step: 'resolve_incident', incidentId: incident.id, resolution: 'Material de ensayo comprobado', fixtureId: 'ops-demo-aurora-resolution' }, 'ops-pg-resolve');
    const command = await opCommand(store, { step: 'close_demo', reviewDigest: (await view(store)).closure.reviewDigest }, 'ops-pg-close');
    await disconnect(store);
    // Invoke the real store/command modules in separate Node processes. No new
    // server, route, credentials or application harness is introduced.
    const program = `import {PostgresOfficeStore} from './src/office/backend/postgres-store.ts'; import {executeOfficeCommand} from './src/office/backend/commands.ts'; const store=new PostgresOfficeStore({stateId:process.argv[1]}); try { await store.initialize(${AT}); const r=await executeOfficeCommand(store,JSON.parse(process.argv[2]),()=>${AT}); const v=r.snapshot.cases[0].operationalWorkflow; console.log(JSON.stringify({pid:process.pid,replayed:r.replayed,revision:v.revision,status:v.closure.status,recordId:v.closure.recordId})); } finally {await store.close();}`;
    const first = JSON.parse((await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, stateId, JSON.stringify(command)])).stdout);
    const second = JSON.parse((await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, stateId, JSON.stringify(command)])).stdout);
    assert.notEqual(first.pid, second.pid); assert.equal(first.replayed, false); assert.equal(second.replayed, true);
    assert.equal(second.status, 'closed_demo'); assert.equal(first.recordId, second.recordId); assert.equal(first.revision, second.revision);
    const reopened = await connect(), after = await reopened.snapshot();
    for (const [key, row] of Object.entries(old.office.commands)) assert.deepEqual(after.office.commands[key], row);
    assert(after.office.operational!.cases['demo-aurora'].records.every(r => r.actorId === 'OFFICE_DEMO_OPERATOR'));
    const count = await reopened.pool.query('SELECT count(*)::int AS count FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, command.idempotencyKey]);
    assert.equal(count.rows[0].count, 1);
    console.log('OPERATIONAL_RESTART_EVIDENCE=' + JSON.stringify({ ...second, firstPid: first.pid, independentProcesses: true, persisted: true }));
  });
  it('serializes an incident racing closure and concurrent retries without losing either audit history', async t => {
    const { store, connect } = await database(t); await ready(store, 'ops-pg-race'); const other = await connect();
    const close = await opCommand(store, { step: 'close_demo', reviewDigest: (await view(store)).closure.reviewDigest }, 'ops-pg-race-close');
    const incident = await opCommand(store, { step: 'open_incident', description: 'Incidencia que compite con cierre', owner: 'quality_demo' }, 'ops-pg-race-incident');
    const raced = await Promise.allSettled([executeOfficeCommand(store, close, () => AT), executeOfficeCommand(other, incident, () => AT)]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = raced.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'OPERATIONAL_REVISION_CONFLICT');
    if ((await view(store)).closure.status === 'closed_demo') {
      const next = await opCommand(other, { step: 'open_incident', description: 'Incidencia posterior al cierre', owner: 'quality_demo' }, 'ops-pg-after-close');
      const replayed = await Promise.all([executeOfficeCommand(store, next, () => AT), executeOfficeCommand(other, next, () => AT)]);
      assert.equal(replayed.filter(r => r.replayed).length, 1);
    } else {
      const replayed = await Promise.all([executeOfficeCommand(store, incident, () => AT), executeOfficeCommand(other, incident, () => AT)]);
      assert(replayed.every(r => r.replayed));
    }
    const final = await view(store);
    assert.notEqual(final.closure.status, 'closed_demo'); assert.equal(final.quality!.incidents.length, 1);
    const stored = await store.snapshot(), prefix = structuredClone(stored.office.operational!.cases['demo-aurora'].records);
    await assert.rejects(store.transact(s => {
      const record = s.office.operational!.cases['demo-aurora'].records[0]; record.evidence.at = new Date(AT + 1).toISOString();
      const { digest: _digest, ...content } = record; record.digest = sha256(content);
    }), e => e instanceof OfficeError && e.code === 'OPERATIONAL_APPEND_ONLY');
    assert.deepEqual((await store.snapshot()).office.operational!.cases['demo-aurora'].records, prefix);
  });
  it('reopens old aggregates unchanged and rejects stale dependency bindings after another pool updates the menu', async t => {
    const { store, connect, disconnect } = await database(t); await ready(store, 'ops-pg-stale'); const other = await connect();
    const before = await store.snapshot();
    const late = await opCommand(store, { step: 'confirm_milestone', milestone: 'delivery', fixtureId: 'ops-demo-aurora-delivery' }, 'ops-pg-late');
    await run(other, { step: 'validate_menu', fixtureId: 'supply-menu-demo-aurora-missing-quantity' }, 'ops-pg-menu-changed');
    await disconnect(store); const reopened = await connect();
    await assert.rejects(executeOfficeCommand(reopened, late, () => AT), e => e instanceof OfficeError && e.code === 'OPERATIONAL_REVISION_CONFLICT');
    const after = await reopened.snapshot();
    assert.deepEqual(after.office.operational, before.office.operational);
    assert.equal((await view(reopened)).summary.receipt, 'stale');
    assert((await view(reopened)).blockers.some(b => /abastecimiento/.test(b)));
  });
});

describe('assignment withdrawal on independent PostgreSQL pools', () => {
  it('reads the previous assignment payload and persists withdrawal/replacement without rewriting old command digests', async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const first = await prepareSelection(store, 'pg-withdraw-old'); await approve(store, first.link, 'pg-withdraw-old-approved');
    const assigned = command({ step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'pg-withdraw-old-assigned');
    await executeOfficeCommand(store, assigned, () => AT);
    const old = await store.snapshot(), assignment = Object.values(old.office.supply!.assignments)[0]; delete assignment.revision;
    await store.pool.query('UPDATE office_demo.states SET payload=$2::jsonb WHERE id=$1', [stateId, JSON.stringify(old)]);
    const oldEvents = await store.pool.query('SELECT command_key,digest FROM office_demo.command_events WHERE state_id=$1 ORDER BY command_key', [stateId]);
    await disconnect(store); const next = await connect();
    assert.deepEqual((await next.snapshot()).office.commands, old.office.commands);
    assert.equal(Object.hasOwn((await next.snapshot()).office.supply!.assignments[assignment.id], 'revision'), false);
    const withdrawal = command({ step: 'withdraw_assignment', assignmentId: assignment.id, revision: 1, reason: 'Replanificación sintética persistida' }, 'pg-withdraw-retire');
    await executeOfficeCommand(next, withdrawal, () => AT + 1);
    const replacement = await prepareSelection(next, 'pg-withdraw-next', 'demo-aurora', 1); await approve(next, replacement.link, 'pg-withdraw-next-approved');
    await run(next, { step: 'assign_demo', selectionId: replacement.selection.id, revision: replacement.selection.revision }, 'pg-withdraw-next-assigned');
    const expected = await next.snapshot(); await disconnect(next); const recovered = await connect();
    assert.equal(canonical(await recovered.snapshot()), canonical(expected));
    for (const replay of [assigned, withdrawal]) assert.equal((await executeOfficeCommand(recovered, replay, () => AT + 2)).replayed, true);
    assert.equal(canonical(await recovered.snapshot()), canonical(expected));
    for (const [key, value] of Object.entries(old.office.commands)) assert.deepEqual(expected.office.commands[key], value);
    for (const [key, value] of Object.entries(old.office.history)) assert.deepEqual(expected.office.history[key], value);
    const events = await recovered.pool.query('SELECT command_key,digest FROM office_demo.command_events WHERE state_id=$1 AND command_key=ANY($2::text[]) ORDER BY command_key', [stateId, oldEvents.rows.map(row => row.command_key)]);
    assert.deepEqual(events.rows, oldEvents.rows);
    const rows = Object.values(expected.office.supply!.assignments); assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.status === 'assigned_demo').length, 1);
    assert.deepEqual(expected.office.supply!.assignments[assignment.id].evidence, assignment.evidence);
  });
  it('serializes exact withdrawal retries and concurrent approved replacements into one active assignment', async t => {
    const { store, connect, stateId } = await database(t), independent = await connect();
    const first = await prepareSelection(store, 'pg-withdraw-race-old'); await approve(store, first.link, 'pg-withdraw-race-old-approved');
    await run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'pg-withdraw-race-old-assigned');
    const oldAssignment = Object.values((await store.snapshot()).office.supply!.assignments)[0];
    const withdrawal = { step: 'withdraw_assignment' as const, assignmentId: oldAssignment.id, revision: 1, reason: 'Sustitución sintética concurrente' };
    const withdrawn = await Promise.all([run(store, withdrawal, 'pg-withdraw-race-retire'), run(independent, withdrawal, 'pg-withdraw-race-retire')]);
    assert.equal(withdrawn.filter(row => row.replayed).length, 1);
    const a = await prepareSelection(store, 'pg-withdraw-race-a'); const b = await prepareSelection(independent, 'pg-withdraw-race-b', 'demo-aurora', 1);
    await approve(store, a.link, 'pg-withdraw-race-a-approved'); await approve(independent, b.link, 'pg-withdraw-race-b-approved');
    const results = await Promise.allSettled([
      run(store, { step: 'assign_demo', selectionId: a.selection.id, revision: a.selection.revision }, 'pg-withdraw-race-a-assigned'),
      run(independent, { step: 'assign_demo', selectionId: b.selection.id, revision: b.selection.revision }, 'pg-withdraw-race-b-assigned'),
    ]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    const failed = results.find(row => row.status === 'rejected') as PromiseRejectedResult; assert.equal(failed.reason.code, 'SUPPLY_CASE_ALREADY_ASSIGNED');
    const state = await independent.snapshot(); assert.equal(Object.values(state.office.supply!.assignments).filter(row => row.status === 'assigned_demo').length, 1);
    assert.equal(state.office.supply!.assignments[oldAssignment.id].status, 'withdrawn_demo');
    const receipts = await store.pool.query('SELECT count(*)::int AS n FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, 'pg-withdraw-race-retire']); assert.equal(receipts.rows[0].n, 1);
    await assert.rejects(run(store, withdrawal, 'pg-withdraw-race-late-retire'), (e: unknown) => e instanceof OfficeError && e.code === 'SUPPLY_REVISION_CONFLICT');
  });
  it('does not release an overlapping reservation on unavailability; explicit withdrawal allows another case after concurrency/retry', async t => {
    const { store, connect } = await database(t), independent = await connect();
    await store.transact(state => { state.office.cases['demo-harbor'].saleClosed = true; });
    const first = await prepareSelection(store, 'pg-withdraw-overlap-a'); await approve(store, first.link, 'pg-withdraw-overlap-a-approved');
    await run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: 1 }, 'pg-withdraw-overlap-a-assigned');
    const current = (await store.snapshot()).office.supply!.cases['demo-aurora'].candidates[first.selection.candidateId];
    await run(store, { step: 'verify_availability', candidateId: current.id, revision: current.revision, status: 'unavailable' }, 'pg-withdraw-overlap-unavailable');
    const second = await prepareSelection(independent, 'pg-withdraw-overlap-b', 'demo-harbor'); await approve(independent, second.link, 'pg-withdraw-overlap-b-approved');
    const replacement = { step: 'assign_demo' as const, selectionId: second.selection.id, revision: second.selection.revision };
    await assert.rejects(run(independent, replacement, 'pg-withdraw-overlap-blocked', 'demo-harbor'), (e: unknown) => e instanceof OfficeError && e.code === 'SUPPLY_ASSIGNMENT_OVERLAP');
    const id = Object.values((await store.snapshot()).office.supply!.assignments)[0].id;
    const result = await Promise.allSettled([
      run(store, { step: 'withdraw_assignment', assignmentId: id, revision: 1, reason: 'Liberación interna de ventana sintética' }, 'pg-withdraw-overlap-retire'),
      run(independent, replacement, 'pg-withdraw-overlap-recover', 'demo-harbor'),
    ]);
    assert.equal(result[0].status, 'fulfilled');
    await run(independent, replacement, 'pg-withdraw-overlap-recover', 'demo-harbor');
    const assignments = Object.values((await store.snapshot()).office.supply!.assignments);
    assert.equal(assignments.filter(row => row.status === 'assigned_demo').length, 1); assert.equal(assignments.find(row => row.status === 'assigned_demo')!.caseId, 'demo-harbor');
  });
});

describe('terminal purchase recovery on independent PostgreSQL pools', () => {
  for (const action of ['reject', 'cancel'] as const) for (const timing of ['current', 'historical'] as const) it(`opens one fresh review after ${action} of a ${timing} option without rewriting earlier payload or events`, async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const prefix = `pg-purchase-terminal-${action}-${timing}`, fixtures = getSupplyFixtures('demo-aurora', AT);
    const { option, link } = await preparePurchase(store, prefix);
    if (timing === 'historical') await run(store, { step: 'choose_purchase_option', optionFixtureId: fixtures.optionFixtures[1].id, listRevision: option.listRevision }, `${prefix}-alternate`);
    const terminal = { idempotencyKey: `${prefix}-terminal`, caseId: link.caseId, functionId: link.functionId, action, approvalId: link.id, revision: link.revision, digest: link.digest };
    await executeOfficeCommand(store, terminal, () => AT);
    // These records use the unchanged payload schema and revision-1 option
    // shape written before recovery was supported. Reopening must not migrate
    // terminal decisions, digests, contexts or command/history records.
    const previous = await store.snapshot();
    const previousEvents = await store.pool.query('SELECT command_key,digest FROM office_demo.command_events WHERE state_id=$1 ORDER BY command_key', [stateId]);
    const previousHistory = await store.pool.query('SELECT history_id,record FROM office_demo.history_events WHERE state_id=$1 ORDER BY history_id', [stateId]);
    await disconnect(store);
    const restarted = await connect(), independent = await connect();
    assert.equal(canonical(await restarted.snapshot()), canonical(previous));

    const choose = { step: 'choose_purchase_option' as const, optionFixtureId: fixtures.optionFixtures[0].id, listRevision: option.listRevision };
    const chosen = await Promise.all([run(restarted, choose, `${prefix}-choose-a`), run(independent, choose, `${prefix}-choose-b`)]);
    const selectedIds = chosen.map(result => result.snapshot.cases[0].supplyWorkflow!.procurement!.selectedOptionId);
    assert.equal(selectedIds[0], selectedIds[1], 'independent choices must share one fresh record');
    const selected = (await restarted.snapshot()).office.supply!.cases['demo-aurora'];
    const fresh = selected.options[selected.selectedOptionId!];
    assert.notEqual(fresh.id, option.id, 'a terminal review must never be reselected');
    assert.equal(fresh.revision, option.revision + 1);
    assert.equal(Object.keys(selected.options).length, Object.keys(previous.office.supply!.cases['demo-aurora'].options).length + 1);
    assert.equal(fresh.reviewStatus, 'pending'); assert.equal(fresh.approvalId, null); assert.equal(fresh.snapshot, null);
    assert.deepEqual(selected.options[option.id].snapshot, option.snapshot);
    assert.equal(selected.options[option.id].digest, option.digest);
    assert.deepEqual(selected.options[option.id].evidence, option.evidence);
    assert.deepEqual((await restarted.snapshot()).office.approvals[link.id], previous.office.approvals[link.id]);

    const review = { step: 'review_purchase' as const, optionId: fresh.id, revision: fresh.revision };
    const reviews = await Promise.all([run(restarted, review, `${prefix}-review-a`), run(independent, review, `${prefix}-review-b`)]);
    assert.equal(reviews.filter(result => result.replayed).length, 1, 'concurrent reviews must bind one approval');
    const reviewed = await independent.snapshot(), current = reviewed.office.supply!.cases['demo-aurora'].options[fresh.id];
    assert(current.approvalId); assert.notEqual(current.approvalId, link.id);
    const approval = reviewed.office.approvals[current.approvalId];
    assert.equal(Object.keys(reviewed.office.approvals).length, Object.keys(previous.office.approvals).length + 1);
    assert.equal(current.reviewStatus, 'pending'); assert.equal(approval.status, 'pending'); assert.equal(approval.coreApprovalId, undefined);
    assert.equal(Object.values(reviewed.office.approvals).filter(row => row.supplyContext?.kind === 'purchase' && row.supplyContext.optionId === fresh.id).length, 1);

    // Replay each original input, including menu/list/choice/review/terminal
    // commands, through both pools. Receipts return current state and cannot
    // restore a historical choice or alter the fresh pending approval.
    const beforeReplay = canonical(reviewed);
    const oldInputs = Object.values(previous.office.commands).map(record => record.input);
    for (let index = 0; index < oldInputs.length; index++) {
      const replay = await executeOfficeCommand(index % 2 ? independent : restarted, oldInputs[index], () => AT + 1);
      assert.equal(replay.replayed, true);
      assert.equal(replay.snapshot.cases[0].supplyWorkflow!.procurement!.selectedOptionId, fresh.id);
    }
    assert.equal(canonical(await restarted.snapshot()), beforeReplay);
    await assert.rejects(approve(independent, link, `${prefix}-old-approval`), error => error instanceof OfficeError && error.code === 'APPROVAL_TERMINAL');
    await assert.rejects(run(restarted, { step: 'review_purchase', optionId: option.id, revision: option.revision }, `${prefix}-old-review`), error => error instanceof OfficeError && error.code === 'SUPPLY_REVIEW_STALE');
    assert.equal(canonical(await independent.snapshot()), beforeReplay);

    await approve(independent, approval, `${prefix}-fresh-approved`);
    const expected = await independent.snapshot();
    assert.equal(expected.office.supply!.cases['demo-aurora'].options[fresh.id].reviewStatus, 'approved_demo');
    assert.equal(expected.office.approvals[link.id].status, action === 'reject' ? 'rejected_demo' : 'cancelled_demo');
    assert.deepEqual(expected.office.approvals[link.id], previous.office.approvals[link.id]);
    for (const [key, record] of Object.entries(previous.office.commands)) assert.deepEqual(expected.office.commands[key], record);
    for (const [id, record] of Object.entries(previous.office.history)) assert.deepEqual(expected.office.history[id], record);
    const events = await restarted.pool.query('SELECT command_key,digest FROM office_demo.command_events WHERE state_id=$1 AND command_key=ANY($2::text[]) ORDER BY command_key', [stateId, previousEvents.rows.map(row => row.command_key)]);
    assert.deepEqual(events.rows, previousEvents.rows);
    const history = await restarted.pool.query('SELECT history_id,record FROM office_demo.history_events WHERE state_id=$1 AND history_id=ANY($2::text[]) ORDER BY history_id', [stateId, previousHistory.rows.map(row => row.history_id)]);
    assert.deepEqual(history.rows, previousHistory.rows);
    await disconnect(restarted); await disconnect(independent);
    const recovered = await connect();
    assert.equal(canonical(await recovered.snapshot()), canonical(expected));
    const snapshot = projectOfficeSnapshot(await recovered.snapshot(), AT);
    assert.equal(snapshot.outboundEffects, 0); assert.equal(snapshot.mondayWrites, 0);
    assert.equal(current.externalOrdered, false); assert.equal(current.externalPaid, false); assert.equal(current.externalReceived, false);
    console.log('PURCHASE_RECOVERY_EVIDENCE=' + JSON.stringify({ action, timing, independentPools: true, oldOptionId: option.id, freshOptionId: fresh.id, revision: fresh.revision, oldApprovalId: link.id, freshApprovalId: approval.id, preservedCommands: previousEvents.rows.length, persisted: true }));
  });
});

describe('supply durability on real PostgreSQL (requires office:db start)', () => {
  it('persists separate supplier and purchase reviews across independent pools without executing either', async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const { selection, link } = await prepareSelection(store, 'pg-supply-persist');
    await approve(store, link, 'pg-supply-persist-approved');
    const { option, link: purchase } = await preparePurchase(store, 'pg-purchase-persist');
    const before = await store.snapshot();
    assert.equal(projectSupplyWorkflow(before, 'demo-aurora', AT).sourcing!.assignments.length, 0);
    await disconnect(store);
    const restarted = await connect();
    assert.equal(canonical(await restarted.snapshot()), canonical(before));
    const persisted = projectSupplyWorkflow(await restarted.snapshot(), 'demo-aurora', AT);
    assert.equal(persisted.sourcing!.selections[0].reviewStatus, 'approved_demo');
    assert.equal(persisted.sourcing!.selections[0].assignedDemo, false);
    assert.equal(persisted.procurement!.options.find(row => row.id === option.id)!.reviewStatus, 'pending');
    assert.deepEqual((await restarted.snapshot()).office.approvals[link.id].supplyContext, link.supplyContext);
    assert.deepEqual((await restarted.snapshot()).office.approvals[purchase.id].supplyContext, purchase.supplyContext);
    await approve(restarted, purchase, 'pg-purchase-persist-approved');
    const after = projectSupplyWorkflow(await restarted.snapshot(), 'demo-aurora', AT);
    const approved = after.procurement!.options.find(row => row.id === option.id)!;
    assert.equal(approved.reviewStatus, 'approved_demo'); assert.equal(approved.externalOrdered, false); assert.equal(approved.externalPaid, false); assert.equal(approved.externalReceived, false);
    assert.equal(after.sourcing!.assignments.length, 0);
    await run(restarted, { step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, 'pg-supply-persist-assigned');
    const assigned = projectSupplyWorkflow(await restarted.snapshot(), 'demo-aurora', AT).sourcing!.assignments;
    assert.equal(assigned.length, 1); assert.equal(assigned[0].externalHired, false);
    const snapshot = projectOfficeSnapshot(await restarted.snapshot(), AT);
    assert.equal(snapshot.cases[0].supplier, 'pending'); assert.equal(snapshot.outboundEffects, 0); assert.equal(snapshot.mondayWrites, 0);
    assert(snapshot.cases[0].tasks.some(row => row.id === 'workflow-demo-aurora-paid-without-supplier' && row.status === 'blocked'));
    const count = await restarted.pool.query('SELECT count(*)::int AS count FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, 'pg-supply-persist-select']);
    assert.equal(count.rows[0].count, 1);
  });

  it('upgrades a legacy payload lacking supply while preserving old command digests and history records', async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const legacy = { idempotencyKey: 'pg-supply-legacy-chat', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'Registro ficticio anterior a proveedores.' };
    await executeOfficeCommand(store, legacy, () => AT);
    const old = await store.snapshot();
    delete old.office.supply;
    await store.pool.query('UPDATE office_demo.states SET payload=$2::jsonb WHERE id=$1', [stateId, JSON.stringify(old)]);
    const oldCommands = canonical(old.office.commands);
    const oldHistory = structuredClone(old.office.history);
    const oldEvents = await store.pool.query('SELECT command_key, digest FROM office_demo.command_events WHERE state_id=$1 ORDER BY command_key', [stateId]);
    await disconnect(store);
    const restarted = await connect();
    assert.equal(canonical((await restarted.snapshot()).office.commands), oldCommands);
    await run(restarted, { step: 'ingest_digest', fixtureId: getSupplyFixtures('demo-aurora', AT).digestFixtures[0].id }, 'pg-supply-legacy-first');
    const upgraded = await restarted.snapshot();
    assert.equal(upgraded.office.supply!.schemaVersion, 1);
    assert.deepEqual(upgraded.office.commands[legacy.idempotencyKey], old.office.commands[legacy.idempotencyKey]);
    for (const [id, record] of Object.entries(oldHistory)) assert.deepEqual(upgraded.office.history[id], record);
    const replay = await executeOfficeCommand(restarted, legacy, () => AT + 1);
    assert.equal(replay.replayed, true);
    const events = await restarted.pool.query('SELECT command_key, digest FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, legacy.idempotencyKey]);
    assert.deepEqual(events.rows, oldEvents.rows);
  });

  it('serializes duplicate digest ingestion from different keys and independent connections into one queue and four candidates', async t => {
    const { store, connect, stateId } = await database(t);
    const independent = await connect();
    const fixture = getSupplyFixtures('demo-aurora', AT).digestFixtures[0];
    await Promise.all(Array.from({ length: 6 }, (_, index) => run(index % 2 ? independent : store, { step: 'ingest_digest', fixtureId: fixture.id }, `pg-supply-ingest-race-${index}`)));
    const state = await store.snapshot();
    const sourcing = projectSupplyWorkflow(state, 'demo-aurora', AT).sourcing!;
    assert.equal(sourcing.digests.length, 1); assert.equal(sourcing.candidates.length, 4);
    assert.equal(sourcing.digests[0].announcedCount, 3); assert.equal(sourcing.digests[0].extractedCount, 5); assert.equal(sourcing.digests[0].uniqueCount, 4); assert.equal(sourcing.digests[0].duplicateCount, 1);
    assert.equal(Object.keys(state.office.supply!.cases['demo-aurora'].digests).length, 1);
    assert.equal(sourcing.queue?.status, 'queued'); assert.equal(sourcing.queue?.externalResolved, false);
    assert(sourcing.candidates.every(row => row.revision === 1 && row.availability.status === 'unknown' && !row.externalHired));
    assert.equal(state.office.supply!.cases['demo-aurora'].queue!.id, sourcing.queue!.id);
    const projected = projectOfficeSnapshot(state, AT).cases[0];
    assert.equal(projected.supplyWorkflow!.sourcing!.queue!.id, sourcing.queue!.id);
    const records = await independent.pool.query('SELECT count(*)::int AS count FROM office_demo.command_events WHERE state_id=$1 AND command_key LIKE $2', [stateId, 'pg-supply-ingest-race-%']);
    assert.equal(records.rows[0].count, 6);
  });

  it('allows one of two overlapping assignments for a global candidate and rolls the losing transaction back', async t => {
    const { store, connect } = await database(t);
    const independent = await connect();
    await store.transact(state => { state.office.cases['demo-harbor'].saleClosed = true; });
    const first = await prepareSelection(store, 'pg-supply-overlap-a', 'demo-aurora');
    const second = await prepareSelection(independent, 'pg-supply-overlap-b', 'demo-harbor');
    assert.equal(first.selection.candidateId, second.selection.candidateId);
    assert.deepEqual(first.selection.snapshot.event.window, second.selection.snapshot.event.window);
    await approve(store, first.link, 'pg-supply-overlap-approve-a');
    await approve(independent, second.link, 'pg-supply-overlap-approve-b');
    const results = await Promise.allSettled([
      run(store, { step: 'assign_demo', selectionId: first.selection.id, revision: first.selection.revision }, 'pg-supply-overlap-assign-a', 'demo-aurora'),
      run(independent, { step: 'assign_demo', selectionId: second.selection.id, revision: second.selection.revision }, 'pg-supply-overlap-assign-b', 'demo-harbor'),
    ]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    const failed = results.find(row => row.status === 'rejected') as PromiseRejectedResult;
    assert(failed.reason instanceof OfficeError); assert.equal(failed.reason.statusCode, 409);
    const state = await store.snapshot();
    const assignments = Object.values(state.office.supply!.assignments);
    assert.equal(assignments.length, 1); assert.equal(assignments[0].externalHired, false);
    const commandKeys = ['pg-supply-overlap-assign-a', 'pg-supply-overlap-assign-b'];
    assert.equal(commandKeys.filter(key => Object.hasOwn(state.office.commands, key)).length, 1);
    assert.equal(Object.values(state.office.history).filter(row => commandKeys.includes(row.commandKey ?? '')).length, 1);
    assert.equal(state.office.cases['demo-aurora'].supplier, 'pending'); assert.equal(state.office.cases['demo-harbor'].supplier, 'unknown');
  });

  it('checks current candidate facts across pools before committing the exact human decision', async t => {
    const { store, connect } = await database(t);
    const independent = await connect();
    const { selection, link } = await prepareSelection(store, 'pg-supply-stale');
    const candidate = projectSupplyWorkflow(await independent.snapshot(), 'demo-aurora', AT).sourcing!.candidates.find(row => row.id === selection.candidateId)!;
    await run(independent, { step: 'verify_availability', candidateId: candidate.id, revision: candidate.revision, status: 'unavailable' }, 'pg-supply-stale-change');
    const before = canonical(await store.snapshot());
    await assert.rejects(approve(store, link, 'pg-supply-stale-decision'), (failure: unknown) => failure instanceof OfficeError && failure.statusCode === 409);
    assert.equal(canonical(await independent.snapshot()), before);
    const sourcing = projectSupplyWorkflow(await store.snapshot(), 'demo-aurora', AT).sourcing!;
    assert.equal(sourcing.assignments.length, 0);
    assert.equal(sourcing.candidates.find(row => row.id === candidate.id)!.availability.status, 'unavailable');
  });

  it('persists explicit DEMO assignment once and returns current state for replays after a new pool', async t => {
    const { store, connect, disconnect, stateId } = await database(t);
    const { selection, link } = await prepareSelection(store, 'pg-supply-replay');
    await approve(store, link, 'pg-supply-replay-approved');
    const assignment = command({ step: 'assign_demo', selectionId: selection.id, revision: selection.revision }, 'pg-supply-replay-assigned');
    await executeOfficeCommand(store, assignment, () => AT);
    await disconnect(store);
    const restarted = await connect();
    const before = canonical(await restarted.snapshot());
    const replay = await executeOfficeCommand(restarted, assignment, () => AT + 1);
    assert.equal(replay.replayed, true); assert.equal(canonical(await restarted.snapshot()), before);
    assert.equal(projectSupplyWorkflow(await restarted.snapshot(), 'demo-aurora', AT).sourcing!.assignments.length, 1);
    const records = await restarted.pool.query('SELECT count(*)::int AS count FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, assignment.idempotencyKey]);
    assert.equal(records.rows[0].count, 1);
    assert.equal(replay.snapshot.outboundEffects, 0); assert.equal(replay.snapshot.mondayWrites, 0); assert.equal(replay.snapshot.cases[0].supplier, 'pending');
  });
});
