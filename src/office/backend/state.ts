import { createHash } from 'node:crypto';
import type { AreaId, CommercialThread, Evidence, FunctionId, OfficeCase, OfficeCommand, OfficeHistory, OfficeSnapshot, WorkStatus } from '../contracts';
import { FUNCTIONS } from '../functions';
import { assertCommercialContext, createCommercialThreads } from './commercial-fixtures';
import { readSalesWorkflow } from './sales-workflow';
import type { SupplyReviewContext, SupplyState } from '../supply-contracts';
import { isSupplyOperation } from '../supply-contracts';
import { assertSupplyState, projectSupplyWorkflow } from './supply-workflow';

export const DEMO_ACTOR = 'OFFICE_DEMO_OPERATOR';
export const CASE_IDS = ['demo-aurora', 'demo-cedar', 'demo-harbor'] as const;
export const FUNCTION_IDS: FunctionId[] = ['sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent'];
export const FUNCTION_NAMES: Record<FunctionId, string> = { sales: 'Ventas', proposals: 'Propuestas', coordination: 'Coordinación / tastings', logistics: 'Logística', suppliers: 'Proveedores', finance: 'Finanzas', quality: 'Calidad', marketing: 'Marketing', talent: 'Talento' };
export const FUNCTION_AREAS = Object.fromEntries(FUNCTIONS.map(row => [row.id, row.area])) as Record<FunctionId, AreaId>;
export type DemoCaseId = typeof CASE_IDS[number];
export type JobStatus = Exclude<WorkStatus, 'awaiting_approval'> | 'waiting_approval';
export type OfficeJob = { id: string; caseId: DemoCaseId; area: AreaId; functionId: FunctionId; title: string; detail: string; status: JobStatus; evidence: Evidence; approvalId?: string; revision?: number };
export type ApprovalLink = { id: string; caseId: DemoCaseId; functionId: FunctionId; coreDraftId: string; title: string; account: string; channel: 'email'; recipient: string; attachments: string[]; revision: number; digest: string; status: 'pending' | 'approved_demo' | 'rejected_demo' | 'cancelled_demo'; evidence: Evidence; coreApprovalId?: string; jobId: string; commercialContext?: CommercialThread; supplyContext?: SupplyReviewContext };
export type CommandRecord = { key: string; digest: string; input: OfficeCommand; actorId: typeof DEMO_ACTOR; atMs: number; salesFlow?: { fingerprint: string; approvalId?: string; error?: 'SALES_PLANNER_FAILED' | 'SALES_PLANNER_TIMEOUT' | 'INVALID_SALES_PLAN' } };
export type HistoryRecord = OfficeHistory & { caseId: DemoCaseId; commandKey: string | null };
export type DemoCase = Omit<OfficeCase, 'history' | 'tasks' | 'approvals' | 'commercialThreads' | 'supplyWorkflow'>;
export type CoreDraft = { kind: string; gourmetEventId: string; currentRevision: number; revisions: Record<string, { draftId: string; revision: number; text?: string; contentDigest: string; [key: string]: unknown }> };
export type OfficeState = {
  version: 1; mode: 'simulation';
  leads: Record<string, unknown>; closers: Record<string, unknown>; assignments: Record<string, unknown>; callBindings: Record<string, unknown>; callEvents: Record<string, unknown>;
  payments: Record<string, unknown>; invoices: Record<string, unknown>; exceptions: Record<string, unknown>; drafts: Record<string, CoreDraft>; approvals: Record<string, { valid: boolean; [key: string]: unknown }>;
  commands: Record<string, unknown>; sourceLeadBindings: Record<string, unknown>; providerEvents: Record<string, unknown>; audit: Record<string, unknown>; reconciliations: Record<string, unknown>; closerIdentityBindings: Record<string, unknown>;
  office: { version: 1; syntheticOnly: true; actorId: typeof DEMO_ACTOR; initializedAtMs: number; cases: Record<DemoCaseId, DemoCase>; approvals: Record<string, ApprovalLink>; jobs: Record<string, OfficeJob>; history: Record<string, HistoryRecord>; commands: Record<string, CommandRecord>; supply?: SupplyState };
};
export interface OfficeStore { transact<T>(fn: (state: OfficeState) => T | Promise<T>): Promise<T>; snapshot(): Promise<OfficeState>; }

export class OfficeError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 400) { super(code); this.name = 'OfficeError'; }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function evidence(caseId: DemoCaseId, reference: string, atMs: number, source = 'demo:office-command'): Evidence {
  return { source, at: new Date(atMs).toISOString(), simulated: true, reference: `demo:${caseId}:${reference}` };
}
export function currentTime(clock: () => number) {
  const at = clock();
  if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw new OfficeError('INVALID_CLOCK', 503);
  return at;
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function parseOfficeCommand(body: unknown): OfficeCommand {
  if (!plain(body)) throw new OfficeError('INVALID_COMMAND');
  const base = ['idempotencyKey', 'caseId', 'functionId', 'action'];
  const actions = ['draft', 'chat', 'approve', 'reject', 'cancel', 'revise'];
  if (typeof body.action !== 'string' || !actions.includes(body.action)) throw new OfficeError('INVALID_ACTION');
  const decision = ['approve', 'reject', 'cancel', 'revise'].includes(body.action);
  const commercialKeys = ['commercialThreadId', 'commercialThreadRevision', 'commercialThreadDigest'];
  const commercial = commercialKeys.some(key => Object.hasOwn(body, key));
  const supply = Object.hasOwn(body, 'supply');
  if (supply && (body.action !== 'draft' || !['suppliers', 'logistics'].includes(body.functionId as string) || commercial || Object.hasOwn(body, 'text'))) throw new OfficeError('INVALID_SUPPLY_COMMAND');
  if (commercial && (body.action !== 'draft' || body.functionId !== 'sales')) throw new OfficeError('INVALID_COMMERCIAL_DRAFT');
  const required = [...base, ...(decision ? ['approvalId', 'revision', 'digest'] : []), ...(['chat', 'revise'].includes(body.action) ? ['text'] : []), ...(commercial ? commercialKeys : [])];
  const allowed = [...required, ...(body.action === 'draft' && !commercial && !supply ? ['text'] : []), ...(supply ? ['supply'] : [])];
  for (const key of Reflect.ownKeys(body)) {
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) throw new OfficeError('UNKNOWN_FIELD');
  }
  if (required.some(key => !Object.hasOwn(body, key))) throw new OfficeError('MISSING_FIELD');
  const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
  if (!validId(body.idempotencyKey)) throw new OfficeError('INVALID_IDEMPOTENCY_KEY');
  if (!CASE_IDS.includes(body.caseId as DemoCaseId)) throw new OfficeError('UNKNOWN_CASE');
  if (!FUNCTION_IDS.includes(body.functionId as FunctionId)) throw new OfficeError('UNKNOWN_FUNCTION');
  if (body.text !== undefined && (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.text))) throw new OfficeError('INVALID_TEXT');
  if (decision && (!validId(body.approvalId) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1 || (body.revision as number) > 1_000_000 || typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest))) throw new OfficeError('INVALID_DECISION');
  if (commercial && (!validId(body.commercialThreadId) || !Number.isSafeInteger(body.commercialThreadRevision) || (body.commercialThreadRevision as number) < 1 || (body.commercialThreadRevision as number) > 1_000_000 || typeof body.commercialThreadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.commercialThreadDigest))) throw new OfficeError('INVALID_COMMERCIAL_BINDING');
  if (supply) {
    if (!isSupplyOperation(body.supply)) throw new OfficeError('INVALID_SUPPLY_COMMAND');
    const sourcing = ['queue_sourcing', 'ingest_digest', 'evaluate_candidate', 'verify_availability', 'approve_terms', 'select_candidate', 'assign_demo'].includes(body.supply.step);
    if (body.functionId !== (sourcing ? 'suppliers' : 'logistics')) throw new OfficeError('INVALID_SUPPLY_FUNCTION', 403);
  }
  return structuredClone(body) as OfficeCommand;
}
export function assertOfficeState(state: OfficeState): void {
  if (!state || state.version !== 1 || state.mode !== 'simulation' || !state.office || state.office.version !== 1 || state.office.syntheticOnly !== true || state.office.actorId !== DEMO_ACTOR) throw new OfficeError('OFFICE_STATE_INVALID', 503);
  if (Object.keys(state.office.cases).length !== CASE_IDS.length || CASE_IDS.some(id => !Object.hasOwn(state.office.cases, id))) throw new OfficeError('OFFICE_STATE_INVALID', 503);
  for (const [id, item] of Object.entries(state.office.cases)) {
    if (id !== item.id || !CASE_IDS.includes(id as DemoCaseId)) throw new OfficeError('OFFICE_STATE_INVALID', 503);
    for (const ev of [item.evidence, item.paymentEvidence, item.supplierEvidence, item.callEvidence, ...item.results.map(row => row.evidence), ...item.messages.map(row => row.evidence)].filter(Boolean) as Evidence[]) assertEvidence(ev, id as DemoCaseId);
  }
  for (const row of [...Object.values(state.office.approvals), ...Object.values(state.office.jobs), ...Object.values(state.office.history)]) {
    if (!CASE_IDS.includes(row.caseId) || !FUNCTION_IDS.includes(row.functionId)) throw new OfficeError('OFFICE_STATE_INVALID', 503);
    assertEvidence(row.evidence, row.caseId);
  }
  for (const link of Object.values(state.office.approvals)) if (link.commercialContext !== undefined) {
    assertCommercialContext(state, link.commercialContext, link.caseId);
    if (link.functionId !== 'sales' || link.recipient !== link.commercialContext.recipient) throw new OfficeError('INVALID_COMMERCIAL_CONTEXT', 503);
  }
  assertSupplyState(state);
  for (const link of Object.values(state.office.approvals)) if (link.supplyContext !== undefined) {
    if (link.supplyContext.caseId !== link.caseId || link.functionId !== (link.supplyContext.kind === 'selection' ? 'suppliers' : 'logistics') || link.recipient !== 'supply-review@invalid.test' || link.commercialContext !== undefined) throw new OfficeError('INVALID_SUPPLY_CONTEXT', 503);
    assertEvidence(link.supplyContext.evidence, link.caseId);
    const context = link.supplyContext;
    const id = context.kind === 'selection' ? context.selectionId : context.optionId;
    if (context.digest !== sha256({ kind: context.kind, caseId: context.caseId, id, revision: context.revision, snapshot: context.snapshot })) throw new OfficeError('INVALID_SUPPLY_CONTEXT', 503);
  }
}
export function assertEvidence(ev: Evidence, caseId: DemoCaseId) {
  if (ev.simulated !== true || !ev.source.startsWith('demo:') && ev.source !== 'fixture:office-demo' || !ev.reference.startsWith(`demo:${caseId}:`) || !Number.isFinite(Date.parse(ev.at))) throw new OfficeError('OFFICE_PROVENANCE_INVALID', 503);
}
export function projectOfficeSnapshot(state: OfficeState, nowMs: number): OfficeSnapshot {
  assertOfficeState(state);
  let hasMore = false;
  const bounded = <T extends { id: string; evidence: Evidence }>(rows: T[], pendingFirst = false, workflowFirst = false): T[] => {
    if (rows.length > 1000) hasMore = true;
    const priority = (row: T) => workflowFirst && row.id.startsWith('workflow-') ? 2 : pendingFirst && (row as T & { status?: string }).status === 'pending' ? 1 : 0;
    return rows.sort((a, b) => priority(b) - priority(a) || b.evidence.at.localeCompare(a.evidence.at) || b.id.localeCompare(a.id)).slice(0, 1000);
  };
  // Existing development records retain their original stored values; the UI
  // projects every function into its current canonical area without rewriting history.
  const currentArea = <T extends { functionId: FunctionId }>(row: T) => ({ ...row, area: FUNCTION_AREAS[row.functionId] });
  const snapshot = {
    mode: 'demo', asOf: new Date(nowMs).toISOString(),
    note: 'DEMOSTRACIÓN · PostgreSQL local. Funciones lógicas, venta humana y chat guionado. Sin LLM, conectores, envíos ni cobros reales. Toda aprobación continúa siendo simulada.',
    outboundEffects: 0, mondayWrites: 0,
    cases: CASE_IDS.map(id => {
      const workflow = readSalesWorkflow(state, id, nowMs);
      return { ...state.office.cases[id],
      commercialThreads: createCommercialThreads(id, state.office.initializedAtMs),
      supplyWorkflow: projectSupplyWorkflow(state, id, nowMs),
      results: bounded([...state.office.cases[id].results, ...workflow.results], false, true).map(currentArea), messages: bounded([...state.office.cases[id].messages]).map(currentArea),
      tasks: bounded([...Object.values(state.office.jobs).filter(row => row.caseId === id), ...workflow.tasks], false, true).map(job => { const { caseId: _caseId, approvalId: _approvalId, revision: _revision, ...task } = job as OfficeJob; return { ...currentArea(task), status: task.status === 'waiting_approval' ? 'awaiting_approval' : task.status }; }),
      approvals: bounded(Object.values(state.office.approvals).filter(row => row.caseId === id), true).map(row => ({ id: row.id, area: FUNCTION_AREAS[row.functionId], functionId: row.functionId, title: row.title, body: state.drafts[row.coreDraftId]?.revisions[row.revision]?.text ?? '', recipient: row.recipient, account: row.account, attachments: row.attachments, channel: row.channel, revision: row.revision, digest: row.digest, status: row.status, evidence: row.evidence, ...(row.commercialContext !== undefined ? { commercialContext: row.commercialContext } : {}), ...(row.supplyContext !== undefined ? { supplyContext: row.supplyContext } : {}) })),
      history: bounded(Object.values(state.office.history).filter(row => row.caseId === id)).map(({ caseId: _caseId, commandKey: _commandKey, ...row }) => row).sort((a, b) => a.evidence.at.localeCompare(b.evidence.at) || a.id.localeCompare(b.id)),
    }; }),
  } as OfficeSnapshot;
  if (hasMore) { snapshot.hasMore = true; snapshot.note += ' Cobertura parcial: hasta 1000 registros recientes por colección; aprobaciones pendientes primero. PostgreSQL conserva el historial completo.'; }
  return structuredClone(snapshot);
}
