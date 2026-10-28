import { acceptConversationContext } from './conversation-context.mjs';
const REQUIRED = ['customerName', 'eventDate', 'reservationSummary', 'currency', 'agreedTotal', 'depositAmount'];
const FIELDS = new Set(REQUIRED);

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function validateCapture(input, options) {
  return acceptConversationContext(input, options);
}

export function manualCapture(text, confirmed, now = new Date().toISOString()) {
  if (confirmed !== true) throw new Error('Confirma que tienes autorización para usar el texto proporcionado.');
  return validateCapture({
    schemaVersion: 1, source: 'user-provided', capturedAt: now, captureMode: 'manual-text',
    historyComplete: false, authorization: { captureConfirmed: true, confirmedAt: now }, text,
    warnings: ['Texto proporcionado por el operador; su origen y cobertura no se han verificado.'],
  });
}

function cents(value, field) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{2})$/.test(value)) {
    throw new Error(`${field}: usa una cantidad decimal explícita, por ejemplo 250.00.`);
  }
  return BigInt(value.replace('.', ''));
}

export function buildReservationBrief(input, confirmed = {}, reviewedAt = null, options) {
  const capture = validateCapture(input, options);
  if (reviewedAt !== null && !validTimestamp(reviewedAt)) throw new Error('La fecha de revisión no es válida.');
  if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed)) throw new Error('Los datos confirmados deben ser un objeto.');
  for (const field of Object.keys(confirmed)) {
    if (!FIELDS.has(field)) throw new Error(`Campo confirmado desconocido: ${field}.`);
  }
  if (Object.keys(confirmed).length && reviewedAt === null) {
    throw new Error('Confirma la revisión humana antes de preparar datos de reserva.');
  }
  const reservation = {};
  for (const field of REQUIRED) {
    const value = confirmed[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 2000) {
      throw new Error(`${field}: se requiere texto explícito sin espacios externos.`);
    }
    reservation[field] = value;
  }
  if (reservation.eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(reservation.eventDate) ||
      !Number.isFinite(Date.parse(`${reservation.eventDate}T00:00:00Z`)) ||
      new Date(`${reservation.eventDate}T00:00:00Z`).toISOString().slice(0, 10) !== reservation.eventDate)) {
    throw new Error('eventDate: confirma una fecha real en formato YYYY-MM-DD.');
  }
  // V1 deliberately supports the existing business currency only; no implicit FX or rounding.
  if (reservation.currency && reservation.currency !== 'USD') throw new Error('La moneda debe confirmarse como USD para este prototipo.');
  for (const field of ['agreedTotal', 'depositAmount']) {
    if (reservation[field] && cents(reservation[field], field) <= 0n) throw new Error(`${field}: la cantidad debe ser positiva.`);
  }
  if (reservation.agreedTotal && reservation.depositAmount && cents(reservation.depositAmount, 'depositAmount') > cents(reservation.agreedTotal, 'agreedTotal')) {
    throw new Error('El depósito no puede superar el total acordado.');
  }
  return {
    schemaVersion: 1,
    kind: 'gourmet-reservation-review-brief',
    status: 'draft-for-human-review',
    capture,
    reservation,
    review: { operatorConfirmed: Boolean(reviewedAt), confirmedAt: reviewedAt },
    missingConfirmations: REQUIRED.filter(field => !reservation[field]),
    constraints: { paymentExecutionAllowed: false, publicationAllowed: false, automaticMessagesAllowed: false },
    warnings: [
      'La conversación es parcial. No deducir acuerdos, total, depósito ni pagos anteriores de ausencias en el texto.',
      'Las autorizaciones del archivo son declaraciones del operador; no son credenciales ni autorización de cobro.',
      'Solo se permite un adaptador local de generación ficticia; no hay emisión comercial ni conexión al proveedor de pagos.',
      'Revisar fuera de esta captura si el cliente ya pagó antes de autorizar cualquier operación futura.',
    ],
  };
}
