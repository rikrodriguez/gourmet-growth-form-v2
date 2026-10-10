import type { FunctionId, OfficeCommand } from '../contracts';
import { computeApprovalDigest, draftCore, runPilotCommand } from './pilot-core';
import { DEMO_ACTOR, FUNCTION_AREAS, FUNCTION_NAMES, OfficeError, assertOfficeState, currentTime, evidence, parseOfficeCommand, projectOfficeSnapshot, sha256 } from './state';
import type { OfficeState, OfficeStore, DemoCaseId, ApprovalLink } from './state';
import { commercialHistoryBinding, commercialScriptedDraft, resolveCommercialThread } from './commercial-fixtures';

function demoText(text: string) { return text.startsWith('DEMO — ') ? text : `DEMO — ${text}`; }

function scriptedResponse(state: OfficeState, caseId: DemoCaseId, functionId: FunctionId) {
  const item = state.office.cases[caseId];
  const topic: Record<FunctionId, string> = {
    sales: `Venta humana ${item.saleClosed ? 'cerrada en el fixture' : 'abierta'}. ${item.assignment === 'queued' ? 'En cola porque no hay closer disponible.' : 'Responsable asignado en fixture.'} La llamada intentada y el contacto humano son medidas distintas.`,
    proposals: 'Puedo preparar un borrador con catálogo ilustrativo y revisiones. No tengo menú, disponibilidad ni precios reales conectados.',
    coordination: 'Puedo preparar brief y checklist de tasting. Calendarios y confirmaciones reales no están conectados.',
    logistics: 'Puedo preparar un checklist de montaje y transporte. No tengo rutas, inventario ni proveedores logísticos conectados.',
    suppliers: item.saleClosed ? `El cierre humano sintético permite preparar una revisión. Proveedor ${item.supplier}; no se busca ni contacta a chefs desde esta demo.` : 'La búsqueda de chef está bloqueada hasta cerrar la venta humana. No confundir un borrador comercial con cierre.',
    finance: `Pago ${item.payment}; proveedor ${item.supplier}. Son estados independientes. Sin confirmación bancaria real ni enlace de cobro; conciliación manual semanal pendiente.`,
    quality: 'Puedo preparar un checklist de calidad. Faltan reseñas, evaluación del evento y evidencia real.',
    marketing: 'Puedo preparar una hipótesis de campaña. Faltan datos actuales de anuncios; no se publican campañas ni se realiza gasto.',
    talent: 'Puedo preparar criterios de selección. No hay candidatos conectados ni personal contratado por esta oficina.',
  };
  return `DEMO — Respuesta guionada local de ${FUNCTION_NAMES[functionId]}, sin LLM. ${topic[functionId]} Ninguna aprobación ejecuta acciones externas.`;
}
function recordHistory(state: OfficeState, command: OfficeCommand, atMs: number, title: string, detail: string, status: 'completed' | 'blocked' | 'awaiting_approval' | 'stale') {
  const id = `history-${sha256(command.idempotencyKey).slice(0, 24)}`;
  state.office.history[id] = { id, caseId: command.caseId as DemoCaseId, functionId: command.functionId, commandKey: command.idempotencyKey, title, detail, status, evidence: evidence(command.caseId as DemoCaseId, id, atMs) };
}
function checkedApproval(state: OfficeState, command: OfficeCommand) {
  const link = Object.hasOwn(state.office.approvals, command.approvalId!) ? state.office.approvals[command.approvalId!] : undefined;
  if (!link || link.caseId !== command.caseId || link.functionId !== command.functionId) throw new OfficeError('APPROVAL_NOT_FOUND', 404);
  if (link.revision !== command.revision) throw new OfficeError('REVISION_CONFLICT', 409);
  if (link.digest !== command.digest || computeApprovalDigest(state, link) !== command.digest) throw new OfficeError('APPROVAL_DIGEST_MISMATCH', 409);
  return link;
}
export async function executeOfficeCommand(store: OfficeStore, raw: unknown, clock = Date.now) {
  const command = parseOfficeCommand(raw);
  const inputDigest = sha256(command);
  return store.transact(async state => {
    assertOfficeState(state);
    const previous = Object.hasOwn(state.office.commands, command.idempotencyKey) ? state.office.commands[command.idempotencyKey] : undefined;
    const atMs = currentTime(clock);
    if (previous) {
      if (previous.digest !== inputDigest) throw new OfficeError('IDEMPOTENCY_CONFLICT', 409);
      // Replay reports current authoritative state; it never restores an old approval.
      return { snapshot: projectOfficeSnapshot(state, atMs), replayed: true };
    }
    const caseId = command.caseId as DemoCaseId;
    const item = state.office.cases[caseId];
    if (command.functionId === 'suppliers' && command.action !== 'chat' && item.saleClosed !== true) throw new OfficeError('SALE_NOT_CLOSED', 403);
    const token = sha256(command.idempotencyKey).slice(0, 24);
    if (command.action === 'chat') {
      const response = scriptedResponse(state, caseId, command.functionId);
      const ev = evidence(caseId, `chat-${token}`, atMs, 'demo:scripted-chat');
      item.messages.push({ id: `message-${token}-user`, area: FUNCTION_AREAS[command.functionId], functionId: command.functionId, author: 'Operador · identidad DEMO', text: `DEMO — ${command.text!}`, evidence: ev }, { id: `message-${token}-response`, area: FUNCTION_AREAS[command.functionId], functionId: command.functionId, author: `${FUNCTION_NAMES[command.functionId]} · guion DEMO`, text: response, evidence: { ...ev, reference: `${ev.reference}:response` } });
      state.office.jobs[`job-${token}-chat`] = { id: `job-${token}-chat`, caseId, area: FUNCTION_AREAS[command.functionId], functionId: command.functionId, title: 'Respuesta guionada DEMO', detail: 'Conversación local guardada; no se consultó un LLM ni se envió un mensaje externo.', status: 'completed', evidence: ev };
      recordHistory(state, command, atMs, 'Chat guionado guardado · DEMO', 'Pregunta y respuesta sintéticas persistidas en PostgreSQL local. Sin LLM ni fuentes conectadas.', 'completed');
    } else if (command.action === 'draft') {
      const id = `approval-${token}`;
      const coreDraftId = `draft-${token}`;
      const commercialContext = command.commercialThreadId !== undefined ? resolveCommercialThread(state, command) : undefined;
      const text = commercialContext ? commercialScriptedDraft(commercialContext) : demoText(command.text ?? scriptedResponse(state, caseId, command.functionId));
      const recipient = commercialContext?.recipient ?? 'cliente-demo@invalid.test';
      const refs = command.functionId === 'proposals' ? [{ draftId: `quote-${caseId}-fixture`, revision: 1 }] : [];
      await runPilotCommand(state, caseId, 'message', { draftId: coreDraftId, channel: 'email', recipient, text, artifactRefs: refs }, `${token}-draft`, atMs);
      const ev = evidence(caseId, `${id}-revision-1`, atMs);
      const jobId = `job-${token}`;
      const link: ApprovalLink = { id, caseId, functionId: command.functionId, coreDraftId, title: `${FUNCTION_NAMES[command.functionId]} · ${commercialContext ? 'respuesta contextual' : 'borrador'} DEMO`, account: 'Gourmet · cuenta de demostración', channel: 'email', recipient, attachments: refs.length ? [`Cotización DEMO ${caseId} · revisión 1`] : [], revision: 1, digest: '', status: 'pending', evidence: ev, jobId, ...(commercialContext ? { commercialContext: structuredClone(commercialContext) } : {}) };
      link.digest = computeApprovalDigest(state, link);
      state.office.approvals[id] = link;
      state.office.jobs[jobId] = { id: jobId, caseId, functionId: command.functionId, area: FUNCTION_AREAS[command.functionId], title: link.title, detail: 'DEMO — Requiere decisión humana. No hay envío ni ejecución externa.', status: 'waiting_approval', evidence: ev, approvalId: id, revision: 1 };
      recordHistory(state, command, atMs, commercialContext ? 'Respuesta comercial preparada · DEMO' : 'Borrador preparado · DEMO', `Contenido exacto, cuenta, destinatario y adjuntos quedan vinculados a la revisión. No se envió.${commercialHistoryBinding(commercialContext)}`, 'awaiting_approval');
    } else {
      const link = checkedApproval(state, command);
      if (command.action !== 'revise' && link.status !== 'pending') throw new OfficeError('APPROVAL_TERMINAL', 409);
      if (command.action === 'revise') {
        const current = state.drafts[link.coreDraftId]!;
        const record = current.revisions[link.revision]!;
        // Stored refs include derived contentDigest; domain input accepts only
        // identity/revision and recomputes the binding to current artifacts.
        const artifactRefs = (record.artifactRefs as Array<{ draftId: string; revision: number }>).map(({ draftId, revision }) => ({ draftId, revision }));
        await runPilotCommand(state, caseId, 'revise_message', { draftId: link.coreDraftId, channel: link.channel, recipient: link.recipient, text: demoText(command.text!), artifactRefs, expectedRevision: link.revision }, `${token}-revise`, atMs);
        const oldJob = state.office.jobs[link.jobId]!;
        oldJob.status = 'stale'; oldJob.detail = 'DEMO — Revisión anterior desactualizada; su aprobación dejó de ser válida.';
        link.revision += 1; link.status = 'pending'; delete link.coreApprovalId;
        link.evidence = evidence(caseId, `${link.id}-revision-${link.revision}`, atMs);
        link.digest = computeApprovalDigest(state, link);
        const jobId = `job-${token}-revision-${link.revision}`;
        link.jobId = jobId;
        state.office.jobs[jobId] = { id: jobId, caseId, functionId: link.functionId, area: FUNCTION_AREAS[link.functionId], title: `${link.title} · revisión ${link.revision}`, detail: 'DEMO — Nueva revisión; requiere nueva decisión exacta. Sin ejecución externa.', status: 'waiting_approval', evidence: link.evidence, approvalId: link.id, revision: link.revision };
        recordHistory(state, command, atMs, 'Nueva revisión · DEMO', `La revisión anterior y cualquier aprobación dependiente quedaron desactualizadas. Se abrió una nueva revisión pendiente.${commercialHistoryBinding(link.commercialContext)}`, 'awaiting_approval');
      } else {
        const job = state.office.jobs[link.jobId]!;
        if (command.action === 'approve') {
          const reviewed = draftCore.reviewMessageDraft(state, { draftId: link.coreDraftId, revision: link.revision });
          const coreApprovalId = `core-approval-${token}`;
          await runPilotCommand(state, caseId, 'approve_message', { approvalId: coreApprovalId, draftId: link.coreDraftId, revision: link.revision, reviewDigest: reviewed.reviewDigest }, `${token}-approve`, atMs, true);
          link.coreApprovalId = coreApprovalId;
          link.status = 'approved_demo'; job.status = 'blocked'; job.detail = 'DEMO — Aprobación registrada; envío y ejecución externa siguen bloqueados. No acredita pago ni acepta proveedor.';
        } else {
          link.status = command.action === 'reject' ? 'rejected_demo' : 'cancelled_demo';
          job.status = 'completed'; job.detail = `DEMO — Decisión ${command.action === 'reject' ? 'de rechazo' : 'de cancelación'} registrada. No hubo ejecución ni envío.`;
        }
        link.evidence = evidence(caseId, `${link.id}-${command.action}-revision-${link.revision}`, atMs);
        job.evidence = link.evidence;
        recordHistory(state, command, atMs, command.action === 'approve' ? 'Aprobación registrada · DEMO' : command.action === 'reject' ? 'Borrador rechazado · DEMO' : 'Borrador cancelado · DEMO', `${job.detail}${commercialHistoryBinding(link.commercialContext)}`, command.action === 'approve' ? 'blocked' : 'completed');
        item.results.push({ id: `result-${token}`, area: FUNCTION_AREAS[command.functionId], functionId: command.functionId, title: command.action === 'approve' ? 'Aprobado DEMO · ejecución bloqueada' : command.action === 'reject' ? 'Rechazo DEMO registrado' : 'Cancelación DEMO registrada', detail: job.detail, evidence: link.evidence });
      }
    }
    const snapshot = projectOfficeSnapshot(state, atMs);
    state.office.commands[command.idempotencyKey] = { key: command.idempotencyKey, digest: inputDigest, input: command, actorId: DEMO_ACTOR, atMs };
    return { snapshot, replayed: false };
  });
}
