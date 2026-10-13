import type { ApprovalQueue, DashboardReadSource, DashboardReviewSource, DashboardSnapshot } from './contracts';
import { communicationsClient, CommunicationsClientError, latestDrafts, validateCommunicationsReview, verifyDraftContext } from '../communications-client';
import type { CommunicationsClient } from '../communications-client';

const AS_OF = '2026-10-13T00:00:00.000Z';
const sample: DashboardSnapshot = {
  mode: 'fixture', asOf: AS_OF, periodStart: '2026-10-01T00:00:00.000Z', outboundEffects: 0,
  sources: [
    { id: 'sample', label: 'Muestra del dashboard', mode: 'fixture', coverage: 'partial', lastVerifiedAt: AS_OF, note: 'Cuatro oportunidades inventadas para evaluar la interfaz. Corte fijo de la muestra, no sincronización del negocio.' },
    { id: 'monday', label: 'Monday · oportunidades', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'El dashboard no consulta Monday. No se ha verificado aquí una conexión operativa.' },
    { id: 'gmail', label: 'Gmail · buzones separados', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'Sin lectura de cuentas reales. La revisión local utiliza solo buzones @example.test.' },
    { id: 'web', label: 'Formulario web', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'La consulta de ejemplo no está importada del formulario público.' },
    { id: 'instagram', label: 'Instagram', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'Canal no conectado. No se reciben ni contestan mensajes.' },
    { id: 'messenger', label: 'Messenger', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'Canal no conectado. No se reciben ni contestan mensajes.' },
    { id: 'payments', label: 'Pagos', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'Sin evidencia de cobros, saldos ni enlaces de pago.' },
    { id: 'ads', label: 'Publicidad', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'Sin gasto, atribución ni retorno verificables.' },
    { id: 'catalog', label: 'Catálogo y conocimiento', mode: 'unconfigured', coverage: 'unknown', lastVerifiedAt: null, note: 'No hay tarifas o reglas comerciales autorizadas para producir presupuestos.' },
  ],
  opportunities: [
    { id: 'sample-aurora', name: 'Aurora · ejemplo', event: 'Cena de equipo', stage: 'new', guests: 12, eventDate: '2026-11-12', enteredStageAt: '2026-10-12T10:00:00.000Z', amountMinor: null, currency: null, sourceId: 'sample', channel: 'email' },
    { id: 'sample-cedar', name: 'Cedar · ejemplo', event: 'Celebración familiar', stage: 'qualifying', guests: null, eventDate: null, enteredStageAt: '2026-10-10T15:00:00.000Z', amountMinor: null, currency: null, sourceId: 'sample', channel: 'email' },
    { id: 'sample-olivo', name: 'Olivo · ejemplo', event: 'Cóctel de bienvenida', stage: 'proposal', guests: 40, eventDate: '2026-11-20', enteredStageAt: '2026-10-08T12:00:00.000Z', amountMinor: null, currency: null, sourceId: 'sample', channel: 'web' },
    { id: 'sample-marea', name: 'Marea · ejemplo', event: 'Encuentro privado', stage: 'confirmed', guests: 20, eventDate: '2026-11-25', enteredStageAt: '2026-10-05T09:00:00.000Z', amountMinor: null, currency: null, sourceId: 'sample', channel: 'web' },
  ],
  conversations: [
    { id: 'sample-aurora-info', contact: 'Aurora · ejemplo', subject: 'Consulta sobre una cena de equipo', bodyText: 'Mensaje inventado: queremos conocer las opciones para una cena de doce personas. Todavía no hay un presupuesto validado.', channel: 'email', mailbox: 'info@example.test', state: 'needs_review', at: '2026-10-12T10:00:00.000Z', sourceId: 'sample', opportunityId: 'sample-aurora' },
    { id: 'sample-aurora-felipe', contact: 'Aurora · ejemplo', subject: 'La misma consulta en otro buzón', bodyText: 'Mensaje inventado en otro buzón. Las dos conversaciones no se fusionan ni se vinculan automáticamente. La asociación necesita evidencia y revisión explícita.', channel: 'email', mailbox: 'felipe@example.test', state: 'unread', at: '2026-10-12T09:00:00.000Z', sourceId: 'sample', opportunityId: null },
    { id: 'sample-cedar-info', contact: 'Cedar · ejemplo', subject: 'Faltan fecha y número de invitados', bodyText: 'Mensaje inventado: estamos definiendo los detalles del evento. No se debe inferir fecha, precio ni disponibilidad.', channel: 'email', mailbox: 'info@example.test', state: 'waiting', at: '2026-10-10T15:00:00.000Z', sourceId: 'sample', opportunityId: 'sample-cedar' },
    { id: 'sample-olivo-web', contact: 'Olivo · ejemplo', subject: 'Solicitud de cóctel desde formulario', bodyText: 'Consulta de formulario inventada para mostrar el diseño. No acredita una importación, un cliente real ni el envío de una propuesta.', channel: 'web', mailbox: null, state: 'needs_review', at: '2026-10-08T12:00:00.000Z', sourceId: 'sample', opportunityId: 'sample-olivo' },
  ],
  activity: [
    { id: 'sample-activity-1', label: 'Consulta sintética de Aurora añadida a la muestra', at: '2026-10-12T10:00:00.000Z', sourceId: 'sample', kind: 'inquiry' },
    { id: 'sample-activity-2', label: 'Ejemplo Cedar: faltan detalles del evento', at: '2026-10-10T15:00:00.000Z', sourceId: 'sample', kind: 'review' },
    { id: 'sample-activity-3', label: 'Ejemplo Olivo en etapa propuesta, sin precio ni envío', at: '2026-10-08T12:00:00.000Z', sourceId: 'sample', kind: 'proposal' },
  ],
};

export const dashboardFixtureSource: DashboardReadSource = Object.freeze({ mode: 'fixture' as const, async read(signal: AbortSignal) { signal.throwIfAborted(); return structuredClone(sample); } });
export class DashboardReadError extends Error {
  constructor(readonly code: 'expired' | 'invalid_scope' | 'invalid_relation') { super(code); this.name = 'DashboardReadError'; }
}
// A deliberately narrow dependency: this adapter cannot start sessions, edit
// sources, create drafts, approve or dispatch. Never fall back to real providers.
export function createDashboardReviewSource(reader: Pick<CommunicationsClient, 'read'>, clock: () => number = Date.now): DashboardReviewSource {
  return Object.freeze({ async read(signal: AbortSignal): Promise<ApprovalQueue> {
    signal.throwIfAborted();
    const view = validateCommunicationsReview(await reader.read(signal));
    signal.throwIfAborted();
    if (view.session.organizationId !== 'gourmet-communications-fixture' || !/^fixture-[a-f0-9-]{36}$/.test(view.session.actorId)) throw new DashboardReadError('invalid_scope');
    if (Date.parse(view.session.expiresAt) <= clock()) throw new DashboardReadError('expired');
    const workflow = view.workflow;
    const items = await Promise.all(latestDrafts(workflow).map(async draft => {
      const association = workflow.associations.find(a => a.id === draft.associationId && a.digest === draft.associationDigest);
      const account = workflow.snapshots.find(s => s.id === association?.accountSnapshotId);
      const thread = workflow.snapshots.find(s => s.id === association?.threadSnapshotId);
      if (!association || account?.kind !== 'account' || thread?.kind !== 'thread' || account.data.accountId !== thread.data.accountId || account.data.mailbox !== thread.data.mailbox) throw new DashboardReadError('invalid_relation');
      const reason = await verifyDraftContext(workflow, draft);
      const approved = workflow.approvals.some(a => a.current && a.approval.draftId === draft.id && a.approval.draftRevision === draft.revision && a.approval.draftDigest === draft.digest);
      return { id: draft.id, revision: draft.revision, digest: draft.digest, subject: draft.subject, recipient: draft.to.join(', '), mailbox: account.data.email, state: reason ? 'blocked' as const : approved ? 'approved_unsent' as const : 'needs_review' as const, reason: reason ?? (approved ? 'Aprobación guardada sin envío. No se ha enviado ningún mensaje.' : 'Requiere abrir la revisión, seleccionar el borrador y verificar de nuevo el contenido y contexto exactos.'), href: '/office/communications' as const };
    }));
    signal.throwIfAborted();
    if (Date.parse(view.session.expiresAt) <= clock()) throw new DashboardReadError('expired');
    return { mode: 'fixture', workflowRevision: workflow.revision, expiresAt: view.session.expiresAt, items, outboundEffects: 0 };
  } });
}
export const dashboardReviewSource = createDashboardReviewSource({ read: signal => communicationsClient.read(signal) });
export function dashboardErrorText(error: unknown): string {
  if (error instanceof DashboardReadError && error.code === 'expired' || error instanceof CommunicationsClientError && error.status === 401) return 'No hay una sesión local vigente. Abre la revisión de comunicaciones e inicia allí una sesión sintética de forma explícita.';
  if (error instanceof CommunicationsClientError && error.status === 404) return 'La revisión local está desactivada en este servidor. La muestra del dashboard no necesita habilitarla.';
  if (error instanceof CommunicationsClientError && error.status === 403) return 'Acceso rechazado. La cola no está disponible y no se ha intentado otra cuenta.';
  return 'No se pudo verificar esta lectura. Los pendientes son desconocidos; no se muestran como cero ni se reintenta automáticamente.';
}
