import { draftCore, computeApprovalDigest, paymentCore, officePilotPolicy } from './pilot-core';
import { CASE_IDS, DEMO_ACTOR, FUNCTION_AREAS, FUNCTION_IDS, FUNCTION_NAMES, evidence, currentTime } from './state';
import type { OfficeState, DemoCaseId, DemoCase, JobStatus, ApprovalLink } from './state';

export function createOfficeFixtureState(nowMs = Date.now()): OfficeState {
  currentTime(() => nowMs);
  const tables = ['leads', 'closers', 'assignments', 'callBindings', 'callEvents', 'payments', 'invoices', 'exceptions', 'drafts', 'approvals', 'commands', 'sourceLeadBindings', 'providerEvents', 'audit', 'reconciliations', 'closerIdentityBindings'];
  const state = { version: 1, mode: 'simulation', ...Object.fromEntries(tables.map(name => [name, {}])), office: { version: 1, syntheticOnly: true, actorId: DEMO_ACTOR, initializedAtMs: nowMs, cases: {}, approvals: {}, jobs: {}, history: {}, commands: {} } } as OfficeState;
  const at = (seconds: number) => Math.max(0, nowMs - seconds * 1000);
  const fixture = (id: DemoCaseId, reference: string, milliseconds = nowMs) => evidence(id, reference, milliseconds, 'fixture:office-demo');
  const definitions: Array<{ id: DemoCaseId; title: string; subtitle: string; seconds: number; payment: DemoCase['payment']; supplier: DemoCase['supplier']; closed: boolean; attemptedSeconds: number | null; connectedSeconds: number | null }> = [
    { id: 'demo-aurora', title: 'Aurora · cena corporativa', subtitle: 'DEMO · venta humana cerrada; anticipo verificado sintético (USD 37.45 de 74.90), saldo pendiente y proveedor pendiente.', seconds: 180, payment: 'verified', supplier: 'pending', closed: true, attemptedSeconds: 20, connectedSeconds: 35 },
    { id: 'demo-cedar', title: 'Cedar · recepción de equipo', subtitle: 'DEMO · venta humana cerrada; pago pendiente y proveedor aceptado sintético.', seconds: 240, payment: 'pending', supplier: 'accepted', closed: true, attemptedSeconds: 25, connectedSeconds: null },
    { id: 'demo-harbor', title: 'Harbor · nuevo lead', subtitle: 'DEMO · venta abierta; en cola porque no hay closer disponible.', seconds: 45, payment: 'pending', supplier: 'unknown', closed: false, attemptedSeconds: null, connectedSeconds: null },
  ];
  for (const item of definitions) {
    const captured = at(item.seconds);
    const attemptedAt = item.attemptedSeconds === null ? null : new Date(captured + item.attemptedSeconds * 1000).toISOString();
    const connectedAt = item.connectedSeconds === null ? null : new Date(captured + item.connectedSeconds * 1000).toISOString();
    state.office.cases[item.id] = {
      id: item.id, title: item.title, subtitle: item.subtitle, evidence: fixture(item.id, 'case', captured),
      payment: item.payment, paymentEvidence: fixture(item.id, `payment-${item.payment}`),
      supplier: item.supplier, supplierEvidence: item.supplier === 'unknown' ? null : fixture(item.id, `supplier-${item.supplier}`),
      capturedAt: new Date(captured).toISOString(), attemptedAt, connectedAt,
      humanContactVerified: connectedAt !== null,
      callEvidence: attemptedAt ? fixture(item.id, connectedAt ? 'synthetic-human-contact-35s' : 'synthetic-attempt-connected-unknown', captured + (item.connectedSeconds ?? item.attemptedSeconds!) * 1000) : null,
      closerAvailable: item.closed, assignment: item.closed ? 'assigned' : 'queued', saleClosed: item.closed,
      results: [{ id: `result-${item.id}-context`, area: 'sales', functionId: 'sales', title: 'Contexto de prueba DEMO', detail: item.closed ? 'Venta humana cerrada en fixture. No se realizó una venta ni llamada real.' : 'Lead sintético sin closer disponible; no hubo llamada ni venta.', evidence: fixture(item.id, 'seed-context') }],
      messages: [{ id: `message-${item.id}-intro`, area: 'sales', functionId: 'sales', author: 'Ventas · guion DEMO', text: 'DEMO — Puedo preparar un borrador local y dejarlo a revisión humana. No hay LLM ni fuente conectada; ninguna decisión envía mensajes.', evidence: fixture(item.id, 'intro') }],
    };
    state.leads[`lead-${item.id}`] = { leadId: `lead-${item.id}`, departmentId: 'sales', gourmetEventId: item.id, captureSource: 'OFFICE_DEMO_FIXTURE', capturedAtMs: captured, createdAtMs: captured, updatedAtMs: captured, status: item.closed ? 'assigned' : 'queued', telephony: item.attemptedSeconds !== null ? { firstCallInitiatedAtMs: captured + item.attemptedSeconds * 1000, firstCallAnsweredAtMs: connectedAt ? captured + item.connectedSeconds! * 1000 : null, humanContactVerified: false } : null };
    const statuses: JobStatus[] = item.id === 'demo-aurora' ? ['completed', 'waiting_approval', 'running', 'queued', 'blocked', 'completed', 'failed', 'stale', 'blocked'] : item.id === 'demo-cedar' ? ['completed', 'queued', 'queued', 'blocked', 'completed', 'waiting_approval', 'blocked', 'stale', 'blocked'] : ['queued', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'stale', 'blocked'];
    FUNCTION_IDS.forEach((functionId, index) => {
      const status = statuses[index]!;
      const detail = functionId === 'suppliers' ? item.closed ? `DEMO — Proveedor ${item.supplier}; la búsqueda está habilitada por cierre humano sintético, pero no se contacta a ningún chef.` : 'DEMO — Buscar chef está bloqueado hasta cerrar la venta humana.' : status === 'failed' ? 'DEMO — Fallo ilustrativo: fuente de calidad ausente. No hubo ejecución externa.' : status === 'stale' ? 'DEMO — Evidencia ilustrativa antigua; requiere nueva revisión, sin actividad real.' : status === 'running' ? 'DEMO — Estado ilustrativo de checklist; no hay un worker ejecutando tareas.' : functionId === 'sales' && !item.closed ? 'DEMO — No hay closer disponible; la cola representa disponibilidad, no animación.' : `DEMO — ${FUNCTION_NAMES[functionId]}: estado de prueba, sin conexiones reales.`;
      const id = `job-${item.id}-${functionId}-fixture`;
      state.office.jobs[id] = { id, caseId: item.id, area: FUNCTION_AREAS[functionId], functionId, title: `${FUNCTION_NAMES[functionId]} · escenario DEMO`, detail, status, evidence: fixture(item.id, `job-${functionId}`, status === 'stale' ? at(86_400) : nowMs) };
    });
    const historyId = `history-${item.id}-captured`;
    state.office.history[historyId] = { id: historyId, caseId: item.id, commandKey: null, functionId: 'sales', title: 'Lead sintético registrado', detail: 'Fixture local DEMO; no llegó desde Monday ni desde un anuncio real.', status: item.closed ? 'completed' : 'queued', evidence: fixture(item.id, 'capture', captured) };
    if (item.closed) {
      const closedId = `history-${item.id}-closed`;
      state.office.history[closedId] = { id: closedId, caseId: item.id, commandKey: null, functionId: 'sales', title: 'Cierre humano · fixture DEMO', detail: 'Cierre ilustrativo por un operador sintético. Habilita preparar revisión de proveedores; no los contacta.', status: 'completed', evidence: fixture(item.id, 'human-sale-closed') };
    }
  }
  // Real domain arithmetic is reused with an explicitly synthetic catalog/ledger.
  for (const id of CASE_IDS) {
    draftCore.createQuoteDraft(state, { draftId: `quote-${id}-fixture`, gourmetEventId: id, actorId: DEMO_ACTOR, currency: 'USD', catalogVersion: officePilotPolicy.catalog.version, lines: [{ catalogItemId: 'buffet', label: officePilotPolicy.catalog.items.buffet.label, qty: 2, unitPriceCents: 3500 }], taxBps: 700, depositBps: 5000 }, { nowMs });
  }
  paymentCore.registerInvoice(state, { invoiceId: 'invoice-demo-aurora', eventId: 'demo-aurora', provider: 'OFFICE_FIXTURE_PAYMENTS', providerInvoiceId: 'provider-invoice-demo-aurora', currency: 'USD', totalCents: 7490 });
  paymentCore.applyConfirmedPayment(state, { provider: 'OFFICE_FIXTURE_PAYMENTS', eventId: 'payment-demo-aurora', transactionId: 'transaction-demo-aurora', providerInvoiceId: 'provider-invoice-demo-aurora', invoiceId: 'invoice-demo-aurora', gourmetEventId: 'demo-aurora', amountCents: 3745, currency: 'USD', status: 'confirmed', occurredAtMs: nowMs }, { nowMs });
  const initial = [{ caseId: 'demo-aurora' as const, functionId: 'proposals' as const, text: 'DEMO — Borrador de propuesta Aurora: menú ilustrativo de USD 74.90, anticipo ilustrativo USD 37.45. Revisar brief y precios reales antes de usar. No se envía ni cobra.' }, { caseId: 'demo-cedar' as const, functionId: 'finance' as const, text: 'DEMO — Cedar conserva pago pendiente aunque el proveedor figure aceptado en el fixture. Preparar revisión de cobro; no hay enlace de pago ni confirmación bancaria.' }, { caseId: 'demo-harbor' as const, functionId: 'sales' as const, text: 'DEMO — Harbor requiere closer disponible y contacto humano. Este seguimiento es sólo un borrador; buscar chef seguirá bloqueado hasta cerrar la venta.' }];
  for (const item of initial) {
    const id = `approval-${item.caseId}-${item.functionId}-fixture`;
    const coreDraftId = `message-${item.caseId}-${item.functionId}-fixture`;
    draftCore.prepareMessageDraft(state, { draftId: coreDraftId, gourmetEventId: item.caseId, actorId: DEMO_ACTOR, channel: 'email', recipient: 'cliente-demo@invalid.test', text: item.text, artifactRefs: [{ draftId: `quote-${item.caseId}-fixture`, revision: 1 }] }, { nowMs });
    const jobId = `job-${item.caseId}-${item.functionId}-fixture`;
    const link: ApprovalLink = { id, caseId: item.caseId, functionId: item.functionId, coreDraftId, title: `${FUNCTION_NAMES[item.functionId]} · borrador DEMO`, account: 'Gourmet · cuenta de demostración', channel: 'email', recipient: 'cliente-demo@invalid.test', attachments: [`Cotización DEMO ${item.caseId} · revisión 1`], revision: 1, digest: '', status: 'pending', evidence: fixture(item.caseId, `${id}-revision-1`), jobId };
    link.digest = computeApprovalDigest(state, link);
    state.office.approvals[id] = link;
    Object.assign(state.office.jobs[jobId]!, { status: 'waiting_approval', detail: 'DEMO — Borrador listo para revisión humana. Aprobar registra una decisión local; el envío sigue bloqueado.', approvalId: id, revision: 1 });
  }
  return state;
}
