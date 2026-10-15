import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEventQuoteApi, EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF, type EventQuoteIdentity } from '../../src/office/backend/event-quote-http';
import { EventQuoteError, type EventQuoteService, type EventQuoteView, type QuoteActor, type QuoteScope } from '../../src/office/backend/event-quote-contracts';

const NOW = 1_792_000_000_000;
const ORIGIN = 'http://127.0.0.1:4188';
const headers = { host: '127.0.0.1:4188', origin: ORIGIN, cookie: 'existing-session=synthetic', [CSRF]: 'csrf-token-for-test-only' };
const scope: QuoteScope = { organizationId: 'test-org', workspaceId: 'test-space', mode: 'test' };
const actor: Omit<QuoteActor, 'expiresAtMs'> = { actorId: 'test-actor', durable: false, canWrite: true, canApprove: true };
function setup() {
  let identity: EventQuoteIdentity | null = { scope, actor, csrfToken: headers[CSRF], expiresAtMs: NOW + 60_000 };
  const calls: Array<{ operation: string; scope: QuoteScope; actor: QuoteActor; eventId?: string; command?: unknown }> = [];
  const html = '<!doctype html><p>Stored synthetic version 1</p><script>throw new Error("never run")</script>';
  const artifact = { mediaType: 'text/html; charset=utf-8' as const, html, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') };
  const view = { record: { scope, eventId: 'test-event', quotes: [{ version: 1, artifact }] }, currentQuoteStatus: 'pending_internal_review', externalEffectsEnabled: false } as EventQuoteView;
  const service: EventQuoteService = {
    async status(scope, actor) { calls.push({ operation: 'status', scope, actor }); return { enabled: false, reason: 'CATALOG_MISSING', catalog: null, catalogDigest: null }; },
    async read(scope, actor, eventId) { calls.push({ operation: 'read', scope, actor, eventId }); if (scope.workspaceId !== 'test-space') throw new EventQuoteError('UNAVAILABLE_PRIVATE_IDENTIFIER', 404); return view; },
    async execute(scope, actor, eventId, command) { calls.push({ operation: 'execute', scope, actor, eventId, command }); return view; },
  };
  const app = createEventQuoteApi({ service, allowedOrigin: ORIGIN, clock: () => NOW,
    resolveIdentity: request => request.headers.cookie === headers.cookie ? identity : null });
  return { app, calls, view, service, identity: (value: EventQuoteIdentity | null) => { identity = value; } };
}

test('quote API exposes only explicit authenticated composition with no session endpoint', async () => {
  const t = setup(); try {
    for (const path of ['/status', '/test-event', '/test-event/quotes/1/artifact']) {
      const denied = await t.app.inject({ url: API + path, headers: { host: headers.host } }); assert.equal(denied.statusCode, 401); assert.equal(denied.headers['cache-control'], 'no-store');
    }
    assert.equal(t.calls.length, 0);
    assert.equal((await t.app.inject({ method: 'POST', url: API + '/session', headers, payload: {} })).statusCode, 404);
    const result = await t.app.inject({ url: API + '/status', headers });
    assert.equal(result.statusCode, 200); assert.equal(result.json().enabled, false); assert.equal(result.json().session.csrfToken, headers[CSRF]); assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['access-control-allow-origin'], undefined); assert.equal(result.json().externalEffectsEnabled, false);
  } finally { await t.app.close(); }
});

test('quote API rejects expired, missing and nondurable commercial identities before service access', async () => {
  const t = setup(); try {
    for (const identity of [null, { scope, actor, csrfToken: headers[CSRF], expiresAtMs: NOW }, { scope: { ...scope, mode: 'commercial' as const }, actor, csrfToken: headers[CSRF], expiresAtMs: NOW + 1_000 }]) {
      t.identity(identity); assert.equal((await t.app.inject({ url: API + '/status', headers })).statusCode, 401);
    }
    assert.equal(t.calls.length, 0);
    t.identity({ scope: { ...scope, mode: 'commercial' }, actor: { ...actor, durable: true }, csrfToken: headers[CSRF], expiresAtMs: NOW + 1_000 });
    assert.equal((await t.app.inject({ url: API + '/status', headers })).statusCode, 200);
  } finally { await t.app.close(); }
});

test('quote writes require same origin, host, fetch-site, JSON and matching CSRF', async () => {
  const t = setup(); try {
    const invalidHeaders = [
      { ...headers, origin: undefined }, { ...headers, origin: 'https://elsewhere.invalid' }, { ...headers, host: 'elsewhere.invalid' },
      { ...headers, 'sec-fetch-site': 'cross-site' }, { ...headers, [CSRF]: undefined }, { ...headers, [CSRF]: 'another-session-csrf' },
    ];
    for (const invalid of invalidHeaders) {
      const r = await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers: Object.fromEntries(Object.entries(invalid).filter(([, value]) => value !== undefined)), payload: { action: 'create' } }); assert.equal(r.statusCode, 403, r.body);
    }
    assert.equal((await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
    assert.equal(t.calls.length, 0);
  } finally { await t.app.close(); }
});

test('server identity controls every read and write, and submitted scope or actor is rejected', async () => {
  const t = setup(); try {
    const spoofedHeaders = { ...headers, 'x-actor-id': 'owner', 'x-workspace-id': 'elsewhere', 'x-mode': 'commercial' };
    await t.app.inject({ url: API + '/test-event', headers: spoofedHeaders });
    await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers: spoofedHeaders, payload: { action: 'brief' } });
    assert.equal(t.calls.length, 2); for (const call of t.calls) { assert.deepEqual(call.scope, scope); assert.deepEqual(call.actor, { ...actor, expiresAtMs: NOW + 60_000 }); }
    for (const key of ['scope', 'actor', 'actorId', 'organizationId', 'workspaceId', 'mode', 'tenantId']) assert.equal((await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { action: 'create', [key]: 'spoof' } })).statusCode, 400);
    assert.equal((await t.app.inject({ url: API + '/test-event?workspaceId=elsewhere', headers })).statusCode, 400);
    assert.equal(t.calls.length, 2);
  } finally { await t.app.close(); }
});

test('write and approval capabilities are enforced before calling the workflow', async () => {
  const t = setup(); try {
    t.identity({ scope, actor: { ...actor, canWrite: false }, csrfToken: headers[CSRF], expiresAtMs: NOW + 60_000 });
    assert.equal((await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { action: 'create' } })).statusCode, 403);
    t.identity({ scope, actor: { ...actor, canApprove: false }, csrfToken: headers[CSRF], expiresAtMs: NOW + 60_000 });
    for (const action of ['approve', 'prepare_payment', 'prepare_payment_v2', 'configure_payment_v2', 'register_payment_draft_v2']) {
      assert.equal((await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { action } })).statusCode, 403, action);
    }
    assert.equal(t.calls.length, 0);
  } finally { await t.app.close(); }
});

test('payment draft commands request approval authorization before accessing the workflow', async () => {
  const t = setup();
  const targets: unknown[] = [];
  const app = createEventQuoteApi({ allowedOrigin: ORIGIN, clock: () => NOW,
    runAuthorized: async (_request, target, operation) => {
      targets.push(target);
      return operation({ scope, actor, csrfToken: headers[CSRF], expiresAtMs: NOW + 60_000 }, t.service);
    },
  });
  try {
    for (const action of ['configure_payment_v2', 'register_payment_draft_v2']) {
      const response = await app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { action } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(targets, [{ kind: 'approve', eventId: 'test-event' }, { kind: 'approve', eventId: 'test-event' }]);
    assert.equal(t.calls.length, 2);
  } finally { await app.close(); await t.app.close(); }
});

test('exact-version artifact GET is authenticated, scoped, read-only, no-store and sandboxed', async () => {
  const t = setup(); try {
    const result = await t.app.inject({ url: API + '/test-event/quotes/1/artifact', headers });
    assert.equal(result.statusCode, 200); assert.equal(result.body, t.view.record.quotes[0].artifact.html);
    assert.equal(result.headers['content-type'], 'text/html; charset=utf-8'); assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(String(result.headers['content-security-policy']), /default-src 'none'/); assert.match(String(result.headers['content-security-policy']), /sandbox/);
    assert.doesNotMatch(String(result.headers['content-security-policy']), /allow-scripts|allow-same-origin/);
    assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
    for (const version of ['2', '0', '01', 'latest']) assert.equal((await t.app.inject({ url: API + `/test-event/quotes/${version}/artifact`, headers })).statusCode, 404);
    t.identity({ scope: { ...scope, workspaceId: 'other-test-space' }, actor, csrfToken: headers[CSRF], expiresAtMs: NOW + 60_000 });
    const crossScope = await t.app.inject({ url: API + '/test-event/quotes/1/artifact', headers }); assert.equal(crossScope.statusCode, 404); assert.deepEqual(crossScope.json(), { error: 'NOT_FOUND' });
    assert(t.calls.every(call => call.operation === 'read'));
  } finally { await t.app.close(); }
});

test('corrupted artifacts and dependency messages are never returned', async () => {
  const t = setup(); try {
    t.view.record.quotes[0].artifact.html += 'tampered';
    const corrupt = await t.app.inject({ url: API + '/test-event/quotes/1/artifact', headers }); assert.equal(corrupt.statusCode, 503); assert.deepEqual(corrupt.json(), { error: 'SERVICE_UNAVAILABLE' });
    t.service.status = async () => { throw new Error('postgres password=private host=private'); };
    const failed = await t.app.inject({ url: API + '/status', headers }); assert.equal(failed.statusCode, 503); assert.doesNotMatch(failed.body, /postgres|password|private/);
    t.service.execute = async () => { throw new EventQuoteError('CONTAINS_PRIVATE_RECIPIENT', 409); };
    const conflict = await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { action: 'brief' } }); assert.deepEqual(conflict.json(), { error: 'REVISION_CONFLICT' });
  } finally { await t.app.close(); }
});

test('malformed JSON, excessive bodies and invalid artifact identities fail closed', async () => {
  const t = setup(); try {
    const malformed = await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"secret"' });
    assert.equal(malformed.statusCode, 400); assert.doesNotMatch(malformed.body, /secret/);
    assert.equal((await t.app.inject({ method: 'POST', url: API + '/test-event/commands', headers, payload: { value: 'a'.repeat(70_000) } })).statusCode, 413);
    assert.equal((await t.app.inject({ url: API + '/constructor/quotes/1/artifact', headers })).statusCode, 400);
    assert.equal(t.calls.length, 0);
  } finally { await t.app.close(); }
});

test('composed HTTP and real workflow persist manual intake, catalogue quote, exact approval and obsolescence', async () => {
  const { TEST_AT, testScope, testActor, testBrief, testService } = await import('./event-quote-fixtures');
  const t = testService(); let selectedScope = testScope;
  const app = createEventQuoteApi({ service: t.service, allowedOrigin: ORIGIN, clock: () => TEST_AT,
    resolveIdentity: () => ({ scope: selectedScope, actor: testActor, csrfToken: headers[CSRF], expiresAtMs: TEST_AT + 60_000 }) });
  const command = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: API + '/HTTP-EVENT/commands', headers, payload });
  try {
    const status = (await app.inject({ url: API + '/status', headers })).json();
    assert.equal(status.enabled, true);
    const create = { action: 'create', key: 'http-create', expectedRevision: 0, brief: testBrief };
    const created = await command(create); assert.equal(created.statusCode, 200, created.body);
    const quoted = await command({ action: 'quote', key: 'http-quote', expectedRevision: 1, expectedBriefDigest: created.json().record.briefs[0].digest, expectedCatalogDigest: status.catalogDigest, selections: [{ itemId: 'TEST-ITEM', quantity: 24 }] });
    assert.equal(quoted.statusCode, 200, quoted.body); const quote = quoted.json().record.quotes[0];
    const approve = { action: 'approve', key: 'http-approve', expectedRevision: 2, quoteVersion: 1, quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256, intendedRecipient: testBrief.recipient };
    const approved = await command(approve); assert.equal(approved.statusCode, 200, approved.body); assert.equal(approved.json().currentQuoteStatus, 'approved_internal_unsent');
    assert.deepEqual((await command(approve)).json(), approved.json(), 'an exact repeated command does not create a second decision');
    const artifact = await app.inject({ url: API + '/HTTP-EVENT/quotes/1/artifact', headers }); assert.equal(artifact.statusCode, 200); assert.equal(artifact.body, quote.artifact.html);
    assert.equal((await app.inject({ url: API + '/HTTP-EVENT', headers })).json().record.revision, 3);
    const edited = await command({ action: 'brief', key: 'http-edit', expectedRevision: 3, brief: { ...testBrief, attendees: 25 } });
    assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().currentQuoteStatus, 'obsolete');
    assert.equal((await command({ ...approve, key: 'http-stale', expectedRevision: 4 })).statusCode, 409);
    assert.equal((await app.inject({ url: API + '/HTTP-EVENT/quotes/1/artifact', headers })).body, artifact.body, 'historical artifact bytes remain exact');
    selectedScope = { ...testScope, workspaceId: 'OTHER-TEST-WORKSPACE' };
    assert.equal((await app.inject({ url: API + '/HTTP-EVENT', headers })).statusCode, 404);
    assert.equal((await app.inject({ url: API + '/HTTP-EVENT/quotes/1/artifact', headers })).statusCode, 404);
  } finally { await app.close(); }
});
