import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersistedQuoteWorkspace, PersistedQuoteReview } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { eventQuoteClient, EventQuoteClientError, exactQuoteApproval, exactQuoteReviewKey, latestBriefInput, quoteApprovalBlocked, quoteArtifactUrl, validateQuoteStatus, validateQuoteView, verifyQuoteArtifact, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { TEST_AT, testActor, testBrief, testScope, testService } from './event-quote-fixtures';
const EVENT = 'TEST-EVENT';
async function setup(extra: Partial<typeof testBrief> = {}) {
  const t = testService();
  let view = await t.service.execute(testScope, testActor, EVENT, { action: 'create', key: 'ui-create', expectedRevision: 0, brief: { ...testBrief, ...extra } });
  const serviceStatus = await t.service.status(testScope, testActor);
  view = await t.service.execute(testScope, testActor, EVENT, { action: 'quote', key: 'ui-quote', expectedRevision: view.record.revision, expectedBriefDigest: view.record.briefs.at(-1)!.digest, expectedCatalogDigest: serviceStatus.catalogDigest, selections: [{ itemId: 'TEST-ITEM', quantity: 24 }] });
  const status: EventQuoteStatusResponse = { ...serviceStatus, session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: 'test-csrf-not-for-display', expiresAtMs: TEST_AT + 60_000 }, externalEffectsEnabled: false };
  return { ...t, status, view };
}
const render = (state?: Awaited<ReturnType<typeof setup>>, identityKey: string | null = 'test-identity') => renderToStaticMarkup(state && identityKey
  ? <PersistedQuoteReview view={state.view} status={state.status} />
  : <PersistedQuoteWorkspace client={eventQuoteClient} eventId={EVENT} identityKey={identityKey} />);

test('persisted workspace starts read-only loading with no fixture values, login creation or auto approval', () => {
  const html = render();
  assert.match(html, /Cargando expediente/); assert.match(html, /No envío ni cobro/);
  assert.doesNotMatch(html, /DEMO-EVT|CAT-LAB|client@example|Crear sesión|Iniciar sesión|3000|900/);
  assert.doesNotMatch(html, /data-testid="persisted-quote-approve"/);
});

test('production workspace ignores any stale initial state when an identity is replaced', async () => {
  const t = await setup();
  const html = renderToStaticMarkup(<PersistedQuoteWorkspace client={eventQuoteClient} eventId={EVENT} identityKey="new-identity" {...{ initialState: { status: t.status, view: t.view } }} />);
  assert.match(html, /Cargando expediente/); assert.doesNotMatch(html, /client@example|TEST-CATALOG|Partida sintética/);
});

test('null existing identity renders no retained quote, manual contact or controls', async () => {
  const t = await setup(); const html = render(t, null);
  assert.match(html, /identidad existente verificada/);
  assert.doesNotMatch(html, /client@example|TEST-CATALOG|TEST-EVENT|input|button/);
});

test('review shows persisted catalogue, original context and exact HTML safely without enabling approval', async () => {
  const hostile = '<img src="https://external.invalid/pixel" onerror="alert(1)"><script>alert(2)</script>';
  const t = await setup({ originalMessage: hostile }); const html = render(t);
  assert.match(html, /TEST-CATALOG/); assert.match(html, /client@example.test/); assert.match(html, /USD/);
  assert.match(html, /Cobrado: desconocido/); assert.match(html, /sin envío|sin aceptación|sin confirmar/i);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|<iframe/);
  assert.match(html, /Leer HTML exacto guardado/); assert.doesNotMatch(html, /test-csrf-not-for-display/);
});

test('session token is never rendered and exact approval starts unchecked and disabled', async () => {
  const t = await setup(); const html = render(t);
  assert.doesNotMatch(html, /test-csrf-not-for-display/);
  assert.match(html, /data-testid="persisted-quote-approve"[^>]*disabled=""/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, new RegExp(t.view.record.quotes[0].digest));
  assert.match(html, /\/api\/office\/event-quotes\/TEST-EVENT\/quotes\/1\/artifact/);
});

test('approval payload binds exact revision, version, recipient, quote digest and artifact hash', async () => {
  const t = await setup(); const q = t.view.record.quotes.at(-1)!;
  assert.equal(quoteApprovalBlocked(t.view, t.status, TEST_AT), false);
  const command = exactQuoteApproval(t.view, t.status, 'ui-approval', TEST_AT);
  assert.deepEqual(command, { action: 'approve', key: 'ui-approval', expectedRevision: 2, quoteVersion: 1, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  const result = await t.service.execute(testScope, testActor, EVENT, command);
  assert.equal(result.currentQuoteStatus, 'approved_internal_unsent'); assert.equal(result.externalEffectsEnabled, false);
  assert.equal(quoteApprovalBlocked(result, t.status, TEST_AT), true);
});

test('changed brief, current catalogue, permissions, scope mode and expiry block stale approvals', async () => {
  const t = await setup();
  for (const mutate of [
    (s: EventQuoteStatusResponse) => { s.enabled = false; },
    (s: EventQuoteStatusResponse) => { s.session.canApprove = false; },
    (s: EventQuoteStatusResponse) => { s.session.canWrite = false; },
    (s: EventQuoteStatusResponse) => { s.session.mode = 'commercial'; },
    (s: EventQuoteStatusResponse) => { s.session.expiresAtMs = TEST_AT; },
    (s: EventQuoteStatusResponse) => { s.catalog!.validUntilMs = TEST_AT; },
    (s: EventQuoteStatusResponse) => { s.catalogDigest = 'f'.repeat(64); },
  ]) { const s = structuredClone(t.status); mutate(s); assert.equal(quoteApprovalBlocked(t.view, s, TEST_AT), true); assert.throws(() => exactQuoteApproval(t.view, s, 'no-approval', TEST_AT), EventQuoteClientError); }
  const before = exactQuoteReviewKey(t.view);
  const updated = await t.service.execute(testScope, testActor, EVENT, { action: 'brief', key: 'ui-new-brief', expectedRevision: 2, brief: { ...testBrief, recipient: 'new@example.test' } });
  assert.notEqual(exactQuoteReviewKey(updated), before); assert.equal(quoteApprovalBlocked(updated, t.status, TEST_AT), true);
  const html = render({ ...t, view: updated });
  assert.match(html, /Destinatario previsto: <strong>client@example.test/); assert.match(html, /Cotización obsoleta/);
});

test('artifact integrity check detects changed bytes and length before review', async () => {
  const t = await setup(); const quote = t.view.record.quotes[0];
  assert.equal(await verifyQuoteArtifact(quote), true);
  assert.equal(await verifyQuoteArtifact({ ...quote, artifact: { ...quote.artifact, html: quote.artifact.html + 'tamper' } }), false);
  assert.equal(await verifyQuoteArtifact({ ...quote, artifact: { ...quote.artifact, sha256: '0'.repeat(64) } }), false);
});

test('response validators reject unsafe authority, unknown effects, malformed identity and event substitution', async () => {
  const t = await setup(); assert.equal(validateQuoteStatus(t.status), t.status); assert.equal(validateQuoteView(t.view, EVENT), t.view);
  assert.throws(() => validateQuoteStatus({ ...t.status, session: { ...t.status.session, mode: 'commercial' } }), EventQuoteClientError);
  assert.throws(() => validateQuoteStatus({ ...t.status, externalEffectsEnabled: true }), EventQuoteClientError);
  assert.throws(() => validateQuoteView(t.view, 'ANOTHER-EVENT'), EventQuoteClientError);
  assert.throws(() => validateQuoteView({ ...t.view, externalEffectsEnabled: true }, EVENT), EventQuoteClientError);
  assert.throws(() => quoteArtifactUrl('../outside', 1), EventQuoteClientError);
  assert.throws(() => quoteArtifactUrl(EVENT, 0), EventQuoteClientError);
  assert.equal(quoteArtifactUrl('TEST:EVENT.v1', 2), '/api/office/event-quotes/TEST%3AEVENT.v1/quotes/2/artifact');
  assert.equal(latestBriefInput(null).originalMessage, ''); assert.deepEqual(latestBriefInput(t.view), testBrief);
});

test('transport sends only explicit commands, same-origin credentials and CSRF, without mutation retries', async () => {
  const t = await setup(); const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(t.view), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const command = exactQuoteApproval(t.view, t.status, 'transport-approve', TEST_AT);
    await eventQuoteClient.execute(EVENT, command, t.status.session.csrfToken, new AbortController().signal);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/office/event-quotes/TEST-EVENT/commands');
    const init = calls[0].init!; assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('x-event-quote-csrf'), t.status.session.csrfToken); assert.deepEqual(JSON.parse(init.body as string), command);
    assert.doesNotMatch(init.body as string, /organizationId|workspaceId|actorId|unitPriceCents/);
    globalThis.fetch = async () => { calls.push({ url: 'uncertain' }); throw new Error('network interrupted'); };
    await assert.rejects(() => eventQuoteClient.execute(EVENT, command, t.status.session.csrfToken, new AbortController().signal), (error: unknown) => error instanceof EventQuoteClientError && error.code === 'REQUEST_UNCERTAIN');
    assert.equal(calls.filter(c => c.url === 'uncertain').length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
