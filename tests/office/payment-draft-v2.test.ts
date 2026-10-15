import assert from 'node:assert/strict';
import test from 'node:test';
import { EventQuoteError, type PaymentContractModeV2, type TestPaymentDraftDependenciesV2, type QuoteScope, type EventQuoteView } from '../../src/office/backend/event-quote-contracts';
import { assertEventQuoteRecord, canonical, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { MemoryEventQuoteStore, TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

const code = (expected: string) => (error: unknown) => error instanceof EventQuoteError && error.code === expected;
// The unit callback is an explicit test double, not evidence that PHP executed.
// The separate PostgreSQL/PHP contract harness supplies the real isolated parser.
const echo = (body: string) => JSON.stringify({ status: 'contract_validated_internal', prepared: JSON.parse(body),
  executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false });

async function setup(mode: PaymentContractModeV2 = 'retainer_50', options: { enabled?: boolean; commercial?: boolean; timeout?: number } = {}) {
  const store = new MemoryEventQuoteStore(), eventId = 'synthetic-draft-event';
  const scope: QuoteScope = options.commercial ? { ...testScope, mode: 'commercial' } : testScope;
  const actor = { ...testActor, durable: !!options.commercial };
  let now = TEST_AT, lead: { source: 'synthetic_fixture'; canonicalLeadId: string } | null = { source: 'synthetic_fixture', canonicalLeadId: 'synthetic-bound-lead' };
  let catalog = { ...testCatalog, authority: options.commercial ? 'owner_authorized' as const : 'test_only' as const,
    taxBps: 0, items: [{ ...testCatalog.items[0], unitPriceCents: 10001 }] };
  let leadCalls = 0, validationCalls = 0, leadHook: (() => void) | undefined, validate: TestPaymentDraftDependenciesV2['validateContract'] = async body => echo(body);
  const drafts: TestPaymentDraftDependenciesV2 = {
    resolveCanonicalLead: async (receivedScope, receivedEvent) => {
      assert.deepEqual(receivedScope, scope); assert.equal(receivedEvent, eventId); leadCalls++; leadHook?.(); return lead;
    },
    validateContract: async (...args) => { validationCalls++; return validate(...args); },
    ...(options.timeout === undefined ? {} : { validationTimeoutMs: options.timeout }),
  };
  const service = createEventQuoteService({ store, catalogFor: async () => catalog, clock: () => now,
    ...(options.enabled === false ? {} : { testPaymentDrafts: drafts }) });
  const execute = (input: unknown, asActor = actor) => service.execute(scope, asActor, eventId, input);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: 1, quoteDigest: q.digest,
    artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await execute({ action: 'prepare_payment_v2', key: 'prepare-v2', expectedRevision: 3, quoteVersion: 1,
    quoteDigest: q.digest, approvalDigest: view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode: mode });
  const preparation = view.record.paymentContractPreparationsV2![0];
  const configure: any = { action: 'configure_payment_v2', key: 'configure-v2', expectedRevision: 4, preparationId: preparation.id,
    preparationDigest: preparation.digest, paymentTerms: 'Condiciones nuevas sintéticas.\n🧾 Sin envío ni cobro.\u2028\u2029',
    termsChangeReason: 'Revisión expresa sintética de condiciones y modalidad.',
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'fixed_49_reservation'
      ? { kind: mode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: preparation.paymentBalanceCents }
      : { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null },
    linkExpiration: { kind: 'never' } };
  const registration = (configured: EventQuoteView, key = 'register-v2') => {
    const c = configured.record.paymentConfigurationsV2![0];
    return { action: 'register_payment_draft_v2', key, expectedRevision: configured.record.revision, configurationId: c.id,
      configurationDigest: c.digest, expectedReviewDigest: c.reviewDigest };
  };
  return { service, store, scope, actor, eventId, view, q, preparation, configure, execute, registration,
    calls: () => ({ leadCalls, validationCalls }), clock(value: number) { now = value; },
    lead(value: typeof lead) { lead = value; }, catalog(value: typeof catalog) { catalog = value; },
    getCatalog: () => catalog, validate(value: typeof validate) { validate = value; }, onLead(hook: () => void) { leadHook = hook; } };
}

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
  test(`synthetic ${mode} configuration and registration use the existing aggregate transaction and preserve source facts`, async () => {
    const t = await setup(mode), before = structuredClone(t.view.record);
    const configured = await t.execute(t.configure), c = configured.record.paymentConfigurationsV2![0];
    assert.equal(configured.record.schemaVersion, 4); assert.equal(c.id, t.configure.key); assert.equal(c.status, 'draft_configuration');
    assert.equal(c.leadSource, 'synthetic_fixture'); assert.equal(c.configuration.canonicalLeadId, 'synthetic-bound-lead');
    assert.equal(c.configuration.paymentTerms, t.configure.paymentTerms); assert.equal(c.actorId, t.actor.actorId); assert.equal(c.atMs, TEST_AT);
    assert.equal(t.calls().validationCalls, 0); assert.deepEqual(configured.record.paymentDraftRegistrationsV2, []);
    const registered = await t.execute(t.registration(configured)), r = registered.record.paymentDraftRegistrationsV2![0];
    assert.equal(r.status, 'draft_internal'); assert.equal(r.configurationDigest, c.digest); assert.equal(r.reviewDigest, c.reviewDigest);
    assert.equal(r.receipt.prepared.plan.sourceQuote.totalCents, t.q.totalCents);
    assert.equal(r.receipt.prepared.plan.sourceQuote.depositCents, t.q.depositCents);
    assert.equal(r.receipt.prepared.plan.sourceQuote.depositBasis.basisPoints, t.q.catalog.depositBps);
    assert.equal(r.receipt.prepared.plan.sourceQuote.terms, t.q.catalog.terms);
    assert.equal(r.receipt.prepared.plan.paymentTerms, t.configure.paymentTerms);
    assert.equal(r.receipt.prepared.internalApproval.actorId, r.actorId); assert.equal(r.receipt.prepared.internalApproval.atMs, r.atMs);
    assert.equal(r.bodySha256, digest(r.receipt.prepared)); assert.equal(r.receiptDigest, digest(r.receipt));
    assert.equal(r.executable, false); assert.equal(r.providerEnabled, false); assert.equal(r.publicPaymentUrl, null); assert.equal(r.authorizationVerified, false);
    assert.equal(r.receipt.authorizationVerified, false); assert.equal(registered.externalEffectsEnabled, false);
    for (const key of ['briefs', 'quotes', 'decisions', 'paymentContractPreparationsV2'] as const) assert.deepEqual(registered.record[key], before[key]);
    assert.equal(registered.record.revision, 6); assert.equal(t.calls().validationCalls, 1);
    assertEventQuoteRecord(JSON.parse(JSON.stringify(registered.record)), t.scope, t.eventId);
  });
}

test('configuration and registration require explicit test opt-in and reject commercial scope before callbacks', async () => {
  for (const options of [{ enabled: false }, { commercial: true }]) {
    const t = await setup('retainer_50', options);
    await assert.rejects(t.execute(t.configure), code(options.commercial ? 'PAYMENT_DRAFTS_TEST_ONLY' : 'PAYMENT_DRAFTS_DISABLED'));
    assert.deepEqual(t.calls(), { leadCalls: 0, validationCalls: 0 });
    assert.deepEqual((await t.store.read(t.scope, t.eventId)), t.view.record);
  }
});

test('status advertises the draft capability only for explicit test composition with a current test-only catalogue', async () => {
  const enabled = await setup(), disabled = await setup('retainer_50', { enabled: false }), commercial = await setup('retainer_50', { commercial: true });
  assert.equal((await enabled.service.status(enabled.scope, enabled.actor)).paymentDraftsEnabled, true);
  for (const t of [disabled, commercial]) assert.equal(Object.hasOwn(await t.service.status(t.scope, t.actor), 'paymentDraftsEnabled'), false);
  enabled.clock(testCatalog.validUntilMs);
  assert.equal(Object.hasOwn(await enabled.service.status(enabled.scope, enabled.actor), 'paymentDraftsEnabled'), false);
});

test('both commands require write and approval and never accept identity, lead, mode, amount or receipt authority from a command', async () => {
  const t = await setup();
  await assert.rejects(t.execute(t.configure, { ...t.actor, canApprove: false }), code('APPROVAL_FORBIDDEN'));
  await assert.rejects(t.execute(t.configure, { ...t.actor, canWrite: false }), code('WRITE_FORBIDDEN'));
  for (const injected of [{ canonicalLeadId: 'forged' }, { actorId: 'forged' }, { scope: testScope }, { paymentMode: 'full_upfront' }, { totalCents: 1 }, { approved: true }])
    await assert.rejects(t.execute({ ...t.configure, ...injected }), code('INVALID_INPUT'));
  const configured = await t.execute(t.configure);
  await assert.rejects(t.execute(t.registration(configured), { ...t.actor, canApprove: false }), code('APPROVAL_FORBIDDEN'));
  for (const injected of [{ receipt: {} }, { prepared: {} }, { actorId: 'forged' }, { canonicalLeadId: 'forged' }])
    await assert.rejects(t.execute({ ...t.registration(configured), ...injected }), code('INVALID_INPUT'));
});

test('missing explicit facts and unresolved lead leave the existing pending preparation unchanged', async () => {
  const t = await setup();
  for (const key of ['paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']) {
    const command = { ...t.configure }; delete command[key];
    await assert.rejects(t.execute(command));
  }
  await assert.rejects(t.execute({ ...t.configure, paymentSchedule: null }));
  t.lead(null); await assert.rejects(t.execute(t.configure), code('SYNTHETIC_CANONICAL_LEAD_REQUIRED'));
  assert.deepEqual(await t.store.read(t.scope, t.eventId), t.view.record);
});

test('same key and input replay do not resolve lead or call validation again; changed input or actor conflicts', async () => {
  const t = await setup(), configured = await t.execute(t.configure), calls = t.calls();
  assert.deepEqual(await t.execute(t.configure), configured); assert.deepEqual(t.calls(), calls);
  await assert.rejects(t.execute({ ...t.configure, paymentTerms: 'Changed' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(t.execute(t.configure, { ...t.actor, actorId: 'other-actor' }), code('IDEMPOTENCY_CONFLICT'));
  const input = t.registration(configured), registered = await t.execute(input), registrationCalls = t.calls();
  assert.deepEqual(await t.execute(input), registered); assert.deepEqual(t.calls(), registrationCalls);
  await assert.rejects(t.execute({ ...input, expectedReviewDigest: 'f'.repeat(64) }), code('IDEMPOTENCY_CONFLICT'));
  const disabled = createEventQuoteService({ store: t.store, catalogFor: async () => t.getCatalog(), clock: () => TEST_AT });
  await assert.rejects(disabled.execute(t.scope, t.actor, t.eventId, input), code('PAYMENT_DRAFTS_DISABLED'));
});

test('one immutable configuration per preparation and one registration per configuration require fresh quote/preparation for changes', async () => {
  const t = await setup(), configured = await t.execute(t.configure);
  await assert.rejects(t.execute({ ...t.configure, key: 'another-configuration', expectedRevision: 5 }), code('PAYMENT_CONFIGURATION_ALREADY_EXISTS'));
  const registered = await t.execute(t.registration(configured));
  await assert.rejects(t.execute({ ...t.registration(configured, 'another-registration'), expectedRevision: registered.record.revision }), code('PAYMENT_DRAFT_ALREADY_REGISTERED'));
});

test('stale configuration, review digest, preparation and source pins fail before validation', async () => {
  const t = await setup();
  await assert.rejects(t.execute({ ...t.configure, preparationDigest: 'f'.repeat(64) }), code('STALE_PAYMENT_CONFIGURATION'));
  const configured = await t.execute(t.configure), input = t.registration(configured);
  for (const patch of [{ configurationDigest: 'f'.repeat(64) }, { expectedReviewDigest: 'f'.repeat(64) }, { configurationId: 'other-config' }])
    await assert.rejects(t.execute({ ...input, ...patch }), code('STALE_PAYMENT_CONFIGURATION'));
  const changed = await t.execute({ action: 'brief', key: 'changed-brief', expectedRevision: 5, brief: { ...testBrief, requirements: 'Different synthetic scope' } });
  await assert.rejects(t.execute({ ...input, expectedRevision: changed.record.revision }), code('STALE_PAYMENT_CONFIGURATION'));
  assert.equal(t.calls().validationCalls, 0);
});

test('changed PHP echo, malformed receipt, claimed authorization and provider enablement roll back registration', async () => {
  const t = await setup(), configured = await t.execute(t.configure), input = t.registration(configured);
  for (const response of [(body: string) => { const r = JSON.parse(echo(body)); r.prepared.plan.paymentTerms += ' changed'; return JSON.stringify(r); },
    () => '{', (body: string) => { const r = JSON.parse(echo(body)); r.authorizationVerified = true; return JSON.stringify(r); },
    (body: string) => { const r = JSON.parse(echo(body)); r.providerEnabled = true; return JSON.stringify(r); }]) {
    t.validate(async body => response(body));
    await assert.rejects(t.execute(input), code('INVALID_PAYMENT_CONTRACT_RECEIPT'));
    assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
  }
  t.validate(async () => JSON.stringify({ status: 'blocked', code: 'INCOMPATIBLE_SYNTHETIC_CONTRACT' }));
  await assert.rejects(t.execute(input), code('PAYMENT_CONTRACT_REJECTED'));
});

test('bounded validation aborts hanging callbacks and late completion cannot append a record', async () => {
  const t = await setup('retainer_50', { timeout: 20 }), configured = await t.execute(t.configure);
  let captured: AbortSignal | undefined, finish: ((raw: string) => void) | undefined, body = '';
  t.validate((raw, _clock, signal) => { captured = signal; body = raw; return new Promise(resolve => { finish = resolve; }); });
  await assert.rejects(t.execute(t.registration(configured)), code('PAYMENT_VALIDATION_TIMEOUT'));
  assert.equal(captured?.aborted, true); finish!(echo(body)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
});

test('validation deadline also rejects a callback that blocks the event loop past its budget', async () => {
  const t = await setup('retainer_50', { timeout: 10 }), configured = await t.execute(t.configure);
  let signal: AbortSignal | undefined;
  t.validate(async (body, _clock, received) => {
    signal = received;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    return echo(body);
  });
  await assert.rejects(t.execute(t.registration(configured)), code('PAYMENT_VALIDATION_TIMEOUT'));
  assert.equal(signal?.aborted, true); assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
});

test('an abort listener returning an echo cannot turn a timed-out validation into success', async () => {
  const t = await setup('retainer_50', { timeout: 10 }), configured = await t.execute(t.configure);
  t.validate((body, _clock, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(echo(body)), { once: true })));
  await assert.rejects(t.execute(t.registration(configured)), code('PAYMENT_VALIDATION_TIMEOUT'));
  assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
});

test('balance and expiration that cease being future during PHP validation roll back before the aggregate append', async () => {
  const boundary = TEST_AT + 60_000, date = new Date(boundary).toISOString().slice(0, 10), time = new Date(boundary).toISOString().slice(11, 16);
  for (const mode of ['retainer_50', 'full_upfront'] as const) {
    const t = await setup(mode);
    if (mode === 'full_upfront') t.configure.linkExpiration = { kind: 'at', date, time, timezone: 'UTC' };
    else t.configure.paymentSchedule = { kind: mode, eventDate: new Date(TEST_AT + 86400000).toISOString().slice(0, 10), eventTime: '18:00', timezone: 'UTC',
      balanceDate: date, balanceTime: time, timingExceptionReason: 'Evento cercano; fecha futura sintética revisada expresamente.' };
    const configured = await t.execute(t.configure);
    t.validate(async body => { t.clock(boundary); return echo(body); });
    await assert.rejects(t.execute(t.registration(configured)), code('STALE_PAYMENT_CONFIGURATION'));
    assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
  }
});

test('post-validation actor expiry, catalogue changes and lead changes roll back the registration', async () => {
  for (const change of ['actor', 'catalog', 'lead'] as const) {
    const t = await setup(), configured = await t.execute(t.configure);
    t.validate(async body => {
      if (change === 'actor') t.clock(t.actor.expiresAtMs);
      else if (change === 'catalog') t.catalog({ ...t.getCatalog(), version: 'new-version' });
      else t.lead({ source: 'synthetic_fixture', canonicalLeadId: 'different-synthetic-lead' });
      return echo(body);
    });
    await assert.rejects(t.execute(t.registration(configured)));
    assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
  }
});

test('a later refresh may not accept a clock lower than an already observed post-PHP time', async () => {
  const t = await setup(), configured = await t.execute(t.configure);
  t.validate(async body => { t.clock(TEST_AT + 20); return echo(body); });
  t.onLead(() => { if (t.calls().leadCalls === 3) t.clock(TEST_AT + 10); });
  await assert.rejects(t.execute(t.registration(configured)), code('CLOCK_REGRESSION'));
  assert.deepEqual(await t.store.read(t.scope, t.eventId), configured.record);
});

test('historical reconstruction uses the recorded time, never PHP or current permissions, and detects tampered ledger facts', async () => {
  const t = await setup(), configured = await t.execute(t.configure), registered = await t.execute(t.registration(configured));
  t.clock(Date.parse('2100-01-01T00:00:00Z'));
  assertEventQuoteRecord(registered.record, t.scope, t.eventId);
  assert.equal(t.calls().validationCalls, 1);
  for (const change of [(r: any) => { r.paymentConfigurationsV2[0].configuration.paymentTerms += 'tamper'; },
    (r: any) => { r.paymentConfigurationsV2[0].reviewDigest = 'f'.repeat(64); },
    (r: any) => { r.paymentDraftRegistrationsV2[0].receipt.prepared.plan.initialPaymentCents++; },
    (r: any) => { r.paymentDraftRegistrationsV2[0].authorizationVerified = true; },
    (r: any) => { r.paymentDraftRegistrationsV2[0].receiptDigest = 'f'.repeat(64); }]) {
    const altered = structuredClone(registered.record); change(altered);
    assert.throws(() => assertEventQuoteRecord(altered, t.scope, t.eventId));
  }
  assert.equal(canonical(registered.record.paymentContractPreparationsV2), canonical(t.view.record.paymentContractPreparationsV2));
});

test('schema 4 remains monotonic after preparing another quote and keeps all prior ledgers intact', async () => {
  const t = await setup(), configured = await t.execute(t.configure), old = structuredClone(configured.record);
  let view = await t.execute({ action: 'quote', key: 'quote-two', expectedRevision: 5, expectedBriefDigest: old.briefs[0].digest,
    expectedCatalogDigest: digest(t.getCatalog()), selections: [{ itemId: t.getCatalog().items[0].id, quantity: 2 }] });
  const q = view.record.quotes[1];
  view = await t.execute({ action: 'approve', key: 'approve-two', expectedRevision: 6, quoteVersion: 2, quoteDigest: q.digest,
    artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await t.execute({ action: 'prepare_payment_v2', key: 'prep-two', expectedRevision: 7, quoteVersion: 2, quoteDigest: q.digest,
    approvalDigest: view.record.decisions[1].digest, artifactSha256: q.artifact.sha256, paymentMode: 'full_upfront' });
  assert.equal(view.record.schemaVersion, 4); assert.deepEqual(view.record.paymentConfigurationsV2, old.paymentConfigurationsV2);
  assert.deepEqual(view.record.paymentDraftRegistrationsV2, old.paymentDraftRegistrationsV2);
});

test('invalid validation deadlines fail at composition before invoking callbacks', () => {
  for (const timeout of [0, -1, NaN, Infinity, 5001]) assert.throws(() => createEventQuoteService({
    store: new MemoryEventQuoteStore(), catalogFor: async () => testCatalog,
    testPaymentDrafts: { resolveCanonicalLead: async () => null, validateContract: async () => '', validationTimeoutMs: timeout },
  }), code('INVALID_PAYMENT_VALIDATION_TIMEOUT'));
});
