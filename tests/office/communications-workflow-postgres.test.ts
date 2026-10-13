import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCommunicationsWorkflow, CommunicationsError } from '../../src/office/backend/communications';
import { createCommunicationsStore, communicationsStorageKey } from '../../src/office/backend/communications-store';
import { MondayVault, PostgresMondayStore, type MondayStore } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import type { CommunicationsScope, Observation } from '../../src/office/backend/communications-contracts';

const AT = 1791806400000;
const observations: Observation[] = [
  { kind: 'lead', source: 'monday', sourceKey: 'fixture-board:fixture-lead', providerVersion: 'fixture-v1', observedAtMs: AT, data: { boardId: 'fixture-board', itemId: 'fixture-lead', displayName: 'Synthetic PG contact', email: 'customer@invalid.test', phone: null, phoneCountry: null, eventDate: null, guestsText: null, eventTypeText: null, serviceStyleText: null, mappingVersion: 'fixture-v1' } },
  { kind: 'event', source: 'event_reference', sourceKey: 'fixture-event', providerVersion: 'fixture-v1', observedAtMs: AT, data: { eventId: 'fixture-event', leadItemId: 'fixture-lead', eventDate: null, evidenceRef: 'fixture:explicit-event' } },
  { kind: 'account', source: 'gmail', sourceKey: 'felipe:fixture-account', providerVersion: 'fixture-v1', observedAtMs: AT, data: { mailbox: 'felipe', accountId: 'fixture-account', email: 'felipe@invalid.test', verified: true } },
  { kind: 'thread', source: 'gmail', sourceKey: 'felipe:fixture-account:fixture-thread', providerVersion: 'history-v1', observedAtMs: AT, data: { mailbox: 'felipe', accountId: 'fixture-account', threadId: 'fixture-thread', messages: [{ id: 'fixture-message', from: ['customer@invalid.test'], to: ['felipe@invalid.test'], cc: [], subject: 'Fixture', bodyText: 'Synthetic private conversation', attachments: [] }], coverage: { scope: 'correspondence', incoming: 'complete', outgoing: 'complete' } } },
];
const newScope = (): CommunicationsScope => ({ organizationId: `fixture-${randomUUID()}`, actorId: 'fixture-owner', partition: 'external', dataMode: 'fixture' });
function create(scope: CommunicationsScope, physical: MondayStore) { return createCommunicationsWorkflow({ scope, store: createCommunicationsStore({ scope, store: physical, vault: new MondayVault(Buffer.alloc(32, 81)) }), clock: () => AT }); }
async function connect() { const office = new PostgresOfficeStore(); await office.initialize(AT); return { office, physical: new PostgresMondayStore(office.pool) }; }
async function prepare(workflow: ReturnType<typeof create>) {
  for (const observation of observations) await workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation });
  let v = await workflow.view(); await workflow.link({ expectedRevision: v.revision, id: 'fixture-association', ...v.candidates[0], explicit: true, evidenceRef: 'fixture:review', ambiguityAcknowledged: false });
  v = await workflow.view(); await workflow.saveDraft({ expectedRevision: v.revision, id: 'fixture-draft', associationId: 'fixture-association', purpose: 'reply', to: ['customer@invalid.test'], cc: [], subject: 'Exact fixture subject', bodyText: 'Exact private fixture response', attachments: [] });
  return workflow.view();
}
function command(view: Awaited<ReturnType<ReturnType<typeof create>['view']>>, id = 'fixture-approval') { const d = view.drafts.at(-1)!; return { expectedRevision: view.revision, id, draftId: d.id, draftRevision: d.revision, draftDigest: d.digest }; }

test('real PostgreSQL: full communications workflow survives factory/store/pool restart with encrypted exact approvals', async () => {
  const scope = newScope(), first = await connect(); let second: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const workflow = create(scope, first.physical); const pending = await prepare(workflow); await workflow.approve(command(pending)); const expected = await workflow.view();
    const raw = await first.physical.read(communicationsStorageKey(scope)); assert(raw); const sealed = JSON.stringify(raw.value);
    for (const privateValue of ['Synthetic PG contact', 'customer@invalid.test', 'Exact private fixture response']) assert(!sealed.includes(privateValue));
    await first.office.close(); second = await connect(); const restarted = create(scope, second.physical); assert.deepEqual(await restarted.view(), expected);
    const view = await restarted.view(); await restarted.approve({ ...command(view), id: 'different-retry-id' }); assert.equal((await restarted.view()).outbox.length, 1);
    const source = structuredClone(observations[3]); source.providerVersion = 'history-v2'; await restarted.recordObservation({ expectedRevision: (await restarted.view()).revision, observation: source });
    assert.equal((await create(scope, second.physical).view()).approvals[0].current, false);
  } finally { if (second) await second.office.close(); else await first.office.close(); }
});

test('real PostgreSQL: competing approval writers commit one exact decision/outbox row', async () => {
  const scope = newScope(), a = await connect(), b = await connect();
  try {
    const left = create(scope, a.physical), right = create(scope, b.physical); const pending = await prepare(left);
    const results = await Promise.allSettled([left.approve(command(pending, 'approve-a')), right.approve(command(pending, 'approve-b'))]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const view = await right.view(); assert.equal(view.approvals.length, 1); assert.equal(view.outbox.length, 1); assert.equal(view.outbox[0].status, 'approved_unsent'); assert.equal(view.outbox[0].dispatchEnabled, false);
  } finally { await Promise.all([a.office.close(), b.office.close()]); }
});

test('real PostgreSQL: a failed encrypted ledger write leaves the decision/history/revision unchanged', async () => {
  const scope = newScope(), connection = await connect();
  try {
    const workflow = create(scope, connection.physical); const pending = await prepare(workflow); const before = await connection.physical.read(communicationsStorageKey(scope));
    const unavailable: MondayStore = { read: key => connection.physical.read(key), compareAndSet: async () => { throw new Error('synthetic-private-storage-marker'); } };
    await assert.rejects(create(scope, unavailable).approve(command(pending)), e => e instanceof CommunicationsError && e.code === 'store_unavailable' && !String(e).includes('synthetic-private-storage-marker'));
    assert.deepEqual(await connection.physical.read(communicationsStorageKey(scope)), before); const view = await workflow.view(); assert.equal(view.revision, pending.revision); assert.equal(view.approvals.length, 0); assert.equal(view.outbox.length, 0);
  } finally { await connection.office.close(); }
});
