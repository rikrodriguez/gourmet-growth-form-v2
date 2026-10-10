import type { CommercialThread, OfficeCommand } from '../contracts';
import type { DemoCaseId, OfficeState } from './state';
import { OfficeError, canonical, currentTime, evidence, sha256 } from './state';

const CASE_NAMES: Record<DemoCaseId, string> = { 'demo-aurora': 'Aurora', 'demo-cedar': 'Cedar', 'demo-harbor': 'Harbor' };

// Fixtures belong to the server, not an import payload or a connected mailbox.
// The persisted initialization time makes their revisions stable across restarts.
export function createCommercialThreads(caseId: DemoCaseId, initializedAtMs: number): CommercialThread[] {
  currentTime(() => initializedAtMs);
  return (['brief', 'followup'] as const).map((kind, index) => {
    const id = `commercial-${caseId}-${kind}`;
    const atMs = Math.max(0, initializedAtMs - (90 - index * 30) * 1000);
    const at = new Date(atMs).toISOString();
    const fixtureEvidence = evidence(caseId, `${id}-revision-1`, atMs, 'fixture:office-demo');
    const thread: Omit<CommercialThread, 'digest'> = {
      schemaVersion: 1, id, caseId, revision: 1,
      subject: kind === 'brief' ? `Solicitud de brief · ${CASE_NAMES[caseId]} · DEMO` : `Seguimiento de información · ${CASE_NAMES[caseId]} · DEMO`,
      recipient: `${caseId}@invalid.test`,
      messages: [
        { id: `${id}-client`, author: 'Cliente sintético', at, text: kind === 'brief' ? 'Estamos preparando un evento ficticio. Queremos revisar el formato y las preferencias alimentarias antes de definir un menú.' : 'Seguimos evaluando el evento ficticio. ¿Qué información del brief necesitan para poder revisarlo?' },
        { id: `${id}-team`, author: 'Equipo comercial sintético', at: new Date(Math.max(atMs, initializedAtMs - 10_000)).toISOString(), text: 'Para revisar el brief necesitamos fecha, ubicación, cantidad de asistentes y restricciones alimentarias. Este intercambio sintético no confirma precio, disponibilidad ni venta.' },
      ],
      references: [
        { id: `${id}-fixture`, source: 'fixture', status: 'simulated', label: 'Conversación sintética disponible', detail: 'Fixture local de demostración; no acredita correo ni solicitud de un cliente real.', evidence: structuredClone(fixtureEvidence) },
        { id: `${id}-gmail`, source: 'gmail', status: 'missing', label: 'Gmail · sin conexión', detail: 'No hay correo real conectado, consultado ni importado.', evidence: null },
        { id: `${id}-monday`, source: 'monday', status: 'missing', label: 'Monday · sin conexión', detail: 'No hay tablero ni evidencia real de disponibilidad conectados.', evidence: null },
      ],
      evidence: fixtureEvidence,
    };
    return { ...thread, digest: sha256(thread) };
  });
}

export function resolveCommercialThread(state: OfficeState, command: OfficeCommand): CommercialThread {
  const thread = createCommercialThreads(command.caseId as DemoCaseId, state.office.initializedAtMs).find(row => row.id === command.commercialThreadId);
  if (!thread) throw new OfficeError('COMMERCIAL_THREAD_NOT_FOUND', 404);
  if (thread.revision !== command.commercialThreadRevision) throw new OfficeError('COMMERCIAL_THREAD_REVISION_CONFLICT', 409);
  if (thread.digest !== command.commercialThreadDigest) throw new OfficeError('COMMERCIAL_THREAD_DIGEST_MISMATCH', 409);
  return structuredClone(thread);
}

export function assertCommercialContext(state: OfficeState, value: unknown, caseId: DemoCaseId): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficeError('INVALID_COMMERCIAL_CONTEXT', 503);
  const context = value as CommercialThread;
  const expected = createCommercialThreads(caseId, state.office.initializedAtMs).find(row => row.id === context.id);
  if (!expected || canonical(expected) !== canonical(context)) throw new OfficeError('INVALID_COMMERCIAL_CONTEXT', 503);
}

export function commercialHistoryBinding(context: CommercialThread | undefined): string {
  return context ? ` Hilo ${context.id} · revisión ${context.revision} · referencia ${context.evidence.reference} · digest ${context.digest}. Gmail y Monday ausentes; contexto sintético.` : '';
}

export function commercialScriptedDraft(context: CommercialThread): string {
  return `DEMO — Respuesta comercial guionada para revisión interna; no se ha enviado.\nHilo: ${context.subject}\nContexto sintético citado:\n${context.messages.map(row => `${row.author}: ${row.text}`).join('\n')}\nRespuesta propuesta: Gracias por la información del brief. Antes de preparar una propuesta, necesitamos confirmar fecha, ubicación, cantidad de asistentes y restricciones alimentarias. No podemos confirmar precio ni disponibilidad con las fuentes actuales.\nFuentes: conversación fixture disponible; Gmail y Monday ausentes. No se consultó un LLM ni se contactó a un cliente o proveedor. Ninguna aprobación ejecuta un envío, acredita pago o cierra una venta.`;
}
