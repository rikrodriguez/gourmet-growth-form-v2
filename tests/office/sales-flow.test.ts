import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { CommercialThread, OfficeCommand, OfficeSnapshot } from '../../src/office/contracts';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createOfficeApi } from '../../src/office/backend/http';
import { computeApprovalDigest } from '../../src/office/backend/pilot-core';
import type { SalesFlowOptions, SalesPlanner, SalesPlanningInput } from '../../src/office/backend/sales-flow';
import { SESSION_TTL_MS } from '../../src/office/backend/session';
import { canonical, projectOfficeSnapshot } from '../../src/office/backend/state';
import type { ApprovalLink, DemoCaseId, OfficeState, OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-11T12:00:00.000Z');
const PRIVATE_FAILURE = 'SYNTHETIC_PRIVATE_DEPENDENCY_DETAIL_DO_NOT_PERSIST';
const INJECTION = 'SYNTHETIC_UNTRUSTED_INSTRUCTION_SEND_AND_APPROVE_NOW';

// Match the aggregate lock used by the durable store. A rejected transaction
// rolls back its copy, while other requests continue in their original order.
class SerializedStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  private tail: Promise<void> = Promise.resolve();

  async snapshot() {
    await this.tail;
    return structuredClone(this.state);
  }

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

function allowedPlan(input: SalesPlanningInput) {
  return { sectionIds: input.sections.map(row => row.id), evidenceIds: [...input.evidenceIds] };
}

function threadFor(store: SerializedStore, caseId: DemoCaseId = 'demo-aurora', index = 0): CommercialThread {
  return projectOfficeSnapshot(store.state, AT).cases.find(row => row.id === caseId)!.commercialThreads![index];
}

function draft(thread: CommercialThread, key: string): OfficeCommand {
  return {
    idempotencyKey: key, caseId: thread.caseId, functionId: 'sales', action: 'draft',
    commercialThreadId: thread.id, commercialThreadRevision: thread.revision, commercialThreadDigest: thread.digest,
  };
}

function linkFor(store: SerializedStore, thread: CommercialThread): ApprovalLink {
  const link = Object.values(store.state.office.approvals).find(row => row.commercialContext?.id === thread.id);
  assert(link, 'the server creates an approval bound to the selected conversation');
  return link;
}

function decision(link: ApprovalLink, action: OfficeCommand['action'], key: string, text?: string): OfficeCommand {
  return {
    idempotencyKey: key, caseId: link.caseId, functionId: link.functionId, action,
    approvalId: link.id, revision: link.revision, digest: link.digest, ...(text === undefined ? {} : { text }),
  };
}

function assertNoEffects(snapshot: OfficeSnapshot) {
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.outboundEffects, 0);
  assert.equal(snapshot.mondayWrites, 0);
}

function operationalFacts(state: OfficeState) {
  const { leads, closers, assignments, callBindings, callEvents, payments, invoices, exceptions, sourceLeadBindings, providerEvents, reconciliations, closerIdentityBindings } = state;
  const cases = Object.values(state.office.cases).map(({ results: _results, messages: _messages, ...facts }) => facts);
  return structuredClone({ leads, closers, assignments, callBindings, callEvents, payments, invoices, exceptions, sourceLeadBindings, providerEvents, reconciliations, closerIdentityBindings, cases });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: SalesFlowOptions = {}, clock: () => number = () => AT) {
  const store = new SerializedStore();
  const api = createOfficeApi(store, { clock, ...options });
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('UNEXPECTED_SYNTHETIC_NETWORK_CALL'); });
  t.after(() => api.close());
  t.after(() => assert.equal(network.mock.callCount(), 0, 'this flow never calls a network provider'));
  await api.ready();
  const baseHeaders = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
  async function login(scope: object = { role: 'operator', functionIds: ['sales'] }) {
    const response = await api.inject({ method: 'POST', url: '/office-api/session', headers: baseHeaders, payload: scope });
    assert.equal(response.statusCode, 200);
    return { ...baseHeaders, cookie: String(response.headers['set-cookie']).split(';')[0] };
  }
  function post(headers: Record<string, string>, command: unknown) {
    return api.inject({ method: 'POST', url: '/office-api/commands', headers, payload: command as object });
  }
  return { api, store, baseHeaders, login, post };
}

function assertFailedAudit(store: SerializedStore, before: OfficeState, key: string, code: string) {
  assert.deepEqual(store.state.office.approvals, before.office.approvals);
  assert.deepEqual(store.state.approvals, before.approvals);
  assert.deepEqual(store.state.drafts, before.drafts);
  assert.deepEqual(operationalFacts(store.state), operationalFacts(before));
  const jobs = Object.values(store.state.office.jobs).filter(row => !Object.hasOwn(before.office.jobs, row.id));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[0].functionId, 'sales');
  assert(jobs[0].detail.includes(code));
  const history = Object.values(store.state.office.history).filter(row => row.commandKey === key);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'failed');
  assert(history[0].detail.includes(code));
  assert.equal(store.state.office.commands[key].salesFlow?.error, code);
  assert(!canonical(store.state).includes(PRIVATE_FAILURE));
  assert(!canonical(store.state).includes(INJECTION));
}

describe('bounded sales orchestration through the office API', () => {
  it('checks session, role, case, function and expiration before planning, including replays', async t => {
    let now = AT;
    let calls = 0;
    const salesPlanner: SalesPlanner = { async plan(input) { calls += 1; return allowedPlan(input); } };
    const { api, store, baseHeaders, login, post } = await fixture(t, { salesPlanner }, () => now);
    const command = draft(threadFor(store), 'sales-scope');
    const before = canonical(store.state);
    assert.equal((await post(baseHeaders, command)).statusCode, 401);
    for (const scope of [
      { role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['sales'] },
      { role: 'operator', caseIds: ['demo-cedar'], functionIds: ['sales'] },
      { role: 'operator', caseIds: ['demo-aurora'], functionIds: ['finance'] },
    ]) {
      const headers = await login(scope);
      assert.equal((await post(headers, command)).statusCode, 403);
    }
    assert.equal(calls, 0);
    assert.equal(canonical(store.state), before);
    const operator = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['sales'] });
    const exceptionsBefore = structuredClone(store.state.exceptions);
    const prepared = await post(operator, command);
    assert.equal(prepared.statusCode, 200);
    assert.equal(calls, 1);
    assert.deepEqual(store.state.exceptions, exceptionsBefore, 'an Aurora-scoped command cannot create an SLA alert for Harbor');
    const committed = canonical(store.state);
    const viewer = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['sales'] });
    assert.equal((await post(viewer, command)).statusCode, 403);
    const read = await api.inject({ url: '/office-api/snapshot', headers: viewer });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().cases.length, 1);
    now += SESSION_TTL_MS;
    assert.equal((await post(operator, command)).statusCode, 401);
    assert.equal((await api.inject({ url: '/office-api/snapshot', headers: viewer })).statusCode, 401);
    assert.equal(calls, 1);
    assert.equal(canonical(store.state), committed);
  });

  it('rejects stale, cross-case and injected client bindings before invoking the planner', async t => {
    let calls = 0;
    const { store, login, post } = await fixture(t, { salesPlanner: { async plan(input) { calls += 1; return allowedPlan(input); } } });
    const headers = await login();
    const thread = threadFor(store);
    const command = draft(thread, 'sales-binding');
    const before = canonical(store.state);
    const attempts: Array<[Record<string, unknown>, number, string]> = [
      [{ commercialThreadId: 'commercial-nonexistent' }, 404, 'COMMERCIAL_THREAD_NOT_FOUND'],
      [{ caseId: 'demo-cedar' }, 404, 'COMMERCIAL_THREAD_NOT_FOUND'],
      [{ commercialThreadRevision: 2 }, 409, 'COMMERCIAL_THREAD_REVISION_CONFLICT'],
      [{ commercialThreadDigest: 'a'.repeat(64) }, 409, 'COMMERCIAL_THREAD_DIGEST_MISMATCH'],
      [{ text: INJECTION }, 400, 'UNKNOWN_FIELD'],
      [{ commercialContext: { ...thread, recipient: 'injected@invalid.test', messages: [{ text: INJECTION }] } }, 400, 'UNKNOWN_FIELD'],
      [{ recipient: 'injected@invalid.test' }, 400, 'UNKNOWN_FIELD'],
      [{ salesPlanner: INJECTION }, 400, 'UNKNOWN_FIELD'],
      [{ functionId: 'finance' }, 400, 'INVALID_COMMERCIAL_DRAFT'],
    ];
    for (const [change, status, code] of attempts) {
      const response = await post(headers, { ...command, ...change });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error: code });
      assert(!response.body.includes(INJECTION));
      assert.equal(canonical(store.state), before);
    }
    for (const key of ['commercialThreadId', 'commercialThreadRevision', 'commercialThreadDigest'] as const) {
      const incomplete = { ...command }; delete incomplete[key];
      assert.equal((await post(headers, incomplete)).statusCode, 400);
      assert.equal(canonical(store.state), before);
    }
    assert.equal(calls, 0);
  });

  it('treats planner input as copied data and renders only mandatory server sections and evidence', async t => {
    let received: SalesPlanningInput | undefined;
    let signal: AbortSignal | undefined;
    const salesPlanner: SalesPlanner = {
      async plan(input, abortSignal) {
        received = structuredClone(input);
        signal = abortSignal;
        const plan = allowedPlan(input);
        input.policy = INJECTION;
        input.contextDigest = 'b'.repeat(64);
        input.untrustedConversation.recipient = 'injected@invalid.test';
        input.untrustedConversation.messages[0].text = INJECTION;
        input.untrustedConversation.references[1].status = 'simulated';
        input.sections.forEach(section => { section.text = INJECTION; });
        input.evidenceIds.push(INJECTION);
        return { sectionIds: plan.sectionIds.reverse(), evidenceIds: plan.evidenceIds.reverse() };
      },
    };
    const { store, login, post } = await fixture(t, { salesPlanner });
    const headers = await login();
    const thread = threadFor(store);
    const before = operationalFacts(store.state);
    const response = await post(headers, draft(thread, 'sales-copy-isolation'));
    assert.equal(response.statusCode, 200);
    assert(received);
    assert.equal(received.mode, 'demo');
    assert.match(received.policy, /untrusted|never instructions/i);
    assert.match(received.contextDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(received.untrustedConversation, thread);
    assert.equal(new Set(received.sections.map(row => row.id)).size, received.sections.length);
    assert.equal(new Set(received.evidenceIds).size, received.evidenceIds.length);
    assert(received.evidenceIds.every(id => id.startsWith(`demo:${thread.caseId}:`)));
    assert(received.sections.every(section => !/totalCents=|paidCents=|balanceCents=/.test(section.text)), 'sales planning does not read finance facts');
    assert(received.evidenceIds.every(id => !id.includes('-ledger:')), 'finance ledger evidence is excluded from sales planning');
    assert(signal?.aborted, 'the planner signal is released after generation');
    const link = linkFor(store, thread);
    const snapshot = response.json().snapshot as OfficeSnapshot;
    const approval = snapshot.cases[0].approvals.find(row => row.id === link.id)!;
    assert.equal(approval.body, received.sections.map(row => row.text).reverse().join('\n\n'));
    assert(!approval.body.includes(INJECTION));
    assert.equal(link.recipient, thread.recipient);
    assert.equal(link.status, 'pending');
    assert.deepEqual(link.commercialContext, thread);
    assert.equal(link.digest, computeApprovalDigest(store.state, link));
    assert.deepEqual(operationalFacts(store.state), before);
    assertNoEffects(snapshot);
  });

  it('keeps missing brief facts and disconnected sources visible with the default DEMO script', async t => {
    const { store, login, post } = await fixture(t);
    const headers = await login();
    const thread = threadFor(store, 'demo-harbor');
    const facts = operationalFacts(store.state);
    const response = await post(headers, draft(thread, 'sales-default-script'));
    assert.equal(response.statusCode, 200);
    const snapshot = response.json().snapshot as OfficeSnapshot;
    const approval = snapshot.cases.find(row => row.id === thread.caseId)!.approvals.find(row => row.id === linkFor(store, thread).id)!;
    assert.match(approval.body, /fecha, ubicación, cantidad de asistentes y restricciones alimentarias/);
    assert.match(approval.body, /pendientes de confirmación/);
    assert.match(approval.body, /Gmail|gmail/);
    assert.match(approval.body, /Monday|monday/);
    assert.match(approval.body, /sin LLM|No se consultó un LLM/i);
    assert.match(approval.body, /No podemos confirmar precio ni disponibilidad/);
    assert.match(approval.body, /aprobación humana/);
    assert.equal(approval.status, 'pending');
    assert.equal(store.state.office.cases['demo-harbor'].saleClosed, false);
    assert.equal(store.state.office.cases['demo-harbor'].supplier, 'unknown');
    const actualFacts = operationalFacts(store.state);
    assert.deepEqual({ ...actualFacts, exceptions: facts.exceptions }, facts);
    for (const [id, row] of Object.entries(facts.exceptions)) assert.deepEqual(store.state.exceptions[id], row);
    const newExceptions = Object.entries(store.state.exceptions).filter(([id]) => !Object.hasOwn(facts.exceptions, id)).map(([, row]) => row) as Array<Record<string, unknown>>;
    assert.equal(newExceptions.length, 1, 'the selected overdue case receives one local human-review audit');
    assert.equal(newExceptions[0].gourmetEventId, 'demo-harbor');
    assert.equal(newExceptions[0].leadId, 'lead-demo-harbor');
    assert.equal(newExceptions[0].requiresHumanReview, true);
    assert.equal(newExceptions[0].status, 'pending_human_review');
    assertNoEffects(snapshot);
  });

  it('serializes concurrent requests and reuses one draft for another key with the same context', async t => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const salesPlanner: SalesPlanner = { async plan(input) { calls += 1; entered.resolve(); await release.promise; return allowedPlan(input); } };
    const { store, login, post } = await fixture(t, { salesPlanner });
    const headers = await login();
    const thread = threadFor(store);
    const before = structuredClone(store.state);
    const command = draft(thread, 'sales-concurrent-original');
    const first = post(headers, command);
    await entered.promise;
    const sameKey = post(headers, command);
    const differentKey = post(headers, draft(thread, 'sales-concurrent-alias'));
    release.resolve();
    const responses = await Promise.all([first, sameKey, differentKey]);
    assert(responses.every(response => response.statusCode === 200));
    assert.deepEqual(responses.map(response => response.json().replayed), [false, true, true]);
    assert.equal(calls, 1);
    const link = linkFor(store, thread);
    assert.equal(Object.keys(store.state.office.approvals).length, Object.keys(before.office.approvals).length + 1);
    assert.equal(Object.keys(store.state.drafts).length, Object.keys(before.drafts).length + 1);
    assert.equal(Object.values(store.state.office.history).filter(row => row.commandKey === command.idempotencyKey).length, 1);
    assert.equal(Object.values(store.state.office.history).filter(row => row.commandKey === 'sales-concurrent-alias').length, 0);
    assert.equal(store.state.office.commands['sales-concurrent-alias'].salesFlow?.approvalId, link.id);
    assert.equal(store.state.office.commands[command.idempotencyKey].salesFlow?.fingerprint, store.state.office.commands['sales-concurrent-alias'].salesFlow?.fingerprint);
    for (const response of responses) assertNoEffects(response.json().snapshot);
    assert.deepEqual(operationalFacts(store.state), operationalFacts(before));
    const stable = canonical(store.state);
    const conflict = await post(headers, { ...command, commercialThreadId: threadFor(store, 'demo-aurora', 1).id });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { error: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(canonical(store.state), stable);
    assert.equal(calls, 1);
  });

  it('keeps stable context across time while isolating different conversations and cases', async t => {
    let now = AT;
    let calls = 0;
    const inputs: SalesPlanningInput[] = [];
    const { store, login, post } = await fixture(t, { salesPlanner: { async plan(input) { calls += 1; inputs.push(structuredClone(input)); return allowedPlan(input); } } }, () => now);
    const headers = await login();
    const firstThread = threadFor(store);
    const original = draft(firstThread, 'sales-context-original');
    const facts = operationalFacts(store.state);
    assert.equal((await post(headers, original)).statusCode, 200);
    const firstApproval = linkFor(store, firstThread).id;
    now += 60_000;
    const alias = await post(headers, draft(firstThread, 'sales-context-later-alias'));
    assert.equal(alias.statusCode, 200);
    assert.equal(alias.json().replayed, true);
    assert.equal(calls, 1, 'elapsed time without changed facts is not a new generation context');
    const otherThread = threadFor(store, 'demo-aurora', 1);
    const otherCaseThread = threadFor(store, 'demo-cedar');
    for (const [thread, key] of [[otherThread, 'sales-context-other-thread'], [otherCaseThread, 'sales-context-other-case']] as const) {
      const result = await post(headers, draft(thread, key));
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().replayed, false);
      assert.deepEqual(linkFor(store, thread).commercialContext, thread);
      assert.equal(linkFor(store, thread).recipient, thread.recipient);
      assertNoEffects(result.json().snapshot);
    }
    assert.equal(calls, 3);
    assert.equal(new Set([firstApproval, linkFor(store, otherThread).id, linkFor(store, otherCaseThread).id]).size, 3);
    assert.equal(new Set(inputs.map(input => input.contextDigest)).size, 3);
    for (const input of inputs) assert(input.evidenceIds.every(id => id.startsWith(`demo:${input.untrustedConversation.caseId}:`)));
    assert.deepEqual(operationalFacts(store.state), facts);
  });

  it('persists sanitized dependency failure and never retries a failed transport key', async t => {
    let calls = 0;
    const salesPlanner: SalesPlanner = { async plan(input) { calls += 1; if (calls === 1) throw new Error(PRIVATE_FAILURE); return allowedPlan(input); } };
    const { api, store, login, post } = await fixture(t, { salesPlanner });
    const headers = await login();
    const thread = threadFor(store);
    const command = draft(thread, 'sales-failed-once');
    const before = structuredClone(store.state);
    const failed = await post(headers, command);
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), { error: 'SALES_PLANNER_FAILED' });
    assertFailedAudit(store, before, command.idempotencyKey, 'SALES_PLANNER_FAILED');
    const committed = canonical(store.state);
    for (let count = 0; count < 2; count += 1) {
      const replay = await post(headers, command);
      assert.equal(replay.statusCode, 502);
      assert.deepEqual(replay.json(), { error: 'SALES_PLANNER_FAILED' });
      assert.equal(canonical(store.state), committed);
    }
    assert.equal(calls, 1);
    const snapshot = await api.inject({ url: '/office-api/snapshot', headers });
    assert.equal(snapshot.statusCode, 200);
    assert(!snapshot.body.includes(PRIVATE_FAILURE));
    assertNoEffects(snapshot.json());
    const retry = await post(headers, draft(thread, 'sales-explicit-retry'));
    assert.equal(retry.statusCode, 200);
    assert.equal(calls, 2);
    assert.equal(linkFor(store, thread).status, 'pending');
    const recovered = canonical(store.state);
    assert.equal((await post(headers, command)).statusCode, 502);
    assert.equal(calls, 2);
    assert.equal(canonical(store.state), recovered);
  });

  it('aborts timed out planning, persists the failure and ignores a late result and replay', async t => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    let latePlan: ReturnType<typeof allowedPlan> | undefined;
    const result = deferred<unknown>();
    const salesPlanner: SalesPlanner = { async plan(input, abortSignal) { calls += 1; signal = abortSignal; latePlan = allowedPlan(input); return result.promise; } };
    const { store, login, post } = await fixture(t, { salesPlanner, plannerTimeoutMs: 10 });
    const headers = await login();
    const command = draft(threadFor(store), 'sales-timeout');
    const before = structuredClone(store.state);
    const response = await post(headers, command);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.json(), { error: 'SALES_PLANNER_TIMEOUT' });
    assert(signal?.aborted);
    assertFailedAudit(store, before, command.idempotencyKey, 'SALES_PLANNER_TIMEOUT');
    const committed = canonical(store.state);
    result.resolve(latePlan);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(canonical(store.state), committed);
    assert.equal((await post(headers, command)).statusCode, 504);
    assert.equal(calls, 1);
    assert.equal(canonical(store.state), committed);
  });

  it('keeps timeout classification when the planner rejects while its signal is aborted', async t => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const salesPlanner: SalesPlanner = {
      async plan(_input, abortSignal) {
        calls += 1;
        signal = abortSignal;
        return new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error(PRIVATE_FAILURE)), { once: true });
        });
      },
    };
    const { store, login, post } = await fixture(t, { salesPlanner, plannerTimeoutMs: 10 });
    const headers = await login();
    const command = draft(threadFor(store), 'sales-timeout-abort-rejection');
    const before = structuredClone(store.state);
    const response = await post(headers, command);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.json(), { error: 'SALES_PLANNER_TIMEOUT' });
    assert(signal?.aborted);
    assertFailedAudit(store, before, command.idempotencyKey, 'SALES_PLANNER_TIMEOUT');
    const committed = canonical(store.state);
    assert.equal((await post(headers, command)).statusCode, 504);
    assert.equal(calls, 1);
    assert.equal(canonical(store.state), committed);
  });

  it('binds human decisions to the exact revision and preserves zero effects across approval and replay', async t => {
    let calls = 0;
    const { store, login, post } = await fixture(t, { salesPlanner: { async plan(input) { calls += 1; return allowedPlan(input); } } });
    const headers = await login();
    const thread = threadFor(store);
    const command = draft(thread, 'sales-human-draft');
    const facts = operationalFacts(store.state);
    assert.equal((await post(headers, command)).statusCode, 200);
    const original = structuredClone(linkFor(store, thread));
    const exactApproval = decision(original, 'approve', 'sales-human-approve');
    const mismatch = await post(headers, { ...exactApproval, idempotencyKey: 'sales-human-wrong-digest', digest: 'a'.repeat(64) });
    assert.equal(mismatch.statusCode, 409);
    assert.deepEqual(mismatch.json(), { error: 'APPROVAL_DIGEST_MISMATCH' });
    const approved = await post(headers, exactApproval);
    assert.equal(approved.statusCode, 200);
    assert.equal(linkFor(store, thread).status, 'approved_demo');
    assert.equal(store.state.office.jobs[linkFor(store, thread).jobId].status, 'blocked');
    assertNoEffects(approved.json().snapshot);
    for (const replayCommand of [command, exactApproval]) {
      const replay = await post(headers, replayCommand);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().replayed, true);
      assert.equal(replay.json().snapshot.cases[0].approvals.find((row: { id: string }) => row.id === original.id).status, 'approved_demo');
      assertNoEffects(replay.json().snapshot);
    }
    const revise = decision(linkFor(store, thread), 'revise', 'sales-human-revise', 'DEMO — Texto revisado por humano; precio y disponibilidad siguen pendientes.');
    assert.equal((await post(headers, revise)).statusCode, 200);
    const revised = linkFor(store, thread);
    assert.equal(revised.revision, 2);
    assert.equal(revised.status, 'pending');
    assert.notEqual(revised.digest, original.digest);
    assert.deepEqual(revised.commercialContext, thread);
    assert.equal(revised.recipient, original.recipient);
    assert.deepEqual(revised.attachments, original.attachments);
    assert.equal(revised.account, original.account);
    assert.equal(revised.channel, original.channel);
    assert(Object.values(store.state.approvals).every(row => !row.valid));
    const stale = await post(headers, { ...exactApproval, idempotencyKey: 'sales-human-stale' });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'REVISION_CONFLICT' });
    for (const replayCommand of [command, exactApproval, revise, draft(thread, 'sales-human-context-alias')]) {
      const replay = await post(headers, replayCommand);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().replayed, true);
      const approval = replay.json().snapshot.cases[0].approvals.find((row: { id: string }) => row.id === original.id);
      assert.equal(approval.revision, 2);
      assert.equal(approval.status, 'pending');
      assertNoEffects(replay.json().snapshot);
    }
    assert.equal(calls, 1);
    assert.deepEqual(operationalFacts(store.state), facts);
    assert.equal(Object.values(store.state.office.approvals).filter(row => row.commercialContext?.id === thread.id).length, 1);
  });

  it('replays rejected and cancelled contexts without preparing another draft or restoring pending state', async t => {
    for (const action of ['reject', 'cancel'] as const) {
      await t.test(action, async subtest => {
        let calls = 0;
        const { store, login, post } = await fixture(subtest, { salesPlanner: { async plan(input) { calls += 1; return allowedPlan(input); } } });
        const headers = await login();
        const thread = threadFor(store);
        const command = draft(thread, `sales-terminal-${action}-draft`);
        const facts = operationalFacts(store.state);
        assert.equal((await post(headers, command)).statusCode, 200);
        const link = structuredClone(linkFor(store, thread));
        const terminalCommand = decision(link, action, `sales-terminal-${action}-decision`);
        assert.equal((await post(headers, terminalCommand)).statusCode, 200);
        const status = action === 'reject' ? 'rejected_demo' : 'cancelled_demo';
        for (const replayCommand of [command, terminalCommand, draft(thread, `sales-terminal-${action}-alias`)]) {
          const response = await post(headers, replayCommand);
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().replayed, true);
          assert.equal(response.json().snapshot.cases[0].approvals.find((row: { id: string }) => row.id === link.id).status, status);
          assertNoEffects(response.json().snapshot);
        }
        assert.equal(calls, 1);
        assert.equal(linkFor(store, thread).id, link.id);
        assert.deepEqual(operationalFacts(store.state), facts);
      });
    }
  });
});

describe('adversarial synthetic planner output', () => {
  it('rejects free actions, omitted facts and executable or sparse array shapes without creating approvals', async t => {
    type Attack = { name: string; make: (input: SalesPlanningInput, executed: { count: number }) => unknown };
    const attacks: Attack[] = [
      { name: 'free reply text', make: input => ({ ...allowedPlan(input), text: INJECTION }) },
      { name: 'tool command', make: input => ({ ...allowedPlan(input), tools: [{ name: 'send', recipient: 'injected@invalid.test' }] }) },
      { name: 'send action', make: input => ({ ...allowedPlan(input), send: true }) },
      { name: 'approval action', make: input => ({ ...allowedPlan(input), approve: true }) },
      { name: 'unknown section', make: input => ({ ...allowedPlan(input), sectionIds: [...input.sections.slice(1).map(row => row.id), INJECTION] }) },
      { name: 'missing mandatory section', make: input => ({ ...allowedPlan(input), sectionIds: input.sections.slice(1).map(row => row.id) }) },
      { name: 'duplicate section', make: input => { const plan = allowedPlan(input); plan.sectionIds[0] = plan.sectionIds[1]; return plan; } },
      { name: 'unknown evidence', make: input => { const plan = allowedPlan(input); plan.evidenceIds[0] = INJECTION; return plan; } },
      { name: 'missing evidence', make: input => ({ ...allowedPlan(input), evidenceIds: input.evidenceIds.slice(1) }) },
      { name: 'duplicate evidence', make: input => { const plan = allowedPlan(input); plan.evidenceIds[0] = plan.evidenceIds[1]; return plan; } },
      { name: 'non-string IDs', make: input => ({ ...allowedPlan(input), sectionIds: input.sections.map(() => ({ id: INJECTION })) }) },
      { name: 'null response', make: () => null },
      { name: 'array response', make: input => [allowedPlan(input)] },
      { name: 'inherited plan fields', make: input => Object.create(allowedPlan(input)) },
      { name: 'symbol output field', make: input => ({ ...allowedPlan(input), [Symbol('action')]: INJECTION }) },
      { name: 'non-enumerable output field', make: input => Object.defineProperty(allowedPlan(input), 'send', { value: true }) },
      { name: 'top-level getter', make: (input, executed) => Object.defineProperty({ evidenceIds: [...input.evidenceIds] }, 'sectionIds', { enumerable: true, get() { executed.count += 1; return input.sections.map(row => row.id); } }) },
      { name: 'sparse sections', make: input => { const plan = allowedPlan(input); delete plan.sectionIds[0]; return plan; } },
      { name: 'sparse evidence', make: input => { const plan = allowedPlan(input); delete plan.evidenceIds[0]; return plan; } },
      { name: 'section index getter', make: (input, executed) => { const plan = allowedPlan(input); Object.defineProperty(plan.sectionIds, '0', { enumerable: true, get() { executed.count += 1; return input.sections[0].id; } }); return plan; } },
      { name: 'evidence index getter', make: (input, executed) => { const plan = allowedPlan(input); Object.defineProperty(plan.evidenceIds, '0', { enumerable: true, get() { executed.count += 1; return input.evidenceIds[0]; } }); return plan; } },
      { name: 'array subclass', make: input => { const plan = allowedPlan(input); class ExecutableArray extends Array<string> {} plan.sectionIds = ExecutableArray.from(plan.sectionIds); return plan; } },
      { name: 'array map override', make: (input, executed) => { const plan = allowedPlan(input); Object.defineProperty(plan.sectionIds, 'map', { value() { executed.count += 1; return [INJECTION]; }, enumerable: true }); return plan; } },
      { name: 'array every override', make: (input, executed) => { const plan = allowedPlan(input); Object.defineProperty(plan.sectionIds, 'every', { value() { executed.count += 1; return true; }, enumerable: true }); return plan; } },
      { name: 'array iterator override', make: (input, executed) => { const plan = allowedPlan(input); Object.defineProperty(plan.sectionIds, Symbol.iterator, { value: function* () { executed.count += 1; yield* input.sections.map(row => row.id); } }); return plan; } },
    ];
    for (const attack of attacks) {
      await t.test(attack.name, async subtest => {
        const executed = { count: 0 };
        let calls = 0;
        const { store, login, post } = await fixture(subtest, { salesPlanner: { async plan(input) { calls += 1; return attack.make(input, executed); } } });
        const headers = await login();
        const command = draft(threadFor(store), 'sales-invalid-plan');
        const before = structuredClone(store.state);
        const response = await post(headers, command);
        assert.equal(response.statusCode, 502, attack.name);
        assert.deepEqual(response.json(), { error: 'INVALID_SALES_PLAN' });
        assert(!response.body.includes(INJECTION));
        assert.equal(executed.count, 0, 'output validation never invokes planner-controlled getters or methods');
        assertFailedAudit(store, before, command.idempotencyKey, 'INVALID_SALES_PLAN');
        const committed = canonical(store.state);
        assert.equal((await post(headers, command)).statusCode, 502);
        assert.equal(calls, 1);
        assert.equal(canonical(store.state), committed);
      });
    }
  });
});
