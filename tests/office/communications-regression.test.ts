import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCommunicationsWorkflow, CommunicationsError, normalizeContactEmail } from '../../src/office/backend/communications';
import type { CommunicationsScope, CommunicationsStore, CommunicationsStoredRecord, Observation, Coverage } from '../../src/office/backend/communications-contracts';

const AT = 1_791_806_400_000;
const scope: CommunicationsScope = { organizationId: 'fixture-org', actorId: 'fixture-owner', partition: 'external', dataMode: 'fixture' };
const complete: Coverage = { scope: 'correspondence', incoming: 'complete', outgoing: 'complete' };
const lead = (itemId = 'lead-1', email = 'customer@example.test', boardId = 'board-1'): Observation => ({ kind: 'lead', source: 'monday', sourceKey: `${boardId}:${itemId}`, providerVersion: 'lead-v1', observedAtMs: AT, data: { boardId, itemId, displayName: 'Fixture', email, phone: null, phoneCountry: null, eventDate: '2026-11-12', guestsText: null, eventTypeText: null, serviceStyleText: null, mappingVersion: 'fixture-v1' } });
const event = (eventId = 'event-1', leadItemId = 'lead-1'): Observation => ({ kind: 'event', source: 'event_reference', sourceKey: eventId, providerVersion: 'event-v1', observedAtMs: AT, data: { eventId, leadItemId, eventDate: '2026-11-12', evidenceRef: 'fixture:manual-event' } });
const account = (mailbox: 'felipe' | 'info' = 'felipe', accountId = 'account-1'): Observation => ({ kind: 'account', source: 'gmail', sourceKey: `${mailbox}:${accountId}`, providerVersion: 'identity-v1', observedAtMs: AT, data: { mailbox, accountId, email: `${mailbox}@example.test`, verified: true } });
const thread = (mailbox: 'felipe' | 'info' = 'felipe', accountId = 'account-1', threadId = 'thread-1', email = 'customer@example.test'): Observation => ({ kind: 'thread', source: 'gmail', sourceKey: `${mailbox}:${accountId}:${threadId}`, providerVersion: 'history-v1', observedAtMs: AT, data: { mailbox, accountId, threadId, messages: [{ id: 'message-1', from: [email], to: [`${mailbox}@example.test`], cc: ['friend@example.test'], subject: 'Fixture request', bodyText: 'Fixture content', attachments: [] }], coverage: complete } });
const voice = (email = 'customer@example.test'): Observation => ({ kind: 'voice', source: 'voice_notification', sourceKey: 'info:other-account:notice-1', providerVersion: 'notice-v1', observedAtMs: AT, data: { mailbox: 'info', accountId: 'other-account', contactEmail: email, notificationId: 'notice-1', incomingText: 'Fixture notification', coverage: { scope: 'incoming_notifications', incoming: 'partial', outgoing: 'unknown' } } });
const code = (expected: string) => (e: unknown) => e instanceof CommunicationsError && e.code === expected;
function setup() {
  let stored: CommunicationsStoredRecord | null = null; let rejectWrite = false;
  const store: CommunicationsStore = { async read() { return structuredClone(stored); }, async compareAndSet(expected, ledger) { if (rejectWrite || (stored?.revision ?? null) !== expected) return false; stored = { revision: (stored?.revision ?? 100) + 7, ledger: structuredClone(ledger) }; return true; } };
  const workflow = createCommunicationsWorkflow({ scope, store, clock: () => AT });
  return { store, workflow, stored: () => structuredClone(stored), replace: (v: CommunicationsStoredRecord) => { stored = structuredClone(v); }, failWrites: () => { rejectWrite = true; } };
}
type Workflow = ReturnType<typeof createCommunicationsWorkflow>;
async function observe(w: Workflow, o: Observation) { return w.recordObservation({ expectedRevision: (await w.view()).revision, observation: o }); }
async function seed(w: Workflow, observations = [lead(), event(), account(), thread()]) { for (const o of observations) await observe(w, o); }
async function bind(w: Workflow) { const v = await w.view(); return w.link({ expectedRevision: v.revision, id: 'association-1', ...v.candidates[0], explicit: true, evidenceRef: 'fixture:manual-review', ambiguityAcknowledged: v.candidates[0].review === 'ambiguous' }); }
async function draft(w: Workflow, extra: Record<string, unknown> = {}) { return w.saveDraft({ expectedRevision: (await w.view()).revision, id: 'draft-1', associationId: 'association-1', purpose: 'reply', to: ['customer@example.test'], cc: [], subject: 'Fixture exact subject', bodyText: 'Fixture exact body', attachments: [{ id: 'file-1', filename: 'fixture.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }], ...extra }); }
async function approve(w: Workflow, id = 'approval-1') { const v = await w.view(), d = v.drafts.at(-1)!; return w.approve({ expectedRevision: v.revision, id, draftId: d.id, draftRevision: d.revision, draftDigest: d.digest }); }
async function ready() { const h = setup(); await seed(h.workflow); await bind(h.workflow); await draft(h.workflow); await approve(h.workflow); return h; }

test('rejects invalid email local length/domain labels and keeps exact alias distinctions', () => {
  for (const value of [`${'a'.repeat(65)}@example.test`, 'a@x.-b.test', 'a@x-.b.test', '.a@example.test', 'a.@example.test', 'a..b@example.test', 'a@example.test\r\nBcc:x@example.test']) assert.throws(() => normalizeContactEmail(value), code('invalid_request'));
  assert.equal(normalizeContactEmail(' A.B+Tag@Example.Test '), 'a.b+tag@example.test');
});

test('replays only exact immutable snapshots and rejects corrupted semantic history without normalizing it', async () => {
  const original = await ready(), baseline = original.stored()!;
  const transformations = [
    (r: CommunicationsStoredRecord) => { const v = r.ledger.events[0].value; if ('digest' in v) v.digest = 'f'.repeat(64); },
    (r: CommunicationsStoredRecord) => { const v = r.ledger.events[0].value; if ('kind' in v && v.kind === 'lead') v.data.email = 'CUSTOMER@EXAMPLE.TEST'; },
    (r: CommunicationsStoredRecord) => { const v = r.ledger.events.at(-1)!.value; if ('approvedBy' in v) v.approvedBy = 'other-actor'; },
    (r: CommunicationsStoredRecord) => { const v = r.ledger.events.at(-1)!.value; if ('draftId' in v) v.draftId = 'missing-draft'; },
    (r: CommunicationsStoredRecord) => { r.ledger.scope.organizationId = 'other-org'; },
    (r: CommunicationsStoredRecord) => { const v = r.ledger.events[4].value; if ('leadSnapshotId' in v) v.leadSnapshotId = r.ledger.events[2].value.id; },
    (r: CommunicationsStoredRecord) => { r.ledger.events.push({ ...r.ledger.events.at(-1)!, revision: ++r.ledger.revision }); },
    (r: CommunicationsStoredRecord) => { [r.ledger.events[5], r.ledger.events[6]] = [r.ledger.events[6], r.ledger.events[5]]; r.ledger.events.forEach((v, i) => { v.revision = i + 1; }); },
  ];
  for (const alter of transformations) { const h = setup(), bad = structuredClone(baseline); alter(bad); h.replace(bad); await assert.rejects(h.workflow.view(), code('invalid_state')); await assert.rejects(h.workflow.recordObservation({ expectedRevision: bad.ledger.revision, observation: lead() }), code('invalid_state')); assert.deepEqual(h.stored(), bad); }
});

test('every exact content/routing/attachment field changes approval and remains stale after reverting', async () => {
  const variants = [{ to: ['customer@example.test', 'friend@example.test'] }, { cc: ['friend@example.test'] }, { bcc: ['friend@example.test'] }, { subject: 'Changed subject' }, { bodyText: 'Changed body' }, { bodyHtml: '<p>Exact review HTML</p>' }, { purpose: 'follow_up' }, ...['id', 'filename', 'mimeType', 'sha256'].map(field => ({ attachments: [{ id: 'file-1', filename: 'fixture.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64), [field]: field === 'sha256' ? 'b'.repeat(64) : field === 'mimeType' ? 'text/plain' : 'changed-value' }] }))];
  for (const variant of variants) { const { workflow, store } = await ready(); await draft(workflow, variant); let v = await workflow.view(); assert.equal(v.approvals[0].current, false); assert.equal(v.outbox[0].status, 'stale'); await draft(workflow); v = await createCommunicationsWorkflow({ scope, store }).view(); assert.equal(v.approvals[0].current, false); }
  const h = await ready(); const changedPolicy = createCommunicationsWorkflow({ scope, store: h.store, policyVersion: 'policy-v2' }); assert.equal((await changedPolicy.view()).approvals[0].current, false);
});

test('new relevant correspondence never inherits an old ambiguity acknowledgment', async () => {
  const h = setup(); await seed(h.workflow, [lead(), event(), event('event-2'), account(), thread()]); await bind(h.workflow); await draft(h.workflow, { purpose: 'follow_up' }); await approve(h.workflow);
  assert.equal((await h.workflow.view()).approvals[0].current, true);
  await observe(h.workflow, thread('felipe', 'account-1', 'new-thread'));
  const v = await h.workflow.view(); assert.equal(v.candidates.length, 4); assert.equal(v.associationStates[0].current, false); assert.equal(v.approvals[0].current, false); await assert.rejects(approve(h.workflow, 'another'), code('source_changed'));
});

test('Voice on another account blocks the same contact, while unrelated Voice leaves review current', async () => {
  const h = await ready(); await observe(h.workflow, voice('unrelated@example.test')); assert.equal((await h.workflow.view()).approvals[0].current, true);
  const relevant = voice(); relevant.sourceKey = 'info:other-account:notice-2'; if (relevant.kind === 'voice') relevant.data.notificationId = 'notice-2'; await observe(h.workflow, relevant); assert.equal((await h.workflow.view()).approvals[0].current, false);
  await assert.rejects(draft(h.workflow, { purpose: 'follow_up' }), code('coverage_incomplete'));
});

test('canonical source tuples avoid delimiter collisions and retain account/mailbox identities', async () => {
  const h = setup(); await seed(h.workflow, [lead(), event(), account('felipe', 'a:b'), account('felipe', 'a'), thread('felipe', 'a:b', 'c'), thread('felipe', 'a', 'b:c')]);
  const v = await h.workflow.view(); assert.equal(v.candidates.length, 2); assert.notEqual(v.candidates[0].threadSnapshotId, v.candidates[1].threadSnapshotId); assert.equal(v.snapshots.filter(s => s.kind === 'thread').length, 2);
  await observe(h.workflow, account('info', 'a')); await observe(h.workflow, thread('info', 'a', 'b:c')); assert.equal((await h.workflow.view()).candidates.length, 3);
});

test('unqualified event references cannot select a lead ID shared across boards', async () => {
  const h = setup(); await seed(h.workflow); await observe(h.workflow, lead('lead-1', 'different@example.test', 'another-board')); assert.equal((await h.workflow.view()).candidates.length, 0);
});

test('source version replay is idempotent, never rolls the current version back, and rejects stale no-op revisions', async () => {
  const h = setup(); await observe(h.workflow, lead()); await observe(h.workflow, { ...lead(), providerVersion: 'lead-v2' }); const before = h.stored();
  await observe(h.workflow, { ...lead(), observedAtMs: AT + 50 }); assert.deepEqual(h.stored(), before);
  await assert.rejects(h.workflow.recordObservation({ expectedRevision: 0, observation: lead() }), code('revision_conflict')); assert.deepEqual(h.stored(), before);
  const changed = lead(); if (changed.kind === 'lead') changed.data.displayName = 'Conflicting content'; await assert.rejects(observe(h.workflow, changed), code('source_version_conflict'));
});

test('one durable outbox entry per exact approved draft, including repeated approval IDs and competing writers', async () => {
  const h = await ready(); const before = h.stored(); await approve(h.workflow); await approve(h.workflow, 'duplicate-key'); assert.deepEqual(h.stored(), before); assert.equal((await h.workflow.view()).outbox.length, 1);
  await draft(h.workflow, { bodyText: 'Second approved revision' }); await assert.rejects(approve(h.workflow), code('idempotency_conflict'));
  const v = await h.workflow.view(), d = v.drafts.at(-1)!; const command = { expectedRevision: v.revision, draftId: d.id, draftRevision: d.revision, draftDigest: d.digest };
  const other = createCommunicationsWorkflow({ scope, store: h.store, clock: () => AT });
  const outcomes = await Promise.allSettled([h.workflow.approve({ ...command, id: 'approval-2' }), other.approve({ ...command, id: 'approval-3' })]); assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const result = await h.workflow.view(); assert.equal(result.approvals.length, 2); assert.equal(result.outbox.filter(o => o.status === 'approved_unsent').length, 1); assert(result.outbox.every(o => o.dispatchEnabled === false)); assert.equal(result.outboundEffects, 0);
});

test('lost CAS does not persist approval and physical revision is independent of logical revision', async () => {
  const h = setup(); await seed(h.workflow); await bind(h.workflow); await draft(h.workflow); assert(h.stored()!.revision > 100); const before = h.stored(); h.failWrites(); await assert.rejects(approve(h.workflow), code('revision_conflict')); assert.deepEqual(h.stored(), before);
});

test('unsafe inputs are rejected without evaluating getters/serializers and outputs are detached', async () => {
  const h = setup(); let executed = 0; const nested = lead(); Object.defineProperty(nested.data, 'email', { enumerable: true, get() { executed++; return 'customer@example.test'; } });
  const serializer = Object.assign(lead(), { toJSON() { executed++; return {}; } }); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const observation of [nested, serializer, cycle, new Date(), { ...lead(), extra: 'marker' }]) await assert.rejects(h.workflow.recordObservation({ expectedRevision: 0, observation }), code('invalid_request'));
  assert.equal(executed, 0); assert.equal(h.stored(), null); await seed(h.workflow); const view = await h.workflow.view(); view.snapshots[0].id = 'mutated'; assert.notEqual((await h.workflow.view()).snapshots[0].id, 'mutated');
});

test('client-supplied approval authority and unbound/duplicate/header-injected recipients are rejected', async () => {
  const h = await ready(); const v = await h.workflow.view(), d = v.drafts.at(-1)!;
  for (const field of ['approvedBy', 'approvedAtMs', 'status', 'send', 'policyVersion']) await assert.rejects(h.workflow.approve({ expectedRevision: v.revision, id: 'forged', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest, [field]: 'caller' }), code('invalid_request'));
  for (const extra of [{ to: ['other@example.test'] }, { to: ['customer@example.test', 'customer@example.test'] }, { cc: ['customer@example.test'] }, { subject: 'Hi\r\nBcc: other@example.test' }, { attachments: [{ id: 'same', filename: 'a', mimeType: 'text/plain', sha256: null }, { id: 'same', filename: 'b', mimeType: 'text/plain', sha256: null }] }]) await assert.rejects(draft(h.workflow, extra));
});

test('zero provider/network effects and no sender, scheduler or draft-provider API exist', async () => {
  const old = globalThis.fetch; let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error('Forbidden synthetic network'); }) as typeof fetch;
  try { const h = await ready(); await createCommunicationsWorkflow({ scope, store: h.store }).view(); assert.equal(calls, 0); assert.deepEqual(Object.keys(h.workflow).sort(), ['approve', 'link', 'recordObservation', 'saveDraft', 'view']); } finally { globalThis.fetch = old; }
});

test('candidate construction is indexed and bounded before a mutation commits', async () => {
  const h = setup(); await seed(h.workflow, [lead(), account(), ...Array.from({ length: 15 }, (_, i) => event(`event-${i}`)), ...Array.from({ length: 15 }, (_, i) => thread('felipe', 'account-1', `thread-${i}`))]);
  const started = performance.now(), v = await h.workflow.view(); const elapsed = performance.now() - started; assert.equal(v.candidates.length, 225); assert(elapsed < 500, `225-candidate view took ${elapsed}ms`);
  const big = setup(); await seed(big.workflow, [lead(), account(), ...Array.from({ length: 31 }, (_, i) => event(`event-${i}`)), ...Array.from({ length: 32 }, (_, i) => thread('felipe', 'account-1', `thread-${i}`))]);
  const before = big.stored(); await assert.rejects(observe(big.workflow, thread('felipe', 'account-1', 'over-cap')), code('capacity_exceeded')); assert.deepEqual(big.stored(), before); assert.equal((await big.workflow.view()).candidates.length, 992);
});

test('a maximum-size ledger remains readable through its physical wrapper', async () => {
  const o = thread(); assert(o.kind === 'thread'); o.data.messages = Array.from({ length: 4 }, (_, i) => ({ ...o.data.messages[0], id: `m-${i}`, bodyText: 'x'.repeat(100000) }));
  const first = setup(); await observe(first.workflow, o); let remaining = 512 * 1024 - Buffer.byteLength(JSON.stringify(first.stored()!.ledger));
  for (const m of o.data.messages) { const added = Math.min(131072 - m.bodyText.length, remaining); m.bodyText += 'x'.repeat(added); remaining -= added; } assert.equal(remaining, 0);
  const full = setup(); await observe(full.workflow, o); assert.equal(Buffer.byteLength(JSON.stringify(full.stored()!.ledger)), 512 * 1024); assert.equal((await full.workflow.view()).revision, 1);
});

test('stale review never resurrects when later sources become irrelevant, including after restart', async () => {
  const h = await ready(); await observe(h.workflow, thread('felipe', 'account-1', 'later-thread')); assert.equal((await h.workflow.view()).approvals[0].current, false);
  await observe(h.workflow, { ...thread('felipe', 'account-1', 'later-thread', 'unrelated@example.test'), providerVersion: 'history-v2' });
  const restarted = createCommunicationsWorkflow({ scope, store: h.store }); assert.equal((await restarted.view()).approvals[0].current, false);
  const voiceCase = await ready(); await observe(voiceCase.workflow, voice()); assert.equal((await voiceCase.workflow.view()).approvals[0].current, false);
  await observe(voiceCase.workflow, { ...voice('unrelated@example.test'), providerVersion: 'notice-v2' }); assert.equal((await createCommunicationsWorkflow({ scope, store: voiceCase.store }).view()).approvals[0].current, false);
  await assert.rejects(draft(voiceCase.workflow, { purpose: 'follow_up' }), code('coverage_incomplete'));
});
