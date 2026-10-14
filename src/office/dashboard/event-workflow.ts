/** Self-contained synthetic event. Never import connector, account or production data here. */
export type EventWorkflowTab = 'consulta' | 'brief' | 'cotizacion' | 'revision' | 'cobro' | 'operaciones' | 'tastings';
export type Attestation = 'metadata' | 'content' | 'context';
export type PaymentScenario = 'unknown' | 'confirmed_900';
export interface ProposalArtifactDescriptor { fileName: string; sha256: string; byteLength: number }
export interface ProposalArtifact extends ProposalArtifactDescriptor {
  href: string;
  previewHref?: string;
  previewSha256?: string;
  previewByteLength?: number;
}

export const EVENT_FIXTURE = {
  synthetic: true,
  identity: { eventId: 'DEMO-EVT-042', opportunityId: 'DEMO-OP-042', leadId: 'DEMO-L-014', accountId: 'DEMO-GOURMET', mailbox: 'eventos@invalid.test', recipient: 'aurora@invalid.test', threadId: 'DEMO-TH-042' },
  contact: 'Aurora', eventName: 'Cena de equipo',
  messages: [
    { id: 'DEMO-MSG-01', at: '13 oct 2026, 09:00 · America/Lima', text: 'Hola, queremos organizar una cena de equipo para 20 personas el 24 de noviembre a las 19:00 en Lima. ¿Nos pueden preparar una propuesta con servicio?' },
    { id: 'DEMO-MSG-02', at: '13 oct 2026, 09:12 · America/Lima', text: 'Finalmente seremos 24 personas. La dirección está por confirmar y les enviamos luego las restricciones alimentarias.' },
  ],
  brief: { id: 'BRIEF-042', revision: 2, attendees: 24, city: 'Lima', date: '24 nov 2026, 19:00', timeZone: 'America/Lima', dateStatus: 'proposed_unreserved', address: null, restrictions: null },
  quote: { id: 'QUOTE-042', revision: 2, total: 3000, deposit: 900, unit: 'U. DEMO', taxes: 'not_modeled', catalogueId: 'CAT-LAB-01', lines: [
    { name: 'Menú de cena de ejemplo', quantity: 24, unitPrice: 100 },
    { name: 'Servicio de ejemplo', quantity: 1, unitPrice: 400 },
    { name: 'Logística de ejemplo', quantity: 1, unitPrice: 200 },
  ] },
  attachment: { fileName: 'DEMO-EVT-042-propuesta-v2.pdf', sha256: '370eaa2e3668c3836e6e7c496b47b57b75d000682f260ffce868e803df57e630', byteLength: 12697 },
  preview: { sha256: '76aff590db6ca01d91a1053f32612a6f9d6678dfa52ba8e814500336b9d885a0', byteLength: 178239 },
  sources: ['DEMO-TH-042:r2', 'BRIEF-042:r2', 'CAT-LAB-01', 'QUOTE-042:r2'],
  coverage: { gmail: 'not_connected', monday: 'not_connected', calendar: 'not_connected' },
  subject: 'Propuesta v2 · Cena de equipo · DEMO-EVT-042',
  body: 'Hola, Aurora:\n\nTe compartimos la propuesta v2 para 24 personas. La fecha del 24 de noviembre a las 19:00, en Lima, sigue propuesta. Nos falta confirmar la dirección y las restricciones alimentarias.\n\nLa propuesta está adjunta. Quedamos atentos para revisar los detalles contigo.\n\nEquipo Gourmet · Ejemplo de diseño',
} as const;

export const EVENT_TABS: ReadonlyArray<{ id: EventWorkflowTab; label: string }> = [
  { id: 'consulta', label: 'Consulta' }, { id: 'brief', label: 'Brief' }, { id: 'cotizacion', label: 'Cotización' },
  { id: 'revision', label: 'Revisión exacta' }, { id: 'cobro', label: 'Cobro' }, { id: 'operaciones', label: 'Operación' }, { id: 'tastings', label: 'Tastings · Regus' },
];
export type DraftField = 'to' | 'cc' | 'bcc' | 'subject' | 'body';
export type PaymentStep = 'not_prepared' | 'prepared' | 'reviewed' | 'link_simulated' | 'message_reviewed' | 'shared_simulated' | 'unknown';
export type PlanningTask = 'menu' | 'transport' | 'purchases';
export interface EventWorkflowState {
  readonly mode: 'synthetic';
  readonly identity: typeof EVENT_FIXTURE.identity;
  draft: Record<DraftField, string> & { revision: number; attachmentIncluded: boolean };
  artifactAvailable: boolean;
  artifact: ProposalArtifact | null;
  contextRevision: number;
  attestations: Record<Attestation, boolean>;
  approval: { snapshot: string; draftRevision: number } | null;
  simulatedHandoff: boolean;
  humanClosed: boolean;
  sourcingStarted: boolean;
  payment: { step: PaymentStep; requestId: 'PR-042:r2'; linkId: 'LINK-LAB-042' | null; realUrl: null; collected: null; balance: null; reconciliation: 'pending'; attempts: number };
  paymentScenario: PaymentScenario;
  planning: Record<PlanningTask, boolean>;
  meeting: { type: 'tasting' | 'meeting'; city: string; zone: string; proposedDate: string; prepared: boolean; center: null; room: null; foodPermission: 'unknown'; cost: null; reservation: 'not_booked' };
  notice: string;
}
export type EventWorkflowAction =
  | { type: 'EDIT_DRAFT'; field: DraftField; value: string }
  | { type: 'SET_ATTACHMENT'; included: boolean }
  | { type: 'ARTIFACT_AVAILABLE'; available: boolean; artifactIdentity?: string }
  | { type: 'SYNC_ARTIFACT'; artifact: ProposalArtifact | null }
  | { type: 'CONTEXT_CHANGED' }
  | { type: 'ATTEST'; field: Attestation; checked: boolean }
  | { type: 'APPROVE_SIMULATION' }
  | { type: 'HANDOFF_SIMULATION' }
  | { type: 'CLOSE_SALE_SIMULATION' }
  | { type: 'START_SOURCING_SIMULATION' }
  | { type: 'PREPARE_PAYMENT' | 'REVIEW_PAYMENT' | 'CREATE_PAYMENT_LINK' | 'REVIEW_PAYMENT_MESSAGE' | 'SHARE_PAYMENT_LINK' | 'QUERY_PAYMENT_TIMEOUT' }
  | { type: 'SELECT_PAYMENT_SCENARIO'; scenario: PaymentScenario }
  | { type: 'SET_PLANNING'; task: PlanningTask; checked: boolean }
  | { type: 'EDIT_MEETING'; field: 'city' | 'zone' | 'proposedDate'; value: string }
  | { type: 'SET_MEETING_TYPE'; value: 'tasting' | 'meeting' }
  | { type: 'PREPARE_MEETING' }
  | { type: 'RESET'; artifactAvailable?: boolean };

const noAttestations = (): Record<Attestation, boolean> => ({ metadata: false, content: false, context: false });
const initialPayment = (): EventWorkflowState['payment'] => ({ step: 'not_prepared', requestId: 'PR-042:r2', linkId: null, realUrl: null, collected: null, balance: null, reconciliation: 'pending', attempts: 0 });
export function createEventWorkflowState(artifactAvailable = false, artifact: ProposalArtifact | null = null): EventWorkflowState {
  return { mode: 'synthetic', identity: EVENT_FIXTURE.identity,
    draft: { to: EVENT_FIXTURE.identity.recipient, cc: '', bcc: '', subject: EVENT_FIXTURE.subject, body: EVENT_FIXTURE.body, revision: 2, attachmentIncluded: true },
    artifactAvailable: artifactAvailable && isExpectedPreviewArtifact(artifact ?? undefined), artifact: normalizeProposalArtifact(artifact ?? undefined), contextRevision: 2, attestations: noAttestations(), approval: null, simulatedHandoff: false, humanClosed: false, sourcingStarted: false,
    payment: initialPayment(), paymentScenario: 'unknown', planning: { menu: false, transport: false, purchases: false },
    meeting: { type: 'tasting', city: 'Lima', zone: '', proposedDate: '', prepared: false, center: null, room: null, foodPermission: 'unknown', cost: null, reservation: 'not_booked' },
    notice: 'Caso local de laboratorio. No se ha aprobado, enviado, cobrado ni reservado nada.',
  };
}

/** Metadata already checked against bundled bytes by the build process; not a runtime network check. */
export function isExpectedProposalArtifact(artifact?: ProposalArtifactDescriptor): boolean {
  return !!artifact && artifact.fileName === EVENT_FIXTURE.attachment.fileName && artifact.sha256 === EVENT_FIXTURE.attachment.sha256 && artifact.byteLength === EVENT_FIXTURE.attachment.byteLength;
}
/** Restrict assets to normalized same-origin paths; this does not read or verify runtime bytes. */
export function normalizeLocalArtifactHref(href?: string): string | null {
  if (!href || !/^\/(?!\/)/.test(href) || /[\\\u0000-\u001f]/.test(href)) return null;
  const url = new URL(href, 'https://local.invalid');
  return url.origin === 'https://local.invalid' ? `${url.pathname}${url.search}${url.hash}` : null;
}
export function normalizeProposalArtifact(artifact?: ProposalArtifact): ProposalArtifact | null {
  if (!isExpectedProposalArtifact(artifact)) return null;
  const href = normalizeLocalArtifactHref(artifact?.href);
  if (!artifact || !href) return null;
  return { fileName: artifact.fileName, sha256: artifact.sha256, byteLength: artifact.byteLength, href,
    ...(artifact.previewHref !== undefined ? { previewHref: normalizeLocalArtifactHref(artifact.previewHref) ?? '' } : {}),
    ...(artifact.previewSha256 !== undefined ? { previewSha256: artifact.previewSha256 } : {}),
    ...(artifact.previewByteLength !== undefined ? { previewByteLength: artifact.previewByteLength } : {}),
  };
}
export function proposalArtifactIdentity(artifact?: ProposalArtifact | null): string {
  return JSON.stringify(normalizeProposalArtifact(artifact ?? undefined));
}
export function isExpectedPreviewArtifact(artifact?: ProposalArtifact): boolean {
  const normalized = normalizeProposalArtifact(artifact);
  return !!normalized?.previewHref && normalized.previewSha256 === EVENT_FIXTURE.preview.sha256
    && normalized.previewByteLength === EVENT_FIXTURE.preview.byteLength;
}
/** Exact in-memory serialization, deliberately not described as a cryptographic digest. */
export function exactReviewSnapshot(state: EventWorkflowState): string {
  return JSON.stringify({ identity: state.identity, draft: state.draft,
    attachment: state.draft.attachmentIncluded ? EVENT_FIXTURE.attachment : null, artifactAvailable: state.artifactAvailable, artifact: state.artifact,
    context: { revision: state.contextRevision, messages: EVENT_FIXTURE.messages, brief: EVENT_FIXTURE.brief, quote: EVENT_FIXTURE.quote, sources: EVENT_FIXTURE.sources, coverage: EVENT_FIXTURE.coverage },
  });
}
export function hasCurrentApproval(state: EventWorkflowState): boolean {
  return !!state.approval && state.approval.snapshot === exactReviewSnapshot(state) && state.approval.draftRevision === state.draft.revision;
}
export function canApproveSimulation(state: EventWorkflowState): boolean {
  return state.artifactAvailable && isExpectedPreviewArtifact(state.artifact ?? undefined) && state.draft.attachmentIncluded && !!state.draft.to.trim() && !!state.draft.subject.trim() && !!state.draft.body.trim()
    && Object.values(state.attestations).every(Boolean);
}
function invalidate(state: EventWorkflowState, changed: Partial<EventWorkflowState>): EventWorkflowState {
  return { ...state, ...changed, attestations: noAttestations(), approval: null, simulatedHandoff: false, humanClosed: false, sourcingStarted: false,
    payment: initialPayment(), paymentScenario: 'unknown',
    notice: 'Cambió el contenido o contexto. Revisión invalidada; las etapas dependientes de esta simulación vuelven a pendientes. No había acciones reales.',
  };
}
export function paymentScenarioView(state: EventWorkflowState) {
  return state.paymentScenario === 'confirmed_900'
    ? { scenario: 'confirmed_900' as const, label: 'Caso alternativo: anticipo confirmado de laboratorio', collected: 900, balance: 2100, reconciliation: 'pending' as const, supplierException: true }
    : { scenario: 'unknown' as const, label: 'Escenario principal: cobro desconocido', collected: state.payment.collected, balance: state.payment.balance, reconciliation: state.payment.reconciliation, supplierException: false };
}
export function eventWorkflowReducer(state: EventWorkflowState, action: EventWorkflowAction): EventWorkflowState {
  switch (action.type) {
    case 'EDIT_DRAFT':
      return state.draft[action.field] === action.value ? state : invalidate(state, { draft: { ...state.draft, [action.field]: action.value, revision: state.draft.revision + 1 } });
    case 'SET_ATTACHMENT':
      return state.draft.attachmentIncluded === action.included ? state : invalidate(state, { draft: { ...state.draft, attachmentIncluded: action.included, revision: state.draft.revision + 1 } });
    case 'ARTIFACT_AVAILABLE': {
      if (action.artifactIdentity !== undefined && action.artifactIdentity !== proposalArtifactIdentity(state.artifact)) return state;
      const available = action.available && isExpectedPreviewArtifact(state.artifact ?? undefined);
      return state.artifactAvailable === available ? state : invalidate(state, { artifactAvailable: available });
    }
    case 'SYNC_ARTIFACT': {
      const artifact = normalizeProposalArtifact(action.artifact ?? undefined);
      if (proposalArtifactIdentity(artifact) === proposalArtifactIdentity(state.artifact)) return state;
      return invalidate(state, { artifact, artifactAvailable: isExpectedPreviewArtifact(artifact ?? undefined) });
    }
    case 'CONTEXT_CHANGED': return invalidate(state, { contextRevision: state.contextRevision + 1 });
    case 'ATTEST':
      if (state.attestations[action.field] === action.checked) return state;
      return action.checked ? { ...state, attestations: { ...state.attestations, [action.field]: true } }
        : invalidate(state, { attestations: noAttestations() });
    case 'APPROVE_SIMULATION':
      if (hasCurrentApproval(state) || !canApproveSimulation(state)) return state;
      return { ...state, approval: { snapshot: exactReviewSnapshot(state), draftRevision: state.draft.revision }, notice: 'Versión exacta aprobada solo en la simulación. No se ha enviado nada.' };
    case 'HANDOFF_SIMULATION':
      if (state.simulatedHandoff || !hasCurrentApproval(state)) return state;
      return { ...state, simulatedHandoff: true, notice: 'Salto temporal explícito: envío ficticio registrado en memoria. Ningún correo ha salido.' };
    case 'CLOSE_SALE_SIMULATION':
      if (state.humanClosed || !state.simulatedHandoff || !hasCurrentApproval(state)) return state;
      return { ...state, humanClosed: true, notice: 'Cierre humano simulado. Solo habilita preparar la solicitud y buscar candidatos; no reserva fecha ni asigna proveedor.' };
    case 'START_SOURCING_SIMULATION':
      if (!state.humanClosed || state.sourcingStarted) return state;
      return { ...state, sourcingStarted: true, notice: 'Búsqueda simulada abierta. Chef DEMO-03 sigue sin contacto, disponibilidad, aceptación ni asignación.' };
    case 'PREPARE_PAYMENT':
      if (!state.humanClosed || state.payment.step !== 'not_prepared') return state;
      return { ...state, payment: { ...state.payment, step: 'prepared' }, notice: 'Solicitud PR-042:r2 preparada en laboratorio por 900 U. DEMO. Sin cobro.' };
    case 'REVIEW_PAYMENT':
      if (state.payment.step !== 'prepared') return state;
      return { ...state, payment: { ...state.payment, step: 'reviewed' }, notice: 'Solicitud revisada en simulación. Todavía no existe ningún enlace.' };
    case 'CREATE_PAYMENT_LINK':
      if (state.payment.step !== 'reviewed') return state;
      return { ...state, payment: { ...state.payment, step: 'link_simulated', linkId: 'LINK-LAB-042' }, notice: 'Referencia local LINK-LAB-042 creada. No es una URL y no permite pagar.' };
    case 'REVIEW_PAYMENT_MESSAGE':
      if (state.payment.step !== 'link_simulated') return state;
      return { ...state, payment: { ...state.payment, step: 'message_reviewed' }, notice: 'Mensaje de solicitud revisado por separado, solo en simulación.' };
    case 'SHARE_PAYMENT_LINK':
      if (state.payment.step !== 'message_reviewed') return state;
      return { ...state, payment: { ...state.payment, step: 'shared_simulated' }, notice: 'Salto temporal: mensaje ficticio compartido. No se envió mensaje ni enlace real.' };
    case 'QUERY_PAYMENT_TIMEOUT':
      if (state.payment.step !== 'shared_simulated') return state;
      return { ...state, payment: { ...state.payment, step: 'unknown', attempts: 1 }, notice: 'TIMEOUT_DEMO. Cobrado y saldo desconocidos. Conservar PR-042:r2; no reenviar ni cobrar otra vez.' };
    case 'SELECT_PAYMENT_SCENARIO':
      return state.paymentScenario === action.scenario ? state : { ...state, paymentScenario: action.scenario, notice: action.scenario === 'confirmed_900' ? 'Caso alternativo aislado: 900 cobrados, 2.100 de saldo y conciliación pendiente. El principal conserva su cobro desconocido.' : 'De vuelta al caso principal: se conserva la misma solicitud y el resultado desconocido.' };
    case 'SET_PLANNING':
      return state.planning[action.task] === action.checked ? state : { ...state, planning: { ...state.planning, [action.task]: action.checked }, notice: 'Nota de preparación local actualizada. No acredita compra, recepción, calidad ni evento listo.' };
    case 'EDIT_MEETING':
      return state.meeting[action.field] === action.value ? state : { ...state, meeting: { ...state.meeting, [action.field]: action.value, prepared: false }, notice: 'Propuesta de coordinación editada. Reserva, costes y permisos siguen sin verificar.' };
    case 'SET_MEETING_TYPE':
      return state.meeting.type === action.value ? state : { ...state, meeting: { ...state.meeting, type: action.value, prepared: false } };
    case 'PREPARE_MEETING':
      if (state.meeting.prepared || !state.meeting.city.trim() || !state.meeting.zone.trim()) return state;
      return { ...state, meeting: { ...state.meeting, prepared: true }, notice: 'Ficha de coordinación preparada localmente para revisión humana. Centro y sala pendientes; ninguna reserva ni invitación.' };
    case 'RESET': return createEventWorkflowState(action.artifactAvailable ?? state.artifactAvailable, state.artifact);
    default: return state;
  }
}

/** Exact text extracted with pdftotext -layout from the verified bundled PDF. */
export const PROPOSAL_PDF_EXTRACTED_TEXT = "Propuesta v2 · Documento de laboratorio\n\n   No es una cotización comercial de Gourmet.\n   Contenido ficticio. Unidades DEMO, no moneda. No habilita pagos, reservas ni\n   contratación.\n\n\n\nCena de equipo · Empresa Aurora DEMO\n\nEvento DEMO-EVT-042 · Oportunidad DEMO-OP-042\nCliente Aurora · aurora@invalid.test\nBrief BRIEF-042:r2 · Catálogo CAT-LAB-01 · QUOTE-042:r2\n\n24 personas. Fecha propuesta: 24 nov 2026, 19:00, America/Lima.\nLima; dirección y restricciones alimentarias pendientes. No hay reserva confirmada.\n\n\n Concepto ficticio                                Cantidad             U. DEMO                    Subtotal\n\n\n Menú de cena de ejemplo                          24                   100                            2.400\n\n\n Servicio de ejemplo                              1                    400                                  400\n\n\n Logística de ejemplo                             1                    200                                  200\n\n\n Total del escenario de prueba                                                                        3.000\n\n\nAnticipo de laboratorio: 900 U. DEMO.\nResto esperado: 2.100 U. DEMO solo si se verifica el anticipo.\nImpuestos no modelados. No representa deuda ni obligación comercial.\n\nCondiciones del ejemplo\n\nLa versión v1 para 20 personas queda superada. Se requiere una revisión nueva de texto,\ndestinatarios, adjunto y contexto. Aprobar un borrador no envía, no confirma la fecha y no\ncontrata al proveedor.\n\nArchivo sintético para inspeccionar el contenido del adjunto en el prototipo de diseño. No proviene de un\ncatálogo real ni del sistema de producción.";
