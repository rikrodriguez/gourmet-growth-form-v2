import { COMMUNICATIONS_API, COMMUNICATIONS_CSRF_HEADER } from './communications-api-contracts';
import type { CommunicationsReviewView, CommunicationsSessionView } from './communications-api-contracts';
import type { WorkflowView } from './backend/communications';
import type { Association, AttachmentData, Candidate, Coverage, ExactDraft, SourceSnapshot } from './backend/communications-contracts';

// This module contains browser-only review code. No provider or sender is imported.
export type LinkInput = Pick<Association, 'id' | 'leadSnapshotId' | 'eventSnapshotId' | 'accountSnapshotId' | 'threadSnapshotId' | 'evidenceRef' | 'ambiguityAcknowledged'> & { expectedRevision: number; explicit: true };
export type SaveDraftInput = Pick<ExactDraft, 'id' | 'associationId' | 'purpose' | 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText' | 'bodyHtml' | 'attachments'> & { expectedRevision: number };
export type ApproveInput = { expectedRevision: number; id: string; draftId: string; draftRevision: number; draftDigest: string };
export class CommunicationsClientError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) { super(code); this.name = 'CommunicationsClientError'; }
}
const invalid = (): never => { throw new CommunicationsClientError('invalid_response'); };
type Row = Record<string, unknown>;
function row(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const r = value as Row;
  if (keys.some(key => !Object.hasOwn(r, key)) || Object.keys(r).some(key => !keys.includes(key))) invalid();
  return r;
}
function text(value: unknown, max = 8192): string { if (typeof value !== 'string' || value.length > max) return invalid(); return value; }
function number(value: unknown, min = 0): number { if (!Number.isSafeInteger(value) || (value as number) < min) return invalid(); return value as number; }
function timestamp(value: unknown): number { const result = number(value); if (result > 8_640_000_000_000_000) invalid(); return result; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function hash(value: unknown): string { const h = text(value, 64); if (!/^[a-f0-9]{64}$/.test(h)) invalid(); return h; }
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) return invalid(); return value as T; }
function list<T>(value: unknown, parse: (item: unknown) => T, max = 1000): T[] { if (!Array.isArray(value) || value.length > max) return invalid(); return value.map(parse); }
function texts(value: unknown) { return list(value, v => text(v, 320), 30); }
function optionalText(value: unknown) { return value === null ? null : text(value); }
function coverage(value: unknown): Coverage { const r = row(value, ['scope', 'incoming', 'outgoing']); return { scope: choice(r.scope, ['selected_thread', 'correspondence', 'incoming_notifications']), incoming: choice(r.incoming, ['complete', 'partial', 'unknown']), outgoing: choice(r.outgoing, ['complete', 'partial', 'unknown']) }; }
function attachment(value: unknown): AttachmentData { const r = row(value, ['id', 'filename', 'mimeType', 'sha256']); return { id: text(r.id), filename: text(r.filename), mimeType: text(r.mimeType), sha256: r.sha256 === null ? null : hash(r.sha256) }; }
function snapshot(value: unknown): SourceSnapshot {
  const r = row(value, ['id', 'revision', 'digest', 'kind', 'source', 'sourceKey', 'providerVersion', 'observedAtMs', 'data']);
  text(r.id); number(r.revision, 1); hash(r.digest); text(r.sourceKey); text(r.providerVersion); timestamp(r.observedAtMs);
  if (r.kind === 'lead' && r.source === 'monday') {
    const d = row(r.data, ['boardId', 'itemId', 'displayName', 'email', 'phone', 'phoneCountry', 'eventDate', 'guestsText', 'eventTypeText', 'serviceStyleText', 'mappingVersion']);
    ['boardId', 'itemId', 'displayName', 'mappingVersion'].forEach(k => text(d[k]));
    ['email', 'phone', 'phoneCountry', 'eventDate', 'guestsText', 'eventTypeText', 'serviceStyleText'].forEach(k => optionalText(d[k]));
  } else if (r.kind === 'event' && r.source === 'event_reference') {
    const d = row(r.data, ['eventId', 'leadItemId', 'eventDate', 'evidenceRef']); text(d.eventId); text(d.leadItemId); optionalText(d.eventDate); text(d.evidenceRef);
  } else if (r.kind === 'account' && r.source === 'gmail') {
    const d = row(r.data, ['mailbox', 'accountId', 'email', 'verified']); choice(d.mailbox, ['felipe', 'info']); text(d.accountId); text(d.email); if (d.verified !== true) invalid();
  } else if (r.kind === 'thread' && r.source === 'gmail') {
    const d = row(r.data, ['mailbox', 'accountId', 'threadId', 'messages', 'coverage']); choice(d.mailbox, ['felipe', 'info']); text(d.accountId); text(d.threadId); coverage(d.coverage);
    list(d.messages, value => { const m = row(value, ['id', 'from', 'to', 'cc', 'subject', 'bodyText', 'attachments']); text(m.id); texts(m.from); texts(m.to); texts(m.cc); text(m.subject); text(m.bodyText, 128 * 1024); list(m.attachments, attachment, 50); return m; }, 100);
  } else if (r.kind === 'voice' && r.source === 'voice_notification') {
    const d = row(r.data, ['mailbox', 'accountId', 'contactEmail', 'notificationId', 'incomingText', 'coverage']); choice(d.mailbox, ['felipe', 'info']); text(d.accountId); text(d.contactEmail); text(d.notificationId); text(d.incomingText, 65536); const c = coverage(d.coverage); if (c.scope !== 'incoming_notifications' || c.incoming !== 'partial' || c.outgoing !== 'unknown') invalid();
  } else invalid();
  return r as SourceSnapshot;
}
export const SOURCE_REFS = ['leadSnapshotId', 'eventSnapshotId', 'accountSnapshotId', 'threadSnapshotId'] as const;
function association(value: unknown): Association {
  const r = row(value, ['id', 'revision', 'digest', 'candidateSetDigest', ...SOURCE_REFS, 'evidenceRef', 'ambiguityAcknowledged']);
  text(r.id); number(r.revision, 1); hash(r.digest); hash(r.candidateSetDigest); SOURCE_REFS.forEach(k => text(r[k])); text(r.evidenceRef); bool(r.ambiguityAcknowledged); return r as Association;
}
function draft(value: unknown): ExactDraft {
  const r = row(value, ['id', 'revision', 'digest', 'associationId', 'associationDigest', 'contextDigest', 'policyVersion', 'purpose', 'to', 'cc', 'bcc', 'subject', 'bodyText', 'bodyHtml', 'attachments']);
  text(r.id); number(r.revision, 1); hash(r.digest); text(r.associationId); hash(r.associationDigest); hash(r.contextDigest); text(r.policyVersion); choice(r.purpose, ['reply', 'follow_up']); texts(r.to); texts(r.cc); texts(r.bcc); text(r.subject); text(r.bodyText, 65536); if (r.bodyHtml !== null) text(r.bodyHtml, 128 * 1024); list(r.attachments, attachment, 50); return r as ExactDraft;
}
export function validateCommunicationsSession(value: unknown): CommunicationsSessionView {
  const r = row(value, ['mode', 'actorId', 'organizationId', 'csrfToken', 'expiresAt', 'storage', 'outboundEffects']);
  if (r.mode !== 'fixture' || r.outboundEffects !== 0) invalid(); text(r.actorId); text(r.organizationId); const csrf = text(r.csrfToken, 512);
  if (!/^[a-zA-Z0-9_-]{16,512}$/.test(csrf) || !Number.isFinite(Date.parse(text(r.expiresAt, 64)))) invalid(); choice(r.storage, ['ephemeral', 'postgres']); return r as CommunicationsSessionView;
}
export function validateCommunicationsReview(value: unknown): CommunicationsReviewView {
  const r = row(value, ['mode', 'session', 'workflow']); if (r.mode !== 'fixture') invalid(); validateCommunicationsSession(r.session);
  const w = row(r.workflow, ['revision', 'snapshots', 'associations', 'drafts', 'candidates', 'associationStates', 'approvals', 'outbox', 'outboundEffects']);
  number(w.revision); if (w.outboundEffects !== 0) invalid();
  list(w.snapshots, snapshot); list(w.associations, association); list(w.drafts, draft);
  list(w.candidates, value => { const c = row(value, [...SOURCE_REFS, 'reason', 'review']); SOURCE_REFS.forEach(k => text(c[k])); if (c.reason !== 'exact_email') invalid(); choice(c.review, ['required', 'ambiguous']); return c; });
  list(w.associationStates, value => { const s = row(value, ['association', 'current']); association(s.association); bool(s.current); return s; });
  list(w.approvals, value => { const s = row(value, ['approval', 'current']); bool(s.current); const a = row(s.approval, ['id', 'draftId', 'draftRevision', 'draftDigest', 'approvedBy', 'approvedAtMs', 'status']); text(a.id); text(a.draftId); number(a.draftRevision, 1); hash(a.draftDigest); text(a.approvedBy); timestamp(a.approvedAtMs); if (a.status !== 'approved_unsent') invalid(); return s; });
  list(w.outbox, value => { const o = row(value, ['id', 'approvalId', 'draftId', 'draftRevision', 'draftDigest', 'status', 'dispatchEnabled']); text(o.id); text(o.approvalId); text(o.draftId); number(o.draftRevision, 1); hash(o.draftDigest); choice(o.status, ['approved_unsent', 'stale']); if (o.dispatchEnabled !== false) invalid(); return o; });
  return r as CommunicationsReviewView;
}
async function request(path: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal, csrf?: string, body?: unknown): Promise<unknown> {
  const maxBytes = path === '/drafts' ? 512 * 1024 : 16 * 1024;
  if (body !== undefined && new TextEncoder().encode(JSON.stringify(body)).byteLength > maxBytes) throw new CommunicationsClientError('payload_too_large', 413);
  let response: Response;
  try { response = await fetch(`${COMMUNICATIONS_API}${path}`, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { [COMMUNICATIONS_CSRF_HEADER]: csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }); }
  catch (error) { if (signal.aborted) throw error; throw new CommunicationsClientError('request_uncertain'); }
  if (method === 'DELETE' && response.status === 204) return undefined;
  let result: unknown;
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    const body = await response.text(); if (body.length > 2 * 1024 * 1024) throw new Error(); result = JSON.parse(body);
  } catch { throw new CommunicationsClientError(response.status === 404 ? 'disabled' : 'invalid_response', response.status); }
  if (!response.ok) {
    const code = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' && /^[a-zA-Z0-9_]{1,96}$/.test(result.error) ? result.error : 'request_rejected';
    throw new CommunicationsClientError(code, response.status);
  }
  return result;
}
export const communicationsClient = {
  async session(signal: AbortSignal) { return validateCommunicationsSession(await request('/session', 'GET', signal)); },
  async start(signal: AbortSignal) { return validateCommunicationsReview(await request('/session', 'POST', signal, undefined, {})); },
  async read(signal: AbortSignal) { return validateCommunicationsReview(await request('', 'GET', signal)); },
  async end(csrf: string, signal: AbortSignal) { await request('/session', 'DELETE', signal, csrf); },
  async link(input: LinkInput, csrf: string, signal: AbortSignal) { return validateCommunicationsReview(await request('/associations', 'POST', signal, csrf, input)); },
  async save(input: SaveDraftInput, csrf: string, signal: AbortSignal) { return validateCommunicationsReview(await request('/drafts', 'POST', signal, csrf, input)); },
  async approve(input: ApproveInput, csrf: string, signal: AbortSignal) { return validateCommunicationsReview(await request('/approvals', 'POST', signal, csrf, input)); },
};
export type CommunicationsClient = typeof communicationsClient;
export const candidateKey = (candidate: Candidate) => SOURCE_REFS.map(ref => candidate[ref]).join('|');
export const draftKey = (draft: ExactDraft) => `${draft.id}:${draft.revision}:${draft.digest}`;
export function latestDrafts(workflow: WorkflowView): ExactDraft[] { return [...new Map(workflow.drafts.map(d => [d.id, d])).values()]; }
export function followUpAllowed(workflow: WorkflowView, association: Association): boolean {
  const lead = workflow.snapshots.find(s => s.id === association.leadSnapshotId);
  const thread = workflow.snapshots.find(s => s.id === association.threadSnapshotId);
  return lead?.kind === 'lead' && thread?.kind === 'thread' && thread.data.coverage.scope === 'correspondence' && thread.data.coverage.incoming === 'complete' && thread.data.coverage.outgoing === 'complete' && !workflow.snapshots.some(s => s.kind === 'voice' && s.data.contactEmail === lead.data.email);
}
export function draftBlockReason(workflow: WorkflowView, draft: ExactDraft): string | null {
  if (latestDrafts(workflow).find(d => d.id === draft.id)?.digest !== draft.digest) return 'Existe una revisión más reciente de este borrador.';
  const binding = workflow.associationStates.find(s => s.association.id === draft.associationId && s.association.digest === draft.associationDigest);
  if (!binding?.current) return 'El vínculo o sus fuentes cambiaron. Revisa y vuelve a vincular las fuentes.';
  if (draft.attachments.some(a => a.sha256 === null)) return 'Hay adjuntos sin hash verificado. La aprobación está bloqueada.';
  if (draft.purpose === 'follow_up' && !followUpAllowed(workflow, binding.association)) return 'La cobertura de correspondencia no permite este seguimiento.';
  if (workflow.approvals.some(s => s.approval.draftId === draft.id && s.approval.draftDigest === draft.digest && !s.current)) return 'La aprobación de esta revisión quedó obsoleta. Revisa las fuentes y guarda una nueva revisión.';
  return null;
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(',')}}`; return JSON.stringify(value); }
// Additional browser preflight. The server remains authoritative and checks its
// current policy, all source versions, exact digest and expected ledger revision.
export async function verifyDraftContext(workflow: WorkflowView, draft: ExactDraft): Promise<string | null> {
  const blocked = draftBlockReason(workflow, draft); if (blocked) return blocked;
  if (!globalThis.crypto?.subtle) return 'No se pudo verificar la huella de las fuentes en este navegador.';
  const sha256 = async (value: unknown) => { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))); return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join(''); };
  const { digest: storedDigest, ...exactContent } = draft;
  if (await sha256(exactContent) !== storedDigest) return 'El contenido mostrado no coincide con la huella guardada. La aprobación está bloqueada.';
  const association = workflow.associations.find(a => a.id === draft.associationId && a.digest === draft.associationDigest);
  if (!association) return 'El vínculo exacto del borrador no está disponible.';
  const sources = SOURCE_REFS.map(k => workflow.snapshots.find(s => s.id === association[k]));
  const lead = sources[0]; if (sources.some(s => !s) || lead?.kind !== 'lead') return 'Faltan fuentes de la revisión guardada.';
  const voice = workflow.snapshots.filter(s => s.kind === 'voice' && s.data.contactEmail === lead.data.email);
  const digest = await sha256({ association, sources, voice, policyVersion: draft.policyVersion });
  return digest === draft.contextDigest ? null : 'Las fuentes o su cobertura cambiaron desde el guardado. Revisa el contexto y guarda una nueva revisión.';
}
export function communicationsErrorText(error: unknown): string {
  if (!(error instanceof CommunicationsClientError)) return 'No se pudo confirmar la operación.';
  if (error.status === 401) return 'La sesión local ha expirado o no está iniciada.';
  if (error.status === 404 || error.code === 'disabled') return 'El servicio de revisión local está desactivado en este servidor.';
  if (error.status === 403) return 'El servidor rechazó el acceso o la verificación de seguridad. Actualiza la lectura antes de continuar.';
  const messages: Record<string, string> = {
    revision_conflict: 'Otra revisión cambió el estado. Revisa la lectura actualizada antes de repetir la acción.',
    draft_changed: 'El borrador cambió. Revisa la versión guardada actual.',
    source_changed: 'Las fuentes cambiaron. Revisa los vínculos y guarda de nuevo el borrador.',
    recipient_mismatch: 'Los destinatarios deben pertenecer a la correspondencia revisada y el lead debe estar en Para.',
    attachment_unverified: 'Un adjunto no tiene hash verificado. No se puede aprobar.',
    coverage_incomplete: 'El seguimiento requiere correspondencia completa de entrada y salida, sin evidencia parcial de Voice.',
    invalid_response: 'La respuesta no cumple el contrato de revisión. No se considera confirmada.',
    request_uncertain: 'No se pudo confirmar el resultado. La acción no se reintentó.',
    payload_too_large: 'El contenido supera el límite local (512 KiB para borradores; 16 KiB para otras acciones). Reduce el contenido antes de guardar.',
    invalid_request: 'Revisa los campos del formulario. El servidor no aceptó estos datos.',
    store_unavailable: 'El almacenamiento local no está disponible. No se ha confirmado la operación.',
    ambiguous: 'Hay varias coincidencias. Debes revisar y reconocer la ambigüedad.',
  };
  return messages[error.code] ?? (error.status === 413 ? 'El contenido supera el límite local de la solicitud. Reduce el texto o el HTML antes de guardar.' : error.status === 503 ? 'El servicio local no está disponible.' : 'El servidor no aceptó la operación. Revisa el estado antes de continuar.');
}
