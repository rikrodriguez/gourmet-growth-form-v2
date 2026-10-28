import { acceptConversationContext, conversationDigest, realTimestamp } from './conversation-context.mjs';
import { buildReservationBrief } from './reservation-brief.mjs';
import { extractEvidenceCandidates } from '../../extensions/voice-context/evidence.js';
import { compareMonday } from './monday-comparison.mjs';

const FIELDS = ['customerName', 'eventDate', 'reservationSummary', 'currency', 'agreedTotal', 'depositAmount'];
function exactSpan(text, span) {
  return span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 &&
    span.end > span.start && span.end <= text.length && typeof span.quote === 'string' && span.quote.trim() &&
    text.slice(span.start, span.end) === span.quote;
}
const reason = value => typeof value === 'string' && value.trim().length >= 10 && value.length <= 2000;

export function inspectConversation(input, { monday = null, ...options } = {}) {
  const context = acceptConversationContext(input, options);
  const evidence = extractEvidenceCandidates(context.text);
  const suggestions = Object.fromEntries(FIELDS.flatMap(field => {
    if (evidence.fields[field].hasUnresolvedUpdate) return [];
    const last = evidence.fields[field].candidates.at(-1);
    return last ? [[field, last.value]] : [];
  }));
  return {
    schemaVersion: 1, status: 'requires-explicit-review', source: context.source,
    historyComplete: false, captureSha256: conversationDigest(context.text), evidence,
    missing: FIELDS.filter(field => evidence.fields[field].status === 'missing' || evidence.fields[field].hasUnresolvedUpdate),
    conflicts: FIELDS.filter(field => evidence.fields[field].status === 'conflict'),
    monday: compareMonday(suggestions, monday),
    warnings: ['Los candidatos más recientes del extracto no son acuerdos confirmados. El historial sigue incompleto.'],
  };
}

/** Prepares only a fixture request for the existing external generator's pure adapter. */
export function prepareFixtureGeneration(input, review, { monday = null, ...options } = {}) {
  const context = acceptConversationContext(input, options);
  if (!review || review.schemaVersion !== 1 || review.operatorConfirmed !== true || review.identityConfirmed !== true ||
      !realTimestamp(review.confirmedAt) || review.captureSha256 !== conversationDigest(context.text)) {
    throw new Error('REVIEW_REQUIRED: revisión e identidad explícitas ligadas al texto actual.');
  }
  if (!review.fields || Object.keys(review.fields).length !== FIELDS.length || Object.keys(review.fields).some(field => !FIELDS.includes(field))) {
    throw new Error('MISSING_EVIDENCE: se necesita revisión de cada campo.');
  }
  const evidence = extractEvidenceCandidates(context.text);
  const reservation = {};
  const decisions = {};
  for (const field of FIELDS) {
    const selected = review.fields[field];
    const fieldEvidence = evidence.fields[field];
    if (fieldEvidence.hasUnresolvedUpdate) throw new Error(`UNRESOLVED_UPDATE: ${field} tiene una actualización posterior pendiente o no compatible.`);
    const candidates = fieldEvidence.candidates;
    const candidate = candidates.find(item => item.value === selected?.value && item.start === selected?.start && item.end === selected?.end && item.quote === selected?.quote);
    if (!candidate || selected.confirmed !== true) throw new Error(`MISSING_EVIDENCE: ${field} no tiene un candidato exacto confirmado.`);
    const agreement = selected.agreementEvidence;
    const lastObservationEnd = fieldEvidence.latestObservation?.end ?? candidates.at(-1)?.end;
    if (!exactSpan(context.text, agreement) || agreement.start < lastObservationEnd) {
      throw new Error(`LATEST_AGREEMENT_REQUIRED: ${field} necesita evidencia de aceptación posterior a sus propuestas visibles.`);
    }
    if (evidence.fields[field].status === 'conflict' && !reason(selected.resolution)) {
      throw new Error(`UNRESOLVED_CONFLICT: ${field} requiere una resolución explícita.`);
    }
    reservation[field] = candidate.value;
    decisions[field] = {
      value: candidate.value, evidence: { quote: candidate.quote, start: candidate.start, end: candidate.end },
      agreementEvidence: { quote: agreement.quote, start: agreement.start, end: agreement.end },
      latestCandidateInExcerpt: candidate.latestInCapture, operatorConfirmed: true,
      ...(selected.resolution ? { resolution: selected.resolution } : {}),
    };
  }
  // Revalidate the original envelope: verification may need reader-only fixture
  // markers/proof that are intentionally absent from the normalized context.
  const brief = buildReservationBrief(input, reservation, review.confirmedAt, options);
  const comparison = compareMonday(reservation, monday);
  for (const field of FIELDS) {
    if (comparison.fields[field].status === 'conflict') {
      if (!reason(review.fields[field].mondayResolution)) throw new Error(`MONDAY_CONFLICT: ${field} necesita resolución explícita.`);
      decisions[field].mondayResolution = review.fields[field].mondayResolution;
    }
  }
  const payment = review.priorPaymentCheck;
  if (!payment || payment.status !== 'unpaid' || payment.source !== 'fixture-ledger' ||
      !realTimestamp(payment.checkedAt) || !reason(payment.reference)) {
    throw new Error('PAYMENT_STATUS_REQUIRED: esta ruta solo admite una comprobación ficticia explícita de ausencia de pago.');
  }
  const provenance = {
    historyComplete: false, source: context.source, capturedAt: context.capturedAt, captureMode: context.captureMode,
    authorization: context.authorization,
    ...(context.verification ? { verification: context.verification } : {}),
    review: { operatorConfirmed: true, confirmedAt: review.confirmedAt, captureSha256: review.captureSha256 },
  };
  return {
    request: {
      schemaVersion: 1, mode: 'fixture-only', reservation: brief.reservation, provenance,
      providerFixture: {
        id: 'fixture-resource-not-created', status: 'ACTIVE',
        amount: { value: brief.reservation.depositAmount, currency_code: brief.reservation.currency },
        url: 'https://checkout.invalid/fixture-not-payable',
      },
    },
    report: {
      schemaVersion: 1, status: 'fixture-only-reviewed', source: context.source, historyComplete: false,
      captureSha256: review.captureSha256, provenance, evidence: decisions, monday: comparison,
      priorPaymentCheck: { status: payment.status, source: payment.source, checkedAt: payment.checkedAt, reference: payment.reference },
      constraints: brief.constraints,
      warnings: [...context.warnings, ...brief.warnings, 'Salida ficticia; el estado ACTIVE pertenece a un fixture, no a un recurso PayPal real.'],
    },
  };
}
