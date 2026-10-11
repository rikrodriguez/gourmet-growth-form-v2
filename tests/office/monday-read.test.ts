import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMondayReadClient, MondayReadError, MONDAY_API_VERSION, MONDAY_READ_BOARD_IDS, MONDAY_RECORD_BOARD_IDS, MONDAY_READ_SCOPES } from '../../src/office/backend/monday-read';
import type { MondayColumnAllowlist, MondayReadInput } from '../../src/office/backend/monday-read';

const AT = Date.parse('2026-10-11T20:00:00.000Z');
const BOARD = MONDAY_READ_BOARD_IDS[0];
const DEALS = '18411103560' as const;
const TOKEN = 'synthetic-monday-access-token';
const mapping: MondayColumnAllowlist = { [BOARD]: [{ id: 'synthetic_status', type: 'status', field: 'stage' }, { id: 'synthetic_amount', type: 'numbers', field: 'amount' }] };
function input(extra: Partial<MondayReadInput> = {}): MondayReadInput { return { boardId: BOARD, actorId: '900001', accessToken: TOKEN, expiresAt: '2026-10-11T21:00:00.000Z', scopes: [...MONDAY_READ_SCOPES], ...extra }; }
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'API-Version': MONDAY_API_VERSION, ...headers } }); }
function item(id = '100001', status = 'Qualified') { return { id, updated_at: '2026-10-11T19:00:00.000Z', column_values: [{ id: 'synthetic_status', type: 'status', text: status }, { id: 'synthetic_amount', type: 'numbers', text: '500.25' }] }; }
function page(items: unknown[] = [item()], cursor: string | null = null, boardId: string = BOARD): Response { return json({ data: { boards: [{ id: boardId, items_page: { cursor, items } }] } }); }
function fixture(responses: Array<Response | (() => Response)>, extra: Parameters<typeof createMondayReadClient>[0] = {}) {
  const requests: Array<{ endpoint: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } }> = [];
  const fetch = async (endpoint: string | URL | Request, init?: RequestInit) => {
    assert(init && typeof init.body === 'string');
    requests.push({ endpoint: String(endpoint), init, body: JSON.parse(init.body) });
    const response = responses.shift(); assert(response, 'No unexpected automatic request');
    return typeof response === 'function' ? response() : response;
  };
  const client = createMondayReadClient({ enabled: true, fetch: fetch as typeof globalThis.fetch, clock: () => AT, columnAllowlist: mapping, mappingVersion: 'synthetic-mapping-v1', ...extra });
  return { client, requests };
}

describe('Monday fixed read boundary', () => {
  it('is disabled by default and blocks unmapped commercial columns without outbound work', async () => {
    let calls = 0;
    const fetch = async () => { calls++; throw new Error('unexpected synthetic call'); };
    const disabled = createMondayReadClient({ fetch: fetch as typeof globalThis.fetch, clock: () => AT });
    await assert.rejects(disabled.getIdentity(TOKEN), (error: unknown) => error instanceof MondayReadError && error.code === 'disabled');
    await assert.rejects(disabled.verifyBoardAccess(TOKEN), (error: unknown) => error instanceof MondayReadError && error.code === 'disabled');
    assert.equal((await disabled.readBoard(input())).reason, 'disabled');
    assert.equal((await disabled.readUpdates(input())).reason, 'disabled');
    const unconfigured = createMondayReadClient({ enabled: true, fetch: fetch as typeof globalThis.fetch, clock: () => AT });
    assert.equal((await unconfigured.readBoard(input())).reason, 'columns_unconfigured');
    assert.equal(calls, 0);
  });

  it('blocks Deals record reads before fetching even with an approved column mapping', async () => {
    for (const columnAllowlist of [{ [DEALS]: mapping[BOARD]! }, {}]) {
      const { client, requests } = fixture([], { columnAllowlist });
      const result = await client.readBoard(input({ boardId: DEALS }));
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'forbidden_board');
      assert.equal(result.boardId, DEALS); assert.equal(result.pages, 0);
      assert.deepEqual(result.items, []); assert.equal(requests.length, 0);
    }
  });

  it('blocks Deals update metadata reads before fetching regardless of column mapping', async () => {
    for (const columnAllowlist of [{ [DEALS]: mapping[BOARD]! }, {}]) {
      const { client, requests } = fixture([], { columnAllowlist });
      const result = await client.readUpdates(input({ boardId: DEALS }));
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'forbidden_board');
      assert.equal(result.boardId, DEALS); assert.equal(result.pages, 0);
      assert.deepEqual(result.items, []); assert.equal(requests.length, 0);
    }
  });

  it('queries only minimal identity using the pinned endpoint/version and returns no credential', async () => {
    const { client, requests } = fixture([json({ data: { me: { id: '900001', email: 'DEMO@invalid.test' } } })]);
    const identity = await client.getIdentity(TOKEN);
    assert.deepEqual(identity, { id: '900001', email: 'demo@invalid.test', readAt: new Date(AT).toISOString() });
    assert.equal(requests[0].endpoint, 'https://api.monday.com/v2');
    assert.equal(requests[0].init.method, 'POST'); assert.equal(requests[0].init.redirect, 'error');
    assert.equal(new Headers(requests[0].init.headers).get('API-Version'), MONDAY_API_VERSION);
    assert.match(requests[0].body.query, /^query .*\{ me \{ id email \} \}$/);
    assert(!/name|account|phone|users|mutation/.test(requests[0].body.query));
    assert(!JSON.stringify(identity).includes(TOKEN));
  });

  it('verifies exactly the five allowed board IDs with a fixed query and no account or contents fields', async () => {
    const { client, requests } = fixture([json({ data: { boards: [...MONDAY_READ_BOARD_IDS].reverse().map(id => ({ id })) } })], { columnAllowlist: {} });
    const proof = await client.verifyBoardAccess(TOKEN);
    assert.deepEqual(proof.boardIds, ['18403945258', '18411103560', '18398057136', '18396813878', '18377848804']);
    assert.deepEqual(proof, { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(AT).toISOString() });
    assert.equal(requests.length, 1); assert.equal(requests[0].endpoint, 'https://api.monday.com/v2');
    assert.equal(requests[0].body.query, 'query OfficeMondayBoardAccess($boardIds: [ID!]!) { boards(ids: $boardIds) { id } }');
    assert.deepEqual(requests[0].body.variables, { boardIds: [...MONDAY_READ_BOARD_IDS] });
    assert(!/account|name|item|column|update|user|mutation/.test(requests[0].body.query));
    assert(!JSON.stringify(proof).includes(TOKEN));
    assert(Object.isFrozen(proof.boardIds)); assert(Object.isFrozen(MONDAY_READ_BOARD_IDS)); assert(Object.isFrozen(MONDAY_READ_SCOPES));
    assert(Object.isFrozen(MONDAY_RECORD_BOARD_IDS));
    assert.deepEqual(MONDAY_RECORD_BOARD_IDS, ['18403945258', '18398057136', '18396813878', '18377848804']);
    assert.deepEqual(MONDAY_READ_SCOPES, ['boards:read', 'updates:read', 'me:read']);
  });

  it('rejects missing, duplicate, foreign, malformed or unexpectedly detailed board-access responses', async () => {
    const exact = MONDAY_READ_BOARD_IDS.map(id => ({ id }));
    const invalid = [
      [], exact.slice(0, 4), [...exact, { id: '999999999' }],
      [...exact.slice(0, 4), exact[0]], [...exact.slice(0, 4), { id: '999999999' }],
      [...exact.slice(0, 4), { id: 18377848804 }], [...exact.slice(0, 4), null],
      [...exact.slice(0, 4), { ...exact[4], name: 'synthetic-private-board-name' }],
    ];
    for (const boards of invalid) {
      const { client, requests } = fixture([json({ data: { boards } })]);
      await assert.rejects(client.verifyBoardAccess(TOKEN), (error: unknown) => error instanceof MondayReadError && ['forbidden_board', 'incompatible'].includes(error.code) && !JSON.stringify(error).includes('synthetic-private-board-name') && !String(error).includes(TOKEN));
      assert.equal(requests.length, 1);
    }
    const extraData = fixture([json({ data: { boards: exact, account: { id: 'synthetic-unverified-account' } } })]);
    await assert.rejects(extraData.client.verifyBoardAccess(TOKEN), (error: unknown) => error instanceof MondayReadError && error.code === 'incompatible');
  });

  it('refuses board-access proof on quota, permission or partial errors without retries or error-body leakage', async () => {
    const marker = 'synthetic-private-provider-board-error';
    for (const [response, code, wait] of [
      [json({ message: marker }, 429, { 'Retry-After': '19' }), 'rate_limited', 19],
      [json({ message: marker }, 401), 'unauthorized', undefined], [json({ message: marker }, 403), 'forbidden', undefined],
      [json({ data: { boards: MONDAY_READ_BOARD_IDS.map(id => ({ id })) }, errors: [{ message: marker, extensions: { code: 'missingRequiredPermissions' } }] }), 'forbidden', undefined],
      [json({ data: { boards: MONDAY_READ_BOARD_IDS.map(id => ({ id })) }, errors: [{ message: marker }] }), 'provider_partial', undefined],
    ] as const) {
      const { client, requests } = fixture([response]);
      await assert.rejects(client.verifyBoardAccess(TOKEN), (error: unknown) => error instanceof MondayReadError && error.code === code && error.retryAfterSeconds === wait && !String(error).includes(marker) && !JSON.stringify(error).includes(TOKEN));
      assert.equal(requests.length, 1);
    }
    const invalidToken = fixture([]);
    await assert.rejects(invalidToken.client.verifyBoardAccess('synthetic\ninvalid-token'), (error: unknown) => error instanceof MondayReadError && error.code === 'invalid_request');
    assert.equal(invalidToken.requests.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(invalidToken.client.verifyBoardAccess(TOKEN, controller.signal), (error: unknown) => error instanceof MondayReadError && error.code === 'aborted');
    assert.equal(invalidToken.requests.length, 0);
  });

  it('rejects query, column, cursor, board, actor, scope and expiration substitutions before fetching', async () => {
    const { client, requests } = fixture([]);
    const invalid: unknown[] = [
      { ...input(), query: 'mutation { fake }' }, { ...input(), cursor: 'client-controlled' }, { ...input(), columns: ['email'] },
      input({ boardId: '999999999' as typeof BOARD }), input({ actorId: 'not-a-monday-identity' }),
      input({ scopes: ['boards:read', 'updates:read', 'me:read', 'boards:write'] }), input({ scopes: ['boards:read'] }),
      input({ expiresAt: '2026-10-11T19:59:59.000Z' }), input({ expiresAt: '2026-02-30T21:00:00.000Z' }), input({ accessToken: 'synthetic\ninvalid-header' }),
    ];
    for (const raw of invalid) await assert.rejects(client.readBoard(raw as MondayReadInput), error => error instanceof MondayReadError && !String(error).includes(TOKEN));
    assert.equal(requests.length, 0);
  });

  it('rejects server mappings outside five boards or commercial fields and isolates later config changes', async () => {
    for (const raw of [{ '999999999': [] }, { [BOARD]: [{ id: 'email', type: 'email', field: 'stage' }] }, { [BOARD]: [{ id: 'notes', type: 'text', field: 'commercial_notes' }] }, { [BOARD]: [{ id: 'bad-id', type: 'status', field: 'stage' }] }, { [BOARD]: [mapping[BOARD]![0], mapping[BOARD]![0]] }]) {
      assert.throws(() => createMondayReadClient({ columnAllowlist: raw as MondayColumnAllowlist }), MondayReadError);
    }
    const config = structuredClone(mapping);
    const { client, requests } = fixture([page()], { columnAllowlist: config });
    config[BOARD]![0].id = 'unapproved_changed_after_factory';
    assert.equal((await client.readBoard(input())).status, 'complete');
    assert.deepEqual(requests[0].body.variables.columnIds, ['synthetic_status', 'synthetic_amount']);
  });

  it('projects only configured columns with independent source update and read timestamps', async () => {
    const { client, requests } = fixture([page()]);
    const result = await client.readBoard(input());
    assert.equal(result.status, 'complete'); assert.equal(result.pages, 1);
    assert.deepEqual(result.items[0], { id: '100001', boardId: BOARD, sourceUpdatedAt: '2026-10-11T19:00:00.000Z', readAt: new Date(AT).toISOString(), columns: [{ id: 'synthetic_status', field: 'stage', type: 'status', text: 'Qualified', redacted: false }, { id: 'synthetic_amount', field: 'amount', type: 'numbers', text: '500.25', redacted: false }] });
    assert.deepEqual(requests[0].body.variables, { boardIds: [BOARD], cursor: null, columnIds: ['synthetic_status', 'synthetic_amount'] });
    assert(!/mutation|name|value\s*\}|creator|body|email|phone|url/.test(requests[0].body.query));
    assert(!JSON.stringify(result).includes(TOKEN));
  });

  it('withholds contact, credential, URL and markup content in configured labels', async () => {
    for (const status of ['demo@invalid.test', '+1 (555) 123-4567', 'https://example.invalid.test/synthetic', 'token=synthetic-sensitive-marker', '<b>personal</b>']) {
      const { client } = fixture([page([item('100001', status)])]);
      const result = await client.readBoard(input());
      assert.equal(result.items[0].columns[0].text, null); assert.equal(result.items[0].columns[0].redacted, true);
      assert(!JSON.stringify(result).includes(status));
    }
  });

  it('keeps opaque provider cursors internal and limits each read to four pages and 100 items', async () => {
    const responses = Array.from({ length: 4 }, (_, pageIndex) => page(Array.from({ length: 25 }, (_, itemIndex) => item(String(100000 + pageIndex * 25 + itemIndex))), `synthetic-cursor-${pageIndex}`));
    const { client, requests } = fixture(responses);
    const result = await client.readBoard(input());
    assert.equal(result.status, 'partial'); assert.equal(result.reason, 'page_limit'); assert.equal(result.pages, 4); assert.equal(result.items.length, 100); assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(request => request.body.variables.cursor), [null, 'synthetic-cursor-0', 'synthetic-cursor-1', 'synthetic-cursor-2']);
    assert(!JSON.stringify(result).includes('cursor')); assert(!Object.hasOwn(client, 'query'));
  });

  it('rejects a cursor cycle, duplicate item, foreign board, extra private field and malformed date', async () => {
    for (const response of [page([item('100001')], 'same-cursor'), page([item('100001')], null), page([item('100002')], null, MONDAY_READ_BOARD_IDS[1]), page([{ ...item('100002'), email: 'synthetic-private@invalid.test' }]), page([{ ...item('100002'), updated_at: '2026-02-30T12:00:00Z' }])]) {
      const { client } = fixture([page([item('100001')], 'same-cursor'), response]);
      const result = await client.readBoard(input());
      assert.equal(result.status, 'partial'); assert.equal(result.pages, 1); assert.equal(result.items.length, 1);
      assert(['cursor_cycle', 'incompatible'].includes(result.reason!));
      assert(!JSON.stringify(result).includes('synthetic-private'));
    }
  });

  it('binds pagination to its actor, mapping, board and TTL, without accepting a client continuation', async () => {
    let at = AT;
    const { client, requests } = fixture([() => { at = AT + 5 * 60_000; return page([item()], 'synthetic-cursor'); }], { clock: () => at });
    const result = await client.readBoard(input());
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'cursor_expired'); assert.equal(result.items.length, 0); assert.equal(requests.length, 1);
    assert(!Object.hasOwn(result, 'cursor'));
  });

  it('reports HTTP and GraphQL quota/partial failures without retries or sensitive provider errors', async () => {
    const marker = 'synthetic-provider-sensitive-error-marker';
    for (const response of [json({ errors: [{ message: marker }] }, 429, { 'Retry-After': '23' }), json({ data: { boards: [] }, errors: [{ message: marker, extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 17 } }] }), json({ data: { boards: [] }, errors: [{ message: marker, extensions: { code: 'missingRequiredPermissions' } }] })]) {
      const { client, requests } = fixture([page([item()], 'synthetic-cursor'), response]);
      const result = await client.readBoard(input());
      assert.equal(result.status, 'partial'); assert.equal(result.items.length, 1); assert.equal(requests.length, 2);
      assert(['rate_limited', 'provider_partial', 'forbidden'].includes(result.reason!)); assert(!JSON.stringify(result).includes(marker));
    }
    const { client } = fixture([json({ message: marker }, 429, { 'Retry-After': '23' })]);
    const result = await client.readBoard(input()); assert.equal(result.status, 'blocked'); assert.equal(result.retryAfterSeconds, 23);
    const identity = fixture([json({ errors: [{ message: `${TOKEN} ${marker}` }] })]);
    await assert.rejects(identity.client.getIdentity(TOKEN), error => error instanceof MondayReadError && !String(error).includes(marker) && !JSON.stringify(error).includes(TOKEN));
  });

  it('reads update IDs and source dates within an allowed board without content or author fields', async () => {
    const source = { id: '100001', updated_at: null, updates: [{ id: '200001', created_at: '2026-10-10', updated_at: '2026-10-11T19:30:00Z' }] };
    const { client, requests } = fixture([page([source])], { columnAllowlist: {} });
    const result = await client.readUpdates(input()); assert.equal(result.status, 'complete');
    assert.deepEqual(result.items[0].updates[0], { id: '200001', createdAt: '2026-10-10', sourceUpdatedAt: '2026-10-11T19:30:00Z', readAt: new Date(AT).toISOString() });
    assert.match(requests[0].body.query, /updates\(limit: 20\) \{ id created_at updated_at \}/);
    assert(!/body|creator|name|attachments|assets|users|mutation/.test(requests[0].body.query));
  });

  it('marks 20 updates as bounded metadata and rejects unexpected comment content', async () => {
    const source = { id: '100001', updated_at: null, updates: Array.from({ length: 20 }, (_, index) => ({ id: String(200001 + index), created_at: null, updated_at: null })) };
    const truncated = fixture([page([source])]); const result = await truncated.client.readUpdates(input());
    assert.equal(result.status, 'partial'); assert.equal(result.reason, 'updates_limit'); assert.equal(result.items[0].updates.length, 20);
    const extra = fixture([page([{ ...source, updates: [{ ...source.updates[0], body: 'synthetic-private-comment' }] }])]);
    const rejected = await extra.client.readUpdates(input()); assert.equal(rejected.status, 'blocked'); assert.equal(rejected.reason, 'incompatible'); assert.equal(rejected.items.length, 0);
  });

  it('fails closed for transport, identity, API-version, content-type, size and abort failures', async () => {
    for (const [response, reason] of [
      [json({ marker: TOKEN }, 401), 'unauthorized'], [json({ marker: TOKEN }, 403), 'forbidden'],
      [json({ data: { boards: [] } }, 200, { 'API-Version': '2026-10' }), 'incompatible'],
      [new Response('synthetic-invalid-content', { headers: { 'Content-Type': 'text/html' } }), 'incompatible'],
      [json({ oversized: 'x'.repeat(256 * 1024) }), 'incompatible'],
      [page([{ ...item(), updated_at: '2026-10-11T24:00:00Z' }]), 'incompatible'],
    ] as const) {
      const { client, requests } = fixture([response]); const result = await client.readBoard(input());
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, reason); assert.equal(requests.length, 1); assert(!JSON.stringify(result).includes(TOKEN));
    }
    const offline = createMondayReadClient({ enabled: true, clock: () => AT, columnAllowlist: mapping, fetch: (async () => { throw new Error(TOKEN); }) as typeof fetch });
    assert.equal((await offline.readBoard(input())).reason, 'offline');
    const controller = new AbortController(); controller.abort();
    const aborted = fixture([]); assert.equal((await aborted.client.readBoard(input({ signal: controller.signal }))).reason, 'aborted'); assert.equal(aborted.requests.length, 0);
    const extraIdentity = fixture([json({ data: { me: { id: '900001', email: 'demo@invalid.test', phone: 'synthetic-private-phone' } } })]);
    await assert.rejects(extraIdentity.client.getIdentity(TOKEN), (error: unknown) => error instanceof MondayReadError && error.code === 'incompatible');
  });
});
