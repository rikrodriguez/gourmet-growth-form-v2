import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MONDAY_API_VERSION, MONDAY_READ_SCOPES } from '../../src/office/backend/monday-read';

const AT = Date.parse('2026-10-12T18:00:00.000Z');
const BOARD = '18403945258';
const ITEM = '90001001';
const TOKEN = 'synthetic-private-monday-token';
const COLUMNS = ['email_mm1k9cjw', 'phone_mm1en86x', 'date_mm1ehb3s', 'text_mm1er9bx', 'text_mm1e3hn', 'text_mm1ed0nr'];
type Input = { itemId: string; actorId: string; accessToken: string; expiresAt: string; scopes: string[]; signal?: AbortSignal };
function input(extra: Partial<Input> = {}): Input { return { itemId: ITEM, actorId: '90002001', accessToken: TOKEN, expiresAt: '2026-10-12T19:00:00.000Z', scopes: [...MONDAY_READ_SCOPES], ...extra }; }
function lead(extra: Record<string, unknown> = {}) {
  return { id: ITEM, name: 'Synthetic intake name', updated_at: '2026-10-12T17:30:00.000Z', board: { id: BOARD }, column_values: [
    { id: COLUMNS[0], type: 'email', email: ' CONTACT.ONE+EVENT@INVALID.TEST ' },
    { id: COLUMNS[1], type: 'phone', phone: '+12025550123', country_short_name: 'US' },
    { id: COLUMNS[2], type: 'date', date: '2026-11-21' },
    { id: COLUMNS[3], type: 'text', text: 'about 80–100 guests' },
    { id: COLUMNS[4], type: 'text', text: 'Synthetic dinner' },
    { id: COLUMNS[5], type: 'text', text: 'Synthetic buffet' },
  ], ...extra };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'API-Version': MONDAY_API_VERSION, ...headers } });
}
function page(value: unknown = lead()) { return response({ data: { items: [value] } }); }
async function module() {
  const loaded = await import('../../src/office/backend/monday-leads-read').catch(() => null);
  assert(loaded && typeof loaded.createMondayLeadReadClient === 'function', 'Private single-lead read adapter is absent');
  return loaded;
}
async function fixture(responses: Array<Response | (() => Response)>, extra: Record<string, unknown> = {}) {
  const requests: Array<{ endpoint: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } }> = [];
  const send = async (endpoint: string | URL | Request, init?: RequestInit) => {
    assert(init && typeof init.body === 'string');
    requests.push({ endpoint: String(endpoint), init, body: JSON.parse(init.body) });
    const next = responses.shift(); assert(next, 'Unexpected additional provider request');
    return typeof next === 'function' ? next() : next;
  };
  const { createMondayLeadReadClient } = await module();
  return { client: createMondayLeadReadClient({ enabled: true, fetch: send as typeof globalThis.fetch, clock: () => AT, ...extra }), requests };
}
function safeCode(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code
    && !String(error).includes(TOKEN) && !String(error).includes('synthetic-private-provider-marker');
}

describe('Inactive private Monday lead reader', () => {
  it('reads one explicitly selected lead into a versioned private observation', async () => {
    const { client, requests } = await fixture([page()]);
    const observed = await client.readLead(input());
    assert.equal(observed.kind, 'lead'); assert.equal(observed.source, 'monday');
    assert.equal(observed.sourceKey, `${BOARD}:${ITEM}`); assert.equal(observed.observedAtMs, AT);
    assert.equal(observed.providerVersion, `2026-10-12T17:30:00.000Z:${observed.data.mappingVersion}`);
    assert.equal(observed.data.mappingVersion, 'lead-contact-event-v1');
    assert.deepEqual(observed.data, { boardId: BOARD, itemId: ITEM, displayName: 'Synthetic intake name', email: 'contact.one+event@invalid.test', phone: '+12025550123', phoneCountry: 'US', eventDate: '2026-11-21', guestsText: 'about 80–100 guests', eventTypeText: 'Synthetic dinner', serviceStyleText: 'Synthetic buffet', mappingVersion: 'lead-contact-event-v1' });
    assert.equal(requests.length, 1); assert(!JSON.stringify(observed).includes(TOKEN));
  });

  it('keeps the default disabled without issuing any provider request', async () => {
    const { client, requests } = await fixture([], { enabled: false });
    await assert.rejects(client.readLead(input()), safeCode('disabled'));
    const { createMondayLeadReadClient } = await module();
    await assert.rejects(createMondayLeadReadClient({ clock: () => AT }).readLead(input()), safeCode('disabled'));
    assert.equal(requests.length, 0);
  });

  it('uses a fixed read query, typed contacts and the pinned HTTPS transport', async () => {
    const { client, requests } = await fixture([page()]); await client.readLead(input());
    const request = requests[0];
    assert.equal(request.endpoint, 'https://api.monday.com/v2'); assert.equal(request.init.method, 'POST');
    assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.cache, 'no-store');
    assert.equal(new Headers(request.init.headers).get('API-Version'), MONDAY_API_VERSION);
    assert.deepEqual(request.body.variables, { itemIds: [ITEM], columnIds: COLUMNS });
    assert.match(request.body.query, /^query OfficeMondayLeadRead/);
    assert.match(request.body.query, /\bname\b/); assert.match(request.body.query, /board\s*\{\s*id\s*\}/);
    assert.match(request.body.query, /\.\.\. on EmailValue\s*\{\s*email\s*\}/);
    assert.match(request.body.query, /\.\.\. on PhoneValue\s*\{\s*phone country_short_name\s*\}/);
    assert.match(request.body.query, /\.\.\. on DateValue\s*\{\s*date\s*\}/);
    assert(!/mutation|updates|users|account|value\b|cursor|limit|label/.test(request.body.query));
  });

  it('refuses query, board, column and cursor injection before transport', async () => {
    const { client, requests } = await fixture([]);
    for (const extra of [{ query: 'mutation { fake }' }, { boardId: BOARD }, { columnIds: ['email'] }, { cursor: 'fake' }, { actorId: 'not-an-id' }, { itemId: '0' }, { itemId: 90001001 }, { accessToken: 'synthetic\ninvalid' }]) {
      await assert.rejects(client.readLead({ ...input(), ...extra } as Input), safeCode('invalid_request'));
    }
    assert.equal(requests.length, 0);
  });

  it('rejects missing, duplicate and additional scopes before transport', async () => {
    const { client, requests } = await fixture([]);
    for (const scopes of [['boards:read'], [...MONDAY_READ_SCOPES, 'boards:write'], [...MONDAY_READ_SCOPES, 'boards:read'], [1, 2, 3]]) {
      await assert.rejects(client.readLead(input({ scopes: scopes as string[] })), safeCode('scopes_mismatch'));
    }
    assert.equal(requests.length, 0);
  });

  it('blocks expired or invalid credentials before any provider read', async () => {
    const { client, requests } = await fixture([]);
    for (const expiresAt of ['2026-10-12T18:00:00.000Z', '2026-10-12T17:59:59Z', '2026-02-30T19:00:00Z', '2026-10-12', 'not-a-date']) {
      await assert.rejects(client.readLead(input({ expiresAt })), error => error instanceof Error && 'code' in error && ['expired', 'invalid_request'].includes(error.code as string));
    }
    assert.equal(requests.length, 0);
  });

  it('requires exactly the selected item and fixed board association', async () => {
    for (const items of [[], [lead({ id: '90001002' })], [lead({ board: { id: '18377848804' } })], [lead(), lead()]]) {
      const { client, requests } = await fixture([response({ data: { items } })]);
      await assert.rejects(client.readLead(input()), error => error instanceof Error && 'code' in error && ['incompatible', 'not_found', 'forbidden'].includes(error.code as string));
      assert.equal(requests.length, 1);
    }
  });

  it('refuses hidden extra item, board, data and column fields', async () => {
    const marker = 'synthetic-private-provider-marker';
    for (const payload of [
      { data: { items: [lead({ owner: marker })] } },
      { data: { items: [lead({ board: { id: BOARD, name: marker } })] } },
      { data: { items: [lead()], account: marker } },
      { data: { items: [lead({ column_values: [{ ...lead().column_values[0], text: marker }, ...lead().column_values.slice(1)] })] } },
      { data: { items: [lead()] }, private: marker },
    ]) {
      const { client } = await fixture([response(payload)]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
    }
  });

  it('rejects missing, duplicate, foreign and incompatible column projections', async () => {
    const columns = lead().column_values;
    for (const column_values of [columns.slice(1), [...columns, columns[0]], [{ ...columns[0], id: 'foreign_email' }, ...columns.slice(1)], [{ ...columns[0], type: 'text' }, ...columns.slice(1)], [{ id: COLUMNS[0], type: 'email', email: null }, { id: COLUMNS[1], type: 'phone', phone: '+12025550123' }, ...columns.slice(2)]]) {
      const { client } = await fixture([page(lead({ column_values }))]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
    }
  });

  it('preserves explicit null contacts and empty nullable event fields without inventing values', async () => {
    const columns = lead().column_values.map(column => column.type === 'email' ? { ...column, email: null } : column.type === 'phone' ? { ...column, phone: null, country_short_name: null } : column.type === 'date' ? { ...column, date: '' } : { ...column, text: '' });
    const { client } = await fixture([page(lead({ column_values: columns }))]);
    const { data } = await client.readLead(input());
    assert.deepEqual([data.email, data.phone, data.phoneCountry, data.eventDate, data.guestsText, data.eventTypeText, data.serviceStyleText], [null, null, null, null, null, null, null]);
  });

  it('rejects malformed typed contact and event values without leaking them', async () => {
    for (const [index, value] of [[0, { email: 'not-an-email' }], [0, { email: 'x@invalid.test\r\nBcc: other@invalid.test' }], [1, { phone: 'synthetic-private-provider-marker' }], [1, { country_short_name: 'USA' }], [2, { date: '2026-02-30' }], [2, { date: '2026-11-21T00:00:00Z' }], [3, { text: 'x'.repeat(501) }]] as const) {
      const columns = lead().column_values.map((column, at) => at === index ? { ...column, ...value } : column);
      const { client } = await fixture([page(lead({ column_values: columns }))]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
    }
  });

  it('fails closed if the provider cannot supply an item update version', async () => {
    for (const updated_at of [null, '', '2026-02-30T17:30:00Z', '2026-10-12', 'not-a-date']) {
      const { client } = await fixture([page(lead({ updated_at }))]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
    }
  });

  it('does not use display name to replace the typed email or transform email aliases', async () => {
    const columns = lead().column_values.map((column, index) => index === 0 ? { ...column, email: ' Different.Name+Tag@INVALID.TEST ' } : column);
    const { client } = await fixture([page(lead({ name: 'An entirely different synthetic name', column_values: columns }))]);
    const { data } = await client.readLead(input());
    assert.equal(data.email, 'different.name+tag@invalid.test'); assert.equal(data.displayName, 'An entirely different synthetic name');
  });

  it('sanitizes HTTP failures and never retries the read', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'offline'], [302, 'offline']] as const) {
      const { client, requests } = await fixture([response({ message: 'synthetic-private-provider-marker' }, status)]);
      await assert.rejects(client.readLead(input()), safeCode(code)); assert.equal(requests.length, 1);
    }
  });

  it('rejects a GraphQL partial response even when the item itself appears valid', async () => {
    for (const errors of [[{ message: 'synthetic-private-provider-marker' }], [{ extensions: { code: 'missingRequiredPermissions' } }], [{ extensions: { code: 'InvalidTokenException' } }], [{ extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED' } }]]) {
      const { client, requests } = await fixture([response({ data: { items: [lead()] }, errors })]);
      await assert.rejects(client.readLead(input()), error => error instanceof Error && 'code' in error && ['provider_partial', 'forbidden', 'unauthorized', 'rate_limited'].includes(error.code as string) && !String(error).includes('synthetic-private-provider-marker'));
      assert.equal(requests.length, 1);
    }
  });

  it('rejects incompatible media types, API versions and oversized provider bodies', async () => {
    for (const next of [response({ data: { items: [lead()] } }, 200, { 'Content-Type': 'text/plain' }), response({ data: { items: [lead()] } }, 200, { 'API-Version': '2099-01' }), response({ data: { items: [lead()] } }, 200, { 'Content-Length': String(128 * 1024 + 1) }), response({ data: { items: [lead({ name: 'x'.repeat(128 * 1024) })] } })]) {
      const { client } = await fixture([next]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
    }
  });

  it('rejects a resolved response whose URL escaped the fixed endpoint', async () => {
    const next = page(); Object.defineProperty(next, 'url', { value: 'https://unrelated.invalid.test/' });
    const { client } = await fixture([next]); await assert.rejects(client.readLead(input()), safeCode('incompatible'));
  });

  it('stops aborted reads before transport and sanitizes network exceptions', async () => {
    const controller = new AbortController(); controller.abort();
    const { client, requests } = await fixture([]); await assert.rejects(client.readLead(input({ signal: controller.signal })), safeCode('aborted')); assert.equal(requests.length, 0);
    const { createMondayLeadReadClient } = await module(); let calls = 0;
    const broken = createMondayLeadReadClient({ enabled: true, clock: () => AT, fetch: (async () => { calls++; throw new Error(`synthetic-private-provider-marker ${TOKEN}`); }) as typeof fetch });
    await assert.rejects(broken.readLead(input()), safeCode('offline')); assert.equal(calls, 1);
  });
});
