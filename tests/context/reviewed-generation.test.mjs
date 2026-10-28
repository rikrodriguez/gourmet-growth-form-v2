import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { acceptConversationContext, conversationDigest } from '../../src/context/conversation-context.mjs';
import { inspectConversation, prepareFixtureGeneration } from '../../src/context/reviewed-generation.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`../../examples/context/${name}`, import.meta.url), 'utf8'));
const vault = await fixture('vault-fixture.json');
const reviewed = await fixture('reviewed-evidence.json');
const monday = await fixture('monday-fixture.json');
const clone = value => structuredClone(value);
const verifyFixture = input => input.fixture === true && input.verification?.method === 'fixture' &&
  input.verification.artifactSha256 === conversationDigest(input.text);
const options = () => ({ monday: clone(monday), verifyVaultArtifact: verifyFixture });
const sourceContext = source => {
  const context = clone(vault);
  context.source = source;
  context.captureMode = source === 'google-voice' ? 'visible-dom' : 'manual-text';
  delete context.fixture;
  delete context.verification;
  return context;
};
const exactSpan = (text, quote) => {
  const start = text.indexOf(quote);
  assert.ok(start >= 0, 'test quote must exist in its synthetic source');
  return { start, end: start + quote.length, quote };
};

test('Google Voice and manual text are browser-independent partial inputs with preserved authorization', () => {
  for (const source of ['google-voice', 'user-provided']) {
    const input = sourceContext(source);
    const context = acceptConversationContext(input);
    const inspected = inspectConversation(input);
    assert.equal(context.source, source);
    assert.equal(context.historyComplete, false);
    assert.deepEqual(context.authorization, input.authorization);
    assert.equal(context.verification, undefined);
    assert.equal(inspected.status, 'requires-explicit-review');
    assert.deepEqual(inspected.missing, []);
    assert.ok(inspected.conflicts.includes('agreedTotal'));
    assert.ok(inspected.conflicts.includes('depositAmount'));
    assert.equal(inspected.evidence.fields.depositAmount.candidates.at(-1).value, '300.00');
    assert.equal(inspected.monday.status, 'unavailable');
  }
});

test('a Vault JSON verification flag cannot replace the injected artifact verifier', () => {
  assert.throws(() => acceptConversationContext(clone(vault)), /VAULT_READER_UNAVAILABLE/);
  assert.throws(() => acceptConversationContext(clone(vault), { verifyVaultArtifact: () => false }), /VAULT_READER_UNAVAILABLE/);
  assert.throws(() => acceptConversationContext(clone(vault), { verifyVaultArtifact: () => Promise.resolve(true) }), /VAULT_READER_UNAVAILABLE/);
  const tampered = clone(vault);
  tampered.text += '\nContenido editado después de verificar.';
  assert.throws(() => acceptConversationContext(tampered, { verifyVaultArtifact: verifyFixture }), /VAULT_READER_UNAVAILABLE/);
  const wrongFixture = { ...clone(vault), fixture: false };
  assert.throws(() => acceptConversationContext(wrongFixture, { verifyVaultArtifact: verifyFixture }), /VAULT_READER_UNAVAILABLE/);
});

test('verified Vault metadata preserves Message-ID interpretation and exact query metadata without inventing Subject', () => {
  const context = acceptConversationContext(clone(vault), { verifyVaultArtifact: verifyFixture });
  assert.equal(context.source, 'vault');
  assert.equal(context.historyComplete, false);
  assert.deepEqual(context.verification.exportMetadata, vault.verification.exportMetadata);
  assert.equal(context.verification.exportMetadata.fileNameIdentifierKind, 'message-id');
  assert.equal(context.verification.exportMetadata.queryPath, 'Batch/CustomBatchInfo/Query');
  assert.deepEqual(context.verification.exportMetadata.query, {
    UserQuery: 'fixture only', TimeZone: 'Etc/UTC', Custodians: ['fixture@example.invalid'],
  });
  assert.equal(context.verification.exportMetadata.Subject, undefined);
  assert.equal(context.subject, undefined);
  assert.ok(context.warnings.some(warning => /Fixture sintético de Vault/.test(warning)));
});

test('inspection shows evidence for each field and retains contradictory Monday values without choosing them', () => {
  const inspected = inspectConversation(clone(vault), options());
  for (const field of Object.values(inspected.evidence.fields)) {
    assert.ok(field.candidates.length > 0);
    for (const candidate of field.candidates) assert.equal(vault.text.slice(candidate.start, candidate.end), candidate.quote);
  }
  assert.equal(inspected.historyComplete, false);
  assert.equal(inspected.evidence.fields.depositAmount.status, 'conflict');
  assert.equal(inspected.monday.fields.depositAmount.status, 'conflict');
  assert.equal(inspected.monday.fields.depositAmount.voiceValue, '300.00');
  assert.equal(inspected.monday.fields.depositAmount.mondayValue, '250.00');
  assert.equal(inspected.status, 'requires-explicit-review');
});

test('missing labelled evidence remains missing and manual amounts cannot be inserted as confirmed facts', () => {
  const input = sourceContext('google-voice');
  input.text = input.text.split('\n').filter(line => !line.startsWith('Depósito:')).join('\n');
  const inspected = inspectConversation(input);
  assert.ok(inspected.missing.includes('depositAmount'));
  assert.deepEqual(inspected.evidence.fields.depositAmount.candidates, []);
  const review = clone(reviewed);
  review.captureSha256 = conversationDigest(input.text);
  const agreementEvidence = exactSpan(input.text, input.text.split('\n').at(-1));
  for (const [field, selected] of Object.entries(review.fields)) {
    if (field === 'depositAmount') continue;
    const quote = field === 'currency' ? 'Total acordado: 1200.00 USD' : selected.quote;
    Object.assign(selected, exactSpan(input.text, quote), { agreementEvidence });
  }
  review.fields.depositAmount = {
    value: '300.00', confirmed: true,
    ...exactSpan(input.text, 'Total acordado: 1200.00 USD'),
    agreementEvidence,
  };
  assert.throws(() => prepareFixtureGeneration(input, review), /MISSING_EVIDENCE.*depositAmount/);
  const invented = clone(reviewed);
  invented.fields.depositAmount.value = '400.00';
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), invented), /MISSING_EVIDENCE.*depositAmount/);
});

test('each field requires explicit review and a concrete resolution for conflicts in the partial excerpt', () => {
  const noReview = { ...clone(reviewed), operatorConfirmed: false };
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), noReview), /REVIEW_REQUIRED/);
  const missingField = clone(reviewed);
  delete missingField.fields.currency;
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), missingField), /MISSING_EVIDENCE/);
  const unresolved = clone(reviewed);
  delete unresolved.fields.agreedTotal.resolution;
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), unresolved), /UNRESOLVED_CONFLICT.*agreedTotal/);
  const notConfirmed = clone(reviewed);
  notConfirmed.fields.customerName.confirmed = false;
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), notConfirmed), /MISSING_EVIDENCE.*customerName/);
});

test('Monday conflicts block generation until the operator explicitly resolves each difference', () => {
  const review = clone(reviewed);
  delete review.fields.depositAmount.mondayResolution;
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), review, { monday: clone(monday) }), /MONDAY_CONFLICT.*depositAmount/);
  const unidentified = { ...clone(monday), identityConfirmed: false };
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), clone(reviewed), { monday: unidentified }), /identidad/);
});

test('editing source text invalidates review digest and tampered quote offsets are rejected', () => {
  const edited = sourceContext('google-voice');
  edited.text += '\nPropuesta posterior sin revisar.';
  assert.throws(() => prepareFixtureGeneration(edited, clone(reviewed)), /REVIEW_REQUIRED/);
  const review = clone(reviewed);
  review.fields.depositAmount.quote = 'Depósito: 400.00 USD';
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), review), /MISSING_EVIDENCE.*depositAmount/);
});

test('an acceptance preceding a newer visible proposal cannot authorize generation', () => {
  const review = clone(reviewed);
  review.fields.depositAmount.agreementEvidence = exactSpan(vault.text, 'Cliente ficticio: Acepto la primera propuesta de prueba.');
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), review), /LATEST_AGREEMENT_REQUIRED.*depositAmount/);
});

test('paid, unknown or unchecked prior payment states block even an otherwise reviewed fixture', () => {
  for (const status of ['paid', 'unknown', undefined]) {
    const review = clone(reviewed);
    review.priorPaymentCheck.status = status;
    assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), review), /PAYMENT_STATUS_REQUIRED/);
  }
  const missingCheck = clone(reviewed);
  delete missingCheck.priorPaymentCheck;
  assert.throws(() => prepareFixtureGeneration(sourceContext('google-voice'), missingCheck), /PAYMENT_STATUS_REQUIRED/);
});

test('the happy Vault fixture prepares the newest reviewed amounts while keeping all execution gates false', () => {
  const input = clone(vault);
  const review = clone(reviewed);
  const snapshot = clone(monday);
  const original = { input: clone(input), review: clone(review), snapshot: clone(snapshot) };
  const result = prepareFixtureGeneration(input, review, { monday: snapshot, verifyVaultArtifact: verifyFixture });
  assert.equal(result.request.mode, 'fixture-only');
  assert.equal(result.request.reservation.agreedTotal, '1200.00');
  assert.equal(result.request.reservation.depositAmount, '300.00');
  assert.deepEqual(result.request.providerFixture.amount, { value: '300.00', currency_code: 'USD' });
  assert.equal(new URL(result.request.providerFixture.url).hostname, 'checkout.invalid');
  assert.equal(result.request.provenance.historyComplete, false);
  assert.equal(result.request.provenance.source, 'vault');
  assert.deepEqual(result.request.provenance.verification.exportMetadata, vault.verification.exportMetadata);
  assert.equal(result.report.monday.fields.depositAmount.mondayValue, '250.00');
  assert.equal(result.report.evidence.depositAmount.value, '300.00');
  assert.equal(result.report.evidence.depositAmount.latestCandidateInExcerpt, true);
  assert.deepEqual(result.report.constraints, {
    paymentExecutionAllowed: false, publicationAllowed: false, automaticMessagesAllowed: false,
  });
  assert.equal(result.report.historyComplete, false);
  assert.deepEqual({ input, review, snapshot }, original);
});
