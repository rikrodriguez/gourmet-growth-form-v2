import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify, { LogController } from 'fastify';
import { normalizeHistoricalLink, type HistoricalLink } from '../../src/office/backend/lead-link-history';
import { createLeadLinkOpenApi, registerLeadLinkOpenRoutes, leadLinkOpenFrameworkErrors, validateLeadLinkDestination,
  LEAD_LINK_OPEN_API as API, REVIEWED_LEAD_LINK_DESTINATIONS, type LeadLinkOpenIdentity, type LeadLinkOpenRecord,
  type LeadLinkAllowedDestination, type LeadLinkOpeningSource } from '../../src/office/backend/lead-link-opening';

const NOW = Date.parse('2026-10-13T20:10:00Z');
const ORIGIN = 'https://office.invalid';
const TOKEN = 'synthetic-csrf-token-for-session-a';
const scope = { organizationId: 'test-org', workspaceId: 'test-workspace', mode: 'test' as const };
const binding = { accountId: 'synthetic-account', boardId: '200', itemId: '300' };
const provenance = { ...binding, columnId: 'text_mm1kdqqb', updateId: null, observedAt: '2026-10-13T20:00:00Z', changedAt: null, originalValueType: 'text' };
const ORIGINAL = 'https://monday.gourmet-corporation.com/?signature=z%2F%2Ba&guests=50&itemId=300&boardId=200&name=PRIVATE_SYNTHETIC_NAME&signature=second&sourceUrl=https%3A%2F%2Fattribution.invalid%2F%3Futm_campaign%3Dsynthetic';
const headers = { host: 'office.invalid', origin: ORIGIN, cookie: 'existing-session=synthetic',
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1',
  'content-type': 'application/x-www-form-urlencoded' };
function identity(): LeadLinkOpenIdentity {
  return { identityKey: 'synthetic-session-a', scope: { ...scope }, durableIdentity: false, expiresAtMs: NOW + 60_000,
    canRead: true, canOpen: true, leadIds: ['test-lead'], csrfToken: TOKEN };
}
function record(originalUrl = ORIGINAL, columnId = provenance.columnId): LeadLinkOpenRecord {
  return { scope: { ...scope }, leadId: 'test-lead', referenceId: 'ref-a', revision: 'revision-a', sourceBinding: { ...binding },
    link: normalizeHistoricalLink({ provenance: { ...provenance, columnId }, originalUrl }) };
}
const form = { identityKey: identity().identityKey, leadId: 'test-lead', referenceId: 'ref-a', revision: 'revision-a', csrfToken: TOKEN };
const encode = (fields: Record<string, string> = form) => new URLSearchParams(fields).toString();
function setup(allowedDestinations: readonly LeadLinkAllowedDestination[] = REVIEWED_LEAD_LINK_DESTINATIONS) {
  let current: LeadLinkOpenIdentity | null = identity(); let now = NOW; let resolves = 0;
  const data = record(); const reads: { scope: unknown; leadId: string; referenceId: string }[] = [];
  const source: LeadLinkOpeningSource = { async read(selected, leadId, referenceId) { reads.push({ scope: selected, leadId, referenceId }); return data; } };
  const dependencies = { allowedOrigin: ORIGIN, allowedDestinations, source, clock: () => now,
    resolveIdentity: () => { resolves++; return current; } };
  const app = createLeadLinkOpenApi(dependencies);
  const open = (overrides: Record<string, string> = {}, requestHeaders = headers) => app.inject({ method: 'POST', url: API, headers: requestHeaders, payload: encode({ ...form, ...overrides }) });
  return { app, open, data, source, dependencies, reads, resolves: () => resolves, identity: (value: LeadLinkOpenIdentity | null) => { current = value; }, now: (value: number) => { now = value; } };
}
function protectedResponse(response: { headers: Record<string, unknown> }) {
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}
function closedResponse(response: { statusCode: number; body: string; headers: Record<string, unknown> }, status: number) {
  assert.equal(response.statusCode, status, response.body); protectedResponse(response);
  assert.equal(response.headers.location, undefined);
  assert.doesNotMatch(response.body, /PRIVATE|gourmet|signature|sourceUrl|attribution|test-lead|revision-a|synthetic-account/);
}

test('explicit native form returns one 303 with original URL bytes, no response body and no outbound fetch', async () => {
  const t = setup(); const fetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('Outbound requests forbidden'); };
  try {
    const response = await t.open();
    assert.equal(response.statusCode, 303, response.body); assert.equal(response.headers.location, ORIGINAL); assert.equal(response.body, ''); protectedResponse(response);
    assert.equal(fetchCalls, 0); assert.equal(t.reads.length, 2); assert.equal(t.resolves(), 3);
    assert.deepEqual(t.reads, Array(2).fill({ scope, leadId: form.leadId, referenceId: form.referenceId }));
    assert.equal(t.data.link.outer!.originalUrl, ORIGINAL);
  } finally { globalThis.fetch = fetch; await t.app.close(); }
});

test('Origin null only works with valid session CSRF and the complete same-origin user navigation metadata', async () => {
  const t = setup();
  try {
    const response = await t.open({}, { ...headers, origin: 'null' });
    assert.equal(response.statusCode, 303); assert.equal(response.headers.location, ORIGINAL);
    closedResponse(await t.open({ csrfToken: 'incorrect-token-for-session' }, { ...headers, origin: 'null' }), 403);
    for (const key of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      const changed = { ...headers, origin: 'null' } as Record<string, string>; delete changed[key];
      closedResponse(await t.open({}, changed as typeof headers), 403);
    }
    assert.equal(t.reads.length, 2);
  } finally { await t.app.close(); }
});

test('GET, HEAD, OPTIONS, PUT and DELETE cannot open and no subroutes expose provider links', async () => {
  const t = setup();
  try {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'] as const) {
      closedResponse(await t.app.inject({ method, url: API, headers }), 404);
    }
    for (const path of [API + '/', API + '/test-lead', API + '/session', API + '/url']) closedResponse(await t.app.inject({ method: 'POST', url: path, headers, payload: encode() }), 404);
    assert.equal(t.reads.length, 0); assert.equal(t.resolves(), 0);
  } finally { await t.app.close(); }
});

test('missing and changed fetch metadata, host, origin and query strings fail before source access', async () => {
  const t = setup();
  try {
    for (const changes of [{ host: 'evil.invalid' }, { host: 'office.invalid:443' }, { origin: 'https://evil.invalid' },
      { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-user': '?0' }]) {
      closedResponse(await t.open({}, { ...headers, ...changes }), 403);
    }
    closedResponse(await t.app.inject({ method: 'POST', url: API + '?leadId=test-lead', headers, payload: encode() }), 400);
    assert.equal(t.resolves(), 0); assert.equal(t.reads.length, 0);
  } finally { await t.app.close(); }
});

test('closed urlencoded parser rejects missing, duplicate, extra, malformed and caller-selected destination data', async () => {
  const t = setup();
  try {
    const bodies = ['', 'leadId=test-lead', encode() + '&', encode() + '&leadId=test-lead', encode() + '&%6ceadId=foreign',
      encode() + '&url=https%3A%2F%2Fevil.invalid', encode() + '&host=evil.invalid', encode() + '&destination=evil',
      encode() + '&scope=foreign', encode() + '&organizationId=foreign', encode() + '&workspaceId=foreign', encode() + '&mode=commercial',
      encode() + '&__proto__=evil', encode() + '&invalid=%zz', encode().replace('revision-a', '%E0%A4%A'),
      encode().replace('ref-a', '%0D%0APRIVATE'), encode().replace('revision-a', 'rev=second'), encode().replace('test-lead', 'lead+with+spaces')];
    for (const body of bodies) closedResponse(await t.app.inject({ method: 'POST', url: API, headers, payload: body }), 400);
    for (const contentType of ['application/json', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded; charset=ISO-8859-1']) {
      closedResponse(await t.open({}, { ...headers, 'content-type': contentType }), 415);
    }
    closedResponse(await t.app.inject({ method: 'POST', url: API, headers, payload: encode() + 'x'.repeat(2_049) }), 413);
    assert.equal(t.reads.length, 0); assert.equal(t.resolves(), 0);
    assert.equal((await t.open({}, { ...headers, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' })).statusCode, 303);
  } finally { await t.app.close(); }
});

test('authentication, read/open capabilities, exact lead access and session-bound CSRF are required', async () => {
  const t = setup();
  try {
    for (const [selected, status] of [[null, 401], [{ ...identity(), expiresAtMs: NOW }, 401],
      [{ ...identity(), canRead: false }, 403], [{ ...identity(), canOpen: false }, 403], [{ ...identity(), leadIds: ['another-lead'] }, 404],
      [{ ...identity(), csrfToken: 'rotated-token-for-session' }, 403], [{ ...identity(), identityKey: 'new-session-same-csrf' }, 401],
      [{ ...identity(), scope: { ...scope, mode: 'commercial' } }, 401]] as const) {
      t.identity(selected); closedResponse(await t.open(), status);
    }
    t.identity(identity()); closedResponse(await t.open({ csrfToken: 'forged-token-for-session' }), 403);
    closedResponse(await t.open({ identityKey: 'old-session-same-csrf' }), 401);
    closedResponse(await t.open({ leadId: 'test-lead-other' }), 404);
    assert.equal(t.reads.length, 0);
  } finally { await t.app.close(); }
});

test('caller identity and tenant headers never replace trusted session fields', async () => {
  const t = setup();
  try {
    const response = await t.open({}, { ...headers, 'x-workspace-id': 'other', 'x-organization-id': 'other', 'x-identity-key': 'other', 'x-can-open': 'true' } as typeof headers);
    assert.equal(response.statusCode, 303); assert.deepEqual(t.reads[0].scope, scope);
    t.identity({ ...identity(), canOpen: false }); closedResponse(await t.open({}, { ...headers, 'x-can-open': 'true' } as typeof headers), 403);
  } finally { await t.app.close(); }
});

test('record scope, lead, reference and independent account/board/item binding must match exactly', async () => {
  const t = setup();
  try {
    for (const changed of [{ ...record(), scope: { ...scope, organizationId: 'other' } }, { ...record(), scope: { ...scope, workspaceId: 'other' } },
      { ...record(), scope: { ...scope, mode: 'commercial' } }, { ...record(), leadId: 'other-lead' }, { ...record(), referenceId: 'other-reference' },
      { ...record(), sourceBinding: { ...binding, accountId: 'other' } }, { ...record(), sourceBinding: { ...binding, boardId: 'other' } },
      { ...record(), sourceBinding: { ...binding, itemId: 'other' } }]) {
      t.source.read = async () => changed as LeadLinkOpenRecord; closedResponse(await t.open(), 404);
    }
    t.source.read = async () => null; closedResponse(await t.open(), 404);
    t.source.read = async () => ({ ...record(), revision: 'new-revision' }); closedResponse(await t.open(), 409);
  } finally { await t.app.close(); }
});

test('logout, tenant/key change, permission revocation and token rotation during either awaited read deny opening', async () => {
  const t = setup();
  try {
    for (const changeAtRead of [1, 2]) {
      for (const [changed, status] of [[null, 401], [{ ...identity(), identityKey: 'another-session' }, 401],
        [{ ...identity(), scope: { ...scope, organizationId: 'other' } }, 401], [{ ...identity(), scope: { ...scope, workspaceId: 'other' } }, 401],
        [{ ...identity(), durableIdentity: true }, 401], [{ ...identity(), canOpen: false }, 403], [{ ...identity(), canRead: false }, 403],
        [{ ...identity(), leadIds: [] }, 404], [{ ...identity(), csrfToken: 'rotated-token-for-session' }, 401]] as const) {
        t.identity(identity()); let reads = 0;
        t.source.read = async () => { await Promise.resolve(); reads++; if (reads === changeAtRead) t.identity(changed); return record(); };
        closedResponse(await t.open(), status);
      }
    }
  } finally { await t.app.close(); }
});

test('the original lease cannot be extended and expiry is checked after the final authentication await', async () => {
  const t = setup(); const current = identity(); t.identity(current);
  try {
    t.source.read = async () => { current.expiresAtMs = NOW + 600_000; t.now(NOW + 60_000); return record(); };
    closedResponse(await t.open(), 401);
  } finally { await t.app.close(); }
  let now = NOW; let resolutions = 0;
  const app = createLeadLinkOpenApi({ allowedOrigin: ORIGIN, allowedDestinations: REVIEWED_LEAD_LINK_DESTINATIONS, clock: () => now,
    source: { async read() { return record(); } }, resolveIdentity: async () => {
      resolutions++; if (resolutions === 3) now = NOW + 120_000;
      return { ...identity(), expiresAtMs: NOW + 120_000 };
    } });
  try {
    now = NOW; resolutions = 0;
    const response = await app.inject({ method: 'POST', url: API, headers, payload: encode() });
    closedResponse(response, 401);
  } finally { await app.close(); }
});

test('second read denies withdrawn, superseded or changed observations even if revision was incorrectly reused', async () => {
  const t = setup();
  try {
    const variants: Array<LeadLinkOpenRecord | null> = [null, { ...record(), revision: 'revision-b' },
      record(ORIGINAL.replace('guests=50', 'guests=51')),
      { ...record(), link: normalizeHistoricalLink({ provenance: { ...provenance, observedAt: '2026-10-13T20:01:00Z' }, originalUrl: ORIGINAL }) },
      { ...record(), link: normalizeHistoricalLink({ provenance: { ...provenance, changedAt: '2026-10-13T19:59:00Z' }, originalUrl: ORIGINAL }) }];
    for (const latest of variants) {
      let reads = 0; t.source.read = async () => ++reads === 1 ? record() : latest;
      closedResponse(await t.open(), latest === null ? 404 : 409);
    }
  } finally { await t.app.close(); }
});

test('source objects are copied before reauthentication and late URL mutation cannot replace the approved snapshot', async () => {
  const mutable = structuredClone(record()); let resolutions = 0; let reads = 0;
  const app = createLeadLinkOpenApi({ allowedOrigin: ORIGIN, allowedDestinations: REVIEWED_LEAD_LINK_DESTINATIONS, clock: () => NOW,
    resolveIdentity: async () => {
      resolutions++; if (resolutions === 2) mutable.link.outer!.originalUrl = ORIGINAL.replace('guests=50', 'guests=90');
      return identity();
    }, source: { async read(selected) { reads++; assert(Object.isFrozen(selected)); return mutable; } } });
  try { closedResponse(await app.inject({ method: 'POST', url: API, headers, payload: encode() }), 409); assert.equal(reads, 2); }
  finally { await app.close(); }
});

test('missing, quarantined, FullURL/attribution, updates, keywords and forged historical category are never navigation authority', async () => {
  const t = setup();
  try {
    const base = record();
    const links: HistoricalLink[] = [normalizeHistoricalLink({ provenance, originalUrl: null }),
      normalizeHistoricalLink({ provenance, originalUrl: ORIGINAL.replace('itemId=300', 'itemId=999') }),
      normalizeHistoricalLink({ provenance: { ...provenance, columnId: 'text_mm1er3gk' }, originalUrl: ORIGINAL }),
      normalizeHistoricalLink({ provenance: { ...provenance, columnId: null, updateId: '444' }, originalUrl: ORIGINAL }),
      { ...base.link, category: 'keyword' }, { ...base.link, category: 'FullURL' }, { ...base.link, category: 'quote' },
      { ...base.link, status: 'historical', outer: { ...base.link.outer!, originalUrl: ORIGINAL.replace('itemId=300', 'itemId=999') } }];
    for (const link of links) { t.source.read = async () => ({ ...base, link }); closedResponse(await t.open(), 403); }
  } finally { await t.app.close(); }
});

test('destination requires exact configured reviewed origin and path, independently of historical status', async () => {
  const t = setup([]);
  try { closedResponse(await t.open(), 403); } finally { await t.app.close(); }
  const unsafe = ['http://monday.gourmet-corporation.com/?itemId=300', 'https://user:pass@monday.gourmet-corporation.com/?itemId=300',
    'https://monday.gourmet-corporation.com:444/?itemId=300', 'https://127.0.0.1/?itemId=300', 'https://[::1]/?itemId=300',
    'https://localhost/?itemId=300', 'https://monday.gourmet-corporation.com.evil.invalid/?itemId=300', 'https://extra.monday.gourmet-corporation.com/?itemId=300',
    'https://monday.gourmet-corporation.com./?itemId=300', 'https://monday.gourmet-corporatіon.com/?itemId=300',
    'https://monday.gourmet-corporation.com/elsewhere?itemId=300', 'https://monday.gourmet-corporation.com/?itemId=300#private',
    'https://monday.gourmet-corporation.com?itemId=300'];
  for (const original of unsafe) {
    const link = { ...record().link, outer: { ...record().link.outer!, originalUrl: original } };
    assert.throws(() => validateLeadLinkDestination(link, REVIEWED_LEAD_LINK_DESTINATIONS));
  }
  assert.equal(validateLeadLinkDestination(record(ORIGINAL.replace('.com/', '.com:443/')).link, REVIEWED_LEAD_LINK_DESTINATIONS), ORIGINAL.replace('.com/', '.com:443/'));
});

test('path normalization, encoded traversal, raw or encoded controls, CRLF and backslashes cannot be redirected', () => {
  const paths = ['/a/../', '/./', '/%2e/', '/%2e%2e/', '/%252e%252e/', '/%2f', '/%5c', '//', '/\\', '/%00', '/%0D%0AX-Injected:yes'];
  const originals = paths.map(path => 'https://monday.gourmet-corporation.com' + path + '?itemId=300');
  originals.push(ORIGINAL + '\r\nX-Injected: yes', ORIGINAL + '&private=%0d%0aInjected', ORIGINAL.replace('https://', 'https:\\\\'), ORIGINAL + '\t');
  for (const originalUrl of originals) assert.throws(() => validateLeadLinkDestination({ ...record().link, outer: { ...record().link.outer!, originalUrl } }, REVIEWED_LEAD_LINK_DESTINATIONS));
});

test('outer redirect parameter names fail closed while legitimate sourceUrl is not treated as a destination', () => {
  for (const key of ['%256Eext', 'redirect', 'redirect_url', 'REDIRECT-URI', 'url', 'next', 'returnTo', 'return_url', 'destination', 'continue', 'callbackUrl']) {
    assert.throws(() => validateLeadLinkDestination(record(ORIGINAL + '&' + key + '=https%3A%2F%2Fevil.invalid').link, REVIEWED_LEAD_LINK_DESTINATIONS));
  }
  assert.throws(() => validateLeadLinkDestination(record(ORIGINAL + '&%6Eext=https%3A%2F%2Fevil.invalid').link, REVIEWED_LEAD_LINK_DESTINATIONS));
  assert.equal(validateLeadLinkDestination(record().link, REVIEWED_LEAD_LINK_DESTINATIONS), ORIGINAL);
  const nested = 'https://monday.gourmet-corporation.com/?itemId=300&sourceUrl=https%3A%2F%2Fattribution.invalid%2F%3Fnext%3Dhttps%253A%252F%252Felsewhere.invalid';
  assert.equal(validateLeadLinkDestination(record(nested).link, REVIEWED_LEAD_LINK_DESTINATIONS), nested);
});

test('notes and closer use their own exact endpoint and quote requires an explicit private filename entry', async () => {
  for (const [columnId, url] of [['link_mm4w75jc', 'https://gourmet-corporation.com/lead-ai/?itemId=300'],
    ['link_mm5gbcxh', 'https://gourmet-corporation.com/aisalescloser/?itemId=300']] as const) {
    assert.equal(validateLeadLinkDestination(record(url, columnId).link, REVIEWED_LEAD_LINK_DESTINATIONS), url);
    assert.throws(() => validateLeadLinkDestination(record(url).link, REVIEWED_LEAD_LINK_DESTINATIONS));
  }
  const url = 'https://gourmet-corporation.com/quote/synthetic.pdf?signature=Z%2FB%3D&signature=second';
  const data = record(url, 'text_mm1mkvn');
  const privateEntry: LeadLinkAllowedDestination = { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/synthetic.pdf' };
  assert.throws(() => validateLeadLinkDestination(data.link, REVIEWED_LEAD_LINK_DESTINATIONS));
  assert.equal(validateLeadLinkDestination(data.link, [privateEntry]), url);
  assert.throws(() => validateLeadLinkDestination(record(url.replace('synthetic.pdf', 'different.pdf'), 'text_mm1mkvn').link, [privateEntry]));
  const t = setup([privateEntry]); t.source.read = async () => data;
  try { const result = await t.open(); assert.equal(result.statusCode, 303); assert.equal(result.headers.location, url); }
  finally { await t.app.close(); }
});

test('unreviewed origin/path/category and wildcard quote configuration are rejected without reflecting private values', () => {
  for (const bad of [{ category: 'calculator', origin: 'https://evil.invalid', pathname: '/' },
    { category: 'calculator', origin: 'https://sub.monday.gourmet-corporation.com', pathname: '/' },
    { category: 'calculator', origin: 'http://monday.gourmet-corporation.com', pathname: '/' },
    { category: 'calculator', origin: 'https://monday.gourmet-corporation.com', pathname: '/private' },
    { category: 'landing_attribution', origin: 'https://gourmet-corporation.com', pathname: '/' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/*' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/*.pdf' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/synthetic%3fprivate.pdf' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/synthetic%23private.pdf' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/../PRIVATE.pdf' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/%2fPRIVATE.pdf' },
    { category: 'quote', origin: 'https://gourmet-corporation.com', pathname: '/quote/%252ePRIVATE.pdf' }]) {
    assert.throws(() => setup([bad as LeadLinkAllowedDestination]), /^Error: Invalid lead link opening configuration$/);
  }
  assert.equal(Object.isFrozen(REVIEWED_LEAD_LINK_DESTINATIONS), true);
});

test('mutating allowlist configuration after registration cannot expand destination access', async () => {
  const allowed = [{ ...REVIEWED_LEAD_LINK_DESTINATIONS[0] }]; const t = setup(allowed);
  try {
    allowed[0].origin = 'https://evil.invalid';
    assert.equal((await t.open()).statusCode, 303);
    t.source.read = async () => record('https://evil.invalid/?itemId=300'); closedResponse(await t.open(), 403);
  } finally { await t.app.close(); }
});

test('dependency failures never reflect private source content or log provider URLs', async () => {
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'trace', stream: { write(value: string) { logs.push(value); } } },
    logController: new LogController({ disableRequestLogging: true }), frameworkErrors: leadLinkOpenFrameworkErrors });
  const source: LeadLinkOpeningSource = { async read() { throw new Error('PRIVATE_PROVIDER ' + ORIGINAL); } };
  registerLeadLinkOpenRoutes(app, { allowedOrigin: ORIGIN, allowedDestinations: REVIEWED_LEAD_LINK_DESTINATIONS, resolveIdentity: () => identity(), clock: () => NOW, source });
  try {
    const failed = await app.inject({ method: 'POST', url: API, headers, payload: encode() }); closedResponse(failed, 503);
    assert.deepEqual(failed.json(), { error: 'SERVICE_UNAVAILABLE' });
    source.read = async () => record();
    assert.equal((await app.inject({ method: 'POST', url: API, headers, payload: encode() })).statusCode, 303);
    assert.doesNotMatch(logs.join(''), /PRIVATE_PROVIDER|PRIVATE_SYNTHETIC_NAME|gourmet-corporation|signature=|csrfToken/);
  } finally { await app.close(); }
});

test('malformed framework URLs receive static protected errors and new API remains opt-in only', async () => {
  const t = setup();
  try {
    const malformed = await t.app.inject({ method: 'POST', url: API + '/%ZZPRIVATE', headers, payload: encode() });
    closedResponse(malformed, 400); assert.deepEqual(malformed.json(), { error: 'INVALID_REQUEST' });
    assert.equal(t.reads.length, 0);
  } finally { await t.app.close(); }
  for (const path of ['src/office/backend/server.ts', 'src/office/backend/staging-server.ts', 'src/office/backend/staging-app.ts', 'src/office/backend/http.ts']) {
    assert.doesNotMatch(await readFile(new URL('../../' + path, import.meta.url), 'utf8'), /registerLeadLinkOpenRoutes|createLeadLinkOpenApi|lead-link-opening/);
  }
});
