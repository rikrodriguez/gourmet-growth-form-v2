import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCommunicationsWorkflow, CommunicationsError, normalizeContactEmail } from '../../src/office/backend/communications';
import type { CommunicationsScope, CommunicationsStore, CommunicationsStoredRecord, Observation, Coverage } from '../../src/office/backend/communications-contracts';

const AT = 1_791_806_400_000;
const scope: CommunicationsScope = { organizationId: 'synthetic-org', actorId: 'synthetic-actor', partition: 'external', dataMode: 'fixture' };
const complete: Coverage = { scope: 'correspondence', incoming: 'complete', outgoing: 'complete' };
const lead = (itemId = '100001', email = 'customer@example.test', name = 'Synthetic Lead'): Observation => ({ kind: 'lead', source: 'monday', sourceKey: `18403945258:${itemId}`, providerVersion: 'lead-v1', observedAtMs: AT, data: { boardId: '18403945258', itemId, displayName: name, email, phone: null, phoneCountry: null, eventDate: '2026-11-12', guestsText: '12 guests', eventTypeText: 'Private dinner', serviceStyleText: 'Family style', mappingVersion: 'synthetic-v1' } });
const event = (eventId = 'event-1', leadItemId = '100001'): Observation => ({ kind: 'event', source: 'event_reference', sourceKey: eventId, providerVersion: 'event-v1', observedAtMs: AT, data: { eventId, leadItemId, eventDate: '2026-11-12', evidenceRef: 'synthetic:event-reviewed' } });
const account = (mailbox: 'felipe' | 'info' = 'felipe', accountId = 'synthetic-account'): Observation => ({ kind: 'account', source: 'gmail', sourceKey: `${mailbox}:${accountId}`, providerVersion: 'identity-v1', observedAtMs: AT, data: { mailbox, accountId, email: `${mailbox}@example.test`, verified: true } });
const thread = (mailbox: 'felipe' | 'info' = 'felipe', accountId = 'synthetic-account', threadId = 'synthetic-thread', email = 'customer@example.test', coverage = complete): Observation => ({ kind: 'thread', source: 'gmail', sourceKey: `${mailbox}:${accountId}:${threadId}`, providerVersion: 'history-1', observedAtMs: AT, data: { mailbox, accountId, threadId, messages: [{ id: 'synthetic-message', from: [email], to: [`${mailbox}@example.test`], cc: [], subject: 'Synthetic request', bodyText: 'Synthetic body', attachments: [] }], coverage } });
const voice = (): Observation => ({ kind: 'voice', source: 'voice_notification', sourceKey: 'felipe:synthetic-account:voice-1', providerVersion: 'notification-1', observedAtMs: AT, data: { mailbox: 'felipe', accountId: 'synthetic-account', contactEmail: 'customer@example.test', notificationId: 'voice-1', incomingText: 'Synthetic inbound notification', coverage: { scope: 'incoming_notifications', incoming: 'partial', outgoing: 'unknown' } } });
function setup() {
  let row: CommunicationsStoredRecord | null = null;
  const store: CommunicationsStore = {
    async read() { return structuredClone(row); },
    async compareAndSet(expected, ledger) { if ((row?.revision ?? null) !== expected) return false; row = { revision: (row?.revision ?? 0) + 1, ledger: structuredClone(ledger) }; return true; },
  };
  return { store, workflow: createCommunicationsWorkflow({ scope, store, clock: () => AT }) };
}
async function seed(workflow: ReturnType<typeof createCommunicationsWorkflow>, observations: Observation[] = [lead(), event(), account(), thread()]) { for (const observation of observations) await workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation }); return workflow.view(); }
async function bind(workflow: ReturnType<typeof createCommunicationsWorkflow>, extra = {}) { const view = await workflow.view(); const candidate = view.candidates[0]; assert(candidate); return workflow.link({ expectedRevision: view.revision, id: 'association-1', ...candidate, explicit: true, evidenceRef: 'synthetic:manual-review', ambiguityAcknowledged: false, ...extra }); }
async function draft(workflow: ReturnType<typeof createCommunicationsWorkflow>, extra = {}) { return workflow.saveDraft({ expectedRevision: (await workflow.view()).revision, id: 'draft-1', associationId: 'association-1', purpose: 'reply', to: ['customer@example.test'], cc: [], subject: 'Exact synthetic subject', bodyText: 'Exact synthetic body', attachments: [], ...extra }); }
async function approve(workflow: ReturnType<typeof createCommunicationsWorkflow>) { const view = await workflow.view(); const d = view.drafts.at(-1)!; return workflow.approve({ expectedRevision: view.revision, id: 'approval-1', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest }); }
const code = (expected: string) => (error: unknown) => error instanceof CommunicationsError && error.code === expected;

describe('private Monday/Gmail correlation and exact unsent approval', () => {
  it('normalizes exact addresses without stripping dots/plus, and never uses names for identity', async () => {
    assert.equal(normalizeContactEmail(' Customer.Tag+Dinner@Example.Test '), 'customer.tag+dinner@example.test');
    assert.notEqual(normalizeContactEmail('a.b@example.test'), normalizeContactEmail('ab@example.test'));
    assert.notEqual(normalizeContactEmail('a+tag@example.test'), normalizeContactEmail('a@example.test'));
    const { workflow } = setup();
    await seed(workflow, [lead('100001', 'other@example.test', 'Same Name'), event(), account(), thread()]);
    assert.equal((await workflow.view()).candidates.length, 0);
    await workflow.recordObservation({ expectedRevision: 4, observation: { ...lead('100001', 'CUSTOMER@example.test', 'Different Name'), providerVersion: 'lead-v2' } });
    const view = await workflow.view(); assert.equal(view.candidates.length, 1); assert.equal(view.candidates[0].review, 'required'); assert.equal(view.associations.length, 0);
  });

  it('requires explicit association and reviews ambiguity across leads/events/mailboxes', async () => {
    const { workflow } = setup();
    await seed(workflow, [lead(), lead('100002'), event(), event('event-2', '100002'), event('event-3'), account(), account('info', 'info-account'), thread(), thread('info', 'info-account')]);
    const view = await workflow.view(); assert.equal(view.candidates.length, 6); assert(view.candidates.every(c => c.review === 'ambiguous'));
    await assert.rejects(bind(workflow), code('ambiguous'));
    await assert.rejects(bind(workflow, { explicit: false, ambiguityAcknowledged: true }), code('explicit_review_required'));
    await bind(workflow, { ambiguityAcknowledged: true });
    assert.equal((await workflow.view()).associations.length, 1);
  });

  it('pins the event to its lead and the thread to the selected verified account', async () => {
    const { workflow } = setup(); await seed(workflow, [lead(), event(), account(), account('info', 'info-account'), thread(), thread('info', 'info-account')]);
    const view = await workflow.view();
    const infoAccount = view.snapshots.find(s => s.kind === 'account' && s.data.mailbox === 'info')!;
    await assert.rejects(bind(workflow, { accountSnapshotId: infoAccount.id, ambiguityAcknowledged: true }), code('association_mismatch'));
    await bind(workflow, { ambiguityAcknowledged: true });
    const a = (await workflow.view()).associations[0]; assert.equal(a.threadSnapshotId, view.candidates[0].threadSnapshotId);
    assert.notEqual(view.candidates[0].threadSnapshotId, view.candidates[1].threadSnapshotId);
  });

  it('persists exact approval across factory restart; a draft or source change makes it stale and retains history', async () => {
    const { workflow, store } = setup(); await seed(workflow); await bind(workflow); await draft(workflow); await approve(workflow);
    const restarted = createCommunicationsWorkflow({ scope, store, clock: () => AT + 1 });
    let view = await restarted.view(); assert.equal(view.approvals[0].current, true); assert.equal(view.approvals[0].approval.status, 'approved_unsent'); assert.equal(view.approvals[0].approval.approvedBy, scope.actorId);
    await draft(restarted, { bodyText: 'Changed exact body' }); view = await restarted.view(); assert.equal(view.approvals[0].current, false); assert.equal(view.drafts.length, 2);
    const d = view.drafts.at(-1)!;
    await restarted.approve({ expectedRevision: view.revision, id: 'approval-2', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest });
    view = await restarted.view(); assert.equal(view.approvals[1].current, true);
    await restarted.recordObservation({ expectedRevision: view.revision, observation: { ...thread(), providerVersion: 'history-2' } });
    view = await restarted.view(); assert.equal(view.approvals[1].current, false); assert.equal(view.associationStates[0].current, false);
    assert.equal(view.approvals.length, 2); assert.equal(view.drafts.length, 2);
  });

  it('rejects stale exact draft approval, unknown attachment hashes and changed association authority', async () => {
    const { workflow } = setup(); await seed(workflow); await bind(workflow);
    await draft(workflow, { attachments: [{ id: 'a-1', filename: 'synthetic.pdf', mimeType: 'application/pdf', sha256: null }] });
    await assert.rejects(approve(workflow), code('attachment_unverified'));
    await draft(workflow, { attachments: [{ id: 'a-1', filename: 'synthetic.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }] });
    const view = await workflow.view(); const d = view.drafts.at(-1)!;
    await assert.rejects(workflow.approve({ expectedRevision: view.revision, id: 'a-bad', draftId: d.id, draftRevision: d.revision - 1, draftDigest: d.digest }), code('draft_changed'));
    await assert.rejects(workflow.approve({ expectedRevision: view.revision, id: 'a-bad', draftId: d.id, draftRevision: d.revision, draftDigest: 'b'.repeat(64) }), code('draft_changed'));
    await approve(workflow);
    await bind(workflow, { evidenceRef: 'synthetic:second-review' });
    assert.equal((await workflow.view()).approvals[0].current, false);
  });

  it('blocks follow-ups for a selected thread, partial outgoing history, or incoming-only Voice evidence', async () => {
    for (const coverage of [{ ...complete, scope: 'selected_thread' }, { ...complete, outgoing: 'unknown' }, { ...complete, incoming: 'partial' }] as Coverage[]) {
      const { workflow } = setup(); await seed(workflow, [lead(), event(), account(), thread('felipe', 'synthetic-account', 'synthetic-thread', 'customer@example.test', coverage)]); await bind(workflow);
      await assert.rejects(draft(workflow, { purpose: 'follow_up' }), code('coverage_incomplete'));
      await draft(workflow); assert.equal((await workflow.view()).drafts.length, 1);
    }
    const { workflow } = setup(); await seed(workflow); await bind(workflow); await draft(workflow, { purpose: 'follow_up' }); await approve(workflow);
    await workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation: voice() });
    assert.equal((await workflow.view()).approvals[0].current, false);
    await assert.rejects(draft(workflow, { purpose: 'follow_up' }), code('coverage_incomplete'));
    const falseCoverage = voice(); if (falseCoverage.kind === 'voice') (falseCoverage.data.coverage as Coverage).outgoing = 'complete';
    await assert.rejects(workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation: falseCoverage }), code('invalid_request'));
  });

  it('uses CAS for competing writers and deduplicates unchanged observations without weakening version checks', async () => {
    const { workflow, store } = setup(); const other = createCommunicationsWorkflow({ scope, store, clock: () => AT });
    const results = await Promise.allSettled([workflow.recordObservation({ expectedRevision: 0, observation: lead() }), other.recordObservation({ expectedRevision: 0, observation: event() })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await workflow.view()).revision, 1);
    const existing = (await workflow.view()).snapshots[0];
    const { id: _id, revision: _revision, digest: _digest, ...observation } = existing;
    await workflow.recordObservation({ expectedRevision: 1, observation: { ...observation, observedAtMs: AT + 20 } }); assert.equal((await workflow.view()).revision, 1);
    if (observation.kind === 'lead') await assert.rejects(workflow.recordObservation({ expectedRevision: 1, observation: { ...observation, data: { ...observation.data, displayName: 'Changed under same source version' } } }), code('source_version_conflict'));
  });

  it('rejects DEMO, foreign scope, unsafe input and non-current source links without leaking private content', async () => {
    const { workflow, store } = setup();
    assert.throws(() => createCommunicationsWorkflow({ scope: { ...scope, partition: 'demo' } as unknown as CommunicationsScope, store }), code('invalid_scope'));
    await seed(workflow); await bind(workflow); await draft(workflow);
    const unsafe = { expectedRevision: 6, observation: lead() }; Object.defineProperty(unsafe, 'secret', { get() { throw new Error('Synthetic private marker'); }, enumerable: true });
    await assert.rejects(workflow.recordObservation(unsafe), error => error instanceof CommunicationsError && !String(error).includes('Synthetic private marker'));
    const before = await workflow.view(); await workflow.recordObservation({ expectedRevision: before.revision, observation: { ...lead(), providerVersion: 'lead-v2' } });
    await assert.rejects(bind(workflow, { leadSnapshotId: before.candidates[0].leadSnapshotId }), code('source_changed'));
    await assert.rejects(approve(workflow), code('source_changed'));
  });
});
