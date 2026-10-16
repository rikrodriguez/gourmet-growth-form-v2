import type { OfficeCommand } from '../contracts';
import { createHash } from 'node:crypto';
import { MILESTONE_LABELS, OPERATIONAL_MILESTONES, operationalFunction, validateOperationalRecord } from '../operational-contracts';
import type { OperationalIncident, OperationalOperation, OperationalPolicy, OperationalProof, OperationalRecord, OperationalWorkflow } from '../operational-contracts';
import type { SupplySelection, SupplyPurchaseOption } from '../supply-contracts';
import type { DemoCaseId, OfficeState } from './state';
import { CASE_IDS, DEMO_ACTOR, OfficeError, evidence, sha256 } from './state';
import { assertSupplyReviewCurrent, ensureSupplyWorkflow } from './supply-workflow';

// This is an immutable fixture, not a configurable commercial policy. In
// particular it accepts an INTERNAL reservation only for a synthetic rehearsal.
const POLICY: OperationalPolicy = {
  id: 'ops-policy-synthetic-v1', label: 'Política sintética v1 · sólo ensayo DEMO', scope: 'synthetic_rehearsal_only',
  requirements: ['Reserva interna DEMO activa y selección vigente; no acredita aceptación real.', 'Menú/lista/opción aprobados DEMO y recepción completa con contenido verificable.', 'Cuatro hitos ficticios: preparación, montaje, servicio y entrega; sin reglas alimentarias.', 'Incidencias resueltas con evidencia vigente; el actor DEMO puede registrar y revisar el ensayo.', 'Sin SLA, firmantes comerciales, ejecución real ni cierre financiero.'],
};
const fixtureId = (caseId: string, suffix: string) => `ops-${caseId}-${suffix}`;
const contentHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
function recordsFor(state: OfficeState, caseId: DemoCaseId) { return state.office.operational?.cases[caseId]?.records ?? []; }
function approvalFact(state: OfficeState, approvalId: string | null | undefined) {
  const link = approvalId ? state.office.approvals[approvalId] : null;
  return link ? { id: link.id, revision: link.revision, digest: link.digest, status: link.status, coreApprovalId: link.coreApprovalId ?? null, valid: !!link.coreApprovalId && state.approvals[link.coreApprovalId]?.valid === true } : null;
}
function reviewCurrent(state: OfficeState, caseId: DemoCaseId, record: SupplySelection | SupplyPurchaseOption | undefined | null, kind: 'selection' | 'purchase', atMs: number) {
  const link = record?.approvalId ? state.office.approvals[record.approvalId] : undefined;
  const context = link?.supplyContext;
  if (!record || record.reviewStatus !== 'approved_demo' || link?.status !== 'approved_demo' || !link.coreApprovalId || state.approvals[link.coreApprovalId]?.valid !== true || context?.kind !== kind || (context.kind === 'selection' ? context.selectionId : context.optionId) !== record.id) return false;
  try { assertSupplyReviewCurrent(state, context, caseId, atMs); return true; }
  catch (error) { if (error instanceof OfficeError) return false; throw error; }
}

function dependencies(state: OfficeState, caseId: DemoCaseId) {
  const supply = state.office.supply!.cases[caseId], item = state.office.cases[caseId];
  const assignments = Object.values(state.office.supply!.assignments).filter(a => a.caseId === caseId && a.status === 'assigned_demo').map(a => ({ assignment: a, selection: supply.selections[a.selectionId], candidate: supply.candidates[a.candidateId], approval: approvalFact(state, a.approvalId) }));
  const option = supply.selectedOptionId ? supply.options[supply.selectedOptionId] : null;
  // No payment/financial state participates in an operational rehearsal.
  const content = { case: { id: item.id, title: item.title, subtitle: item.subtitle, saleClosed: item.saleClosed, supplier: item.supplier, supplierEvidence: item.supplierEvidence }, event: supply.event, assignments, menu: supply.menu, list: supply.list, option, optionApproval: approvalFact(state, option?.approvalId) };
  return { supply, assignments, option, digest: sha256(content) };
}

export function assertOperationalState(state: OfficeState) {
  const stored = state.office.operational;
  if (stored === undefined) return; // Old aggregates are never reseeded.
  const invalid = () => { throw new OfficeError('OPERATIONAL_STATE_INVALID', 503); };
  if (stored.schemaVersion !== 1 || !stored.cases || Object.keys(stored).some(k => !['schemaVersion', 'cases'].includes(k))) return invalid();
  for (const [caseId, row] of Object.entries(stored.cases)) {
    if (!(CASE_IDS as readonly string[]).includes(caseId) || row.caseId !== caseId || Object.keys(row).some(k => !['caseId', 'eventId', 'records'].includes(k)) || row.eventId !== state.office.supply?.cases[caseId]?.event.id || !Array.isArray(row.records) || row.records.length > 200) return invalid();
    const ids = new Set<string>();
    for (const [i, record] of row.records.entries()) {
      if (!validateOperationalRecord(record, caseId) || record.eventId !== row.eventId || record.revision !== i + 1 || ids.has(record.id)) return invalid();
      ids.add(record.id);
      const { digest, ...content } = record;
      if (digest !== sha256(content) || record.proof && record.proof.contentHash !== (record.proof.content === null ? null : contentHash(record.proof.content))) return invalid();
    }
  }
}

export function projectOperationalWorkflow(state: OfficeState, caseId: DemoCaseId, atMs: number): OperationalWorkflow {
  ensureSupplyWorkflow(state, atMs);
  const d = dependencies(state, caseId), records = recordsFor(state, caseId), newest = [...records].reverse();
  const last = (step: OperationalOperation['step']) => newest.find(r => r.operation.step === step);
  const selectedPolicy = last('set_policy');
  const policy = selectedPolicy?.operation.step === 'set_policy' && selectedPolicy.operation.policyFixtureId === POLICY.id ? structuredClone(POLICY) : null;
  const receipt = last('record_receipt');
  const current = (r: OperationalRecord | undefined) => !!r && r.operation.contextDigest === d.digest;
  const milestones = OPERATIONAL_MILESTONES.map(id => {
    const r = newest.find(r => r.operation.step === 'confirm_milestone' && r.operation.milestone === id);
    return { id, label: MILESTONE_LABELS[id], current: current(r) && r!.proof?.status === 'verified_demo', recordId: r?.id ?? null };
  });
  const incidents: OperationalIncident[] = records.filter(r => r.operation.step === 'open_incident').map(r => {
    const open = r.operation as Extract<OperationalOperation, { step: 'open_incident' }>;
    const resolution = newest.find(x => x.operation.step === 'resolve_incident' && x.operation.incidentId === r.id);
    const acknowledged = records.some(x => x.operation.step === 'acknowledge_incident' && x.operation.incidentId === r.id);
    return { id: r.id, description: open.description, owner: open.owner, status: resolution ? 'resolved_demo' : acknowledged ? 'acknowledged' : 'open', current: current(resolution), resolutionId: resolution?.id ?? null };
  });
  const blockers: string[] = [];
  if (!policy) blockers.push('Falta política operativa; no se infieren mínimos ni firmante.');
  if (state.office.cases[caseId].saleClosed !== true) blockers.push('Falta cierre humano de venta en el fixture.');
  if (d.assignments.length !== 1 || d.assignments.some(a => !reviewCurrent(state, caseId, a.selection, 'selection', atMs) || a.selection?.assignedDemo !== true || a.assignment.selectionRevision !== a.selection.revision || a.assignment.approvalId !== a.selection.approvalId || sha256(a.assignment.window) !== sha256(d.supply.event.window))) blockers.push('Falta reserva interna DEMO activa con selección vigente.');
  if (!reviewCurrent(state, caseId, d.option, 'purchase', atMs) || Date.parse(d.supply.event.window.endAt) <= atMs) blockers.push('Falta abastecimiento aprobado DEMO y vigente para este evento.');
  if (!current(receipt) || receipt?.proof?.status !== 'verified_demo') blockers.push('Falta recepción completa con contenido verificable y dependencias vigentes.');
  for (const m of milestones) if (!m.current) blockers.push(`Falta evidencia vigente del hito: ${m.label}.`);
  if (incidents.some(i => i.status !== 'resolved_demo' || !i.current)) blockers.push('Hay incidencias abiertas o resoluciones obsoletas.');
  const close = last('close_demo');
  const closed = records.at(-1) === close && !!close && current(close) && !blockers.length;
  const status = closed ? 'closed_demo' : close ? 'stale' : blockers.length ? 'blocked' : 'review_ready';
  return {
    schemaVersion: 1, mode: 'demo', caseId, eventId: d.supply.event.id, revision: records.length, contextDigest: d.digest, policy, policyFixtures: [structuredClone(POLICY)], blockers,
    closure: { status, reviewDigest: sha256({ caseId, eventId: d.supply.event.id, revision: records.length, contextDigest: d.digest, policy, records: records.map(r => r.digest), blockers }), recordId: close?.id ?? null },
    summary: { activeAssignmentId: d.assignments[0]?.assignment.id ?? null, selectedOptionId: d.option?.id ?? null, receipt: !receipt ? 'pending' : !current(receipt) ? 'stale' : receipt.proof!.status, milestones },
    logistics: { records: records.filter(r => r.functionId === 'logistics'), receiptFixtures: [{ id: fixtureId(caseId, 'receipt-complete'), label: 'Recepción completa · contenido sintético' }, { id: fixtureId(caseId, 'receipt-partial'), label: 'Recepción parcial · discrepancia sintética' }, { id: fixtureId(caseId, 'receipt-reference'), label: 'Referencia sin documento verificable' }], milestoneFixtures: OPERATIONAL_MILESTONES.map(milestone => ({ id: fixtureId(caseId, milestone), milestone })) },
    quality: { records: records.filter(r => r.functionId === 'quality'), incidents, resolutionFixtureId: fixtureId(caseId, 'resolution') },
  };
}

function proofFor(state: OfficeState, caseId: DemoCaseId, op: OperationalOperation, atMs: number): OperationalProof | null {
  if (!['record_receipt', 'confirm_milestone', 'resolve_incident'].includes(op.step)) return null;
  const fixture = (op as Extract<OperationalOperation, { fixtureId: string }>).fixtureId;
  const occurredAt = new Date(atMs).toISOString();
  let content: string | null, status: OperationalProof['status'] = 'verified_demo';
  let items: OperationalProof['items'] = [];
  if (op.step === 'record_receipt') {
    const { option } = dependencies(state, caseId);
    if (!option || option.reviewStatus !== 'approved_demo') throw new OfficeError('OPERATIONAL_PURCHASE_REQUIRED', 409);
    if (!['receipt-complete', 'receipt-partial', 'receipt-reference'].some(suffix => fixture === fixtureId(caseId, suffix))) throw new OfficeError('OPERATIONAL_FIXTURE_NOT_FOUND', 404);
    status = fixture.endsWith('-reference') ? 'reference_only' : fixture.endsWith('-partial') ? 'partial_demo' : 'verified_demo';
    if (option.items.some(i => i.quantity === null || i.unit === null)) throw new OfficeError('OPERATIONAL_PURCHASE_REQUIRED', 409);
    items = option.items.map((i, index) => ({ id: i.id, label: i.label, unit: i.unit!, expected: i.quantity!, received: status === 'reference_only' ? 0 : status === 'partial_demo' && index === 0 ? 0 : i.quantity! }));
    content = status === 'reference_only' ? null : JSON.stringify({ source: 'trusted-local-fixture', caseId, eventId: op.eventId, optionId: option.id, optionRevision: option.revision, kind: status, items });
  } else {
    const suffix = op.step === 'confirm_milestone' ? op.milestone : 'resolution';
    if (fixture !== fixtureId(caseId, suffix)) throw new OfficeError('OPERATIONAL_FIXTURE_NOT_FOUND', 404);
    content = JSON.stringify({ source: 'trusted-local-fixture', caseId, eventId: op.eventId, contextDigest: op.contextDigest, kind: suffix, ...(op.step === 'resolve_incident' ? { incidentId: op.incidentId, resolution: op.resolution } : {}), result: 'Comprobación sintética del ensayo; no prueba una operación real.' });
  }
  if (content !== null && content.length > 16000) throw new OfficeError('OPERATIONAL_EVIDENCE_TOO_LARGE', 409);
  return { fixtureId: fixture, status, content, contentHash: content === null ? null : contentHash(content), occurredAt, items };
}

export function applyOperationalOperation(state: OfficeState, command: OfficeCommand, atMs: number) {
  const caseId = command.caseId as DemoCaseId, op = command.operational!;
  if (command.action !== 'draft' || command.functionId !== operationalFunction(op)) throw new OfficeError('INVALID_OPERATIONAL_FUNCTION', 403);
  const view = projectOperationalWorkflow(state, caseId, atMs);
  if (op.eventId !== view.eventId) throw new OfficeError('OPERATIONAL_EVENT_MISMATCH', 409);
  if (op.revision !== view.revision || op.contextDigest !== view.contextDigest) throw new OfficeError('OPERATIONAL_REVISION_CONFLICT', 409);
  if (view.revision >= 200) throw new OfficeError('OPERATIONAL_RECORD_LIMIT', 409);
  if (op.step === 'set_policy' && op.policyFixtureId !== null && op.policyFixtureId !== POLICY.id) throw new OfficeError('OPERATIONAL_POLICY_UNKNOWN', 409);
  if (op.step === 'acknowledge_incident' || op.step === 'resolve_incident') {
    const incident = view.quality!.incidents.find(i => i.id === op.incidentId);
    if (!incident) throw new OfficeError('OPERATIONAL_INCIDENT_NOT_FOUND', 404);
    if (op.step === 'acknowledge_incident' && incident.status !== 'open' || op.step === 'resolve_incident' && incident.status === 'resolved_demo' && incident.current) throw new OfficeError('OPERATIONAL_INCIDENT_STATE_CONFLICT', 409);
  }
  if (op.step === 'close_demo' && (view.blockers.length || op.reviewDigest !== view.closure.reviewDigest || view.closure.status === 'closed_demo')) throw new OfficeError('OPERATIONAL_CLOSE_BLOCKED', 409);
  const record: Omit<OperationalRecord, 'digest'> = { id: `ops-${sha256(command.idempotencyKey).slice(0, 24)}`, caseId, eventId: view.eventId, revision: view.revision + 1, actorId: DEMO_ACTOR, functionId: operationalFunction(op), operation: structuredClone(op), proof: proofFor(state, caseId, op, atMs), evidence: evidence(caseId, `operational-${view.revision + 1}`, atMs) };
  state.office.operational ??= { schemaVersion: 1, cases: {} };
  const row = state.office.operational.cases[caseId] ??= { caseId, eventId: view.eventId, records: [] };
  row.records.push({ ...record, digest: sha256(record) });
  const titles: Record<OperationalOperation['step'], string> = { set_policy: 'Política de ensayo registrada', record_receipt: 'Recepción de ensayo registrada', confirm_milestone: 'Hito de ensayo confirmado', open_incident: 'Incidencia DEMO registrada', acknowledge_incident: 'Acuse de incidencia DEMO', resolve_incident: 'Resolución de incidencia DEMO', close_demo: 'Cierre operativo de ensayo registrado' };
  return { title: titles[op.step], detail: `DEMO — ${view.eventId}; registro revisión ${record.revision}. Actor ${DEMO_ACTOR}. Sólo ensayo sintético; sin ejecución, aceptación real ni cierre financiero.` };
}
