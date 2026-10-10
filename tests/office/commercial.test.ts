import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { CommercialThread, OfficeCommand } from '../../src/office/contracts';
import { createCommercialThreads } from '../../src/office/backend/commercial-fixtures';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createOfficeApi } from '../../src/office/backend/http';
import { computeApprovalDigest, draftCore } from '../../src/office/backend/pilot-core';
import { OfficeError, assertOfficeState, canonical, parseOfficeCommand, projectOfficeSnapshot, sha256 } from '../../src/office/backend/state';
import type { ApprovalLink, DemoCaseId, OfficeState, OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-10T21:00:00.000Z');
class SyntheticTransactionStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  async snapshot() { return structuredClone(this.state); }
  async transact<T>(fn: (state: OfficeState) => T | Promise<T>) {
    const copy = structuredClone(this.state);
    const result = await fn(copy);
    this.state = copy;
    return result;
  }
}
const error = (code: string) => (value: unknown) => value instanceof OfficeError && value.code === code;
function draftCommand(thread: CommercialThread, key = 'commercial-thread-draft'): OfficeCommand {
  return { idempotencyKey: key, caseId: thread.caseId, functionId: 'sales', action: 'draft', commercialThreadId: thread.id, commercialThreadRevision: thread.revision, commercialThreadDigest: thread.digest };
}
function selectedThread(store: SyntheticTransactionStore, caseId: DemoCaseId = 'demo-aurora') {
  return projectOfficeSnapshot(store.state, AT).cases.find(row => row.id === caseId)!.commercialThreads![0];
}
function contextualApproval(store: SyntheticTransactionStore, threadId: string): ApprovalLink {
  return Object.values(store.state.office.approvals).find(row => row.commercialContext?.id === threadId)!;
}
function decision(link: ApprovalLink, action: OfficeCommand['action'], key: string, text?: string): OfficeCommand {
  return { idempotencyKey: key, caseId: link.caseId, functionId: link.functionId, action, approvalId: link.id, revision: link.revision, digest: link.digest, ...(text ? { text } : {}) };
}
async function apiFixture(t: TestContext) {
  const store = new SyntheticTransactionStore();
  const api = createOfficeApi(store, { clock: () => AT });
  t.after(() => api.close());
  await api.ready();
  const headers = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
  async function login(payload: object) {
    const response = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload });
    assert.equal(response.statusCode, 200);
    return { ...headers, cookie: String(response.headers['set-cookie']).split(';')[0] };
  }
  return { api, store, headers, login };
}

describe('server-owned synthetic commercial context', () => {
  it('projects two stable threads per case with synthetic fixture evidence and missing external sources', () => {
    const store = new SyntheticTransactionStore();
    const before = canonical(store.state);
    const first = projectOfficeSnapshot(store.state, AT);
    const later = projectOfficeSnapshot(store.state, AT + 3600000);
    for (const row of first.cases) {
      const threads = row.commercialThreads!;
      assert.equal(threads.length, 2);
      assert.deepEqual(threads, later.cases.find(other => other.id === row.id)!.commercialThreads);
      for (const thread of threads) {
        const { digest, ...content } = thread;
        assert.equal(digest, sha256(content));
        assert.equal(thread.schemaVersion, 1); assert.equal(thread.caseId, row.id); assert.equal(thread.revision, 1);
        assert.match(thread.recipient, /@invalid\.test$/); assert.equal(thread.evidence.source, 'fixture:office-demo'); assert.equal(thread.evidence.simulated, true);
        assert.deepEqual(thread.references.map(ref => [ref.source, ref.status, ref.evidence !== null]), [['fixture', 'simulated', true], ['gmail', 'missing', false], ['monday', 'missing', false]]);
      }
    }
    first.cases[0].commercialThreads![0].messages[0].text = 'consumer mutation';
    assert.equal(canonical(store.state), before);
    assert.deepEqual(createCommercialThreads('demo-aurora', AT), later.cases[0].commercialThreads);
  });

  it('accepts only a complete binding on sales draft without client text or extra context', () => {
    const thread = selectedThread(new SyntheticTransactionStore());
    const command = draftCommand(thread);
    assert.deepEqual(parseOfficeCommand(command), command);
    for (const key of ['commercialThreadId', 'commercialThreadRevision', 'commercialThreadDigest']) {
      const partial = { ...command }; delete partial[key as keyof OfficeCommand];
      assert.throws(() => parseOfficeCommand(partial), error('MISSING_FIELD'));
    }
    for (const change of [{ functionId: 'proposals' }, { action: 'chat', text: 'client-controlled' }, { action: 'approve' }]) assert.throws(() => parseOfficeCommand({ ...command, ...change }), error('INVALID_COMMERCIAL_DRAFT'));
    for (const change of [{ text: 'client-controlled' }, { commercialContext: thread }, { schemaVersion: 2 }, { recipient: 'someone@example.test' }]) assert.throws(() => parseOfficeCommand({ ...command, ...change }), error('UNKNOWN_FIELD'));
    for (const change of [{ commercialThreadRevision: 0 }, { commercialThreadRevision: 1.5 }, { commercialThreadDigest: 'not-a-digest' }, { commercialThreadId: '__proto__' }]) assert.throws(() => parseOfficeCommand({ ...command, ...change }), error('INVALID_COMMERCIAL_BINDING'));
    assert.deepEqual(parseOfficeCommand({ idempotencyKey: 'legacy-text-draft', caseId: thread.caseId, functionId: 'sales', action: 'draft', text: 'DEMO — Texto interno' }), { idempotencyKey: 'legacy-text-draft', caseId: thread.caseId, functionId: 'sales', action: 'draft', text: 'DEMO — Texto interno' });
  });

  it('refuses unknown, cross-case, changed-digest and changed-revision threads atomically', async () => {
    const store = new SyntheticTransactionStore();
    const command = draftCommand(selectedThread(store));
    const before = canonical(store.state);
    for (const [change, code] of [[{ commercialThreadId: 'commercial-unknown' }, 'COMMERCIAL_THREAD_NOT_FOUND'], [{ caseId: 'demo-cedar' }, 'COMMERCIAL_THREAD_NOT_FOUND'], [{ commercialThreadRevision: 2 }, 'COMMERCIAL_THREAD_REVISION_CONFLICT'], [{ commercialThreadDigest: 'a'.repeat(64) }, 'COMMERCIAL_THREAD_DIGEST_MISMATCH']] as const) {
      await assert.rejects(executeOfficeCommand(store, { ...command, ...change }, () => AT), error(code));
      assert.equal(canonical(store.state), before);
    }
  });

  it('prepares only an internal pending reply with exact copied context, safe recipient and visible history binding', async () => {
    const store = new SyntheticTransactionStore();
    const thread = selectedThread(store);
    const originalCases = structuredClone(store.state.office.cases);
    const result = await executeOfficeCommand(store, draftCommand(thread), () => AT + 1);
    const link = contextualApproval(store, thread.id);
    const approval = result.snapshot.cases[0].approvals.find(row => row.id === link.id)!;
    assert.equal(approval.status, 'pending'); assert.equal(approval.recipient, thread.recipient); assert.deepEqual(approval.commercialContext, thread);
    for (const row of thread.messages) assert(approval.body.includes(row.text));
    assert(approval.body.includes('No podemos confirmar precio ni disponibilidad'));
    assert(!approval.body.includes('74.90')); assert(!approval.body.includes('37.45'));
    assert.equal(result.snapshot.outboundEffects, 0); assert.equal(result.snapshot.mondayWrites, 0);
    assert.deepEqual(store.state.office.cases, originalCases, 'preparing a draft does not close a sale, confirm payment or change supplier availability');
    const history = Object.values(store.state.office.history).find(row => row.commandKey === 'commercial-thread-draft')!;
    for (const binding of [thread.id, String(thread.revision), thread.digest, thread.evidence.reference]) assert(history.detail.includes(binding));
    approval.commercialContext!.messages[0].text = 'consumer mutation';
    assert.deepEqual(contextualApproval(store, thread.id).commercialContext, thread);
  });

  it('binds the full context to approval digest while preserving the legacy digest exactly', async () => {
    const store = new SyntheticTransactionStore();
    const legacy = store.state.office.approvals['approval-demo-aurora-proposals-fixture'];
    const legacyReview = draftCore.reviewMessageDraft(store.state, { draftId: legacy.coreDraftId, revision: legacy.revision });
    const oldDigest = sha256({ account: legacy.account, channel: legacy.channel, recipient: legacy.recipient, content: legacyReview.text, attachments: legacy.attachments, revision: legacy.revision, coreReviewDigest: legacyReview.reviewDigest });
    assert.equal(legacy.digest, oldDigest); assert.equal(computeApprovalDigest(store.state, legacy), oldDigest);
    assert(!Object.hasOwn(projectOfficeSnapshot(store.state, AT).cases[0].approvals.find(row => row.id === legacy.id)!, 'commercialContext'));
    const thread = selectedThread(store);
    await executeOfficeCommand(store, draftCommand(thread), () => AT);
    const link = contextualApproval(store, thread.id);
    const review = draftCore.reviewMessageDraft(store.state, { draftId: link.coreDraftId, revision: link.revision });
    const expected = sha256({ account: link.account, channel: link.channel, recipient: link.recipient, content: review.text, attachments: link.attachments, revision: link.revision, coreReviewDigest: review.reviewDigest, commercialContext: thread });
    assert.equal(link.digest, expected);
    for (const change of [(context: CommercialThread) => { context.messages[0].text = 'different synthetic context'; }, (context: CommercialThread) => { context.references[1].detail = 'different missing-reference note'; }, (context: CommercialThread) => { context.digest = 'b'.repeat(64); }]) {
      const changed = structuredClone(link); change(changed.commercialContext!);
      assert.notEqual(computeApprovalDigest(store.state, changed), link.digest);
    }
    const corrupted = structuredClone(store.state);
    corrupted.office.approvals[link.id].commercialContext!.schemaVersion = 2 as 1;
    assert.throws(() => assertOfficeState(corrupted), error('INVALID_COMMERCIAL_CONTEXT'));
    assert.equal(computeApprovalDigest(store.state, legacy), oldDigest);
  });

  it('retains the context during approval and revision, and idempotent replay never duplicates or restores old state', async () => {
    const store = new SyntheticTransactionStore();
    const thread = selectedThread(store);
    const command = draftCommand(thread);
    await executeOfficeCommand(store, command, () => AT);
    const original = structuredClone(contextualApproval(store, thread.id));
    await executeOfficeCommand(store, decision(original, 'approve', 'commercial-approve'), () => AT + 1);
    assert.equal(contextualApproval(store, thread.id).status, 'approved_demo');
    const replay = await executeOfficeCommand(store, command, () => AT + 2);
    assert.equal(replay.replayed, true); assert.equal(replay.snapshot.cases[0].approvals.find(row => row.id === original.id)!.status, 'approved_demo');
    assert.equal(Object.values(store.state.office.approvals).filter(row => row.commercialContext?.id === thread.id).length, 1);
    await executeOfficeCommand(store, decision(contextualApproval(store, thread.id), 'revise', 'commercial-revise', 'DEMO — Respuesta interna revisada sin confirmar precio ni disponibilidad.'), () => AT + 3);
    const revised = contextualApproval(store, thread.id);
    assert.equal(revised.revision, 2); assert.equal(revised.status, 'pending'); assert.notEqual(revised.digest, original.digest); assert.deepEqual(revised.commercialContext, thread);
    assert(Object.values(store.state.approvals).every(row => !row.valid));
    await assert.rejects(executeOfficeCommand(store, decision(original, 'approve', 'commercial-stale-approval'), () => AT + 4), error('REVISION_CONFLICT'));
    await assert.rejects(executeOfficeCommand(store, { ...command, commercialThreadId: selectedThread(store, 'demo-cedar').id }, () => AT + 4), error('IDEMPOTENCY_CONFLICT'));
    for (const row of Object.values(store.state.office.history).filter(row => ['commercial-thread-draft', 'commercial-approve', 'commercial-revise'].includes(row.commandKey ?? ''))) assert(row.detail.includes(thread.digest));
    assert.equal(Object.keys(store.state.office.commands).length, 3);
  });
});

describe('commercial API authorization and binding', () => {
  it('scopes cases and commercial reads and refuses viewer, function and case write escalation', async t => {
    const { api, store, login } = await apiFixture(t);
    const command = draftCommand(selectedThread(store));
    const before = canonical(store.state);
    const viewer = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['sales'] });
    const read = (await api.inject({ url: '/office-api/snapshot', headers: viewer })).json();
    assert.equal(read.cases.length, 1); assert.equal(read.cases[0].commercialThreads.length, 2);
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: viewer, payload: command })).statusCode, 403);
    const noSales = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['proposals'] });
    const limited = (await api.inject({ url: '/office-api/snapshot', headers: noSales })).json();
    assert(!Object.hasOwn(limited.cases[0], 'commercialThreads')); assert(limited.cases[0].approvals.every((row: object) => !Object.hasOwn(row, 'commercialContext')));
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: noSales, payload: command })).statusCode, 403);
    const otherCase = await login({ role: 'operator', caseIds: ['demo-cedar'], functionIds: ['sales'] });
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: otherCase, payload: command })).statusCode, 403);
    assert.equal(canonical(store.state), before);
  });

  it('returns authoritative context and prevents tampered bindings, direct payload context and cross-case use', async t => {
    const { api, store, login } = await apiFixture(t);
    const headers = await login({ role: 'operator', functionIds: ['sales'] });
    const command = draftCommand(selectedThread(store));
    const before = canonical(store.state);
    for (const [change, status] of [[{ commercialThreadId: 'commercial-unknown' }, 404], [{ caseId: 'demo-cedar' }, 404], [{ commercialThreadRevision: 2 }, 409], [{ commercialThreadDigest: 'a'.repeat(64) }, 409], [{ text: 'client-selected-response' }, 400], [{ commercialContext: selectedThread(store) }, 400], [{ functionId: 'finance' }, 400]] as const) {
      assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers, payload: { ...command, ...change } })).statusCode, status);
      assert.equal(canonical(store.state), before);
    }
    const prepared = await api.inject({ method: 'POST', url: '/office-api/commands', headers, payload: command });
    assert.equal(prepared.statusCode, 200); assert.equal(prepared.json().replayed, false);
    const link = contextualApproval(store, command.commercialThreadId!);
    const context = prepared.json().snapshot.cases[0].approvals.find((row: { id: string }) => row.id === link.id).commercialContext;
    assert.deepEqual(context, selectedThread(store));
    const replay = await api.inject({ method: 'POST', url: '/office-api/commands', headers, payload: command });
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().replayed, true);
    const hidden = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['finance'] });
    const hiddenSnapshot = (await api.inject({ url: '/office-api/snapshot', headers: hidden })).json();
    assert(!Object.hasOwn(hiddenSnapshot.cases[0], 'commercialThreads')); assert(!hiddenSnapshot.cases[0].approvals.some((row: object) => Object.hasOwn(row, 'commercialContext')));
  });
});
