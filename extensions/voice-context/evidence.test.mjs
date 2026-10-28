import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidenceCandidates } from './evidence.js';

test('explicit ES/EN labels produce suggestions with original quotes and offsets', () => {
  const text = 'Mensaje anterior 😀\r\n  Nombre del cliente: Ricardo Rodríguez  \r\nEvent: BBQ para 20\r\nFecha del evento: 2026-12-10\r\nCurrency: usd\r\nAgreed total: USD 001000.5\r\nDepósito: $250 USD\r\n';
  const result = extractEvidenceCandidates(text);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.historyComplete, false);
  assert.deepEqual(Object.keys(result.fields), ['customerName', 'eventDate', 'reservationSummary', 'currency', 'agreedTotal', 'depositAmount']);
  for (const field of Object.values(result.fields)) {
    assert.equal(field.status, 'candidate');
    for (const candidate of field.candidates) {
      assert.equal(candidate.quote, text.slice(candidate.start, candidate.end));
      assert.equal(typeof candidate.value, 'string');
    }
    assert.equal(field.candidates.filter(({ latestInCapture }) => latestInCapture).length, 1);
  }
  assert.equal(result.fields.customerName.candidates[0].value, 'Ricardo Rodríguez');
  assert.equal(result.fields.agreedTotal.candidates[0].value, '1000.50');
  assert.equal(result.fields.depositAmount.candidates[0].value, '250.00');
  assert.equal(result.fields.currency.candidates.length, 3);
});

test('all distinct labelled values stay as conflicts; last occurrence is only last in extract', () => {
  const text = 'Total acordado: 500 USD\nTotal acordado: USD 600.00\nTotal acordado: 500.00 USD';
  const field = extractEvidenceCandidates(text).fields.agreedTotal;
  assert.equal(field.status, 'conflict');
  assert.deepEqual(field.candidates.map(({ value, latestInCapture }) => [value, latestInCapture]), [
    ['500.00', false], ['600.00', false], ['500.00', true]
  ]);
  assert.equal('confirmed' in field, false);
  assert.equal('agreed' in field, false);
});

test('same normalized amount repeated retains both quotes without inventing conflict', () => {
  const field = extractEvidenceCandidates('Deposit: USD $0250.0\nAnticipo: $250 USD').fields.depositAmount;
  assert.equal(field.status, 'candidate');
  assert.equal(field.candidates.length, 2);
  assert.deepEqual(field.candidates.map(({ value }) => value), ['250.00', '250.00']);
});

test('natural conversation, speaker names, ambiguous dates and unlabeled money stay missing', () => {
  const result = extractEvidenceCandidates('Cliente: Ricardo\nRicardo: Confirmo 12/10 y $250\nTotal: USD 1000\nLa fecha es 2026-12-10\nTenemos BBQ para 20.');
  for (const field of Object.values(result.fields)) assert.deepEqual(field, {
    status: 'missing', candidates: [], observations: [], latestObservation: null, hasUnresolvedUpdate: false
  });
});

test('dates require an exact valid ISO calendar day', () => {
  for (const raw of ['12/10/2026', '2026-02-30', '2026-13-01', '2026-12-10 18:00', '2026-12-10 o 2026-12-11']) {
    assert.equal(extractEvidenceCandidates(`Date: ${raw}`).fields.eventDate.status, 'missing', raw);
  }
  assert.equal(extractEvidenceCandidates('Fecha: 2028-02-29').fields.eventDate.candidates[0].value, '2028-02-29');
});

test('amounts require literal USD and a single unambiguous decimal, never infer a percentage', () => {
  for (const raw of ['$250', '250', '50%', 'USD 250 + 50', 'USD 1,000.00', '1.000,00 USD', 'USD 1.000', '-250 USD', '2e3 USD', '50% (250 USD)', 'EUR 250', 'USD 250 or USD 300', '250 USD extra']) {
    const result = extractEvidenceCandidates(`Depósito: ${raw}`);
    assert.equal(result.fields.depositAmount.status, 'missing', raw);
    assert.equal(result.fields.currency.status, 'missing', raw);
  }
  assert.equal(extractEvidenceCandidates('Deposit amount: 0.50 USD').fields.depositAmount.candidates[0].value, '0.50');
});

test('placeholders remain missing and supported labels are anchored at line start', () => {
  const text = 'Nombre del cliente: por confirmar\nServicio: TBD\nMoneda: $\nRicardo dijo Total acordado: USD 500\nMensaje: Customer name: Ana';
  for (const field of Object.values(extractEvidenceCandidates(text).fields)) assert.equal(field.status, 'missing');
});

test('unsafe text stays data and offsets refer to original Unicode input', () => {
  const text = '😀\nCustomer name: <img src=x onerror=alert(1)>\nEvento: Reserva <script>bad()</script>';
  const result = extractEvidenceCandidates(text);
  assert.equal(result.fields.customerName.candidates[0].value, '<img src=x onerror=alert(1)>');
  for (const field of Object.values(result.fields)) {
    for (const candidate of field.candidates) assert.equal(text.slice(candidate.start, candidate.end), candidate.quote);
  }
});

test('invalid input type fails explicitly', () => {
  assert.throws(() => extractEvidenceCandidates(null), TypeError);
});

test('later unsupported or pending known labels invalidate earlier candidates', () => {
  for (const [fieldName, initial, update] of [
    ['agreedTotal', 'Total acordado: 1000 USD', 'Total acordado: por confirmar'],
    ['depositAmount', 'Depósito: 250 USD', 'Depósito: por confirmar'],
    ['currency', 'Moneda: USD', 'Moneda: EUR'],
    ['eventDate', 'Fecha: 2026-12-10', 'Fecha: 12/10'],
    ['customerName', 'Customer name: Ricardo', 'Customer name:'],
    ['reservationSummary', 'Evento: BBQ', 'Evento: pendiente']
  ]) {
    const text = `${initial}\r\n${update}`;
    const field = extractEvidenceCandidates(text).fields[fieldName];
    assert.equal(field.status, 'conflict', fieldName);
    assert.equal(field.hasUnresolvedUpdate, true, fieldName);
    assert.equal(field.observations.length, 2, fieldName);
    assert.equal(field.latestObservation.value, null, fieldName);
    assert.equal(field.latestObservation.quote, update, fieldName);
    assert.equal(text.slice(field.latestObservation.start, field.latestObservation.end), update, fieldName);
    assert.equal(field.candidates.length, 1, fieldName);
    assert.equal(field.candidates[0].latestInCapture, false, fieldName);
  }
});

test('an unresolved label is retained even when no compatible candidate exists', () => {
  const field = extractEvidenceCandidates('Moneda: EUR').fields.currency;
  assert.equal(field.status, 'missing');
  assert.equal(field.hasUnresolvedUpdate, true);
  assert.equal(field.latestObservation.value, null);
  assert.equal(field.latestObservation.end, 'Moneda: EUR'.length);
});

test('a later compatible correction clears unresolved update and retains value conflict history', () => {
  const field = extractEvidenceCandidates('Total acordado: 1000 USD\nTotal acordado: por confirmar\nTotal acordado: 1200 USD').fields.agreedTotal;
  assert.equal(field.status, 'conflict');
  assert.equal(field.hasUnresolvedUpdate, false);
  assert.equal(field.latestObservation.value, '1200.00');
  assert.equal(field.observations.length, 3);
  assert.equal(field.candidates[0].latestInCapture, false);
  assert.equal(field.candidates[1].latestInCapture, true);
  const sameValue = extractEvidenceCandidates('Depósito: 250 USD\nDepósito: por confirmar\nDepósito: USD 250').fields.depositAmount;
  assert.equal(sameValue.hasUnresolvedUpdate, false);
  assert.equal(sameValue.status, 'candidate');
});

test('explicit unsupported currency after derived USD remains unresolved', () => {
  const field = extractEvidenceCandidates('Total acordado: 1000 USD\nDepósito: 250 USD\nMoneda: EUR').fields.currency;
  assert.equal(field.status, 'conflict');
  assert.equal(field.hasUnresolvedUpdate, true);
  assert.equal(field.latestObservation.value, null);
  assert.equal(field.observations.length, 3);
  assert.equal(field.candidates.every(({ latestInCapture }) => !latestInCapture), true);
});
