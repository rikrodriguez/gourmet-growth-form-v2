import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { SupplyOperation } from '../../src/office/supply-contracts';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { getSupplyFixtures } from '../../src/office/backend/supply-fixtures';
import { projectSupplyWorkflow } from '../../src/office/backend/supply-workflow';
import { OfficeError, canonical, projectOfficeSnapshot } from '../../src/office/backend/state';
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

async function prepareSelection(store: OfficeStore, prefix: string, caseId: DemoCaseId = 'demo-aurora') {
  const fixtures = getSupplyFixtures(caseId, AT);
  await run(store, { step: 'ingest_digest', fixtureId: fixtures.digestFixtures[0].id }, `${prefix}-ingest`, caseId);
  const candidateId = fixtures.digestFixtures[0].entries[0].candidateId;
  const current = async () => projectSupplyWorkflow(await store.snapshot(), caseId, AT).sourcing!.candidates.find(row => row.id === candidateId)!;
  await run(store, { step: 'evaluate_candidate', candidateId, revision: (await current()).revision, verdict: 'eligible' }, `${prefix}-evaluate`, caseId);
  await run(store, { step: 'verify_availability', candidateId, revision: (await current()).revision, status: 'available' }, `${prefix}-available`, caseId);
  const terms = fixtures.termsFixtures.find(row => row.candidateId === candidateId && row.totalCents !== null)!;
  await run(store, { step: 'approve_terms', candidateId, revision: (await current()).revision, termsFixtureId: terms.id }, `${prefix}-terms`, caseId);
  await run(store, { step: 'select_candidate', candidateId, revision: (await current()).revision }, `${prefix}-select`, caseId);
  const state = await store.snapshot();
  const selection = projectSupplyWorkflow(state, caseId, AT).sourcing!.selections[0];
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
