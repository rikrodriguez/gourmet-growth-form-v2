import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { OfficeSnapshot } from '../../src/office/contracts';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { paymentCore } from '../../src/office/backend/pilot-core';
import { evaluateFollowup, readSalesWorkflow } from '../../src/office/backend/sales-workflow';
import { scopeSnapshot } from '../../src/office/backend/session';
import type { DevelopmentSession } from '../../src/office/backend/session';
import { CASE_IDS, DEMO_ACTOR, FUNCTION_AREAS, canonical, evidence, projectOfficeSnapshot } from '../../src/office/backend/state';
import type { DemoCaseId, OfficeState } from '../../src/office/backend/state';

// Synthetic in-memory state only: no HTTP, services, environment, or provider.
const AT = Date.parse('2026-10-10T21:00:00.000Z');
const require = createRequire(import.meta.url);
const paymentReader = require('../../src/operations/payments.mjs') as {
  readVerifiedInvoiceLedger(state: OfficeState, invoiceId: string): { totalCents: number; paidCents: number; balanceCents: number } | null;
};
const assignmentCore = require('../../src/operations/assignment.mjs') as {
  captureLead(state: OfficeState, input: object): { lead: { id: string; leadId?: string }; replayed: boolean };
  setCloserAvailability(state: OfficeState, input: object): unknown;
  reserveLead(state: OfficeState, input: object): { assignment: { id: string; reservationId: string }; replayed: boolean };
  acceptReservation(state: OfficeState, input: object): { accepted: boolean; replayed: boolean };
};
const telephonyCore = require('../../src/operations/telephony.mjs') as {
  registerCallBinding(state: OfficeState, input: object): unknown;
  applyTelnyxEvent(state: OfficeState, event: object, options: { nowMs: number }): { status: string };
};
type Workflow = ReturnType<typeof readSalesWorkflow>;
type Followup = Parameters<typeof evaluateFollowup>[0];
const factKinds = ['closer', 'call-attempt', 'human-contact', 'ledger', 'sale', 'supplier', 'followup'] as const;
const unknown = /unknown|desconocid|null|sin (?:datos|evidencia|verificaci[oó]n)/i;
const alertId = (caseId: DemoCaseId) => `workflow-${caseId}-paid-without-supplier`;
function fact(workflow: Workflow, caseId: DemoCaseId, kind: typeof factKinds[number]) {
  const row = workflow.facts.find(item => item.id === `workflow-${caseId}-${kind}`);
  assert(row, `Missing workflow fact ${caseId}/${kind}`);
  return row;
}
function assertNoAlert(workflow: Workflow, caseId: DemoCaseId) {
  assert(!workflow.tasks.some(row => row.id === alertId(caseId)));
  assert(!workflow.results.some(row => row.id === alertId(caseId)));
}
function assertUnknownLedger(workflow: Workflow) {
  const detail = fact(workflow, 'demo-aurora', 'ledger').detail;
  for (const key of ['totalCents', 'paidCents', 'balanceCents']) assert(detail.includes(`${key}=null`), detail);
  assertNoAlert(workflow, 'demo-aurora');
}
function closer(state: OfficeState, overrides: Record<string, unknown> = {}) {
  state.closers[DEMO_ACTOR] = {
    id: DEMO_ACTOR, closerId: DEMO_ACTOR, actorId: DEMO_ACTOR,
    active: true, departmentIds: ['sales'], capacity: 1,
    shiftStartMs: AT - 60_000, shiftEndMs: AT + 60_000,
    availableUntilMs: AT + 60_000, availabilitySetAtMs: AT,
    createdAtMs: AT, updatedAtMs: AT, policyRevision: 1, ...overrides,
  };
}
function verifiedCall(state: OfficeState) {
  const lead = state.leads['lead-demo-aurora'] as Record<string, unknown>;
  const occurredAtMs = (lead.capturedAtMs as number) + 10_000;
  lead.telephony = { firstCallInitiatedEventId: 'workflow-synthetic-call', firstCallInitiatedAtMs: occurredAtMs, slaStatus: 'target_met' };
  state.callEvents['workflow-synthetic-call'] = {
    eventId: 'workflow-synthetic-call', eventType: 'call.initiated', leadId: lead.leadId,
    occurredAtMs, webhookReceivedAtMs: occurredAtMs + 50_000, status: 'applied',
  };
}
function scoped(functionIds: DevelopmentSession['functionIds'], caseIds: DemoCaseId[] = ['demo-aurora']): DevelopmentSession {
  return { mode: 'demo', actorId: DEMO_ACTOR, role: 'viewer', caseIds, functionIds,
    expiresAt: new Date(AT + 60_000).toISOString(), storage: { kind: 'postgres', durable: true }, outboundEffects: 0 };
}
function mergedSnapshot(state: OfficeState): OfficeSnapshot {
  const snapshot = projectOfficeSnapshot(state, AT);
  for (const item of snapshot.cases) {
    const workflow = readSalesWorkflow(state, item.id as DemoCaseId, AT);
    // Also works after the production projection incorporates this reader.
    const taskIds = new Set(workflow.tasks.map(row => row.id));
    const resultIds = new Set(workflow.results.map(row => row.id));
    item.tasks = [...item.tasks.filter(row => !taskIds.has(row.id)), ...workflow.tasks];
    item.results = [...item.results.filter(row => !resultIds.has(row.id)), ...workflow.results];
  }
  return snapshot;
}

function nativeCoreFixture(capacity = 1) {
  const state = createOfficeFixtureState(AT);
  const t0 = Date.parse(state.office.cases['demo-aurora'].capturedAt);
  for (const [id, row] of Object.entries(state.leads)) {
    if ((row as Record<string, unknown>).gourmetEventId === 'demo-aurora') delete state.leads[id];
  }
  const captured = assignmentCore.captureLead(state, {
    leadId: 'native-workflow-aurora', departmentId: 'sales', captureSource: 'WORKFLOW_SYNTHETIC_CORE', capturedAtMs: t0, nowMs: t0,
  });
  const leadId = captured.lead.id;
  assert.equal(typeof leadId, 'string');
  const lead = state.leads[leadId] as Record<string, unknown>;
  // Trusted scope binding is applied by the pilot after the generic capture core.
  lead.gourmetEventId = 'demo-aurora';
  const policy = { closerId: DEMO_ACTOR, actorId: DEMO_ACTOR, active: true, departmentIds: ['sales'], capacity,
    shiftStartMs: t0, shiftEndMs: AT + 60_000, availableUntilMs: AT + 60_000 };
  assignmentCore.setCloserAvailability(state, { ...policy, nowMs: t0 });
  const reserved = assignmentCore.reserveLead(state, { leadId, nowMs: t0, acceptanceTimeoutMs: 15_000 });
  assert(reserved.assignment);
  assert.equal(assignmentCore.acceptReservation(state, {
    reservationId: reserved.assignment.id, closerId: DEMO_ACTOR, nowMs: t0 + 1000,
  }).accepted, true);
  return { state, t0, lead, leadId, reservationId: reserved.assignment.id, policy };
}

function applyNativeCall(fixture: ReturnType<typeof nativeCoreFixture>) {
  const { state, t0, reservationId } = fixture;
  telephonyCore.registerCallBinding(state, {
    callControlId: 'SYNTHETIC_NATIVE_WORKFLOW_CALL', reservationId, actorId: DEMO_ACTOR, registeredAtMs: t0 + 1000,
  });
  const applied = telephonyCore.applyTelnyxEvent(state, { data: {
    record_type: 'event', id: 'synthetic-native-workflow-initiation', event_type: 'call.initiated',
    occurred_at: new Date(t0 + 10_000).toISOString(),
    payload: { call_control_id: 'SYNTHETIC_NATIVE_WORKFLOW_CALL', direction: 'outgoing' },
  } }, { nowMs: t0 + 60_000 });
  assert.equal(applied.status, 'applied');
  const measurement = fixture.lead.telephony as Record<string, unknown>;
  assert.equal(measurement.timeToFirstCallMs, 10_000);
  assert.equal(measurement.humanContactVerified, false);
}

describe('read-only sales workflow with synthetic evidence', () => {
  it('replays stable case-bound facts/results without creating drafts or changing state', () => {
    const state = createOfficeFixtureState(AT);
    const before = canonical(state);
    for (const caseId of CASE_IDS) {
      const first = readSalesWorkflow(state, caseId, AT);
      assert.deepEqual(readSalesWorkflow(state, caseId, AT), first);
      assert.match(first.digest, /^[a-f0-9]{64}$/);
      assert.equal(new Set(first.facts.map(row => row.id)).size, first.facts.length);
      assert.equal(new Set(first.tasks.map(row => row.id)).size, first.tasks.length);
      assert.equal(new Set(first.results.map(row => row.id)).size, first.results.length);
      for (const kind of factKinds) {
        const row = fact(first, caseId, kind);
        const result = first.results.find(result => result.id === row.id);
        assert(result, `Missing result for ${row.id}`);
        const functionId = kind === 'ledger' ? 'finance' : kind === 'supplier' ? 'suppliers' : 'sales';
        assert.equal(row.functionId, functionId);
        assert.equal(result.functionId, functionId);
        assert.equal(result.area, FUNCTION_AREAS[functionId]);
      }
      for (const row of [...first.facts, ...first.tasks, ...first.results]) assert(row.id.startsWith(`workflow-${caseId}-`));
    }
    assert.equal(canonical(state), before, 'a workflow read must not create drafts, approvals, commands, or history');
  });

  it('returns independently cloned evidence and performs no outbound request', t => {
    const state = createOfficeFixtureState(AT);
    const before = canonical(state);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden in sales workflow test'); });
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
    const sale = fact(workflow, 'demo-aurora', 'sale');
    const saleResult = workflow.results.find(row => row.id === sale.id)!;
    assert(sale.evidence);
    assert.deepEqual(saleResult.evidence, sale.evidence);
    assert.notStrictEqual(saleResult.evidence, sale.evidence);
    assert.notStrictEqual(sale.evidence, state.office.cases['demo-aurora'].evidence);
    sale.evidence.reference = 'consumer-mutated-fact';
    saleResult.evidence.reference = 'consumer-mutated-result';
    const replay = readSalesWorkflow(state, 'demo-aurora', AT);
    assert(!JSON.stringify(replay).includes('consumer-mutated'));
    assert.equal(canonical(state), before);
  });

  it('partitions planner facts before composing a sales-only body, excluding financial values and supplier evidence', () => {
    const state = createOfficeFixtureState(AT);
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
    const salesFacts = workflow.facts.filter(row => row.functionId === 'sales');
    assert.deepEqual(salesFacts.map(row => row.id).sort(), ['closer', 'call-attempt', 'human-contact', 'sale', 'followup'].map(kind => `workflow-demo-aurora-${kind}`).sort());
    const salesBody = JSON.stringify(salesFacts);
    for (const restricted of ['totalCents=', 'paidCents=', 'balanceCents=', '7490', '3745', 'supplier-pending']) assert(!salesBody.includes(restricted), restricted);
    assert.equal(fact(workflow, 'demo-aurora', 'ledger').functionId, 'finance');
    assert.equal(fact(workflow, 'demo-aurora', 'supplier').functionId, 'suppliers');
  });

  it('reports unknown closer availability without an explicit core profile, regardless of fixture flags', () => {
    const state = createOfficeFixtureState(AT);
    assert.equal(state.office.cases['demo-aurora'].closerAvailable, true);
    assert.equal(state.office.cases['demo-harbor'].closerAvailable, false);
    for (const caseId of CASE_IDS) assert.match(fact(readSalesWorkflow(state, caseId, AT), caseId, 'closer').detail, unknown);
  });

  it('recognizes an explicitly active, bound sales closer with valid availability, shift and capacity', () => {
    const state = createOfficeFixtureState(AT);
    closer(state);
    const detail = fact(readSalesWorkflow(state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail;
    assert.match(detail, /available(?:=true)?|disponible/i);
    assert.doesNotMatch(detail, /unavailable|no disponible|sin disponibilidad|available=false|desconocid|unknown/i);
  });

  it('refuses inactive, expired, out-of-shift, ungranted and zero-capacity profiles', () => {
    for (const overrides of [
      { active: false }, { availableUntilMs: AT }, { shiftStartMs: AT + 1 },
      { shiftEndMs: AT }, { departmentIds: ['finance'] }, { capacity: 0 },
    ]) {
      const state = createOfficeFixtureState(AT);
      closer(state, overrides);
      const detail = fact(readSalesWorkflow(state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail;
      assert.match(detail, /unavailable|no disponible|sin disponibilidad|available=false|disponible=false/i, JSON.stringify(overrides));
    }
  });

  it('does not accept presence or a foreign actor as proof of an available closer', () => {
    for (const profile of [{ active: true, presence: 'active' }, { actorId: 'unbound-synthetic-actor' }]) {
      const state = createOfficeFixtureState(AT);
      if ('presence' in profile) state.closers[DEMO_ACTOR] = profile;
      else closer(state, profile);
      const detail = fact(readSalesWorkflow(state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail;
      assert.match(detail, /unavailable|no disponible|sin disponibilidad|available=false|disponible=false|unknown|desconocid|null/i);
    }
  });

  it('separates the 20-second attempt from 35-second verified human contact and preserves unknown timing', () => {
    const state = createOfficeFixtureState(AT);
    const aurora = readSalesWorkflow(state, 'demo-aurora', AT);
    assert.match(fact(aurora, 'demo-aurora', 'call-attempt').detail, /20\s*(?:s\b|seg|second)|(?:seconds|segundos)=20\b/i);
    const human = fact(aurora, 'demo-aurora', 'human-contact').detail;
    assert.match(human, /35\s*(?:s\b|seg|second)|(?:seconds|segundos)=35\b/i);
    for (const kind of ['call-attempt', 'human-contact'] as const) {
      const detail = fact(readSalesWorkflow(state, 'demo-harbor', AT), 'demo-harbor', kind).detail;
      assert.match(detail, unknown);
      assert.doesNotMatch(detail, /(?:seconds|segundos)=0\b|\b0\s*(?:s\b|segundos\b|seconds\b)/i);
    }
    assert.match(fact(readSalesWorkflow(state, 'demo-cedar', AT), 'demo-cedar', 'human-contact').detail, unknown);
  });

  it('prefers verified core call occurrence over the fixture and never turns provider events into human contact', () => {
    const state = createOfficeFixtureState(AT); verifiedCall(state);
    const before = canonical(state);
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
    const attempt = fact(workflow, 'demo-aurora', 'call-attempt');
    assert.match(attempt.detail, /10\s*(?:s\b|seg|second)|(?:seconds|segundos)=10\b/i);
    assert.doesNotMatch(attempt.detail, /(?:seconds|segundos)=20\b|20\s*s\b/i);
    assert(attempt.evidence.reference.includes('workflow-synthetic-call'));
    assert.match(fact(workflow, 'demo-aurora', 'human-contact').detail, unknown);
    assert.equal(canonical(state), before);
  });

  it('does not fall back to known fixture timings when core evidence is future, foreign or inconsistent', () => {
    for (const corrupt of [
      (state: OfficeState) => { (state.callEvents['workflow-synthetic-call'] as Record<string, unknown>).webhookReceivedAtMs = AT + 1; },
      (state: OfficeState) => { (state.callEvents['workflow-synthetic-call'] as Record<string, unknown>).leadId = 'foreign-synthetic-lead'; },
      (state: OfficeState) => { (state.callEvents['workflow-synthetic-call'] as Record<string, unknown>).status = 'ignored'; },
      (state: OfficeState) => { const lead = state.leads['lead-demo-aurora'] as { telephony: Record<string, unknown> }; lead.telephony.slaStatus = 'measurement_unverified'; },
      (state: OfficeState) => { const lead = state.leads['lead-demo-aurora'] as { telephony: Record<string, unknown> }; lead.telephony.firstCallInitiatedAtMs = AT; },
    ]) {
      const state = createOfficeFixtureState(AT); verifiedCall(state); corrupt(state);
      const before = canonical(state);
      const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
      assert.match(fact(workflow, 'demo-aurora', 'call-attempt').detail, unknown);
      assert.match(fact(workflow, 'demo-aurora', 'human-contact').detail, unknown);
      assert.equal(canonical(state), before);
    }
  });

  it('keeps digests stable across time without state changes until an observed eligibility threshold changes', () => {
    const state = createOfficeFixtureState(AT);
    const original = readSalesWorkflow(state, 'demo-aurora', AT);
    const later = readSalesWorkflow(state, 'demo-aurora', AT + 1000);
    assert.equal(original.digest, later.digest);
    assert.deepEqual(original.tasks.map(row => row.id), later.tasks.map(row => row.id));
    assert.deepEqual(original.results.map(row => row.id), later.results.map(row => row.id));
    const capturedAtMs = Date.parse(state.office.cases['demo-harbor'].capturedAt);
    const beforeThreshold = readSalesWorkflow(state, 'demo-harbor', capturedAtMs + 29_000);
    assert.equal(beforeThreshold.digest, readSalesWorkflow(state, 'demo-harbor', capturedAtMs + 29_999).digest);
    const atThreshold = readSalesWorkflow(state, 'demo-harbor', capturedAtMs + 30_000);
    assert.notEqual(atThreshold.digest, beforeThreshold.digest);
    assert.equal(atThreshold.digest, readSalesWorkflow(state, 'demo-harbor', capturedAtMs + 30_001).digest);
    assert.match(fact(atThreshold, 'demo-harbor', 'call-attempt').detail, /human/i);
    closer(state);
    assert.notEqual(readSalesWorkflow(state, 'demo-aurora', AT).digest, readSalesWorkflow(state, 'demo-aurora', AT + 60_000).digest);
  });

  it('projects an explicitly blocked followup fact/result while response, payment and channel signals are unknown', () => {
    const state = createOfficeFixtureState(AT);
    const before = canonical(state);
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
    const followup = fact(workflow, 'demo-aurora', 'followup');
    const result = workflow.results.find(row => row.id === followup.id)!;
    assert.equal(followup.functionId, 'sales'); assert.equal(result.functionId, 'sales');
    assert.match(followup.detail, /blocked|bloquead/i);
    assert.match(followup.detail, /null|unknown|desconocid/i);
    assert.deepEqual(result.evidence, followup.evidence);
    assert.equal(canonical(state), before, 'visibility of the followup must not create a scheduled job');
  });

  it('keeps the verified partial payment distinct from settlement and raises a local human finance alert', () => {
    const state = createOfficeFixtureState(AT);
    const before = canonical(state);
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT);
    const ledger = fact(workflow, 'demo-aurora', 'ledger');
    for (const value of ['totalCents=7490', 'paidCents=3745', 'balanceCents=3745']) assert(ledger.detail.includes(value), ledger.detail);
    assert.match(ledger.detail, /partial|parcial|anticipo/i);
    const task = workflow.tasks.find(row => row.id === alertId('demo-aurora'));
    const result = workflow.results.find(row => row.id === alertId('demo-aurora'));
    assert(task); assert(result);
    assert.equal(task.functionId, 'finance'); assert.equal(task.area, 'finance'); assert.equal(task.status, 'blocked');
    assert.equal(result.functionId, 'finance'); assert.equal(result.area, 'finance');
    for (const row of [task, result]) {
      const text = `${row.title} ${row.detail}`;
      assert.match(text, /inmediat|immediate/i);
      assert.match(text, /human/i);
      assert.match(text, /local|sin env[ií]o|sin enviar|no send/i);
      assert.deepEqual(row.evidence, ledger.evidence);
      assert.notStrictEqual(row.evidence, ledger.evidence);
    }
    assert.equal(canonical(state), before);
  });

  it('keeps the paid-without-supplier alert for unknown supplier but removes it for independently accepted supplier', () => {
    const state = createOfficeFixtureState(AT);
    state.office.cases['demo-aurora'].supplier = 'unknown';
    state.office.cases['demo-aurora'].supplierEvidence = null;
    assert(readSalesWorkflow(state, 'demo-aurora', AT).tasks.some(row => row.id === alertId('demo-aurora')));
    state.office.cases['demo-aurora'].supplier = 'accepted';
    state.office.cases['demo-aurora'].supplierEvidence = structuredClone(state.office.cases['demo-cedar'].supplierEvidence);
    state.office.cases['demo-aurora'].supplierEvidence!.reference = 'demo:demo-aurora:supplier-accepted';
    assertNoAlert(readSalesWorkflow(state, 'demo-aurora', AT), 'demo-aurora');
  });

  it('reports settlement only after the remaining synthetic balance is confirmed', () => {
    const state = createOfficeFixtureState(AT);
    paymentCore.applyConfirmedPayment(state, {
      provider: 'OFFICE_FIXTURE_PAYMENTS', eventId: 'payment-demo-aurora-balance', transactionId: 'transaction-demo-aurora-balance',
      providerInvoiceId: 'provider-invoice-demo-aurora', invoiceId: 'invoice-demo-aurora', gourmetEventId: 'demo-aurora',
      amountCents: 3745, currency: 'USD', status: 'confirmed', occurredAtMs: AT + 1,
    }, { nowMs: AT + 1 });
    const workflow = readSalesWorkflow(state, 'demo-aurora', AT + 1);
    const detail = fact(workflow, 'demo-aurora', 'ledger').detail;
    for (const value of ['totalCents=7490', 'paidCents=7490', 'balanceCents=0']) assert(detail.includes(value), detail);
    assert.match(detail, /settled|liquidado|pago completo|pagado (?:por )?completo/i);
    assert(workflow.tasks.some(row => row.id === alertId('demo-aurora')), 'settlement does not establish supplier acceptance');
  });

  it('does not infer a paid ledger or supplier alert from the case payment flag when the ledger is absent', () => {
    const state = createOfficeFixtureState(AT);
    state.invoices = {};
    assert.equal(state.office.cases['demo-aurora'].payment, 'verified');
    const before = canonical(state);
    assertUnknownLedger(readSalesWorkflow(state, 'demo-aurora', AT));
    assert.equal(canonical(state), before);
  });

  it('does not let another case corrupt ledger block or change the authoritative Aurora digest and alert', () => {
    const state = createOfficeFixtureState(AT);
    const original = readSalesWorkflow(state, 'demo-aurora', AT);
    state.invoices['invoice-demo-cedar-corrupt'] = {
      invoiceId: 'invoice-demo-cedar-corrupt', eventId: 'demo-cedar', provider: 'OFFICE_FIXTURE_PAYMENTS',
      providerInvoiceId: 'provider-invoice-demo-cedar-corrupt', currency: 'USD',
      totalCents: 10_000, paidCents: 5000, balanceCents: 9999, receiptIds: ['missing-synthetic-receipt'],
    };
    const before = canonical(state);
    const withForeignCorruption = readSalesWorkflow(state, 'demo-aurora', AT);
    assert.deepEqual(withForeignCorruption, original);
    assert(withForeignCorruption.tasks.some(row => row.id === alertId('demo-aurora')));
    assert.equal(canonical(state), before);
    Object.assign(state.invoices['invoice-demo-cedar-corrupt'] as object, { paidCents: 1, totalCents: 20_000, balanceCents: -1 });
    assert.equal(readSalesWorkflow(state, 'demo-aurora', AT).digest, original.digest);
    assert.equal(readSalesWorkflow(state, 'demo-cedar', AT).facts.find(row => row.id === 'workflow-demo-cedar-ledger')!.detail.includes('paidCents=null'), true);
  });

  it('reads a valid zero-receipt invoice without initializing payment transactions or events', () => {
    const state = createOfficeFixtureState(AT);
    paymentCore.registerInvoice(state, {
      invoiceId: 'invoice-demo-cedar-unpaid', eventId: 'demo-cedar', provider: 'OFFICE_FIXTURE_PAYMENTS',
      providerInvoiceId: 'provider-invoice-demo-cedar-unpaid', currency: 'USD', totalCents: 7490,
    });
    state.payments = {};
    const before = canonical(state);
    const ledger = paymentReader.readVerifiedInvoiceLedger(state, 'invoice-demo-cedar-unpaid');
    assert(ledger);
    assert.equal(ledger.totalCents, 7490); assert.equal(ledger.paidCents, 0); assert.equal(ledger.balanceCents, 7490);
    assert.equal(Object.hasOwn(state.payments, 'transactions'), false);
    assert.equal(Object.hasOwn(state.payments, 'events'), false);
    assert.equal(canonical(state), before);
  });

  const corruptions: Array<[string, (state: OfficeState) => void]> = [
    ['inconsistent balance', state => { (state.invoices['invoice-demo-aurora'] as Record<string, unknown>).balanceCents = 7490; }],
    ['amounts inconsistent with receipts', state => { Object.assign(state.invoices['invoice-demo-aurora'] as object, { paidCents: 0, balanceCents: 7490 }); }],
    ['missing receipt', state => { state.payments.transactions = {}; }],
    ['changed receipt amount', state => { const rows = state.payments.transactions as Record<string, Record<string, unknown>>; Object.values(rows)[0].amountCents = 1; }],
    ['duplicate receipt reference', state => { const invoice = state.invoices['invoice-demo-aurora'] as { receiptIds: string[] }; invoice.receiptIds.push(invoice.receiptIds[0]); }],
  ];
  for (const [label, corrupt] of corruptions) it(`fails closed for ${label} without repairing state or inventing an alert`, () => {
    const state = createOfficeFixtureState(AT); corrupt(state);
    const before = canonical(state);
    assertUnknownLedger(readSalesWorkflow(state, 'demo-aurora', AT));
    assert.equal(canonical(state), before);
  });

  it('retains the human-sale prerequisite in the supplier fact without performing supplier work', () => {
    const state = createOfficeFixtureState(AT);
    const before = canonical(state);
    const workflow = readSalesWorkflow(state, 'demo-harbor', AT);
    const sale = fact(workflow, 'demo-harbor', 'sale').detail;
    assert.match(sale, /false|open|abiert|no .*cerrad|sin cierre/i);
    assert.match(sale, /chef.*bloquead|b[uú]squeda.*bloquead/i);
    assert.match(fact(workflow, 'demo-harbor', 'supplier').detail, /sin aceptaci[oó]n|pendiente|unknown|desconocid/i);
    assert.equal(canonical(state), before);
  });

  it('filters merged workflow rows by case/function scope and keeps the finance alert out of sales-only reads', () => {
    const snapshot = mergedSnapshot(createOfficeFixtureState(AT));
    const before = canonical(snapshot);
    const sales = scopeSnapshot(snapshot, scoped(['sales']));
    const finance = scopeSnapshot(snapshot, scoped(['finance']));
    for (const [result, functionId] of [[sales, 'sales'], [finance, 'finance']] as const) {
      assert.deepEqual(result.cases.map(row => row.id), ['demo-aurora']);
      for (const row of [...result.cases[0].tasks, ...result.cases[0].results]) assert.equal(row.functionId, functionId);
      assert(!JSON.stringify(result).includes('workflow-demo-cedar-'));
      assert(!JSON.stringify(result).includes('workflow-demo-harbor-'));
    }
    assert(!sales.cases[0].tasks.some(row => row.id === alertId('demo-aurora')));
    assert(!sales.cases[0].results.some(row => row.id === alertId('demo-aurora')));
    assert(finance.cases[0].tasks.some(row => row.id === alertId('demo-aurora')));
    assert(finance.cases[0].results.some(row => row.id === alertId('demo-aurora')));
    assert(!Object.hasOwn(finance.cases[0], 'commercialThreads'));
    assert.equal(canonical(snapshot), before);
  });
});

describe('workflow visibility in a bounded snapshot', () => {
  it('preserves the older paid-without-supplier alert and ledger when over 1000 newer rows require partial coverage', () => {
    const state = createOfficeFixtureState(AT);
    for (let index = 0; index < 1005; index++) {
      const id = `synthetic-workflow-overflow-${index}`;
      const row = { id, functionId: 'sales' as const, area: FUNCTION_AREAS.sales,
        title: 'Registro sintético reciente', detail: 'Fixture de cobertura parcial; sin acción ni envío.',
        evidence: evidence('demo-aurora', id, AT + index + 1) };
      state.office.jobs[id] = { ...row, caseId: 'demo-aurora', status: 'completed' };
      state.office.cases['demo-aurora'].results.push({ ...row, evidence: structuredClone(row.evidence) });
    }
    const before = canonical(state);
    const snapshot = projectOfficeSnapshot(state, AT + 2000);
    const projected = snapshot.cases.find(row => row.id === 'demo-aurora')!;
    assert.equal(snapshot.hasMore, true);
    assert.equal(projected.tasks.length, 1000);
    assert.equal(projected.results.length, 1000);
    const alert = projected.tasks.find(row => row.id === alertId('demo-aurora'));
    assert(alert, 'urgent workflow task must remain visible despite its older ledger evidence');
    assert.equal(alert.status, 'blocked');
    assert.equal(alert.functionId, 'finance');
    assert(projected.results.some(row => row.id === alertId('demo-aurora')));
    const ledger = projected.results.find(row => row.id === 'workflow-demo-aurora-ledger');
    assert(ledger, 'verified ledger must remain visible in the partial projection');
    assert.match(ledger.detail, /paidCents=3745/);
    assert.match(ledger.detail, /balanceCents=3745/);

    const financeRead = scopeSnapshot(snapshot, scoped(['finance']));
    assert.equal(financeRead.cases.length, 1);
    assert(financeRead.cases[0].tasks.some(row => row.id === alertId('demo-aurora')));
    assert(financeRead.cases[0].results.some(row => row.id === ledger.id));
    assert(financeRead.cases[0].tasks.every(row => row.functionId === 'finance'));
    assert(financeRead.cases[0].results.every(row => row.functionId === 'finance'));
    const salesRead = scopeSnapshot(snapshot, scoped(['sales']));
    assert(!salesRead.cases[0].tasks.some(row => row.id === alertId('demo-aurora')));
    assert(!salesRead.cases[0].results.some(row => row.id === ledger.id || row.id === alertId('demo-aurora')));
    const otherCase = scopeSnapshot(snapshot, scoped(['finance'], ['demo-cedar']));
    assert.equal(otherCase.cases.length, 1);
    assert.equal(otherCase.cases[0].id, 'demo-cedar');
    assert(!otherCase.cases[0].results.some(row => row.id.startsWith('workflow-demo-aurora-')));
    assert.equal(canonical(state), before, 'bounded projection and later scoping stay pure');
  });
});

describe('workflow projection through native assignment and telephony core', () => {
  it('keeps an accepted own reservation available at full capacity and native reserve replay consumes one slot', () => {
    const fixture = nativeCoreFixture();
    const replay = assignmentCore.reserveLead(fixture.state, { leadId: fixture.leadId, nowMs: fixture.t0 + 2000, acceptanceTimeoutMs: 15_000 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.assignment.id, fixture.reservationId);
    assert.equal(Object.values(fixture.state.assignments).filter(row => (row as Record<string, unknown>).status === 'accepted').length, 1);
    const before = canonical(fixture.state);
    assert.match(fact(readSalesWorkflow(fixture.state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail, /verificada: disponible/);
    assert.equal(canonical(fixture.state), before);
  });

  for (const shape of ['id-only', 'alias-only'] as const) {
    it(`reads an actual captured and accepted lead persisted as ${shape}, including applied native initiation`, () => {
      const fixture = nativeCoreFixture();
      if (shape === 'id-only') delete fixture.lead.leadId;
      else delete fixture.lead.id;
      applyNativeCall(fixture);
      const before = canonical(fixture.state);
      const workflow = readSalesWorkflow(fixture.state, 'demo-aurora', AT);
      assert.match(fact(workflow, 'demo-aurora', 'closer').detail, /verificada: disponible/);
      assert.match(fact(workflow, 'demo-aurora', 'call-attempt').detail, /attemptSeconds=10(?:;|\b)/);
      assert.match(fact(workflow, 'demo-aurora', 'call-attempt').detail, /objetivo 30 s cumplido/);
      assert.match(fact(workflow, 'demo-aurora', 'human-contact').detail, /connectedSeconds=null/);
      assert.equal(canonical(fixture.state), before);
    });
  }

  it('fails unknown for contradictory persisted id/leadId instead of attributing a reservation or initiation', () => {
    const fixture = nativeCoreFixture();
    applyNativeCall(fixture);
    fixture.lead.leadId = 'contradictory-native-identity';
    const before = canonical(fixture.state);
    const workflow = readSalesWorkflow(fixture.state, 'demo-aurora', AT);
    assert.match(fact(workflow, 'demo-aurora', 'closer').detail, unknown);
    assert.match(fact(workflow, 'demo-aurora', 'call-attempt').detail, /attemptSeconds=null/);
    assert.equal(canonical(fixture.state), before);
  });

  it('does not prove available capacity after two real reservations are accepted and policy capacity is reduced to one', () => {
    const fixture = nativeCoreFixture(2);
    const second = assignmentCore.captureLead(fixture.state, {
      leadId: 'native-workflow-shared-capacity', departmentId: 'sales', captureSource: 'WORKFLOW_SYNTHETIC_CORE',
      capturedAtMs: fixture.t0 + 2000, nowMs: fixture.t0 + 2000,
    });
    (fixture.state.leads[second.lead.id] as Record<string, unknown>).gourmetEventId = 'demo-cedar';
    const reserved = assignmentCore.reserveLead(fixture.state, {
      leadId: second.lead.id, nowMs: fixture.t0 + 2000, acceptanceTimeoutMs: 15_000,
    });
    assert.equal(assignmentCore.acceptReservation(fixture.state, {
      reservationId: reserved.assignment.id, closerId: DEMO_ACTOR, nowMs: fixture.t0 + 3000,
    }).accepted, true);
    assignmentCore.setCloserAvailability(fixture.state, { ...fixture.policy, capacity: 1, nowMs: fixture.t0 + 4000 });
    const before = canonical(fixture.state);
    const detail = fact(readSalesWorkflow(fixture.state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail;
    assert.doesNotMatch(detail, /verificada: disponible/);
    assert.equal(canonical(fixture.state), before);
  });

  it('fails unknown for duplicated persisted active ownership instead of counting two slots as a valid own reservation', () => {
    const fixture = nativeCoreFixture(2);
    const duplicateId = 'duplicated-active-native-reservation';
    fixture.state.assignments[duplicateId] = { ...(fixture.state.assignments[fixture.reservationId] as Record<string, unknown>), id: duplicateId, reservationId: duplicateId };
    const before = canonical(fixture.state);
    assert.match(fact(readSalesWorkflow(fixture.state, 'demo-aurora', AT), 'demo-aurora', 'closer').detail, unknown);
    assert.equal(canonical(fixture.state), before);
  });
});

describe('followup decision requires explicit known signals and response channel', () => {
  const signals = ['replied', 'paid', 'rejected', 'unsubscribed'] as const;
  const eligible: Followup = { replied: false, paid: false, rejected: false, unsubscribed: false, responseChannel: 'email' };
  for (const signal of signals) {
    for (const restUnknown of [false, true]) it(`stops for ${signal}=true even when other signals are ${restUnknown ? 'unknown' : 'false'}`, () => {
      const input: Followup = restUnknown ? { replied: null, paid: null, rejected: null, unsubscribed: null, responseChannel: null } : { ...eligible };
      input[signal] = true;
      const before = structuredClone(input);
      const result = evaluateFollowup(input);
      assert.equal(result.state, 'stopped'); assert.equal(result.channel, input.responseChannel);
      assert(result.reasons.length > 0);
      assert.deepEqual(input, before);
      assert.deepEqual(evaluateFollowup(input), result);
    });
  }
  for (const key of [...signals, 'responseChannel'] as const) it(`blocks when ${key} remains unknown and no stopping signal is true`, () => {
    const input: Followup = { ...eligible, [key]: null };
    const result = evaluateFollowup(input);
    assert.equal(result.state, 'blocked'); assert.equal(result.channel, input.responseChannel);
    assert(result.reasons.length > 0);
  });
  for (const responseChannel of ['email', 'sms'] as const) it(`allows known false signals only on the explicit ${responseChannel} response channel`, () => {
    const input: Followup = { ...eligible, responseChannel };
    const before = structuredClone(input);
    const result = evaluateFollowup(input);
    assert.equal(result.state, 'eligible'); assert.equal(result.channel, responseChannel);
    assert(Array.isArray(result.reasons));
    assert.deepEqual(input, before);
  });
  it('does not turn unknown signals into false or choose a default response channel', () => {
    for (const responseChannel of [null, 'email', 'sms'] as const) {
      const result = evaluateFollowup({ replied: null, paid: null, rejected: null, unsubscribed: null, responseChannel });
      assert.equal(result.state, 'blocked'); assert.equal(result.channel, responseChannel);
      assert(result.reasons.length > 0);
    }
  });
});
