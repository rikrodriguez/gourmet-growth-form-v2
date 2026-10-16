import type { Evidence } from './contracts';

export const OPERATIONAL_MILESTONES = ['preparation', 'assembly', 'service', 'delivery'] as const;
export type OperationalMilestone = typeof OPERATIONAL_MILESTONES[number];
export const MILESTONE_LABELS: Record<OperationalMilestone, string> = { preparation: 'Preparación', assembly: 'Montaje', service: 'Servicio', delivery: 'Entrega' };
type Binding = { eventId: string; revision: number; contextDigest: string };
export type OperationalOperation = Binding & (
  | { step: 'set_policy'; policyFixtureId: string | null }
  | { step: 'record_receipt'; fixtureId: string }
  | { step: 'confirm_milestone'; milestone: OperationalMilestone; fixtureId: string }
  | { step: 'open_incident'; description: string; owner: 'coordination_demo' | 'quality_demo'; milestone?: OperationalMilestone }
  | { step: 'acknowledge_incident'; incidentId: string }
  | { step: 'resolve_incident'; incidentId: string; resolution: string; fixtureId: string }
  | { step: 'close_demo'; reviewDigest: string }
);
const FIELDS: Record<OperationalOperation['step'], string[]> = {
  set_policy: ['policyFixtureId'], record_receipt: ['fixtureId'], confirm_milestone: ['milestone', 'fixtureId'],
  open_incident: ['description', 'owner'], acknowledge_incident: ['incidentId'], resolve_incident: ['incidentId', 'resolution', 'fixtureId'], close_demo: ['reviewDigest'],
};
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const note = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(key => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    return typeof key === 'string' && d?.enumerable && 'value' in d;
  });
}
function exact(v: Record<string, unknown>, fields: string[]) { return Object.keys(v).length === fields.length && fields.every(key => Object.hasOwn(v, key)); }
export function isOperationalOperation(raw: unknown): raw is OperationalOperation {
  if (!object(raw) || typeof raw.step !== 'string' || !Object.hasOwn(FIELDS, raw.step)) return false;
  const fields = ['step', 'eventId', 'revision', 'contextDigest', ...FIELDS[raw.step as OperationalOperation['step']], ...(raw.step === 'open_incident' && Object.hasOwn(raw, 'milestone') ? ['milestone'] : [])];
  if (!exact(raw, fields) || !id(raw.eventId) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || (raw.revision as number) > 200 || !digest(raw.contextDigest)) return false;
  if (Object.hasOwn(raw, 'fixtureId') && !id(raw.fixtureId) || Object.hasOwn(raw, 'incidentId') && !id(raw.incidentId)) return false;
  return (raw.step !== 'set_policy' || raw.policyFixtureId === null || id(raw.policyFixtureId))
    && (raw.step !== 'confirm_milestone' || OPERATIONAL_MILESTONES.includes(raw.milestone as OperationalMilestone))
    && (raw.step !== 'open_incident' || note(raw.description) && ['coordination_demo', 'quality_demo'].includes(raw.owner as string) && (!Object.hasOwn(raw, 'milestone') || OPERATIONAL_MILESTONES.includes(raw.milestone as OperationalMilestone)))
    && (raw.step !== 'resolve_incident' || note(raw.resolution)) && (raw.step !== 'close_demo' || digest(raw.reviewDigest));
}
export const operationalFunction = (op: OperationalOperation): 'logistics' | 'quality' => ['set_policy', 'record_receipt', 'confirm_milestone'].includes(op.step) ? 'logistics' : 'quality';
export type OperationalPolicy = { id: string; label: string; scope: 'synthetic_rehearsal_only'; requirements: string[] };
export type OperationalProof = { fixtureId: string; status: 'verified_demo' | 'partial_demo' | 'reference_only'; content: string | null; contentHash: string | null; occurredAt: string; items: Array<{ id: string; label: string; unit: string; expected: number; received: number }> };
export type OperationalRecord = { id: string; caseId: string; eventId: string; revision: number; actorId: 'OFFICE_DEMO_OPERATOR'; functionId: 'logistics' | 'quality'; operation: OperationalOperation; proof: OperationalProof | null; evidence: Evidence; digest: string };
export type OperationalState = { schemaVersion: 1; cases: Record<string, { caseId: string; eventId: string; records: OperationalRecord[] }> };
export type OperationalIncident = { id: string; description: string; owner: 'coordination_demo' | 'quality_demo'; milestone: OperationalMilestone | null; status: 'open' | 'acknowledged' | 'resolved_demo'; current: boolean; resolutionId: string | null };
export type OperationalWorkflow = {
  schemaVersion: 1; mode: 'demo'; caseId: string; eventId: string; revision: number; contextDigest: string;
  policy: OperationalPolicy | null; policyFixtures: OperationalPolicy[]; blockers: string[];
  closure: { status: 'blocked' | 'review_ready' | 'closed_demo' | 'stale'; reviewDigest: string; recordId: string | null };
  summary: { activeAssignmentId: string | null; selectedOptionId: string | null; receipt: 'pending' | 'stale' | OperationalProof['status']; milestones: Array<{ id: OperationalMilestone; label: string; current: boolean; recordId: string | null }> };
  logistics?: { records: OperationalRecord[]; receiptFixtures: Array<{ id: string; label: string }>; milestoneFixtures: Array<{ id: string; milestone: OperationalMilestone }> };
  quality?: { records: OperationalRecord[]; incidents: OperationalIncident[]; resolutionFixtureId: string };
};

// Rebuild only plain, bounded, explicitly typed operational data before render.
// Hash verification against trusted fixture content also happens on the server.
export function validateOperationalRecord(v: unknown, caseId: string): v is OperationalRecord {
  if (!object(v) || !exact(v, ['id', 'caseId', 'eventId', 'revision', 'actorId', 'functionId', 'operation', 'proof', 'evidence', 'digest']) || !id(v.id) || v.caseId !== caseId || !id(v.eventId) || v.actorId !== 'OFFICE_DEMO_OPERATOR' || !isOperationalOperation(v.operation) || v.functionId !== operationalFunction(v.operation) || v.eventId !== v.operation.eventId || v.revision !== v.operation.revision + 1 || !digest(v.digest)) return false;
  const ev = v.evidence;
  if (!object(ev) || !exact(ev, ['source', 'at', 'simulated', 'reference']) || ev.source !== 'demo:office-command' || ev.simulated !== true || typeof ev.reference !== 'string' || !ev.reference.startsWith(`demo:${caseId}:`) || typeof ev.at !== 'string' || !Number.isFinite(Date.parse(ev.at))) return false;
  if (v.proof === null) return !['record_receipt', 'confirm_milestone', 'resolve_incident'].includes(v.operation.step);
  const p = v.proof;
  if (!['record_receipt', 'confirm_milestone', 'resolve_incident'].includes(v.operation.step) || !object(p) || !exact(p, ['fixtureId', 'status', 'content', 'contentHash', 'occurredAt', 'items']) || !id(p.fixtureId) || !['verified_demo', 'partial_demo', 'reference_only'].includes(p.status as string) || typeof p.occurredAt !== 'string' || !Number.isFinite(Date.parse(p.occurredAt)) || !Array.isArray(p.items) || p.items.length > 1000) return false;
  if (p.status === 'reference_only' ? p.content !== null || p.contentHash !== null : typeof p.content !== 'string' || p.content.length > 16000 || !digest(p.contentHash)) return false;
  return p.items.every(row => object(row) && exact(row, ['id', 'label', 'unit', 'expected', 'received']) && id(row.id) && typeof row.label === 'string' && row.label.length <= 200 && ['g', 'unit'].includes(row.unit as string) && typeof row.expected === 'number' && row.expected > 0 && row.expected <= 1e12 && typeof row.received === 'number' && row.received >= 0 && row.received <= 1e12);
}
export function readOperationalWorkflow(raw: unknown, caseId: string): OperationalWorkflow {
  const bad = () => { throw new Error('INVALID_OPERATIONAL_WORKFLOW'); };
  if (!object(raw) || !exact(raw, ['schemaVersion', 'mode', 'caseId', 'eventId', 'revision', 'contextDigest', 'policy', 'policyFixtures', 'blockers', 'closure', 'summary', ...['logistics', 'quality'].filter(k => Object.hasOwn(raw, k))]) || raw.schemaVersion !== 1 || raw.mode !== 'demo' || raw.caseId !== caseId || !id(raw.eventId) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || (raw.revision as number) > 200 || !digest(raw.contextDigest)) return bad();
  const policy = (p: unknown) => object(p) && exact(p, ['id', 'label', 'scope', 'requirements']) && id(p.id) && typeof p.label === 'string' && p.label.length <= 200 && p.scope === 'synthetic_rehearsal_only' && Array.isArray(p.requirements) && p.requirements.length <= 10 && p.requirements.every(x => typeof x === 'string' && x.length <= 500);
  if (raw.policy !== null && !policy(raw.policy) || !Array.isArray(raw.policyFixtures) || raw.policyFixtures.length !== 1 || !raw.policyFixtures.every(policy) || !Array.isArray(raw.blockers) || raw.blockers.length > 30 || !raw.blockers.every(x => typeof x === 'string' && x.length <= 500)) return bad();
  const c = raw.closure, s = raw.summary;
  if (!object(c) || !exact(c, ['status', 'reviewDigest', 'recordId']) || !['blocked', 'review_ready', 'closed_demo', 'stale'].includes(c.status as string) || !digest(c.reviewDigest) || c.recordId !== null && !id(c.recordId) || !object(s) || !exact(s, ['activeAssignmentId', 'selectedOptionId', 'receipt', 'milestones']) || s.activeAssignmentId !== null && !id(s.activeAssignmentId) || s.selectedOptionId !== null && !id(s.selectedOptionId) || !['pending', 'stale', 'verified_demo', 'partial_demo', 'reference_only'].includes(s.receipt as string) || !Array.isArray(s.milestones) || s.milestones.length !== 4 || s.milestones.some((m, i) => !object(m) || !exact(m, ['id', 'label', 'current', 'recordId']) || m.id !== OPERATIONAL_MILESTONES[i] || m.label !== MILESTONE_LABELS[m.id as OperationalMilestone] || typeof m.current !== 'boolean' || m.recordId !== null && !id(m.recordId))) return bad();
  const records = (v: unknown, fn: string) => Array.isArray(v) && v.length <= 200 && v.every(r => validateOperationalRecord(r, caseId) && r.eventId === raw.eventId && r.functionId === fn && r.revision <= (raw.revision as number)) && new Set(v.map(x => x.id)).size === v.length;
  if (raw.logistics !== undefined) {
    const l = raw.logistics;
    if (!object(l) || !exact(l, ['records', 'receiptFixtures', 'milestoneFixtures']) || !records(l.records, 'logistics') || !Array.isArray(l.receiptFixtures) || l.receiptFixtures.length !== 3 || l.receiptFixtures.some(f => !object(f) || !exact(f, ['id', 'label']) || !id(f.id) || typeof f.label !== 'string' || f.label.length > 200) || !Array.isArray(l.milestoneFixtures) || l.milestoneFixtures.length !== 4 || l.milestoneFixtures.some((f, i) => !object(f) || !exact(f, ['id', 'milestone']) || !id(f.id) || f.milestone !== OPERATIONAL_MILESTONES[i])) return bad();
  }
  if (raw.quality !== undefined) {
    const q = raw.quality;
    if (!object(q) || !exact(q, ['records', 'incidents', 'resolutionFixtureId']) || !records(q.records, 'quality') || !id(q.resolutionFixtureId) || !Array.isArray(q.incidents) || q.incidents.length > 200 || q.incidents.some(v => !object(v) || !exact(v, ['id', 'description', 'owner', 'milestone', 'status', 'current', 'resolutionId']) || !id(v.id) || !note(v.description) || !['coordination_demo', 'quality_demo'].includes(v.owner as string) || v.milestone !== null && !OPERATIONAL_MILESTONES.includes(v.milestone as OperationalMilestone) || !['open', 'acknowledged', 'resolved_demo'].includes(v.status as string) || typeof v.current !== 'boolean' || v.resolutionId !== null && !id(v.resolutionId))) return bad();
  }
  const view = structuredClone(raw) as OperationalWorkflow;
  const { closure, summary } = view;
  const hasClose = closure.recordId !== null;
  const hasBlockers = view.blockers.length > 0;
  // These are projection invariants of the existing DEMO contract, not new
  // business rules. A typed status alone cannot establish a reviewed closure.
  if (hasClose !== ['closed_demo', 'stale'].includes(closure.status) || hasClose && view.revision === 0 || closure.status === 'blocked' && !hasBlockers) return bad();
  if (['review_ready', 'closed_demo'].includes(closure.status) && (
    hasBlockers || view.revision === 0 || view.policy === null || view.policy.id !== view.policyFixtures[0].id
    || summary.activeAssignmentId === null || summary.selectedOptionId === null || summary.receipt !== 'verified_demo'
    || summary.milestones.some(m => !m.current || m.recordId === null)
    || view.quality?.incidents.some(i => i.status !== 'resolved_demo' || !i.current || i.resolutionId === null)
  )) return bad();
  // Quality history can be absent in a legitimately scoped Logistics view.
  // When visible, its latest close must explain the projected status and ID.
  if (view.quality) {
    const close = view.quality.records.filter(r => r.operation.step === 'close_demo').sort((a, b) => b.revision - a.revision)[0];
    if (closure.recordId !== (close?.id ?? null)) return bad();
    const closed = close && close.revision === view.revision && close.operation.contextDigest === view.contextDigest && !hasBlockers;
    const expected = closed ? 'closed_demo' : close ? 'stale' : hasBlockers ? 'blocked' : 'review_ready';
    if (closure.status !== expected) return bad();
  }
  return view;
}
