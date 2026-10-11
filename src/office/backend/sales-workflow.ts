import { createRequire } from 'node:module';
import type { Evidence, FunctionId, OfficeResult, OfficeTask } from '../contracts';
import { callTiming } from '../model';
import type { DemoCase, DemoCaseId, OfficeState } from './state';
import { CASE_IDS, FUNCTION_AREAS, OfficeError, currentTime, evidence, sha256 } from './state';

type RecordValue = Record<string, unknown>;
type VerifiedLedger = {
  invoiceId: string; gourmetEventId: string; currency: 'USD'; totalCents: number;
  paidCents: number; balanceCents: number; receiptIds: string[]; confirmedAtMs: number | null;
};
const require = createRequire(import.meta.url);
const paymentReader = require('../../operations/payments.mjs') as {
  readVerifiedInvoiceLedger(state: OfficeState, invoiceId: string): VerifiedLedger | null;
};

export type SalesWorkflow = {
  digest: string;
  facts: Array<{ id: string; functionId: FunctionId; detail: string; evidence: Evidence }>;
  tasks: OfficeTask[];
  results: OfficeResult[];
};
export type FollowupSignals = {
  replied: boolean | null; paid: boolean | null; rejected: boolean | null;
  unsubscribed: boolean | null; responseChannel: 'email' | 'sms' | null;
};

/** Signals are supplied by a trusted caller; message text cannot set them. */
export function evaluateFollowup(signals: FollowupSignals): {
  state: 'stopped' | 'blocked' | 'eligible'; channel: 'email' | 'sms' | null; reasons: string[];
} {
  const channel = ['email', 'sms'].includes(signals.responseChannel ?? '') ? signals.responseChannel : null;
  const names = ['replied', 'paid', 'rejected', 'unsubscribed'] as const;
  const stopped = names.filter(name => signals[name] === true);
  if (stopped.length) return { state: 'stopped', channel, reasons: [...stopped] };
  const missing: string[] = names.filter(name => signals[name] !== false);
  if (channel === null) missing.push('responseChannel');
  return missing.length
    ? { state: 'blocked', channel, reasons: missing }
    : { state: 'eligible', channel, reasons: [] };
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8_640_000_000_000_000;
}
function leadIdentity(lead: RecordValue | null): string | null {
  // Core captures use id; legacy Office fixtures use leadId. Contradictory
  // identities cannot borrow another lead's reservation or measurement.
  if (!lead) return null;
  if ([lead.id, lead.leadId].some(id => id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || ['constructor', 'prototype'].includes(id)))) return null;
  const ids = [lead.id, lead.leadId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 && ids.every(id => id === ids[0]) ? ids[0] : null;
}
function workflowTiming(state: OfficeState, item: DemoCase, caseId: DemoCaseId, atMs: number) {
  const unknown = { attemptSeconds: null, connectedSeconds: null, proof: item.evidence };
  const leads = Object.values(state.leads).map(record).filter(row => row?.gourmetEventId === caseId);
  const lead = leads.length === 1 ? leads[0] : null;
  const leadId = leadIdentity(lead);
  if (leadId === null) return unknown;
  const measurement = record(lead?.telephony);
  const hasCoreMeasurement = measurement && Object.hasOwn(measurement, 'firstCallInitiatedEventId')
    || Object.values(state.callEvents).some(value => record(value)?.leadId === leadId);
  if (hasCoreMeasurement) {
    const event = typeof measurement?.firstCallInitiatedEventId === 'string'
      ? record(state.callEvents[measurement.firstCallInitiatedEventId]) : null;
    if (!lead || measurement?.slaStatus === 'measurement_unverified' || !event || event.status !== 'applied'
      || event.eventType !== 'call.initiated' || event.leadId !== leadId || event.eventId !== measurement?.firstCallInitiatedEventId
      || !timestamp(lead.capturedAtMs) || !timestamp(event.occurredAtMs) || !timestamp(event.webhookReceivedAtMs)
      || event.occurredAtMs < lead.capturedAtMs || event.occurredAtMs > event.webhookReceivedAtMs
      || event.webhookReceivedAtMs > atMs || measurement?.firstCallInitiatedAtMs !== event.occurredAtMs) return unknown;
    // A provider call.answered event does not verify contact with a human.
    return { attemptSeconds: (event.occurredAtMs - lead.capturedAtMs) / 1000, connectedSeconds: null,
      proof: evidence(caseId, `workflow-call:${event.eventId}`, event.webhookReceivedAtMs) };
  }
  if (!item.callEvidence || Date.parse(item.callEvidence.at) > atMs) return unknown;
  return { ...callTiming({ ...item, history: [], tasks: [], approvals: [] }), proof: item.callEvidence };
}
function coreCloserAvailability(state: OfficeState, caseId: DemoCaseId, atMs: number): { available: boolean | null; atMs: number | null } {
  const leads = Object.values(state.leads).map(record).filter(row => row?.gourmetEventId === caseId);
  const leadId = leads.length === 1 ? leadIdentity(leads[0]) : null;
  if (leadId === null || leads[0]?.departmentId !== 'sales') return { available: null, atMs: null };
  const profiles = Object.values(state.closers).map(record).filter(row => row?.actorId === state.office.actorId);
  if (profiles.length !== 1) return { available: null, atMs: null };
  let knownAt: number | null = null;
  for (const closer of profiles) {
    if (!closer || typeof closer.active !== 'boolean' || typeof closer.id !== 'string' || closer.closerId !== closer.id
      || !Array.isArray(closer.departmentIds) || !closer.departmentIds.every(id => typeof id === 'string')
      || !timestamp(closer.shiftStartMs) || !timestamp(closer.shiftEndMs) || closer.shiftEndMs <= closer.shiftStartMs
      || !timestamp(closer.availableUntilMs) || !timestamp(closer.availabilitySetAtMs) || closer.availabilitySetAtMs > atMs
      || !Number.isSafeInteger(closer.capacity) || (closer.capacity as number) < 0) return { available: null, atMs: null };
    knownAt = Math.max(knownAt ?? 0, closer.availabilitySetAtMs);
    const assignments = Object.values(state.assignments).map(record).filter(row => row?.closerId === closer.id);
    if (assignments.some(row => !row || typeof row.status !== 'string'
      || !['accepted', 'reserved_pending_acceptance', 'released', 'expired', 'invalidated'].includes(row.status)
      || (row.status === 'reserved_pending_acceptance' && !timestamp(row.acceptByMs)))) return { available: null, atMs: null };
    const active = assignments.filter(row => row?.status === 'accepted'
      || (row?.status === 'reserved_pending_acceptance' && (row.acceptByMs as number) > atMs));
    if (active.some(row => typeof row?.leadId !== 'string') || new Set(active.map(row => row!.leadId)).size !== active.length) return { available: null, atMs: null };
    const ownReservation = active.some(row => row?.leadId === leadId);
    const capacity = ownReservation ? active.length <= (closer.capacity as number) : active.length < (closer.capacity as number);
    if (closer.active && closer.departmentIds.includes('sales') && closer.availableUntilMs > atMs
      && closer.shiftStartMs <= atMs && closer.shiftEndMs > atMs && capacity && (closer.capacity as number) > 0) {
      return { available: true, atMs: knownAt };
    }
  }
  return { available: false, atMs: knownAt };
}

/** Pure DEMO projection. Authorization is applied by the caller after projection. */
export function readSalesWorkflow(state: OfficeState, caseId: DemoCaseId, atMs: number): SalesWorkflow {
  currentTime(() => atMs);
  if (!CASE_IDS.includes(caseId) || !Object.hasOwn(state.office.cases, caseId)) throw new OfficeError('UNKNOWN_CASE', 404);
  const item = state.office.cases[caseId];
  const prefix = `workflow-${caseId}`;
  const facts: SalesWorkflow['facts'] = [];
  const tasks: OfficeTask[] = [];
  const results: OfficeResult[] = [];
  const baseEvidence = structuredClone(item.evidence);
  const add = (key: string, title: string, detail: string, functionId: 'sales' | 'finance' | 'suppliers' = 'sales', proof = baseEvidence) => {
    const id = `${prefix}-${key}`;
    const scoped = structuredClone(proof);
    facts.push({ id, functionId, detail, evidence: scoped });
    results.push({ id, area: FUNCTION_AREAS[functionId], functionId, title, detail, evidence: structuredClone(scoped) });
  };

  const closer = coreCloserAvailability(state, caseId, atMs);
  add('closer', 'Disponibilidad explícita del closer · DEMO', closer.available === null
    ? 'DEMO — Disponibilidad del closer desconocida (null): falta un perfil operativo verificable. La presencia o el estado del fixture no acreditan disponibilidad.'
    : `DEMO — Disponibilidad del closer ${closer.available ? 'verificada: disponible' : 'verificada: no disponible'}; active/turno/TTL/departamento/capacidad revisados. No se asignó ni contactó a nadie.`,
  'sales', closer.atMs === null ? baseEvidence : evidence(caseId, `${prefix}-closer-profile`, closer.atMs));

  const timing = workflowTiming(state, item, caseId, atMs);
  const capturedAtMs = Date.parse(item.capturedAt);
  const overdue = timing.attemptSeconds === null && Number.isFinite(capturedAtMs) && capturedAtMs <= atMs && atMs - capturedAtMs >= 30_000;
  add('call-attempt', 'Intento de llamada y SLA · DEMO', timing.attemptSeconds === null
    ? `DEMO — attemptSeconds=null; inicio de llamada desconocido, no equivale a cero. Objetivo 30 s${overdue ? '; umbral transcurrido: requiere revisión humana' : '; medición pendiente'}.`
    : `DEMO — attemptSeconds=${timing.attemptSeconds}; captura → intento ${timing.attemptSeconds} s; objetivo 30 s ${timing.attemptSeconds <= 30 ? 'cumplido' : 'incumplido'}. Es evidencia sintética, no una llamada real.`, 'sales', timing.proof);
  add('human-contact', 'Contacto humano separado del intento · DEMO', timing.connectedSeconds === null
    ? 'DEMO — connectedSeconds=null; contacto humano desconocido; objetivo 30 s desconocido. Una llamada iniciada o respondida por el proveedor no demuestra contacto humano.'
    : `DEMO — connectedSeconds=${timing.connectedSeconds}; captura → contacto humano ${timing.connectedSeconds} s en fixture; objetivo de contacto humano 30 s ${timing.connectedSeconds <= 30 ? 'cumplido' : 'incumplido'}. El intento y el contacto son mediciones distintas; no acredita contacto real.`, 'sales', timing.proof);

  const followup = evaluateFollowup({ replied: null, paid: null, rejected: null, unsubscribed: null, responseChannel: null });
  add('followup', 'Seguimiento condicionado · DEMO', `DEMO — Seguimiento ${followup.state}: señales confiables o canal respondido desconocidos (${followup.reasons.join(', ')}). No se infieren del texto ni del estado de pago restringido. Sin programación ni envío automático; requiere revisión humana.`, 'sales');

  const invoiceIds = Object.entries(state.invoices).filter(([, value]) => record(value)?.eventId === caseId).map(([id]) => id).sort();
  const ledgers = invoiceIds.map(id => paymentReader.readVerifiedInvoiceLedger(state, id));
  const ledgerKnown = ledgers.length > 0 && ledgers.every(row => row !== null && (row.confirmedAtMs === null || row.confirmedAtMs <= atMs));
  const totals = ledgerKnown ? (ledgers as VerifiedLedger[]).reduce((sum, row) => ({ totalCents: sum.totalCents + row.totalCents, paidCents: sum.paidCents + row.paidCents, balanceCents: sum.balanceCents + row.balanceCents }), { totalCents: 0, paidCents: 0, balanceCents: 0 }) : null;
  const validTotals = totals !== null && Object.values(totals).every(value => Number.isSafeInteger(value) && value >= 0);
  const confirmedTimes = (ledgers.filter(Boolean) as VerifiedLedger[]).map(row => row.confirmedAtMs).filter((at): at is number => at !== null);
  const ledgerEvidence = validTotals && confirmedTimes.length
    ? evidence(caseId, `${prefix}-ledger:${sha256(ledgers).slice(0, 24)}`, Math.max(...confirmedTimes)) : baseEvidence;
  add('ledger', 'Anticipo y saldo del ledger · DEMO', validTotals
    ? `DEMO — Ledger verificado: totalCents=${totals.totalCents}; paidCents=${totals.paidCents}; balanceCents=${totals.balanceCents}; USD. ${totals.balanceCents === 0 ? 'Saldo liquidado en el ledger sintético.' : totals.paidCents > 0 ? 'Pago parcial / anticipo confirmado; saldo pendiente, no liquidado.' : 'Sin cobro confirmado; saldo pendiente.'} No se ejecutó cobro.`
    : 'DEMO — Ledger ausente o no verificado: totalCents=null; paidCents=null; balanceCents=null. Saldo desconocido, no equivale a cero; el estado payment del fixture no liquida una factura.', 'finance', ledgerEvidence);

  add('sale', 'Cierre humano y dependencia de chef · DEMO', item.saleClosed === true
    ? 'DEMO — Cierre humano registrado en fixture. Se puede preparar revisión de proveedores; pago y aprobación comercial no acreditan aceptación de chef. No se contactó a proveedores.'
    : 'DEMO — Venta humana abierta o desconocida: búsqueda de chef bloqueada hasta el cierre. La ausencia de chef no bloquea preparar la venta.', 'sales');
  const supplierKnown = item.supplier === 'accepted' && item.supplierEvidence !== null
    && item.supplierEvidence.simulated === true && item.supplierEvidence.reference.startsWith(`demo:${caseId}:`)
    && ['fixture:office-demo', 'demo:office-command'].includes(item.supplierEvidence.source)
    && Number.isFinite(Date.parse(item.supplierEvidence.at)) && Date.parse(item.supplierEvidence.at) <= atMs;
  add('supplier', 'Aceptación de proveedor · DEMO', supplierKnown
    ? 'DEMO — Proveedor aceptado con evidencia sintética; no acredita aceptación real ni pago. Buscar chef depende del cierre humano de la venta.'
    : 'DEMO — Chef/proveedor sin aceptación verificada: pendiente o desconocido. La preparación comercial puede continuar; aceptación y pago son independientes. Buscar chef permanece condicionado al cierre humano de la venta.', 'suppliers', supplierKnown ? item.supplierEvidence! : baseEvidence);
  if (validTotals && totals.paidCents > 0 && !supplierKnown) {
    const id = `${prefix}-paid-without-supplier`;
    const detail = 'DEMO — Alerta inmediata: pago confirmado en el ledger y chef/proveedor sin aceptación verificada. Cola de resolución humana; revisar evidencia y aceptación. Visible sólo en la aplicación; sin envío ni entrega externa. No bloquea preparar la venta ni confirma un chef.';
    tasks.push({ id, area: 'finance', functionId: 'finance', title: 'Alerta inmediata · pago sin chef confirmado · DEMO', detail, status: 'blocked', evidence: structuredClone(ledgerEvidence) });
    results.push({ id, area: 'finance', functionId: 'finance', title: 'Alerta inmediata · resolución humana pendiente · DEMO', detail, evidence: structuredClone(ledgerEvidence) });
  }
  const value = { facts, tasks, results };
  return { digest: sha256(value), ...structuredClone(value) };
}
