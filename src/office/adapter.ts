import type { AreaId, CommercialThread, DataMode, Evidence, FunctionId, OfficeCase, OfficeCommand, OfficeSnapshot, WorkStatus } from './contracts';

export type OfficeErrorCode = 'unauthorized' | 'forbidden' | 'offline' | 'incompatible' | 'conflict' | 'validation';
const ERROR_MESSAGES: Record<OfficeErrorCode, string> = {
  unauthorized: 'Se requiere una sesión staff vigente.',
  forbidden: 'Esta sesión o acción no tiene permiso para la oficina.',
  offline: 'Sin conexión con el servicio. No se han confirmado cambios.',
  incompatible: 'La respuesta no cumple el contrato de la oficina; no se muestran datos sin verificar.',
  conflict: 'La revisión o la acción cambió. Actualiza el caso antes de volver a intentarlo.',
  validation: 'La acción contiene datos inválidos. Revisa el texto y la revisión seleccionada.',
};

export class OfficeReadError extends Error {
  readonly code: OfficeErrorCode;
  constructor(code: OfficeErrorCode) { super(ERROR_MESSAGES[code]); this.name = 'OfficeReadError'; this.code = code; }
}

const AREAS: AreaId[] = ['sales', 'coordination', 'kitchen', 'finance', 'direction'];
const FUNCTIONS: FunctionId[] = ['sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent'];
const STATUSES: WorkStatus[] = ['queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'stale'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
type RecordValue = Record<string, unknown>;
function bad(): never { throw new OfficeReadError('incompatible'); }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad();
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) bad();
}
function string(value: unknown, max = 4000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) bad();
  return value;
}
function id(value: unknown): string { const result = string(value, 128); if (!ID.test(result)) bad(); return result; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') bad(); return value; }
function nullableBool(value: unknown): boolean | null { return value === null ? null : bool(value); }
function date(value: unknown): string {
  const result = string(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)) bad();
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) bad();
  const normalized = new Date(parsed).toISOString();
  if (normalized !== result && normalized.replace('.000Z', 'Z') !== result) bad();
  return result;
}
function nullableDate(value: unknown): string | null { return value === null ? null : date(value); }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) bad(); return value as T; }
function evidence(value: unknown, mode: DataMode, caseId: string): Evidence {
  const item = record(value); keys(item, ['source', 'at', 'simulated', 'reference']);
  const result = { source: string(item.source, 128), at: date(item.at), simulated: bool(item.simulated), reference: string(item.reference, 512) };
  if (result.simulated !== (mode === 'demo')) bad();
  if (mode === 'demo' && !result.reference.startsWith(`demo:${caseId}:`)) bad();
  if (mode === 'demo' && !['fixture:office-demo', 'demo:office-command', 'demo:scripted-chat'].includes(result.source)) bad();
  if (mode === 'live' && !result.reference.startsWith(`growth_v2:lead:${caseId}:`)) bad();
  return result;
}
function nullableEvidence(value: unknown, mode: DataMode, caseId: string): Evidence | null { return value === null ? null : evidence(value, mode, caseId); }
function collection<T extends { id: string }>(value: unknown, map: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 1000) bad();
  const mapped = value.map(map);
  if (new Set(mapped.map(item => item.id)).size !== mapped.length) bad();
  return mapped;
}
function base(item: RecordValue, mode: DataMode, caseId: string) {
  return { id: id(item.id), functionId: choice(item.functionId, FUNCTIONS), evidence: evidence(item.evidence, mode, caseId) };
}
function commercialThread(value: unknown, mode: DataMode, caseId: string): CommercialThread {
  const item = record(value);
  keys(item, ['schemaVersion', 'id', 'caseId', 'revision', 'digest', 'subject', 'recipient', 'messages', 'references', 'evidence']);
  if (mode !== 'demo' || item.schemaVersion !== 1 || item.caseId !== caseId || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > 1_000_000 || !DIGEST.test(string(item.digest, 64))) bad();
  const recipient = string(item.recipient, 300);
  if (!/^[^@\s]+@invalid\.test$/.test(recipient)) bad();
  if (!Array.isArray(item.messages) || !item.messages.length || item.messages.length > 20 || !Array.isArray(item.references) || !item.references.length || item.references.length > 10) bad();
  return {
    schemaVersion: 1, id: id(item.id), caseId, revision: item.revision as number, digest: item.digest as string,
    subject: string(item.subject, 200), recipient, evidence: evidence(item.evidence, mode, caseId),
    messages: collection(item.messages, value => {
      const row = record(value); keys(row, ['id', 'author', 'text', 'at']);
      return { id: id(row.id), author: string(row.author, 100), text: string(row.text, 2000), at: date(row.at) };
    }),
    references: collection(item.references, value => {
      const row = record(value); keys(row, ['id', 'source', 'status', 'label', 'detail', 'evidence']);
      const status = choice(row.status, ['simulated', 'missing']);
      const ev = nullableEvidence(row.evidence, mode, caseId);
      if ((status === 'missing') !== (ev === null)) bad();
      return { id: id(row.id), source: choice(row.source, ['fixture', 'gmail', 'monday']), status, label: string(row.label, 200), detail: string(row.detail, 1000), evidence: ev };
    }),
  };
}
function officeCase(value: unknown, mode: DataMode): OfficeCase {
  const c = record(value);
  keys(c, ['id', 'title', 'subtitle', 'evidence', 'payment', 'paymentEvidence', 'supplier', 'supplierEvidence', 'capturedAt', 'attemptedAt', 'connectedAt', 'humanContactVerified', 'callEvidence', 'closerAvailable', 'assignment', 'saleClosed', 'history', 'tasks', 'results', 'approvals', 'messages'], ['commercialThreads']);
  const caseId = id(c.id);
  const result: OfficeCase = {
    id: caseId, title: string(c.title, 200), subtitle: string(c.subtitle, 600), evidence: evidence(c.evidence, mode, caseId),
    payment: choice(c.payment, ['verified', 'pending', 'unknown']), paymentEvidence: nullableEvidence(c.paymentEvidence, mode, caseId),
    supplier: choice(c.supplier, ['accepted', 'pending', 'unknown']), supplierEvidence: nullableEvidence(c.supplierEvidence, mode, caseId),
    capturedAt: date(c.capturedAt), attemptedAt: nullableDate(c.attemptedAt), connectedAt: nullableDate(c.connectedAt),
    humanContactVerified: bool(c.humanContactVerified), callEvidence: nullableEvidence(c.callEvidence, mode, caseId),
    closerAvailable: nullableBool(c.closerAvailable), assignment: choice(c.assignment, ['assigned', 'queued', 'unknown']), saleClosed: nullableBool(c.saleClosed),
    tasks: collection(c.tasks, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'detail', 'status', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), detail: string(item.detail), status: choice(item.status, STATUSES) }; }),
    results: collection(c.results, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'detail', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), detail: string(item.detail) }; }),
    approvals: collection(c.approvals, value => {
      const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'body', 'recipient', 'account', 'attachments', 'channel', 'revision', 'digest', 'status', 'evidence'], ['commercialContext']);
      if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !DIGEST.test(string(item.digest, 64))) bad();
      if (!Array.isArray(item.attachments) || item.attachments.length > 20) bad();
      const context = Object.hasOwn(item, 'commercialContext') ? commercialThread(item.commercialContext, mode, caseId) : undefined;
      if (context && (item.functionId !== 'sales' || item.recipient !== context.recipient)) bad();
      return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), body: string(item.body, 12000), recipient: string(item.recipient, 300), account: string(item.account, 300), attachments: item.attachments.map(value => string(value, 1000)), channel: string(item.channel, 100), revision: item.revision as number, digest: item.digest as string, status: choice(item.status, ['pending', 'approved_demo', 'rejected_demo', 'cancelled_demo']), ...(context ? { commercialContext: context } : {}) };
    }),
    messages: collection(c.messages, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'author', 'text', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), author: string(item.author, 100), text: string(item.text, 12000) }; }),
    history: collection(c.history, value => { const item = record(value); keys(item, ['id', 'functionId', 'title', 'detail', 'status', 'evidence']); return { ...base(item, mode, caseId), title: string(item.title, 200), detail: string(item.detail), status: choice(item.status, STATUSES) }; }),
  };
  if (Object.hasOwn(c, 'commercialThreads')) {
    if (mode !== 'demo' || !Array.isArray(c.commercialThreads) || c.commercialThreads.length > 20) bad();
    result.commercialThreads = collection(c.commercialThreads, value => commercialThread(value, mode, caseId));
  }
  if ((result.payment === 'verified' && !result.paymentEvidence) || (result.supplier === 'accepted' && !result.supplierEvidence)) bad();
  if ((result.attemptedAt || result.connectedAt || result.humanContactVerified) && !result.callEvidence) bad();
  if (result.connectedAt && !result.humanContactVerified) bad();
  if (result.humanContactVerified && !result.connectedAt) bad();
  if (result.attemptedAt && Date.parse(result.attemptedAt) < Date.parse(result.capturedAt)) bad();
  if (result.connectedAt && (Date.parse(result.connectedAt) < Date.parse(result.capturedAt) || (result.attemptedAt && Date.parse(result.connectedAt) < Date.parse(result.attemptedAt)))) bad();
  if (mode !== 'demo' && result.approvals.some(approval => approval.status !== 'pending')) bad();
  return result;
}

export function validateOfficeSnapshot(value: unknown, expectedMode: 'demo' | 'live'): OfficeSnapshot {
  const item = record(value); keys(item, ['mode', 'asOf', 'cases', 'note', 'outboundEffects', 'mondayWrites'], ['hasMore']);
  if (item.mode !== expectedMode || item.outboundEffects !== 0 || item.mondayWrites !== 0) bad();
  const result: OfficeSnapshot = { mode: expectedMode, asOf: date(item.asOf), cases: collection(item.cases, value => officeCase(value, expectedMode)), note: string(item.note, 3000), outboundEffects: 0, mondayWrites: 0 };
  if (Object.hasOwn(item, 'hasMore')) result.hasMore = bool(item.hasMore);
  return result;
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError'); }
async function requestJson(url: string, signal?: AbortSignal, command?: unknown, method?: 'POST' | 'DELETE'): Promise<unknown> {
  aborted(signal);
  let response: Response;
  try {
    response = await fetch(url, { method: method ?? (command ? 'POST' : 'GET'), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json' } : {}) }, ...(command ? { body: JSON.stringify(command) } : {}) });
  } catch { aborted(signal); throw new OfficeReadError('offline'); }
  aborted(signal);
  if (!response.ok) {
    if (response.status === 401) throw new OfficeReadError('unauthorized');
    if (response.status === 403) throw new OfficeReadError('forbidden');
    if (response.status === 409) throw new OfficeReadError('conflict');
    if ([400, 422].includes(response.status)) throw new OfficeReadError('validation');
    throw new OfficeReadError('offline');
  }
  if (method === 'DELETE' && response.status === 204) return null;
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') bad();
  try { const value: unknown = await response.json(); aborted(signal); return value; }
  catch (error) { aborted(signal); if (error instanceof OfficeReadError) throw error; bad(); }
}

export type DemoSession = {
  mode: 'demo'; actorId: string; role: 'operator' | 'viewer'; caseIds: string[];
  functionIds: FunctionId[]; expiresAt: string; storage: { kind: 'postgres'; durable: true }; outboundEffects: 0;
};
export type DemoSessionScope = { role?: 'operator' | 'viewer'; caseIds?: string[]; functionIds?: FunctionId[] };

function validateDemoSession(value: unknown): DemoSession {
  const item = record(value);
  keys(item, ['mode', 'actorId', 'role', 'caseIds', 'functionIds', 'expiresAt', 'storage', 'outboundEffects']);
  const storage = record(item.storage); keys(storage, ['kind', 'durable']);
  if (item.mode !== 'demo' || item.actorId !== 'OFFICE_DEMO_OPERATOR' || item.outboundEffects !== 0 || storage.kind !== 'postgres' || storage.durable !== true) bad();
  const scoped = <T extends string>(value: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length || new Set(value).size !== value.length) bad();
    return value.map(entry => choice(entry, allowed));
  };
  const expiresAt = date(item.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) throw new OfficeReadError('unauthorized');
  return { mode: 'demo', actorId: item.actorId, role: choice(item.role, ['operator', 'viewer']),
    caseIds: scoped(item.caseIds, ['demo-aurora', 'demo-cedar', 'demo-harbor']),
    functionIds: scoped(item.functionIds, FUNCTIONS), expiresAt, storage: { kind: 'postgres', durable: true }, outboundEffects: 0 };
}

export async function loadDemoSession(signal?: AbortSignal): Promise<DemoSession | null> {
  try { return validateDemoSession(await requestJson('/office-api/session', signal)); }
  catch (error) { if (error instanceof OfficeReadError && error.code === 'unauthorized') return null; throw error; }
}

export async function startDemoSession(scope: DemoSessionScope = {}, signal?: AbortSignal): Promise<DemoSession> {
  try {
    const item = record(scope); keys(item, [], ['role', 'caseIds', 'functionIds']);
    if (item.role !== undefined) choice(item.role, ['operator', 'viewer']);
    for (const [key, allowed] of [['caseIds', ['demo-aurora', 'demo-cedar', 'demo-harbor']], ['functionIds', FUNCTIONS]] as const) {
      if (item[key] === undefined) continue;
      const values = item[key];
      if (!Array.isArray(values) || values.length === 0 || values.length > allowed.length || new Set(values).size !== values.length) bad();
      values.forEach(value => choice(value, allowed));
    }
  } catch { throw new OfficeReadError('validation'); }
  return validateDemoSession(await requestJson('/office-api/session', signal, scope, 'POST'));
}

export async function endDemoSession(signal?: AbortSignal): Promise<void> {
  await requestJson('/office-api/session', signal, undefined, 'DELETE');
}

export async function loadDemoSnapshot(signal?: AbortSignal): Promise<OfficeSnapshot> {
  return validateOfficeSnapshot(await requestJson('/office-api/snapshot', signal), 'demo');
}

function validatedCommand(command: OfficeCommand): OfficeCommand {
  try {
    const item = record(command);
    choice(item.action, ['draft', 'chat', 'approve', 'reject', 'cancel', 'revise']);
    const decision = ['approve', 'reject', 'cancel', 'revise'].includes(command.action);
    const required = ['idempotencyKey', 'caseId', 'functionId', 'action', ...(decision ? ['approvalId', 'revision', 'digest'] : []), ...(['chat', 'revise'].includes(command.action) ? ['text'] : [])];
    const commercialFields = ['commercialThreadId', 'commercialThreadRevision', 'commercialThreadDigest'];
    keys(item, required, command.action === 'draft' ? ['text', ...commercialFields] : []);
    const commandId = (value: unknown) => { const result = id(value); if (result.length > 96 || ['__proto__', 'prototype', 'constructor'].includes(result)) bad(); return result; };
    commandId(item.idempotencyKey); choice(item.caseId, ['demo-aurora', 'demo-cedar', 'demo-harbor']); choice(item.functionId, FUNCTIONS);
    if (item.text !== undefined) string(item.text, 2000);
    if (item.approvalId !== undefined) commandId(item.approvalId);
    if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > 1_000_000)) bad();
    if (item.digest !== undefined && !DIGEST.test(string(item.digest, 64))) bad();
    if (commercialFields.some(key => Object.hasOwn(item, key))) {
      if (!commercialFields.every(key => Object.hasOwn(item, key)) || item.action !== 'draft' || item.functionId !== 'sales' || Object.hasOwn(item, 'text')) bad();
      commandId(item.commercialThreadId);
      if (!Number.isSafeInteger(item.commercialThreadRevision) || (item.commercialThreadRevision as number) < 1 || (item.commercialThreadRevision as number) > 1_000_000) bad();
      if (!DIGEST.test(string(item.commercialThreadDigest, 64))) bad();
    }
    if (['chat', 'revise'].includes(command.action) && item.text === undefined) bad();
    if (['approve', 'reject', 'cancel', 'revise'].includes(command.action) && (item.approvalId === undefined || item.revision === undefined || item.digest === undefined)) bad();
    return { ...command };
  } catch { throw new OfficeReadError('validation'); }
}

export async function executeDemoCommand(command: OfficeCommand, signal?: AbortSignal): Promise<{ snapshot: OfficeSnapshot; replayed: boolean }> {
  const input = validatedCommand(command);
  const item = record(await requestJson('/office-api/command', signal, input)); keys(item, ['snapshot', 'replayed']);
  const snapshot = validateOfficeSnapshot(item.snapshot, 'demo');
  if (!snapshot.cases.some(c => c.id === input.caseId)) bad();
  return { snapshot, replayed: bool(item.replayed) };
}

// Dormant until the existing staff auth is integrated in M2. GETs only; this
// adapter never invokes public lead creation, Monday, telephony or a provider.
export async function loadLiveSnapshot(signal?: AbortSignal): Promise<OfficeSnapshot> {
  const auth = record(await requestJson('/v1/admin/auth/me', signal)); keys(auth, ['user', 'expires_at']);
  const user = record(auth.user); keys(user, ['staff_user_id', 'email', 'role']);
  if (!UUID.test(string(user.staff_user_id, 36))) bad();
  string(user.email, 254); choice(user.role, ['admin', 'viewer']);
  if (Date.parse(date(auth.expires_at)) <= Date.now()) throw new OfficeReadError('unauthorized');
  const payload = record(await requestJson('/v1/admin/leads?range=7d&include_qa=false&limit=50', signal)); keys(payload, ['range', 'rows', 'next_cursor']);
  const range = record(payload.range); keys(range, ['from', 'to', 'label', 'timezone', 'include_qa']);
  const from = date(range.from); const to = date(range.to); string(range.label, 100);
  if (Date.parse(from) >= Date.parse(to) || range.timezone !== 'America/Los_Angeles' || range.include_qa !== false) bad();
  if (payload.next_cursor !== null) string(payload.next_cursor, 500);
  if (!Array.isArray(payload.rows) || payload.rows.length > 50) bad();
  const allowed = ['lead_id', 'session_id', 'status', 'created_at', 'updated_at', 'is_qa', 'intent_cluster', 'crm_status', 'monday_item_url', 'monday_synced_at', 'crm_last_error_code', 'event_type', 'guest_range', 'service_style', 'zip_code', 'source', 'campaign', 'completed', 'time_to_lead_ms', 'phone_captured'];
  const ids = new Set<string>();
  const observedAt = new Date().toISOString();
  const cases: OfficeCase[] = [];
  for (const value of payload.rows) {
    const row = record(value); keys(row, ['lead_id', 'status', 'created_at', 'updated_at', 'is_qa', 'completed', 'phone_captured'], allowed);
    const leadId = string(row.lead_id, 36); if (!UUID.test(leadId) || ids.has(leadId)) bad(); ids.add(leadId);
    choice(row.status, ['captured', 'completed']); const createdAt = date(row.created_at); const updatedAt = date(row.updated_at);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) bad(); bool(row.completed); bool(row.phone_captured);
    for (const key of ['session_id']) if (row[key] !== undefined && !UUID.test(string(row[key], 36))) bad();
    for (const key of ['intent_cluster', 'crm_status', 'monday_item_url', 'crm_last_error_code', 'event_type', 'guest_range', 'service_style', 'zip_code', 'source', 'campaign']) if (row[key] !== undefined && row[key] !== null) string(row[key], 2000, true);
    if (row.monday_synced_at !== undefined && row.monday_synced_at !== null) date(row.monday_synced_at);
    if (row.time_to_lead_ms !== undefined && (typeof row.time_to_lead_ms !== 'number' || !Number.isFinite(row.time_to_lead_ms) || row.time_to_lead_ms < 0)) bad();
    if (bool(row.is_qa)) continue;
    const fact: Evidence = { source: 'growth_v2.leads.created_at (registro PostgreSQL)', at: createdAt, simulated: false, reference: `growth_v2:lead:${leadId}:registered` };
    const unavailable: Evidence = { source: 'office:read-projection', at: observedAt, simulated: false, reference: `growth_v2:lead:${leadId}:missing-operational-evidence` };
    cases.push({
      id: leadId, title: `Lead ${leadId.slice(0, 8)}`, subtitle: 'Registro PostgreSQL; fecha de captura del proveedor aún no verificada.', evidence: fact,
      capturedAt: createdAt, attemptedAt: null, connectedAt: null, humanContactVerified: false, callEvidence: null,
      payment: 'unknown', paymentEvidence: null, supplier: 'unknown', supplierEvidence: null, closerAvailable: null, assignment: 'unknown', saleClosed: null,
      tasks: [{ id: `${leadId}:availability`, area: 'sales', functionId: 'sales', title: 'Verificar asignación y llamada', detail: 'El registro del formulario no acredita un closer activo, una asignación o una llamada real.', status: 'blocked', evidence: unavailable }],
      history: [{ id: `${leadId}:registered`, functionId: 'sales', title: 'Lead registrado', detail: 'Primer registro conservado en growth_v2. Completar el formulario no acredita cierre de venta ni ejecución del evento.', status: 'completed', evidence: fact }],
      results: [{ id: `${leadId}:capture`, area: 'sales', functionId: 'sales', title: 'Registro de lead recibido', detail: 'Lectura del registro existente; datos operativos no conectados.', evidence: fact }], approvals: [], messages: [],
    });
  }
  return { mode: 'live', asOf: observedAt, cases, note: 'Solo lectura de growth_v2; sin evidencia operativa de asignación, llamadas, venta, pagos o proveedor. created_at acredita registro PostgreSQL, no captura fiable del proveedor. No se incluyen datos QA ni teléfonos.', hasMore: payload.next_cursor !== null, outboundEffects: 0, mondayWrites: 0 };
}
