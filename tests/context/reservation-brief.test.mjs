import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReservationBrief, manualCapture, validateCapture } from '../../src/context/reservation-brief.mjs';

const now = '2026-10-28T02:00:00.000Z';
const capture = () => ({ ...manualCapture('Total $1000, depósito $250. Ya pagué ayer.', true, now), source: 'google-voice', captureMode: 'visible-dom' });
const confirmed = () => ({ customerName: 'Cliente de prueba', eventDate: '2026-12-15', reservationSummary: 'Cena de prueba', currency: 'USD', agreedTotal: '1000.00', depositAmount: '250.00' });

test('rejects unauthorized captures and claims of complete history', () => {
  assert.throws(() => manualCapture('hola', false, now), /autorización/);
  assert.throws(() => validateCapture({ ...capture(), authorization: { captureConfirmed: false, confirmedAt: now } }), /autorización/);
  assert.throws(() => validateCapture({ ...capture(), historyComplete: true }), /incompleto/);
  assert.throws(() => validateCapture({ ...capture(), captureMode: 'all-history' }), /modo/);
});

test('retains capture authorization and partial history without inferring price or payment status', () => {
  const brief = buildReservationBrief(capture());
  assert.equal(brief.capture.historyComplete, false);
  assert.deepEqual(brief.capture.authorization, capture().authorization);
  assert.deepEqual(brief.reservation, {});
  assert.equal(brief.missingConfirmations.length, 6);
  assert.deepEqual(brief.constraints, { paymentExecutionAllowed: false, publicationAllowed: false, automaticMessagesAllowed: false });
  assert.match(brief.capture.text, /Ya pagué/);
});

test('requires explicit review and accepts exact confirmed amounts without payment authorization', () => {
  assert.throws(() => buildReservationBrief(capture(), {}, 'not-a-date'), /fecha de revisión/);
  assert.throws(() => buildReservationBrief(capture(), confirmed()), /revisión humana/);
  const brief = buildReservationBrief(capture(), confirmed(), now);
  assert.deepEqual(brief.missingConfirmations, []);
  assert.equal(brief.reservation.depositAmount, '250.00');
  assert.equal(brief.status, 'draft-for-human-review');
  assert.equal(brief.constraints.paymentExecutionAllowed, false);
});

test('rejects ambiguous money, overpayment, unsupported currency and invalid dates', () => {
  for (const value of ['250', '$250.00', '1e2', '-1.00', '0.00', '250.001', 250]) {
    assert.throws(() => buildReservationBrief(capture(), { ...confirmed(), depositAmount: value }, now));
  }
  assert.throws(() => buildReservationBrief(capture(), { ...confirmed(), depositAmount: '1000.01' }, now), /superar/);
  assert.throws(() => buildReservationBrief(capture(), { ...confirmed(), currency: 'EUR' }, now), /USD/);
  assert.throws(() => buildReservationBrief(capture(), { ...confirmed(), eventDate: '2026-02-30' }, now), /fecha real/);
});

test('untrusted input cannot set execution flags or pass unknown confirmed fields', () => {
  const brief = buildReservationBrief({ ...capture(), paymentExecutionAllowed: true, constraints: { publicationAllowed: true } });
  assert.equal(brief.capture.paymentExecutionAllowed, undefined);
  assert.equal(brief.constraints.publicationAllowed, false);
  assert.throws(() => buildReservationBrief(capture(), { ...confirmed(), paypalUrl: 'https://example.test' }, now), /desconocido/);
});
