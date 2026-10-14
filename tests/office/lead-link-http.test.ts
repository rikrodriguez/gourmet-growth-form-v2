import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { createLeadLinkApi, registerLeadLinkRoutes, LEAD_LINK_API as API, LeadLinkHttpError, type LeadLinkIdentity, type LeadLinkReadSource } from '../../src/office/backend/lead-link-http';
import { validateLeadLinkResponse, type LeadLinkResponse, type LeadLinkResponseScope } from '../../src/office/lead-link-response';
import type { LeadLinkView, VerifiedLeadAgreement } from '../../src/office/lead-link-view-contracts';

const NOW = Date.parse('2026-10-13T20:10:00Z');
const ORIGIN = 'https://office.invalid';
const headers = { host: 'office.invalid', origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: 'existing-session=synthetic' };
const scope: LeadLinkResponseScope = { organizationId: 'test-org', workspaceId: 'test-workspace', mode: 'test' };
function fixture(): { history: LeadLinkView; agreement: VerifiedLeadAgreement } {
  return {
    history: { leadId: 'test-lead', links: [{ opening: null, category: 'calculator', status: 'historical', accountId: 'synthetic-account', boardId: '200', itemId: '300',
      columnId: 'text_mm1kdqqb', updateId: null, observedAt: '2026-10-13T20:00:00Z', changedAt: null,
      campaignLabel: 'Otoño sintético', recordedGuests: 50, evidenceKind: 'column_snapshot', attributionIndicators: ['utm', 'google_click_id'] }] },
    agreement: { leadId: 'test-lead', guests: 45, menu: 'Menú verificado sintético', amountLabel: 'USD 900', verifiedAt: '2026-10-13T20:05:00Z', evidenceLabel: 'Conversación verificada sintética' },
  };
}
function authenticated(): LeadLinkIdentity {
  return { identityKey: 'synthetic-opaque-session-key', durableIdentity: false, scope: { ...scope }, expiresAtMs: NOW + 60_000,
    canRead: true, leadIds: ['test-lead'] };
}
function setup() {
  let identity: LeadLinkIdentity | null = authenticated();
  let now = NOW;
  const data = fixture();
  const calls: { scope: Readonly<LeadLinkResponseScope>; leadId: string }[] = [];
  let resolveCount = 0;
  const source: LeadLinkReadSource = { async read(requestScope, leadId) { calls.push({ scope: requestScope, leadId }); return data; } };
  const app = createLeadLinkApi({ allowedOrigin: ORIGIN, source, clock: () => now,
    resolveIdentity: request => { resolveCount++; return request.headers.cookie === headers.cookie ? identity : null; } });
  return { app, data, source, calls, identity: (value: LeadLinkIdentity | null) => { identity = value; }, now: (value: number) => { now = value; }, resolves: () => resolveCount };
}
function assertProtected(response: { headers: Record<string, unknown> }) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.pragma, 'no-cache');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}
function expectedResponse(): LeadLinkResponse { return { identityKey: authenticated().identityKey, scope, leadId: 'test-lead', ...fixture(), openingSession:{canOpen:false,csrfToken:null,expiresAtMs:NOW+60_000} }; }

test('exact-lead read uses existing authentication and returns only the closed read-only projection', async () => {
  const t = setup();
  try {
    const result = await t.app.inject({ url: API + '/test-lead', headers });
    assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json(), expectedResponse()); assertProtected(result);
    assert.deepEqual(t.calls, [{ scope, leadId: 'test-lead' }]);
    assert.equal(result.json().history.links[0].recordedGuests, 50); assert.equal(result.json().agreement.guests, 45);
    assert.doesNotMatch(result.body, /https?:|originalUrl|sourceUrl|externalSessionId|canWrite|cookie|leadIds/);
    t.data.agreement = null as unknown as VerifiedLeadAgreement;
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers })).json().agreement, null);
  } finally { await t.app.close(); }
});

test('no public listing, grants, session, HEAD, writes or nested provider-url endpoint exists', async () => {
  const t = setup();
  try {
    for (const url of [API, API + '/', API + '/test-lead/url', API + '/test-lead/history']) {
      const response = await t.app.inject({ url, headers });
      assert.equal(response.statusCode, 404, response.body); assert.deepEqual(response.json(), { error: 'NOT_FOUND' }); assertProtected(response);
    }
    for (const id of ['status', 'session', 'grant', 'grants']) assert.equal((await t.app.inject({ url: API + '/' + id, headers })).statusCode, 400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
      const response = await t.app.inject({ method, url: API + '/test-lead', headers });
      assert.equal(response.statusCode, 404, response.body); assertProtected(response);
      if (method !== 'HEAD') assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
    }
    assert.equal(t.calls.length, 0); assert.equal(t.resolves(), 0);
  } finally { await t.app.close(); }
});

test('missing, expired, malformed and nondurable commercial identities fail before reading', async () => {
  const t = setup();
  try {
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers: { host: headers.host } })).statusCode, 401);
    for (const invalid of [null, { ...authenticated(), expiresAtMs: NOW }, { ...authenticated(), expiresAtMs: NaN },
      { ...authenticated(), identityKey: 'https://private.invalid/session' }, { ...authenticated(), durableIdentity: undefined },
      { ...authenticated(), leadIds: Array.from({ length: 1_001 }, (_, index) => 'lead-' + index) },
      { ...authenticated(), canRead: 'yes' }, { ...authenticated(), leadIds: ['*'] }, { ...authenticated(), leadIds: [7] },
      { ...authenticated(), scope: { ...scope, workspaceId: '' } }, { ...authenticated(), scope: { ...scope, mode: 'fake' } },
      { ...authenticated(), scope: { ...scope, mode: 'commercial' } }]) {
      t.identity(invalid as LeadLinkIdentity | null);
      const response = await t.app.inject({ url: API + '/test-lead', headers });
      assert.equal(response.statusCode, 401, response.body); assert.deepEqual(response.json(), { error: 'AUTHENTICATION_REQUIRED' }); assertProtected(response);
    }
    assert.equal(t.calls.length, 0);
    t.identity({ ...authenticated(), durableIdentity: true, scope: { ...scope, mode: 'commercial' } });
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers })).statusCode, 200);
    assert.equal(t.calls[0].scope.mode, 'commercial');
  } finally { await t.app.close(); }
});

test('canRead and exact authorized lead IDs reject guessed leads without consulting the source', async () => {
  const t = setup();
  try {
    t.identity({ ...authenticated(), canRead: false });
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers })).statusCode, 403);
    t.identity(authenticated());
    for (const leadId of ['other-lead', 'test-lead-child', 'TEST-LEAD']) {
      const response = await t.app.inject({ url: API + '/' + leadId, headers });
      assert.equal(response.statusCode, 404); assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
    }
    t.identity({ ...authenticated(), leadIds: [] });
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers })).statusCode, 404);
    assert.equal(t.calls.length, 0);
  } finally { await t.app.close(); }
});

test('query strings and incompatible Host, Origin and fetch-site never reach identity or source', async () => {
  const t = setup();
  try {
    for (const invalidHeaders of [{ ...headers, host: 'evil.invalid' }, { ...headers, host: 'office.invalid:443' },
      { ...headers, origin: 'https://evil.invalid' }, { ...headers, origin: 'null' },
      { ...headers, 'sec-fetch-site': 'cross-site' }, { ...headers, 'sec-fetch-site': 'same-site' }, { ...headers, 'sec-fetch-site': 'unknown' }]) {
      const response = await t.app.inject({ url: API + '/test-lead', headers: invalidHeaders });
      assert.equal(response.statusCode, 403); assertProtected(response);
    }
    for (const query of ['?leadId=test-lead', '?identityKey=stolen', '?organizationId=other', '?workspaceId=other', '?mode=commercial']) {
      const response = await t.app.inject({ url: API + '/test-lead' + query, headers });
      assert.equal(response.statusCode, 400, query); assert.deepEqual(response.json(), { error: 'INVALID_REQUEST' }); assertProtected(response);
    }
    for (const id of ['constructor', 'prototype', '__proto__', '%2F', 'lead%20id', 'a'.repeat(97)]) assert.equal((await t.app.inject({ url: API + '/' + id, headers })).statusCode, 400);
    assert.equal(t.calls.length, 0); assert.equal(t.resolves(), 0);
  } finally { await t.app.close(); }
});

test('even an empty raw query delimiter is rejected', async () => {
  const app = Fastify({ logger: false }); let resolves = 0;
  // light-my-request normalizes away a trailing ?. Recreate the raw HTTP request target before the route hooks.
  app.addHook('onRequest', async request => { request.raw.url += '?'; });
  registerLeadLinkRoutes(app, { allowedOrigin: ORIGIN, clock: () => NOW,
    resolveIdentity: () => { resolves++; return authenticated(); }, source: { async read() { return fixture(); } } });
  try {
    const response = await app.inject({ url: API + '/test-lead', headers });
    assert.equal(response.statusCode, 400); assert.equal(resolves, 0);
  } finally { await app.close(); }
});

test('fabricated identity and tenant headers cannot override server identity or scope', async () => {
  const t = setup();
  try {
    const response = await t.app.inject({ url: API + '/test-lead', headers: { ...headers,
      'x-identity-key': 'other-identity', 'x-organization-id': 'other-org', 'x-workspace-id': 'other-workspace',
      'x-tenant-id': 'other-tenant', 'x-mode': 'commercial', 'x-lead-id': 'other-lead', 'x-can-read': 'true',
      'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'http' } });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), expectedResponse()); assert.deepEqual(t.calls[0].scope, scope);
    const unauthorized = await t.app.inject({ url: API + '/test-lead', headers: { host: headers.host, 'x-identity-key': authenticated().identityKey, 'x-can-read': 'true' } });
    assert.equal(unauthorized.statusCode, 401); assert.equal(t.calls.length, 1);
  } finally { await t.app.close(); }
});

test('identity scope is copied and frozen before I/O and expiration is rechecked after I/O', async () => {
  const t = setup();
  const identity = authenticated(); t.identity(identity);
  try {
    t.source.read = async requestScope => {
      assert.notEqual(requestScope, identity.scope); assert.equal(Object.isFrozen(requestScope), true);
      identity.scope.organizationId = 'mutated-org'; identity.scope.workspaceId = 'mutated-workspace'; identity.scope.mode = 'commercial';
      identity.identityKey = 'mutated-identity';
      await Promise.resolve();
      return t.data;
    };
    const result = await t.app.inject({ url: API + '/test-lead', headers });
    assert.equal(result.statusCode, 401); assert.deepEqual(result.json(), { error: 'AUTHENTICATION_REQUIRED' });
    t.identity(authenticated());
    t.source.read = async () => { t.now(NOW + 60_000); return t.data; };
    const expired = await t.app.inject({ url: API + '/test-lead', headers });
    assert.equal(expired.statusCode, 401); assert.deepEqual(expired.json(), { error: 'AUTHENTICATION_REQUIRED' }); assertProtected(expired);
  } finally { await t.app.close(); }
});

test('logout, revoked capability and grant, or changed identity and tenant while source I/O is pending deny the response', async () => {
  const t = setup();
  try {
    for (const [changed, status] of [
      [null, 401], [{ ...authenticated(), canRead: false }, 403], [{ ...authenticated(), leadIds: [] }, 404],
      [{ ...authenticated(), identityKey: 'new-identity' }, 401], [{ ...authenticated(), durableIdentity: true }, 401],
      [{ ...authenticated(), scope: { ...scope, organizationId: 'different-org' } }, 401],
      [{ ...authenticated(), scope: { ...scope, workspaceId: 'different-workspace' } }, 401],
      [{ ...authenticated(), durableIdentity: true, scope: { ...scope, mode: 'commercial' } }, 401],
    ] as const) {
      t.identity(authenticated());
      t.source.read = async () => { await Promise.resolve(); t.identity(changed); return t.data; };
      const response = await t.app.inject({ url: API + '/test-lead', headers });
      assert.equal(response.statusCode, status); assertProtected(response);
      assert.doesNotMatch(response.body, /recordedGuests|history|test-lead|synthetic-account/);
    }
  } finally { await t.app.close(); }
});

test('expiry of the original lease during the final authentication check is still enforced', async () => {
  let now = NOW; let resolutions = 0;
  const app = createLeadLinkApi({ allowedOrigin: ORIGIN, clock: () => now, source: { async read() { return fixture(); } },
    resolveIdentity: async () => {
      resolutions++;
      if (resolutions === 2) { now = NOW + 60_000; return { ...authenticated(), expiresAtMs: NOW + 120_000 }; }
      return authenticated();
    } });
  try {
    const response = await app.inject({ url: API + '/test-lead', headers });
    assert.equal(response.statusCode, 401); assert.equal(resolutions, 2);
  } finally { await app.close(); }
});

test('a source cannot extend the captured lease while read is pending', async () => {
  const t = setup(); const identity = authenticated(); t.identity(identity);
  try {
    t.source.read = async () => { identity.expiresAtMs = NOW + 600_000; t.now(NOW + 60_000); return t.data; };
    assert.equal((await t.app.inject({ url: API + '/test-lead', headers })).statusCode, 401);
  } finally { await t.app.close(); }
});

test('identity expiration while asynchronous authentication resolves is rejected', async () => {
  let now = NOW;
  let reads = 0;
  const app = createLeadLinkApi({ allowedOrigin: ORIGIN, clock: () => now,
    resolveIdentity: async () => { now = NOW + 60_000; return authenticated(); },
    source: { async read() { reads++; return fixture(); } } });
  try { assert.equal((await app.inject({ url: API + '/test-lead', headers })).statusCode, 401); assert.equal(reads, 0); }
  finally { await app.close(); }
});

test('server-selected organizations, workspaces and modes remain distinct source reads', async () => {
  const t = setup();
  try {
    for (const selected of [scope, { ...scope, organizationId: 'other-org' }, { ...scope, workspaceId: 'other-workspace' }, { ...scope, mode: 'commercial' as const }]) {
      t.identity({ ...authenticated(), durableIdentity: true, scope: selected });
      const response = await t.app.inject({ url: API + '/test-lead', headers });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json().scope, selected);
    }
    assert.equal(new Set(t.calls.map(call => JSON.stringify(call.scope))).size, 4);
  } finally { await t.app.close(); }
});

test('foreign-lead history or agreement and all source errors fail closed without sensitive error details', async () => {
  const t = setup();
  try {
    for (const data of [{ ...fixture(), history: { ...fixture().history, leadId: 'foreign-lead' } },
      { ...fixture(), agreement: { ...fixture().agreement, leadId: 'foreign-lead' } },
      { ...fixture(), history: { ...fixture().history, originalUrl: 'https://provider.invalid/private?token=SECRET' } },
      { ...fixture(), agreement: { ...fixture().agreement, menu: 'https://provider.invalid/private?token=SECRET' } }]) {
      t.source.read = async () => data;
      const response = await t.app.inject({ url: API + '/test-lead', headers });
      assert.equal(response.statusCode, 503); assert.deepEqual(response.json(), { error: 'SERVICE_UNAVAILABLE' }); assertProtected(response);
      assert.doesNotMatch(response.body, /foreign|provider|token|SECRET/);
    }
    for (const error of [new Error('password=PRIVATE https://provider.invalid/path'), Object.assign(new Error('PRIVATE'), { statusCode: 404 })]) {
      t.source.read = async () => { throw error; };
      const response = await t.app.inject({ url: API + '/test-lead', headers });
      assert.equal(response.statusCode, 503); assert.deepEqual(response.json(), { error: 'SERVICE_UNAVAILABLE' });
    }
    t.source.read = async () => { throw new LeadLinkHttpError(404); };
    const missing = await t.app.inject({ url: API + '/test-lead', headers });
    assert.equal(missing.statusCode, 404); assert.deepEqual(missing.json(), { error: 'NOT_FOUND' });
  } finally { await t.app.close(); }
});

test('response validator reconstructs safe copies and rejects malformed fields, extensions and provenance', () => {
  const input = expectedResponse(); const parsed = validateLeadLinkResponse(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input); assert.notEqual(parsed.scope, input.scope);
  assert.notEqual(parsed.history, input.history); assert.notEqual(parsed.history.links[0], input.history.links[0]); assert.notEqual(parsed.agreement, input.agreement);
  assert.notEqual(parsed.history.links[0].attributionIndicators, input.history.links[0].attributionIndicators);
  const malformed: unknown[] = [null, [], { ...input, providerUrl: 'https://provider.invalid' }, { ...input, identityKey: '' },
    { ...input, scope: { ...scope, tenantId: 'other' } }, { ...input, scope: { ...scope, mode: 'demo' } },
    { ...input, agreement: { ...input.agreement, guests: 1.5 } }, { ...input, agreement: { ...input.agreement, verifiedAt: '2026-02-30T20:00:00Z' } },
    { ...input, history: { ...input.history, links: new Array(1) } }];
  for (const patch of [{ category: 'arbitrary' }, { status: 'visited' }, { accountId: 'https://provider.invalid' }, { itemId: 300 },
    { observedAt: '2026-02-30T20:00:00Z' }, { changedAt: 'yesterday' }, { recordedGuests: -1 }, { recordedGuests: 1.5 }, { recordedGuests: 100_000 },
    { campaignLabel: 'https://provider.invalid/private?name=secret' }, { campaignLabel: 'token=x&name=secret' },
    { attributionIndicators: ['utm', 'utm'] }, { attributionIndicators: ['gclid=secret'] }, { attributionIndicators: ['utm', 'google_click_id', 'google_campaign_id', 'utm'] },
    { columnId: null }, { updateId: 'update' }, { evidenceKind: 'initial_request_snapshot' }, { category: 'update_link' },
    { status: 'quarantined' }, { status: 'missing' }, { originalUrl: 'https://provider.invalid' }]) {
    malformed.push({ ...input, history: { ...input.history, links: [{ ...input.history.links[0], ...patch }] } });
  }
  for (const value of malformed) assert.throws(() => validateLeadLinkResponse(value), /^Error: Invalid lead link response$/);
  let getterCalls = 0;
  const accessor = { ...input }; Object.defineProperty(accessor, 'identityKey', { enumerable: true, get() { getterCalls++; return 'key'; } });
  assert.throws(() => validateLeadLinkResponse(accessor)); assert.equal(getterCalls, 0);
  const update = { ...input.history.links[0], category: 'update_link', columnId: null, updateId: '444', evidenceKind: 'historical_update_link' };
  assert.throws(() => validateLeadLinkResponse({ ...input, history: { ...input.history, links: [update] } }));
  assert.equal(validateLeadLinkResponse({ ...input, history: { ...input.history, links: [{ ...update, recordedGuests: null }] } }).history.links[0].recordedGuests, null);
});

test('route remains opt-in and absent from the demo, staging and general HTTP composition', async () => {
  for (const path of ['src/office/backend/server.ts', 'src/office/backend/staging-server.ts', 'src/office/backend/staging-app.ts', 'src/office/backend/http.ts']) {
    const content = await readFile(new URL('../../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /registerLeadLinkRoutes|createLeadLinkApi|lead-link-http/);
  }
});

test('framework-level malformed URL failures and GET bodies are static and do not reach authentication', async () => {
  const t = setup();
  try {
    for (const suffix of ['%ZZ', '%E0%A4%A', 'SECRET_PRIVATE' + 'a'.repeat(256)]) {
      const response = await t.app.inject({ url: API + '/' + suffix, headers });
      assert.equal(response.statusCode, 400); assert.deepEqual(response.json(), { error: 'INVALID_REQUEST' }); assertProtected(response);
      assert.doesNotMatch(response.body, /SECRET_PRIVATE|%ZZ|%E0/);
    }
    const body = await t.app.inject({ url: API + '/test-lead', method: 'GET', headers, payload: { identityKey: 'PRIVATE', organizationId: 'other' } });
    assert.equal(body.statusCode, 400); assert.deepEqual(body.json(), { error: 'INVALID_REQUEST' }); assertProtected(body);
    assert.equal(t.resolves(), 0); assert.equal(t.calls.length, 0);
  } finally { await t.app.close(); }
});

test('configuration rejects noncanonical or non-HTTP origins', () => {
  for (const allowedOrigin of ['https://office.invalid/', 'https://office.invalid/path', 'https://user:pass@office.invalid', 'file:///tmp']) {
    assert.throws(() => createLeadLinkApi({ allowedOrigin, resolveIdentity: () => authenticated(), source: { async read() { return fixture(); } } }));
  }
});

test('opening capability and CSRF are projected only from the existing authenticated session',async()=>{
 const t=setup();t.data.history.links[0].opening={referenceId:'synthetic-reference',revision:'synthetic-revision'};
 try{
  const closed=await t.app.inject({url:API+'/test-lead',headers});assert.equal(closed.statusCode,200);assert.equal(closed.json().history.links[0].opening,null);assert.equal(closed.json().openingSession.csrfToken,null);
  t.identity({...authenticated(),canOpen:true,csrfToken:'synthetic_session_open_csrf'});
  const enabled=await t.app.inject({url:API+'/test-lead',headers});assert.equal(enabled.statusCode,200);assert.deepEqual(enabled.json().history.links[0].opening,{referenceId:'synthetic-reference',revision:'synthetic-revision'});assert.equal(enabled.json().openingSession.csrfToken,'synthetic_session_open_csrf');
  assert.doesNotMatch(enabled.body,/https:\/\/|originalUrl|signature=/);
 }finally{await t.app.close();}
});
test('withdrawing opening permission or rotating CSRF during a read denies stale opening data',async()=>{
 for(const updated of [{...authenticated(),canOpen:false},{...authenticated(),canOpen:true,csrfToken:'synthetic_other_session_csrf'}]){
  const t=setup();t.identity({...authenticated(),canOpen:true,csrfToken:'synthetic_session_open_csrf'});
  t.source.read=async()=>{t.identity(updated);return t.data;};
  try{const result=await t.app.inject({url:API+'/test-lead',headers});assert.equal(result.statusCode,401);assert.doesNotMatch(result.body,/csrf|synthetic_session/);}finally{await t.app.close();}
 }
});
test('wire contract rejects raw opening URLs, unsupported category controls and inconsistent opening sessions',()=>{
 const base=expectedResponse();
 for(const patch of [{openingSession:{canOpen:false,csrfToken:'synthetic_should_not_expose',expiresAtMs:NOW+60000}},{openingSession:{canOpen:true,csrfToken:null,expiresAtMs:NOW+60000}},{openingSession:{canOpen:true,csrfToken:'synthetic_open_csrf',expiresAtMs:0}}])assert.throws(()=>validateLeadLinkResponse({...base,...patch}));
 const valid={...base,openingSession:{canOpen:true,csrfToken:'synthetic_open_csrf',expiresAtMs:NOW+60000}};
 for(const opening of [{referenceId:'r',revision:'v',url:'https://private.invalid'},{referenceId:'https://private.invalid',revision:'v'}])assert.throws(()=>validateLeadLinkResponse({...valid,history:{...base.history,links:[{...base.history.links[0],opening}]}}));
 assert.throws(()=>validateLeadLinkResponse({...valid,history:{...base.history,links:[{...base.history.links[0],category:'landing_attribution',opening:{referenceId:'r',revision:'v'}}]}}));
});
