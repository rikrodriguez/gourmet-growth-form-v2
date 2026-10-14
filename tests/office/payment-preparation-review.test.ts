import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventQuoteError, type EventQuoteRecord, type EventQuoteView, type PreparePaymentCommand, type QuoteScope } from '../../src/office/backend/event-quote-contracts';
import { assertEventQuoteRecord, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { createEventQuoteApi, EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF, type QuoteAccessTarget } from '../../src/office/backend/event-quote-http';
import { PersistedPaymentPreparation } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { exactQuoteReviewKey, validateQuoteView, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { TEST_AT, testActor as actor, testBrief as brief, testCatalog as catalog, testScope as scope, testService } from './event-quote-fixtures';

const EVENT = 'review-payment-event';
const rejectsCode = (code: string) => (error: unknown) => error instanceof EventQuoteError && error.code === code;
const prepare = (view: EventQuoteView, key = 'review-prepare'): PreparePaymentCommand => {
  const quote = view.record.quotes.at(-1)!, approval = view.record.decisions.find(d => d.quoteDigest === quote.digest)!;
  return { action: 'prepare_payment', key, expectedRevision: view.record.revision, quoteVersion: quote.version,
    quoteDigest: quote.digest, approvalDigest: approval.digest, artifactSha256: quote.artifact.sha256 };
};
async function approved(t = testService(), owner: QuoteScope = scope, eventId = EVENT) {
  let view = await t.service.execute(owner, actor, eventId, { action: 'create', key: 'review-create', expectedRevision: 0, brief });
  view = await t.service.execute(owner, actor, eventId, { action: 'quote', key: 'review-quote', expectedRevision: 1,
    expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 24 }] });
  const q = view.record.quotes[0];
  view = await t.service.execute(owner, actor, eventId, { action: 'approve', key: 'review-approve', expectedRevision: 2,
    quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: brief.recipient });
  return { ...t, view };
}
async function prepared() {
  const t = await approved();
  return { ...t, view: await t.service.execute(scope, actor, EVENT, prepare(t.view)) };
}
function status(): EventQuoteStatusResponse {
  return { enabled: true, reason: null, catalog, catalogDigest: digest(catalog), externalEffectsEnabled: false,
    session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: 'review_csrf_not_secret', expiresAtMs: actor.expiresAtMs } };
}

test('independent payment review: concurrent equal commands are one append; different keys conflict', async () => {
  const t = await approved(), command = prepare(t.view);
  const [first, second] = await Promise.all([t.service.execute(scope, actor, EVENT, command), t.service.execute(scope, actor, EVENT, command)]);
  assert.deepEqual(first, second); assert.equal(first.record.revision, 4);
  assert.equal(first.record.paymentPreparations?.length, 1);
  assert.equal(first.record.receipts.filter(r => r.key === command.key).length, 1);
  await assert.rejects(t.service.execute(scope, actor, EVENT, { ...command, key: 'different-key', expectedRevision: 4 }), rejectsCode('PAYMENT_ALREADY_PREPARED'));
  assert.deepEqual(await t.service.read(scope, actor, EVENT), first);
});

test('independent payment review: legacy fee cannot replace exact approved cents or terms', async () => {
  const t = await approved(), command = prepare(t.view), original = t.view.record;
  for (const injected of [{ depositCents: 4900 }, { totalCents: 4900 }, { terms: 'New payment agreement' },
    { providerEnabled: true }, { publicPaymentUrl: 'https://provider.example.test/pay' }, { intendedRecipient: 'other@example.test' }]) {
    await assert.rejects(t.service.execute(scope, actor, EVENT, { ...command, ...injected }));
    assert.deepEqual((await t.service.read(scope, actor, EVENT)).record, original);
  }
  const view = await t.service.execute(scope, actor, EVENT, command), p = view.record.paymentPreparations![0], q = view.record.quotes[0];
  assert.equal(p.depositCents, q.depositCents); assert.notEqual(p.depositCents, 4900);
  assert.equal(p.totalCents, q.totalCents); assert.equal(p.remainingCents, q.totalCents - q.depositCents); assert.equal(p.terms, q.catalog.terms);
  assert.equal(p.publicPaymentUrl, null); assert.equal(p.providerEnabled, false); assert.equal(p.financialMeaning, 'unaccepted_quote');
});

test('independent payment review: scope-bound preparation identities resist copying between matching quotes', async () => {
  const t = testService(), otherScope = { ...scope, workspaceId: 'review-other-workspace' };
  const left = await approved(t), right = await approved(t, otherScope);
  assert.equal(left.view.record.quotes[0].digest, right.view.record.quotes[0].digest, 'same synthetic inputs deliberately share business digests');
  const first = await t.service.execute(scope, actor, EVENT, prepare(left.view));
  const second = await t.service.execute(otherScope, actor, EVENT, prepare(right.view));
  assert.notEqual(first.record.paymentPreparations![0].id, second.record.paymentPreparations![0].id);
  const corrupted = structuredClone(second.record); corrupted.paymentPreparations = structuredClone(first.record.paymentPreparations);
  assert.throws(() => assertEventQuoteRecord(corrupted, otherScope, EVENT));
  const otherEvent = await approved(t, scope, 'review-other-event');
  await assert.rejects(t.service.execute(scope, actor, 'review-other-event', prepare(left.view)), rejectsCode('STALE_PAYMENT_PREPARATION'));
  assert.equal(otherEvent.view.record.revision, 3);
});

test('independent payment review: approval rights and exact version pins are required without mutation', async () => {
  const t = await approved(), command = prepare(t.view);
  for (const permission of [{ canWrite: false }, { canApprove: false }]) {
    await assert.rejects(t.service.execute(scope, { ...actor, ...permission }, EVENT, command));
  }
  for (const changed of [{ quoteVersion: 2 }, { quoteDigest: '0'.repeat(64) }, { approvalDigest: '0'.repeat(64) }, { artifactSha256: '0'.repeat(64) }]) {
    await assert.rejects(t.service.execute(scope, actor, EVENT, { ...command, ...changed }), rejectsCode('STALE_PAYMENT_PREPARATION'));
  }
  assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
});

test('independent payment review: rehashing preparation content cannot bypass ledger replay', async () => {
  const { view } = await prepared();
  const attacks: Array<(p: Record<string, unknown>) => void> = [
    p => { p.totalCents = 4900; }, p => { p.depositCents = 4900; }, p => { p.remainingCents = 0; },
    p => { p.terms = 'Altered conditions'; }, p => { p.intendedRecipient = 'attacker@example.test'; },
    p => { p.actorId = 'other-approver'; }, p => { p.atMs = TEST_AT + 1; }, p => { p.approvalDigest = 'f'.repeat(64); },
    p => { p.eventId = 'another-event'; }, p => { p.providerEnabled = true; },
    p => { p.publicPaymentUrl = 'https://provider.example.test/pay'; }, p => { p.blockers = []; },
  ];
  for (const attack of attacks) {
    const forged = structuredClone(view.record), p = forged.paymentPreparations![0];
    attack(p as unknown as Record<string, unknown>); const { digest: _, ...content } = p; p.digest = digest(content);
    assert.throws(() => assertEventQuoteRecord(forged, scope, EVENT));
  }
  for (const mutate of [(r: EventQuoteRecord) => { r.schemaVersion = 1; }, (r: EventQuoteRecord) => { delete r.paymentPreparations; },
    (r: EventQuoteRecord) => { r.paymentPreparations = []; }]) {
    const forged = structuredClone(view.record); mutate(forged); assert.throws(() => assertEventQuoteRecord(forged, scope, EVENT));
  }
});

test('independent payment review: queued preparation checks catalogue and identity after lock wait', async () => {
  for (const reason of ['catalogue', 'identity', 'replacement'] as const) {
    const t = await approved(); let release!: () => void, entered!: () => void, now = TEST_AT, currentCatalog = catalog;
    const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
    const store = { read: t.store.read.bind(t.store), async transact(s: QuoteScope, id: string, fn: Parameters<typeof t.store.transact>[2]) {
      entered(); await gate; return t.store.transact(s, id, fn);
    } };
    const service = createEventQuoteService({ store, clock: () => now, catalogFor: async () => currentCatalog });
    const pending = service.execute(scope, { ...actor, expiresAtMs: reason === 'identity' ? TEST_AT + 1000 : actor.expiresAtMs }, EVENT, prepare(t.view));
    await waiting;
    if (reason === 'catalogue') now = catalog.validUntilMs;
    else if (reason === 'identity') now = TEST_AT + 1000;
    else currentCatalog = { ...catalog, version: 'replacement-version' };
    release(); await assert.rejects(pending);
    assert.deepEqual((await t.store.read(scope, EVENT)), t.view.record);
  }
});

test('independent payment review: a fully rehashed ledger cannot prepare before approval or twice', async () => {
  const { view } = await prepared();
  const rehash = (record: EventQuoteRecord) => {
    record.audit.forEach((audit, index) => {
      audit.sequence = index + 1; audit.previousDigest = index ? record.audit[index - 1].digest : null;
      const { digest: _, ...content } = audit; audit.digest = digest(content);
      record.receipts[index] = { key: audit.commandKey, actorId: audit.actorId, inputDigest: audit.inputDigest, resultingRevision: index + 1 };
    });
    record.revision = record.audit.length;
  };
  const reordered = structuredClone(view.record), q = reordered.quotes[0], d = reordered.decisions[0];
  [reordered.audit[2], reordered.audit[3]] = [reordered.audit[3], reordered.audit[2]];
  reordered.audit[2].inputDigest = digest({ scope, eventId: EVENT, actorId: actor.actorId,
    command: { ...prepare(view), key: reordered.audit[2].commandKey, expectedRevision: 2 } });
  reordered.audit[3].inputDigest = digest({ scope, eventId: EVENT, actorId: actor.actorId,
    command: { action: 'approve', key: d.id, expectedRevision: 3, quoteVersion: q.version, quoteDigest: q.digest,
      artifactSha256: q.artifact.sha256, intendedRecipient: d.intendedRecipient } });
  rehash(reordered);
  assert.throws(() => assertEventQuoteRecord(reordered, scope, EVENT));

  const repeated = structuredClone(view.record), command = prepare(view, 'review-repeated-preparation');
  repeated.paymentPreparations!.push(structuredClone(repeated.paymentPreparations![0]));
  repeated.audit.push({ ...repeated.audit[3], commandKey: command.key,
    inputDigest: digest({ scope, eventId: EVENT, actorId: actor.actorId, command }) });
  rehash(repeated);
  assert.throws(() => assertEventQuoteRecord(repeated, scope, EVENT));
});

test('independent payment review: historical request survives brief edit but cannot authorize a new request', async () => {
  const t = await prepared(), original = structuredClone(t.view.record.paymentPreparations);
  const changed = await t.service.execute(scope, actor, EVENT, { action: 'brief', key: 'review-new-brief', expectedRevision: 4,
    brief: { ...brief, recipient: 'new-client@example.test' } });
  assert.equal(changed.currentQuoteStatus, 'obsolete'); assert.deepEqual(changed.record.paymentPreparations, original);
  await assert.rejects(t.service.execute(scope, actor, EVENT, { ...prepare(t.view, 'review-new-prepare'), expectedRevision: 5 }), rejectsCode('STALE_PAYMENT_PREPARATION'));
  assertEventQuoteRecord(changed.record, scope, EVENT);
});

test('independent payment review: twenty immutable version preparations fit the bounded ledger and fail closed at its quote cap', async () => {
  const t = await prepared(); let view = t.view;
  const original = structuredClone(view.record.paymentPreparations![0]);
  for (let version = 2; version <= 20; version++) {
    view = await t.service.execute(scope, actor, EVENT, { action: 'quote', key: `review-cap-quote-${version}`, expectedRevision: view.record.revision,
      expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: version }] });
    const q = view.record.quotes.at(-1)!;
    view = await t.service.execute(scope, actor, EVENT, { action: 'approve', key: `review-cap-approve-${version}`, expectedRevision: view.record.revision,
      quoteVersion: version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: brief.recipient });
    view = await t.service.execute(scope, actor, EVENT, prepare(view, `review-cap-prepare-${version}`));
  }
  assert.equal(view.record.revision, 61); assert.equal(view.record.paymentPreparations!.length, 20);
  assert.equal(new Set(view.record.paymentPreparations!.map(p => p.id)).size, 20);
  assert.deepEqual(view.record.paymentPreparations![0], original); assertEventQuoteRecord(view.record, scope, EVENT);
  assert.equal(validateQuoteView(view, EVENT), view);
  await assert.rejects(t.service.execute(scope, actor, EVENT, { action: 'quote', key: 'review-cap-excess', expectedRevision: 61,
    expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 21 }] }), rejectsCode('RECORD_LIMIT'));
  assert.deepEqual(await t.service.read(scope, actor, EVENT), view);
});

test('independent payment review: transport classifies preparation as approval and requires CSRF', async () => {
  const t = await approved(), targets: QuoteAccessTarget[] = [], origin = 'https://review.example.test', csrf = 'review_csrf_token_1234';
  let canApprove = true;
  const app = createEventQuoteApi({ allowedOrigin: origin, clock: () => TEST_AT,
    async runAuthorized(_request, target, operation) {
      targets.push(target); return operation({ scope, actor: { ...actor, canApprove }, csrfToken: csrf, expiresAtMs: actor.expiresAtMs }, t.service);
    } });
  const command = prepare(t.view), headers = { host: 'review.example.test', origin, [CSRF]: csrf };
  try {
    canApprove = false;
    assert.equal((await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`, headers, payload: command })).statusCode, 403);
    canApprove = true;
    assert.equal((await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`, headers: { ...headers, [CSRF]: 'incorrect_token_1234' }, payload: command })).statusCode, 403);
    assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
    const accepted = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`, headers, payload: command });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(targets, Array.from({ length: 3 }, () => ({ kind: 'approve', eventId: EVENT })));
  } finally { await app.close(); }
});

test('independent payment review: browser rejects payment URL, paid status and altered monetary response', async () => {
  const { view } = await prepared(); assert.equal(validateQuoteView(view, EVENT), view);
  for (const mutate of [(p: any) => { p.publicPaymentUrl = 'https://provider.example.test/pay'; }, (p: any) => { p.status = 'paid'; },
    (p: any) => { p.totalCents++; }, (p: any) => { p.depositCents++; }, (p: any) => { p.remainingCents++; },
    (p: any) => { p.providerEnabled = true; }, (p: any) => { p.intendedRecipient = 'other@example.test'; }]) {
    const forged = structuredClone(view); mutate(forged.record.paymentPreparations![0]);
    assert.throws(() => validateQuoteView(forged, EVENT));
  }
});

test('independent payment review: card is internal only and cannot look like an executable payment link', async t => {
  t.mock.method(Date, 'now', () => TEST_AT);
  const { view } = await prepared();
  const html = renderToStaticMarkup(React.createElement(PersistedPaymentPreparation, { view, status: status(), writable: true, dirty: false, verified: exactQuoteReviewKey(view) }));
  assert.match(html, /sin enlace/); assert.match(html, /Ninguna solicitud se ha enviado/);
  assert.match(html, /Cobrado: desconocido/); assert.match(html, /USD 49/);
  assert.doesNotMatch(html, /<a\b|href=|<form\b|<iframe\b|<script\b/);
  assert.match(html, /data-testid="persisted-payment-prepare" disabled=""/);
});

test('independent payment review: saved preparation is visually obsolete at catalogue expiry without reload', async t => {
  const { view } = await prepared();
  t.mock.method(Date, 'now', () => catalog.validUntilMs);
  const html = renderToStaticMarkup(React.createElement(PersistedPaymentPreparation, { view, status: status(), writable: false, dirty: false, verified: exactQuoteReviewKey(view) }));
  assert.match(html, /Solicitud obsoleta/, 'an expired catalogue must not keep a saved request visually current');
});

test('independent payment review: refreshed catalogue replacement makes stale view preparation obsolete', async t => {
  t.mock.method(Date, 'now', () => TEST_AT);
  const { view } = await prepared(), replacement = { ...catalog, version: 'v2', terms: 'Replacement approved conditions' };
  const html = renderToStaticMarkup(React.createElement(PersistedPaymentPreparation, { view,
    status: { ...status(), catalog: replacement, catalogDigest: digest(replacement) }, writable: false, dirty: false, verified: exactQuoteReviewKey(view) }));
  assert.match(html, /Solicitud obsoleta/, 'a newer authoritative catalogue overrides stale currentQuoteStatus');
});
