import React, { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { CommunicationsReviewView } from './communications-api-contracts';
import type { WorkflowView } from './backend/communications';
import type { Association, AttachmentData, Candidate, ExactDraft, SourceSnapshot } from './backend/communications-contracts';
import { candidateKey, communicationsClient, CommunicationsClientError, communicationsErrorText, draftBlockReason, draftKey, followUpAllowed, latestDrafts, SOURCE_REFS, verifyDraftContext } from './communications-client';
import type { CommunicationsClient, SaveDraftInput } from './communications-client';

type Phase = 'loading' | 'ready' | 'signed_out' | 'expired' | 'disabled' | 'unavailable';
type Editor = Omit<SaveDraftInput, 'expectedRevision' | 'to' | 'cc' | 'bcc' | 'bodyHtml'> & { baseRevision: number; to: string; cc: string; bcc: string; htmlEnabled: boolean; bodyHtml: string };
type Review = { key: string; workflowRevision: number };
const EMPTY = 'Sin dato';
const dateTime = (value: string | number) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
const addresses = (values: string[]) => values.length ? values.join(', ') : 'Ninguno';
const parseAddresses = (value: string) => value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
function Fact({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Hash({ children }: { children: ReactNode }) { return <code className="communications-hash">{children}</code>; }

export function AttachmentList({ attachments }: { attachments: AttachmentData[] }) {
  if (!attachments.length) return <p className="communications-muted">Sin adjuntos.</p>;
  return <ul className="communications-attachments">{attachments.map(a => <li key={a.id}><strong>{a.filename}</strong><dl className="communications-facts"><Fact label="ID">{a.id}</Fact><Fact label="Tipo">{a.mimeType}</Fact><Fact label="SHA-256">{a.sha256 === null ? <span className="communications-warning">Sin hash verificado · bloquea aprobación</span> : <Hash>{a.sha256}</Hash>}</Fact></dl></li>)}</ul>;
}
function CoverageText({ source }: { source: SourceSnapshot }) {
  if (source.kind !== 'thread' && source.kind !== 'voice') return null;
  const { scope, incoming, outgoing } = source.data.coverage;
  const statuses = { complete: 'completa', partial: 'parcial', unknown: 'desconocida' };
  return <p className="communications-coverage">Cobertura: {scope === 'correspondence' ? 'correspondencia' : scope === 'selected_thread' ? 'sólo este hilo' : 'notificaciones entrantes'} · Entrada {statuses[incoming]} · Salida {statuses[outgoing]}. {scope !== 'correspondence' && 'No acredita toda la correspondencia.'}</p>;
}
export function SourceSnapshotCard({ source }: { source: SourceSnapshot }) {
  const labels = { lead: 'Lead · Monday', event: 'Referencia de evento', account: 'Cuenta · Gmail', thread: 'Hilo · Gmail', voice: 'Notificación · Voice' };
  return <article className="communications-source" data-testid={`communications-source-${source.kind}`}><h4>{labels[source.kind]}</h4>
    {source.kind === 'lead' && <dl className="communications-facts"><Fact label="Nombre">{source.data.displayName}</Fact><Fact label="Tablero / ítem">{source.data.boardId} / {source.data.itemId}</Fact><Fact label="Email">{source.data.email ?? EMPTY}</Fact><Fact label="Teléfono / país">{source.data.phone ?? EMPTY} / {source.data.phoneCountry ?? EMPTY}</Fact><Fact label="Fecha de evento">{source.data.eventDate ?? EMPTY}</Fact><Fact label="Personas">{source.data.guestsText ?? EMPTY}</Fact><Fact label="Tipo / servicio">{source.data.eventTypeText ?? EMPTY} / {source.data.serviceStyleText ?? EMPTY}</Fact><Fact label="Mapeo">{source.data.mappingVersion}</Fact></dl>}
    {source.kind === 'event' && <dl className="communications-facts"><Fact label="Evento">{source.data.eventId}</Fact><Fact label="Ítem del lead">{source.data.leadItemId}</Fact><Fact label="Fecha">{source.data.eventDate ?? EMPTY}</Fact><Fact label="Evidencia de evento">{source.data.evidenceRef}</Fact></dl>}
    {source.kind === 'account' && <dl className="communications-facts"><Fact label="Buzón">{source.data.mailbox === 'felipe' ? 'Felipe' : 'Info'}</Fact><Fact label="Cuenta">{source.data.accountId}</Fact><Fact label="Dirección">{source.data.email}</Fact><Fact label="Identidad">Verificada en la muestra sintética</Fact></dl>}
    {source.kind === 'thread' && <><dl className="communications-facts"><Fact label="Buzón / cuenta">{source.data.mailbox} / {source.data.accountId}</Fact><Fact label="Hilo">{source.data.threadId}</Fact></dl><CoverageText source={source} /><ol className="communications-messages">{source.data.messages.map(message => <li key={message.id}><h5>{message.subject || '(Sin asunto)'}</h5><dl className="communications-facts"><Fact label="Mensaje">{message.id}</Fact><Fact label="De">{addresses(message.from)}</Fact><Fact label="Para">{addresses(message.to)}</Fact><Fact label="CC">{addresses(message.cc)}</Fact></dl><pre className="communications-message-text">{message.bodyText}</pre><AttachmentList attachments={message.attachments} /></li>)}</ol></>}
    {source.kind === 'voice' && <><dl className="communications-facts"><Fact label="Buzón / cuenta">{source.data.mailbox} / {source.data.accountId}</Fact><Fact label="Contacto">{source.data.contactEmail}</Fact><Fact label="Notificación">{source.data.notificationId}</Fact></dl><CoverageText source={source} /><pre className="communications-message-text">{source.data.incomingText}</pre></>}
    <details className="communications-provenance"><summary>Versión exacta de la fuente</summary><dl className="communications-facts"><Fact label="Snapshot"><Hash>{source.id}</Hash></Fact><Fact label="Clave de origen">{source.sourceKey}</Fact><Fact label="Versión / revisión">{source.providerVersion} / {source.revision}</Fact><Fact label="Observado">{dateTime(source.observedAtMs)}</Fact><Fact label="SHA-256"><Hash>{source.digest}</Hash></Fact></dl></details>
  </article>;
}
function SourceChain({ refs, workflow }: { refs: Pick<Association, typeof SOURCE_REFS[number]>; workflow: WorkflowView }) {
  return <div className="communications-source-grid">{SOURCE_REFS.map(ref => { const source = workflow.snapshots.find(s => s.id === refs[ref]); return source ? <SourceSnapshotCard key={ref} source={source} /> : <p key={ref} role="alert">Fuente ausente: {refs[ref]}</p>; })}</div>;
}
function CandidateLabel({ candidate, workflow }: { candidate: Candidate; workflow: WorkflowView }) {
  const lead = workflow.snapshots.find(s => s.id === candidate.leadSnapshotId);
  const event = workflow.snapshots.find(s => s.id === candidate.eventSnapshotId);
  const account = workflow.snapshots.find(s => s.id === candidate.accountSnapshotId);
  const thread = workflow.snapshots.find(s => s.id === candidate.threadSnapshotId);
  return <span><strong>{lead?.kind === 'lead' ? lead.data.displayName : 'Lead sin verificar'}</strong><span>{lead?.kind === 'lead' ? `${lead.data.boardId} / ${lead.data.itemId}` : candidate.leadSnapshotId} · {event?.kind === 'event' ? event.data.eventId : candidate.eventSnapshotId}</span><span>{account?.kind === 'account' ? `${account.data.mailbox} · ${account.data.email}` : candidate.accountSnapshotId} · Hilo {thread?.kind === 'thread' ? thread.data.threadId : candidate.threadSnapshotId}</span><small>{candidate.review === 'ambiguous' ? 'Varias coincidencias: revisión de ambigüedad obligatoria' : 'Coincidencia de email: revisión manual obligatoria'}</small></span>;
}
export function SavedDraftReview({ draft, workflow }: { draft: ExactDraft; workflow: WorkflowView }) {
  const association = workflow.associations.find(a => a.id === draft.associationId && a.digest === draft.associationDigest);
  const account = association && workflow.snapshots.find(s => s.id === association.accountSnapshotId);
  return <article className="communications-saved-draft" data-testid="communications-saved-draft"><h3>Texto exacto guardado · revisión {draft.revision}</h3>
    <dl className="communications-facts"><Fact label="Borrador">{draft.id}</Fact><Fact label="Cuenta de origen">{account?.kind === 'account' ? `${account.data.mailbox} · ${account.data.email} · ${account.data.accountId}` : 'Sin verificar'}</Fact><Fact label="Propósito">{draft.purpose === 'reply' ? 'Respuesta' : 'Seguimiento'}</Fact><Fact label="Para (To)">{addresses(draft.to)}</Fact><Fact label="CC">{addresses(draft.cc)}</Fact><Fact label="CCO (BCC)">{addresses(draft.bcc)}</Fact><Fact label="Asunto">{draft.subject}</Fact><Fact label="Huella exacta (SHA-256)"><Hash>{draft.digest}</Hash></Fact><Fact label="Política">{draft.policyVersion}</Fact></dl>
    <h4>Texto del mensaje</h4><pre className="communications-message-text" data-testid="communications-draft-text">{draft.bodyText}</pre>
    <h4>HTML exacto</h4>{draft.bodyHtml === null ? <p className="communications-muted">Sin versión HTML.</p> : <><p className="communications-muted">Código mostrado como texto. No se ejecuta ni se carga contenido externo.</p><pre className="communications-message-text" data-testid="communications-draft-html">{draft.bodyHtml}</pre></>}
    <h4>Adjuntos de esta revisión</h4><AttachmentList attachments={draft.attachments} />
    <details className="communications-provenance"><summary>Vínculo y fuentes de esta revisión exacta</summary><dl className="communications-facts"><Fact label="Vínculo">{draft.associationId}</Fact><Fact label="Huella del vínculo"><Hash>{draft.associationDigest}</Hash></Fact><Fact label="Huella del contexto"><Hash>{draft.contextDigest}</Hash></Fact><Fact label="Evidencia revisada">{association?.evidenceRef ?? 'Vínculo no disponible'}</Fact></dl>{association && <SourceChain refs={association} workflow={workflow} />}</details>
  </article>;
}
export function CommunicationsHistory({ workflow }: { workflow: WorkflowView }) {
  return <section className="communications-panel" aria-labelledby="communications-history-title"><div className="communications-section-heading"><div><p className="eyebrow">04 · HISTORIAL LOCAL</p><h2 id="communications-history-title">Aprobaciones y salida desactivada</h2></div><span className="communications-tag">0 envíos</span></div><p>Las aprobaciones registran una decisión sobre una revisión exacta. Ningún registro acredita entrega, envío ni permiso para enviar.</p>
    {workflow.outbox.length === 0 ? <p className="communications-empty">No hay aprobaciones guardadas en esta sesión.</p> : <ul className="communications-history-list">{workflow.outbox.map(item => { const approval = workflow.approvals.find(a => a.approval.id === item.approvalId)?.approval; return <li key={item.id} data-testid="communications-outbox-item"><strong>{item.status === 'approved_unsent' ? 'Aprobado, sin enviar' : 'Obsoleto, sin enviar'}</strong><span className={`communications-tag ${item.status === 'stale' ? 'communications-tag-warning' : ''}`}>{item.status}</span><dl className="communications-facts"><Fact label="Borrador / revisión">{item.draftId} / {item.draftRevision}</Fact><Fact label="Huella aprobada"><Hash>{item.draftDigest}</Hash></Fact><Fact label="Aprobación">{item.approvalId}</Fact><Fact label="Registrado por">{approval?.approvedBy ?? EMPTY}</Fact><Fact label="Fecha">{approval ? dateTime(approval.approvedAtMs) : EMPTY}</Fact><Fact label="Despacho">Desactivado</Fact></dl></li>; })}</ul>}
    <details className="communications-provenance"><summary>Revisiones conservadas · {workflow.associations.length} vínculos · {workflow.drafts.length} borradores</summary><ul className="communications-history-list">{workflow.associationStates.map(({ association, current }) => <li key={`${association.id}:${association.revision}`}><strong>Vínculo {association.id} · revisión {association.revision}</strong><p>{current ? 'Vigente en esta lectura' : 'Obsoleto'} · {association.evidenceRef}</p><Hash>{association.digest}</Hash></li>)}{workflow.drafts.map(d => <li key={draftKey(d)}><strong>Borrador {d.id} · revisión {d.revision}</strong><p>{d.subject}</p><Hash>{d.digest}</Hash></li>)}</ul></details>
  </section>;
}
export function CommunicationsSessionState({ phase, busy, error, onStart, onRefresh }: { phase: Exclude<Phase, 'ready'>; busy: string | null; error: string | null; onStart: () => void; onRefresh: () => void }) {
  return <section className="communications-panel communications-session-state" aria-live="polite"><h2>{phase === 'loading' ? 'Consultando la sesión local' : phase === 'disabled' ? 'Revisión local desactivada' : phase === 'expired' ? 'Sesión local expirada' : phase === 'signed_out' ? 'Abre una sesión de revisión sintética' : 'Lectura no disponible'}</h2>
    <p>{phase === 'loading' ? 'Comprobando el estado guardado…' : phase === 'disabled' ? 'Esta ruta necesita el servidor de pruebas de comunicaciones habilitado explícitamente. El servidor habitual no activa estas funciones.' : phase === 'expired' ? 'La muestra anterior ya no se puede recuperar desde esta pantalla. Una nueva sesión crea un alcance y datos de prueba nuevos.' : phase === 'signed_out' ? 'La muestra permite revisar dos buzones ficticios, vincular evidencia y guardar aprobaciones sin envío. La sesión selecciona un alcance sintético; no identifica a una persona real.' : 'No se ha confirmado el estado. Ninguna acción se reintentará automáticamente.'}</p>
    {error && <p className="communications-alert" role="alert">{error}</p>}
    {(phase === 'signed_out' || phase === 'expired') && <button className="button-primary" disabled={!!busy} data-testid="communications-start-session" onClick={onStart}>Iniciar sesión local de prueba</button>}
    {phase !== 'loading' && <button className="button-secondary" disabled={!!busy} onClick={onRefresh}>Volver a consultar</button>}
  </section>;
}

export function CommunicationsPage({ client = communicationsClient, initialView }: { client?: CommunicationsClient; initialView?: CommunicationsReviewView }) {
  const [view, setView] = useState<CommunicationsReviewView | null>(initialView ?? null);
  const [phase, setPhase] = useState<Phase>(initialView ? 'ready' : 'loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [chosenCandidate, setChosenCandidate] = useState('');
  const [evidence, setEvidence] = useState('');
  const [evidenceChecked, setEvidenceChecked] = useState(false);
  const [ambiguityChecked, setAmbiguityChecked] = useState(false);
  const [associationId, setAssociationId] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selectedDraftKey, setSelectedDraftKey] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [approvalChecked, setApprovalChecked] = useState(false);
  const mounted = useRef(false), locked = useRef(false), generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const activeMutation = useRef(false), expiredDuringRequest = useRef(false);
  const workflow = view?.workflow;
  const candidate = workflow?.candidates.find(c => candidateKey(c) === chosenCandidate);
  const association = workflow?.associationStates.find(s => s.association.id === associationId && s.current)?.association;
  const selectedDraft = workflow?.drafts.find(d => draftKey(d) === selectedDraftKey);
  const writable = phase === 'ready' && !busy && !needsRefresh && !sessionExpired;
  const savedBlock = workflow && selectedDraft ? draftBlockReason(workflow, selectedDraft) : null;
  const alreadyApproved = workflow?.approvals.some(a => a.current && a.approval.draftId === selectedDraft?.id && a.approval.draftDigest === selectedDraft?.digest) ?? false;
  const exactReview = !!selectedDraft && !!review && review.key === draftKey(selectedDraft) && review.workflowRevision === workflow?.revision;
  function clearConsent() { setReview(null); setApprovalChecked(false); setEvidenceChecked(false); setAmbiguityChecked(false); }
  function install(result: CommunicationsReviewView) { setView(result); setPhase('ready'); setNeedsRefresh(false); setSessionExpired(Date.parse(result.session.expiresAt) <= Date.now()); }
  function closeLocalState(next: Phase) { setView(null); setPhase(next); setEditor(null); setAssociationId(''); setChosenCandidate(''); setSelectedDraftKey(''); clearConsent(); }

  async function run<T>(label: string, task: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void, mutation = false) {
    if (locked.current || !mounted.current) return;
    locked.current = true; activeMutation.current = mutation; expiredDuringRequest.current = false; const requestGeneration = ++generation.current;
    const controller = new AbortController(); activeRequest.current = controller;
    setBusy(label); setError(null); setNotice(null); clearConsent();
    const current = () => mounted.current && generation.current === requestGeneration && !controller.signal.aborted;
    try { const result = await task(controller.signal); if (current()) apply(result); }
    catch (failure) {
      if (!current()) return;
      const message = communicationsErrorText(failure); setError(message);
      if (expiredDuringRequest.current) { setNeedsRefresh(true); setError(`${message} La sesión expiró durante la operación. Su resultado es desconocido y puede haberse guardado. Abortar o salir no revierte una escritura admitida.`); setNotice(null); }
      else if (failure instanceof CommunicationsClientError && failure.status === 401) closeLocalState(view ? 'expired' : 'signed_out');
      else if (failure instanceof CommunicationsClientError && failure.status === 404) closeLocalState('disabled');
      else if (mutation) {
        // A lost response may hide a committed write. Only read back; never retry it.
        setNeedsRefresh(true);
        try { const refreshed = await client.read(controller.signal); if (current()) { install(refreshed); setNotice('Estado consultado de nuevo. Revisa el resultado y vuelve a elegir la acción; no se repitió ninguna escritura.'); } }
        catch (readFailure) { if (current()) { if (expiredDuringRequest.current) { setNeedsRefresh(true); setError(`${message} La sesión expiró al comprobar el resultado. La operación puede haberse guardado; no se reintentó.`); setNotice(null); } else if (readFailure instanceof CommunicationsClientError && readFailure.status === 401) closeLocalState('expired'); else { if (!view) setPhase('unavailable'); setNotice('No se pudo recuperar el estado. Las acciones siguen bloqueadas hasta una lectura confirmada.'); } } }
      } else { setNeedsRefresh(true); if (!view) setPhase('unavailable'); }
    } finally { if (mounted.current && generation.current === requestGeneration) { locked.current = false; activeMutation.current = false; activeRequest.current = null; setBusy(null); } }
  }
  function refresh() { void run('Consultando estado…', signal => client.read(signal), install); }
  function start() { void run('Iniciando sesión local…', signal => client.start(signal), result => { install(result); setEditor(null); setChosenCandidate(''); setSelectedDraftKey(''); setAssociationId(''); setNotice('Sesión sintética iniciada. Todos los registros permanecen sin enviar.'); }, true); }
  useEffect(() => {
    mounted.current = true; refresh();
    const leave = () => { ++generation.current; activeRequest.current?.abort(); locked.current = false; setBusy(null); clearConsent(); setNeedsRefresh(true); };
    const resume = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    const hide = () => { if (document.visibilityState === 'hidden') { setReview(null); setApprovalChecked(false); } };
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', resume); document.addEventListener('visibilitychange', hide);
    return () => { mounted.current = false; ++generation.current; activeRequest.current?.abort(); locked.current = false; window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', hide); };
    // The client is a stable same-origin transport; changing it cancels old responses.
  }, [client]);
  useEffect(() => {
    if (!view) return;
    const delay = Date.parse(view.session.expiresAt) - Date.now();
    const timer = window.setTimeout(() => {
      if (delay > 2_147_483_647) return;
      setSessionExpired(true); clearConsent();
      if (locked.current && activeMutation.current) {
        // Expiry blocks new actions, but does not undo server-admitted work.
        expiredDuringRequest.current = true;
        setNotice('La sesión expiró durante una operación iniciada. Esperando su resultado; puede guardarse aunque la sesión haya terminado.');
        return;
      }
      ++generation.current; activeRequest.current?.abort(); locked.current = false; setBusy(null); closeLocalState('expired'); setError('La sesión local ha expirado.');
    }, Math.min(Math.max(delay, 0), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [view?.session.expiresAt]);

  function link(event: FormEvent) {
    event.preventDefault(); if (!view || !candidate || !writable || !evidence.trim() || !evidenceChecked || candidate.review === 'ambiguous' && !ambiguityChecked) return;
    const id = newId('association');
    const input = { expectedRevision: view.workflow.revision, id, ...Object.fromEntries(SOURCE_REFS.map(k => [k, candidate[k]])) as Pick<Association, typeof SOURCE_REFS[number]>, explicit: true as const, evidenceRef: evidence, ambiguityAcknowledged: ambiguityChecked };
    void run('Guardando vínculo…', signal => client.link(input, view.session.csrfToken, signal), result => { install(result); setAssociationId(id); setChosenCandidate(''); setEvidence(''); setNotice('Vínculo explícito guardado. Ya puedes preparar un borrador local.'); }, true);
  }
  function openEditor(existing?: ExactDraft) {
    if (!view || !writable) return;
    const a = existing ? workflow?.associationStates.find(s => s.current && s.association.id === existing.associationId)?.association : association;
    if (!a) return; clearConsent(); setAssociationId(a.id);
    const lead = view.workflow.snapshots.find(s => s.id === a.leadSnapshotId);
    const thread = view.workflow.snapshots.find(s => s.id === a.threadSnapshotId);
    setEditor({ id: existing?.id ?? newId('draft'), associationId: a.id, baseRevision: view.workflow.revision, purpose: existing?.purpose ?? 'reply', to: existing?.to.join(', ') ?? (lead?.kind === 'lead' ? lead.data.email ?? '' : ''), cc: existing?.cc.join(', ') ?? '', bcc: existing?.bcc.join(', ') ?? '', subject: existing?.subject ?? (thread?.kind === 'thread' ? `Re: ${thread.data.messages.at(-1)?.subject ?? ''}` : ''), bodyText: existing?.bodyText ?? '', htmlEnabled: existing?.bodyHtml !== undefined && existing.bodyHtml !== null, bodyHtml: existing?.bodyHtml ?? '', attachments: existing?.attachments.map(a => ({ ...a })) ?? [] });
  }
  function edit(values: Partial<Editor>) { setEditor(previous => previous ? { ...previous, ...values } : null); setReview(null); setApprovalChecked(false); }
  function save(event: FormEvent) {
    event.preventDefault(); if (!view || !editor || !writable || editor.baseRevision !== view.workflow.revision) return;
    const input: SaveDraftInput = { expectedRevision: editor.baseRevision, id: editor.id, associationId: editor.associationId, purpose: editor.purpose, to: parseAddresses(editor.to), cc: parseAddresses(editor.cc), bcc: parseAddresses(editor.bcc), subject: editor.subject, bodyText: editor.bodyText, bodyHtml: editor.htmlEnabled ? editor.bodyHtml : null, attachments: editor.attachments };
    void run('Guardando revisión exacta…', signal => client.save(input, view.session.csrfToken, signal), result => { install(result); const saved = latestDrafts(result.workflow).find(d => d.id === editor.id); setSelectedDraftKey(saved ? draftKey(saved) : ''); setEditor(null); setNotice('Revisión guardada en el servidor local. Comprueba su contenido exacto antes de aprobar.'); }, true);
  }
  function verifySaved() {
    if (!selectedDraft || !writable || editor) return;
    const wanted = draftKey(selectedDraft);
    void run('Verificando revisión y fuentes…', async signal => { const result = await client.read(signal); const draft = result.workflow.drafts.find(d => draftKey(d) === wanted); const blocked = draft ? await verifyDraftContext(result.workflow, draft) : 'La revisión seleccionada ya no está disponible.'; return { result, blocked }; }, ({ result, blocked }) => { install(result); if (blocked) setError(blocked); else { setReview({ key: wanted, workflowRevision: result.workflow.revision }); setNotice('Lectura actual confirmada. Revisa el texto guardado y marca la conformidad para esta revisión.'); } });
  }
  function approve() {
    if (!view || !selectedDraft || !writable || editor || !exactReview || !approvalChecked || savedBlock || alreadyApproved) return;
    const input = { expectedRevision: view.workflow.revision, id: newId('approval'), draftId: selectedDraft.id, draftRevision: selectedDraft.revision, draftDigest: selectedDraft.digest };
    void run('Registrando aprobación sin envío…', signal => client.approve(input, view.session.csrfToken, signal), result => { install(result); setNotice('Aprobación guardada: approved_unsent. El mensaje no se ha enviado.'); }, true);
  }

  return <main className="communications-page"><a className="skip-link" href="#communications-content">Saltar a la revisión</a><header className="communications-header"><div><p className="eyebrow">GOURMET AI OFFICE · REVISIÓN LOCAL</p><h1>Comunicaciones</h1><p>Fuentes, texto exacto y aprobación humana, paso a paso.</p></div><nav aria-label="Navegación de comunicaciones"><a className="button-secondary" href="/office/">Volver a la oficina</a><a className="button-secondary" href="/office/provenance">Procedencia</a></nav></header>
    <p className="communications-disclosure"><strong>Datos sintéticos · fixture · 0 envíos.</strong> Esta vista sólo guarda revisiones locales. No conecta Gmail, Monday ni Voice, no carga archivos y no envía mensajes. <strong>No introduzcas datos reales de clientes ni secretos.</strong></p>
    <div id="communications-content">{phase !== 'ready' || !view || !workflow ? <CommunicationsSessionState phase={phase === 'ready' ? 'unavailable' : phase} busy={busy} error={error} onStart={start} onRefresh={refresh} /> : <>
      <section className="communications-panel communications-session" aria-label="Sesión y almacenamiento"><div><strong>Sesión sintética de revisión</strong><p>{view.session.storage === 'postgres' ? 'Almacenamiento PostgreSQL local del servidor de prueba.' : 'Almacenamiento efímero en el servidor: puede perderse al reiniciar.'} No se guardan tokens ni credenciales en localStorage.</p><p>Recargar conserva la sesión activa. Al cerrar, expirar o reiniciar la API, esta pantalla pierde acceso a los borradores anteriores, incluso si siguen en PostgreSQL. Una nueva sesión abre una muestra nueva. La clave de cifrado de esta prueba sólo vive en memoria y se pierde al reiniciar el servidor.</p><p className="communications-muted">Alcance: {view.session.organizationId} · {view.session.actorId} · Revisión global {workflow.revision} · Expira {dateTime(view.session.expiresAt)}</p></div><div className="communications-actions"><button className="button-secondary" disabled={!!busy} data-testid="communications-refresh" onClick={refresh}>Actualizar lectura</button><button className="button-quiet" disabled={!!busy} data-testid="communications-logout" onClick={() => { void run('Cerrando sesión…', signal => client.end(view.session.csrfToken, signal), () => { closeLocalState('signed_out'); setNotice('Sesión local cerrada.'); }, true); }}>Cerrar sesión local</button></div></section>
      {sessionExpired && <div className="communications-alert" role="status" data-testid="communications-expired-result"><p>La sesión ha expirado. Esta pantalla conserva la última lectura recibida; todas las acciones de esa sesión están bloqueadas. Una operación ya iniciada puede haberse guardado. Empezar otra sesión abre una muestra nueva sin recuperar los borradores anteriores.</p><button className="button-secondary" disabled={!!busy} onClick={start}>Iniciar nueva sesión local</button></div>}
      <div data-testid="communications-feedback" className="communications-feedback" aria-live="polite">{busy && <p role="status">{busy}</p>}{error && <p className="communications-alert" role="alert">{error}</p>}{notice && <p className="communications-notice" role="status">{notice}</p>}{needsRefresh && <p className="communications-alert">Las acciones están bloqueadas hasta actualizar la lectura.</p>}</div>
      <section className="communications-accounts" aria-label="Buzones separados">{(['felipe', 'info'] as const).map(mailbox => { const accounts = [...new Map(workflow.snapshots.filter((s): s is SourceSnapshot & { kind: 'account' } => s.kind === 'account' && s.data.mailbox === mailbox).map(s => [s.data.accountId, s])).values()]; return <article key={mailbox}><span className="communications-tag">{mailbox === 'felipe' ? 'Felipe' : 'Info'}</span>{accounts.length ? accounts.map(account => <div key={account.id}><strong>{account.data.email}</strong><p>{account.data.accountId}</p><small>Identidad verificada en la muestra · versión {account.providerVersion}</small></div>) : <p>Sin cuenta verificada en esta lectura.</p>}</article>; })}</section>
      <section className="communications-panel" aria-labelledby="communications-candidates-title"><p className="eyebrow">01 · REVISAR FUENTES</p><h2 id="communications-candidates-title">Elegir un vínculo explícito</h2><p>Una coincidencia de email sólo propone una revisión. Comprueba el tablero, lead, evento, cuenta y conversación; los nombres o fechas similares no prueban identidad.</p>
        {!workflow.candidates.length ? <p className="communications-empty">No hay candidatos en las fuentes devueltas.</p> : <form onSubmit={link}><fieldset disabled={!writable || !!editor}><legend>Candidatos de esta lectura ({workflow.candidates.length})</legend><div className="communications-candidates">{workflow.candidates.map(c => <label className={`communications-candidate ${chosenCandidate === candidateKey(c) ? 'communications-selected' : ''}`} key={candidateKey(c)}><input data-testid="communications-candidate-choice" type="radio" name="communications-candidate" value={candidateKey(c)} checked={chosenCandidate === candidateKey(c)} onChange={() => { setChosenCandidate(candidateKey(c)); setEvidence(''); clearConsent(); }} /><CandidateLabel candidate={c} workflow={workflow} /></label>)}</div></fieldset>
          {candidate && <div className="communications-candidate-review"><h3>Fuentes exactas de la selección</h3><SourceChain refs={candidate} workflow={workflow} /><label className="communications-field">Evidencia de tu revisión<input data-testid="communications-evidence" value={evidence} maxLength={256} required disabled={!writable || !!editor} onChange={event => { setEvidence(event.target.value); setEvidenceChecked(false); setAmbiguityChecked(false); }} placeholder="Referencia concreta de la evidencia revisada" /></label><label className="communications-check"><input data-testid="communications-evidence-check" type="checkbox" checked={evidenceChecked} disabled={!writable || !!editor} onChange={event => setEvidenceChecked(event.target.checked)} />He revisado las fuentes y la evidencia de este lead, evento, cuenta e hilo.</label>{candidate.review === 'ambiguous' && <label className="communications-check communications-warning"><input data-testid="communications-ambiguity-check" type="checkbox" checked={ambiguityChecked} disabled={!writable || !!editor} onChange={event => setAmbiguityChecked(event.target.checked)} />Reconozco las varias coincidencias y elijo explícitamente esta combinación.</label>}<button className="button-primary" data-testid="communications-save-link" disabled={!writable || !!editor || !evidence.trim() || !evidenceChecked || candidate.review === 'ambiguous' && !ambiguityChecked}>Guardar vínculo explícito</button></div>}
        </form>}
        <details className="communications-provenance"><summary>Todas las fuentes conservadas ({workflow.snapshots.length})</summary><p>Incluye versiones históricas y notificaciones parciales. El candidato conserva las versiones seleccionadas; una versión anterior no se presenta como lectura actual.</p><div className="communications-source-grid">{workflow.snapshots.map(source => <SourceSnapshotCard key={source.id} source={source} />)}</div></details>
      </section>
      <section className="communications-panel" aria-labelledby="communications-compose-title"><p className="eyebrow">02 · PREPARAR TEXTO</p><h2 id="communications-compose-title">Borrador local</h2><p>Guardar y aprobar son pasos separados. Los destinatarios deben estar en la correspondencia revisada; el contacto del lead debe aparecer en Para.</p>
        <label className="communications-field">Vínculo vigente para el borrador<select data-testid="communications-association-select" value={associationId} disabled={!writable || !!editor} onChange={event => { setAssociationId(event.target.value); clearConsent(); }}><option value="">Selecciona un vínculo revisado</option>{workflow.associationStates.filter(s => s.current).map(({ association: a }) => <option key={a.id} value={a.id}>{a.id} · revisión {a.revision} · {a.evidenceRef}</option>)}</select></label>
        {!editor ? <button className="button-secondary" disabled={!association || !writable} data-testid="communications-create-draft" onClick={() => openEditor()}>Crear borrador</button> : <form onSubmit={save} className="communications-editor" aria-label="Editor del borrador" data-testid="communications-editor"><p className="communications-tag">Editando · sin guardar · aprobación bloqueada</p><fieldset disabled={!writable}><legend>Contenido de la nueva revisión</legend><label className="communications-field">Propósito<select value={editor.purpose} onChange={event => edit({ purpose: event.target.value as Editor['purpose'] })}><option value="reply">Respuesta</option><option value="follow_up" disabled={!association || !followUpAllowed(workflow, association)}>Seguimiento</option></select></label>{(!association || !followUpAllowed(workflow, association)) && <p className="communications-coverage">Seguimiento bloqueado: se necesita correspondencia completa de entrada y salida, sin evidencia parcial de Voice.</p>}
          <div className="communications-recipient-fields"><label className="communications-field">Para (To)<input required value={editor.to} onChange={event => edit({ to: event.target.value })} maxLength={9600} /></label><label className="communications-field">CC<input value={editor.cc} onChange={event => edit({ cc: event.target.value })} maxLength={9600} /></label><label className="communications-field">CCO (BCC)<input value={editor.bcc} onChange={event => edit({ bcc: event.target.value })} maxLength={9600} /></label></div><p className="communications-muted">Separa direcciones con comas. El servidor normaliza las direcciones y muestra el resultado exacto antes de aprobar. Límite: 512 KiB por solicitud; el historial también tiene capacidad limitada.</p>
          <label className="communications-field">Asunto<input required maxLength={8192} value={editor.subject} onChange={event => edit({ subject: event.target.value })} /></label><label className="communications-field">Texto del mensaje<textarea required rows={8} maxLength={65536} value={editor.bodyText} onChange={event => edit({ bodyText: event.target.value })} /></label><label className="communications-check"><input type="checkbox" checked={editor.htmlEnabled} onChange={event => edit({ htmlEnabled: event.target.checked })} />Incluir HTML exacto como código</label>{editor.htmlEnabled && <label className="communications-field">HTML del mensaje (no se renderiza)<textarea required rows={6} maxLength={131072} value={editor.bodyHtml} onChange={event => edit({ bodyHtml: event.target.value })} spellCheck={false} /></label>}
          <h3>Adjuntos conservados</h3><p className="communications-muted">Se conservan los metadatos y los hashes del borrador. Esta pantalla no añade ni carga archivos.</p><AttachmentList attachments={editor.attachments} /></fieldset>
          {editor.baseRevision !== workflow.revision && <p className="communications-alert" role="alert">El estado cambió durante la edición. Copia el texto si quieres conservarlo, cancela y abre de nuevo el borrador con la lectura actual.</p>}
          <div className="communications-actions"><button className="button-primary" data-testid="communications-save-draft" disabled={!writable || editor.baseRevision !== workflow.revision}>Guardar revisión exacta</button><button type="button" className="button-secondary" disabled={!!busy} data-testid="communications-cancel-edit" onClick={() => { setEditor(null); clearConsent(); setNotice('Edición cerrada. Consulta las revisiones guardadas para confirmar el estado del servidor.'); }}>Cancelar edición</button></div>
        </form>}
      </section>
      <section className="communications-panel" aria-labelledby="communications-review-title"><p className="eyebrow">03 · REVISAR Y APROBAR</p><h2 id="communications-review-title">Aprobar una revisión guardada</h2><p>Comprueba todos los destinatarios, el asunto, ambos cuerpos, los adjuntos y las fuentes. La aprobación sólo registra approved_unsent.</p>
        {!workflow.drafts.length ? <p className="communications-empty">Todavía no hay borradores guardados.</p> : <><label className="communications-field">Revisión guardada<select data-testid="communications-saved-select" value={selectedDraftKey} disabled={!!busy || !!editor} onChange={event => { setSelectedDraftKey(event.target.value); setReview(null); setApprovalChecked(false); }}><option value="">Selecciona un borrador y revisión</option>{workflow.drafts.map(d => <option value={draftKey(d)} key={draftKey(d)}>{d.subject} · revisión {d.revision} · {d.id}</option>)}</select></label>{selectedDraft && <><SavedDraftReview draft={selectedDraft} workflow={workflow} />{savedBlock && <p className="communications-alert" role="alert">{savedBlock}</p>}{alreadyApproved && <p className="communications-notice">Esta revisión ya está aprobada y sigue sin enviar.</p>}{editor && <p className="communications-alert">La aprobación está bloqueada mientras hay una edición abierta.</p>}
          <div className="communications-actions"><button className="button-secondary" disabled={!writable || !!editor || !workflow.associationStates.some(s => s.current && s.association.id === selectedDraft.associationId)} data-testid="communications-edit-draft" onClick={() => openEditor(selectedDraft)}>Editar borrador</button><button className="button-secondary" disabled={!writable || !!editor || !!savedBlock || alreadyApproved} data-testid="communications-verify-draft" onClick={verifySaved}>Verificar revisión guardada</button></div>
          <div className="communications-approval"><label className="communications-check"><input data-testid="communications-approval-check" type="checkbox" checked={approvalChecked} disabled={!writable || !!editor || !exactReview || !!savedBlock || alreadyApproved} onChange={event => setApprovalChecked(event.target.checked)} />He revisado el contenido exacto de la revisión {selectedDraft.revision} y su huella. Apruebo guardarla sin enviar.</label><button className="button-primary" disabled={!writable || !!editor || !exactReview || !approvalChecked || !!savedBlock || alreadyApproved} data-testid="communications-approve" onClick={approve}>Aprobar revisión {selectedDraft.revision} sin enviar</button><p className="communications-muted">Primero verifica la lectura guardada. Cada cambio requiere una nueva revisión y conformidad. El servidor vuelve a validar las fuentes, la política y la revisión al aprobar.</p></div>
        </>}</>}
      </section>
      <CommunicationsHistory workflow={workflow} />
    </>}</div><footer className="communications-footer">Gourmet Office · Muestra local aislada · Sin OAuth, importación, programación ni envío externo</footer></main>;
}
