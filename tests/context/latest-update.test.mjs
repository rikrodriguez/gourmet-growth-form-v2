import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conversationDigest } from '../../src/context/conversation-context.mjs';
import { prepareFixtureGeneration } from '../../src/context/reviewed-generation.mjs';

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
