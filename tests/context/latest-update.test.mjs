import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conversationDigest } from '../../src/context/conversation-context.mjs';
import { inspectConversation, prepareFixtureGeneration } from '../../src/context/reviewed-generation.mjs';

const load = async name => JSON.parse(await readFile(new URL(`../../examples/context/${name}`, import.meta.url), 'utf8'));
const sourceFixture = await load('vault-fixture.json');
const reviewFixture = await load('reviewed-evidence.json');
const mondayFixture = await load('monday-fixture.json');
function scenario() {
  const input = structuredClone(sourceFixture);
  input.source = 'user-provided';
  input.captureMode = 'manual-text';
  delete input.fixture;
  delete input.verification;
  return { input, review: structuredClone(reviewFixture), monday: structuredClone(mondayFixture) };
}

for (const update of ['Total acordado: por confirmar', 'Depósito: por confirmar', 'Moneda: EUR']) {
  test(`a later unresolved observation blocks an older acceptance: ${update}`, () => {
    const { input, review, monday } = scenario();
    input.text += `\n${update}`;
    // Re-pin the current text, but deliberately keep the old agreement span.
    // A fresh digest alone cannot approve an unresolved later observation.
    review.captureSha256 = conversationDigest(input.text);
    assert.throws(() => prepareFixtureGeneration(input, review, { monday }), /UNRESOLVED_UPDATE/);
  });
}

test('a later valid proposal also requires a new acceptance after that observation', () => {
  const { input, review, monday } = scenario();
  input.text += '\nTotal acordado: 1300.00 USD';
  review.captureSha256 = conversationDigest(input.text);
  assert.throws(() => prepareFixtureGeneration(input, review, { monday }), /LATEST_AGREEMENT_REQUIRED/);
});

test('the unchanged reviewed fixture still prepares its explicitly accepted values', () => {
  const { input, review, monday } = scenario();
  const prepared = prepareFixtureGeneration(input, review, { monday });
  assert.equal(prepared.request.reservation.agreedTotal, '1200.00');
  assert.equal(prepared.request.reservation.depositAmount, '300.00');
  assert.deepEqual(prepared.report.constraints, {
    paymentExecutionAllowed: false, publicationAllowed: false, automaticMessagesAllowed: false,
  });
});

test('inspection retains other evidence when a later labelled field is out of bounds', () => {
  for (const [field, update] of [
    ['agreedTotal', 'Total acordado: 1000000000 USD'],
    ['depositAmount', 'Depósito: 0 USD'],
    ['customerName', `Customer name: ${'x'.repeat(2001)}`],
    ['reservationSummary', `Evento: ${'x'.repeat(2001)}`],
  ]) {
    const { input, review, monday } = scenario();
    input.text += `\n${update}`;
    review.captureSha256 = conversationDigest(input.text);
    const report = inspectConversation(input, { monday });
    assert.equal(report.status, 'requires-explicit-review');
    assert.ok(report.missing.includes(field));
    assert.equal(report.evidence.fields[field].hasUnresolvedUpdate, true);
    assert.equal(report.monday.fields[field].voiceValue, null);
    assert.equal(report.evidence.fields.eventDate.candidates.at(-1).value, '2026-12-15');
    assert.throws(() => prepareFixtureGeneration(input, review, { monday }), /UNRESOLVED_UPDATE/);
  }
});

test('inspection reports incompatible total and deposit without losing source evidence', () => {
  const { input, monday } = scenario();
  input.text += '\nDepósito: 1300.00 USD';
  const report = inspectConversation(input, { monday });
  assert.deepEqual(report.issues, [{ code: 'DEPOSIT_EXCEEDS_TOTAL', fields: ['agreedTotal', 'depositAmount'] }]);
  assert.equal(report.evidence.fields.agreedTotal.candidates.at(-1).value, '1200.00');
  assert.equal(report.evidence.fields.depositAmount.candidates.at(-1).value, '1300.00');
  assert.equal(report.monday.fields.agreedTotal.voiceValue, null);
  assert.equal(report.monday.fields.depositAmount.voiceValue, null);
  assert.equal(report.monday.fields.depositAmount.mondayValue, '250.00');
  assert.equal(report.status, 'requires-explicit-review');
  assert.equal(report.historyComplete, false);
});

test('recoverable inspection does not permit generation of a deposit above the total', () => {
  const { input, review } = scenario();
  const update = 'Depósito: 1300.00 USD';
  const acceptance = 'Fixture: aceptación sintética posterior para comprobar la validación.';
  input.text += `\n${update}\n${acceptance}`;
  review.captureSha256 = conversationDigest(input.text);
  const span = quote => ({ start: input.text.lastIndexOf(quote), end: input.text.lastIndexOf(quote) + quote.length, quote });
  for (const selected of Object.values(review.fields)) selected.agreementEvidence = span(acceptance);
  Object.assign(review.fields.depositAmount, span(update), { value: '1300.00' });
  Object.assign(review.fields.currency, span(update), { value: 'USD' });
  assert.equal(inspectConversation(input).issues[0].code, 'DEPOSIT_EXCEEDS_TOTAL');
  assert.throws(() => prepareFixtureGeneration(input, review), /depósito no puede superar/);
});

test('inspection still rejects unverified Monday identity rather than treating it as unavailable', () => {
  const { input, monday } = scenario();
  input.text += '\nDepósito: 0 USD';
  monday.identityConfirmed = false;
  assert.throws(() => inspectConversation(input, { monday }), /identidad/);
});
