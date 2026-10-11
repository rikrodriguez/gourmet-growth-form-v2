// Server-only fixed queries. No tokens, cursors, provider error text, item names,
// update bodies or directory fields are included in a returned projection.
// Docs checked 2026-10-11: /api-reference/docs/api-versioning,
// /reference/me, /reference/items-page, /reference/items, /reference/updates,
// /reference/column-values-v2 and /docs/rate-limits (developer.monday.com).
export const MONDAY_READ_BOARD_IDS = Object.freeze(['18403945258', '18411103560', '18398057136', '18396813878', '18377848804'] as const);
export const MONDAY_READ_SCOPES = Object.freeze(['boards:read', 'updates:read', 'me:read'] as const);
export const MONDAY_API_VERSION = '2026-07' as const;
const ENDPOINT = 'https://api.monday.com/v2';
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const CURSOR_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type MondayBoardId = typeof MONDAY_READ_BOARD_IDS[number];
export type MondayCommercialField = 'stage' | 'event_type' | 'guest_count' | 'event_date' | 'service_style' | 'amount' | 'quote_status';
export type MondayAllowedColumn = { id: string; type: 'status' | 'dropdown' | 'numbers' | 'date'; field: MondayCommercialField };
export type MondayColumnAllowlist = Partial<Record<MondayBoardId, readonly MondayAllowedColumn[]>>;
export type MondayIdentity = { id: string; email: string; readAt: string };
export type MondayBoardAccess = { boardIds: readonly MondayBoardId[]; readAt: string };
export type MondayReadInput = { boardId: MondayBoardId; actorId: string; accessToken: string; expiresAt: string; scopes: readonly string[]; signal?: AbortSignal };
export type MondayReadReason = 'disabled' | 'invalid_request' | 'forbidden_board' | 'scopes_mismatch' | 'expired' | 'columns_unconfigured' | 'incompatible' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'provider_partial' | 'offline' | 'aborted' | 'cursor_expired' | 'cursor_cycle' | 'page_limit' | 'updates_limit';
export type MondayReadItem = { id: string; boardId: MondayBoardId; sourceUpdatedAt: string | null; readAt: string; columns: Array<{ id: string; field: MondayCommercialField; type: MondayAllowedColumn['type']; text: string | null; redacted: boolean }> };
export type MondayUpdateItem = { id: string; boardId: MondayBoardId; sourceUpdatedAt: string | null; readAt: string; updates: Array<{ id: string; createdAt: string | null; sourceUpdatedAt: string | null; readAt: string }> };
export type MondayReadResult<T> = { status: 'complete' | 'partial' | 'blocked'; boardId: MondayBoardId; mappingVersion: string; readAt: string; pages: number; items: T[]; reason?: MondayReadReason; retryAfterSeconds?: number };
export interface MondayReadClient {
  getIdentity(accessToken: string, signal?: AbortSignal): Promise<MondayIdentity>;
  verifyBoardAccess(accessToken: string, signal?: AbortSignal): Promise<MondayBoardAccess>;
  readBoard(input: MondayReadInput): Promise<MondayReadResult<MondayReadItem>>;
  readUpdates(input: MondayReadInput): Promise<MondayReadResult<MondayUpdateItem>>;
}
export type MondayReadClientOptions = { enabled?: boolean; fetch?: typeof fetch; clock?: () => number; columnAllowlist?: MondayColumnAllowlist; mappingVersion?: string };

const QUERIES = Object.freeze({
  identity: 'query OfficeMondayIdentity { me { id email } }',
  boardAccess: 'query OfficeMondayBoardAccess($boardIds: [ID!]!) { boards(ids: $boardIds) { id } }',
  board: 'query OfficeMondayBoardRead($boardIds: [ID!]!, $columnIds: [String!]!, $cursor: String) { boards(ids: $boardIds) { id items_page(limit: 25, cursor: $cursor) { cursor items { id updated_at column_values(ids: $columnIds) { id type text } } } } }',
  updates: 'query OfficeMondayUpdatesRead($boardIds: [ID!]!, $cursor: String) { boards(ids: $boardIds) { id items_page(limit: 25, cursor: $cursor) { cursor items { id updated_at updates(limit: 20) { id created_at updated_at } } } } }',
});
const FIELD_TYPES: Record<MondayCommercialField, readonly MondayAllowedColumn['type'][]> = {
  stage: ['status', 'dropdown'], event_type: ['status', 'dropdown'], guest_count: ['numbers'],
  event_date: ['date'], service_style: ['status', 'dropdown'], amount: ['numbers'], quote_status: ['status', 'dropdown'],
};

export class MondayReadError extends Error {
  constructor(readonly code: MondayReadReason, readonly retryAfterSeconds?: number) {
    super(`Monday read unavailable: ${code}.`);
    this.name = 'MondayReadError';
  }
}
type Row = Record<string, unknown>;
function fail(code: MondayReadReason = 'incompatible'): never { throw new MondayReadError(code); }
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value as Row;
}
function keys(value: Row, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail();
}
function text(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function sourceId(value: unknown): string { const id = text(value, 30); if (!/^[1-9][0-9]{0,29}$/.test(id)) fail(); return id; }
function sourceDate(value: unknown): string | null {
  if (value === null) return null;
  const date = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) || !Number.isFinite(Date.parse(date))) fail();
  if (date.includes('T') && (Number(date.slice(11, 13)) > 23 || Number(date.slice(14, 16)) > 59 || Number(date.slice(17, 19)) > 59)) fail();
  const calendar = date.slice(0, 10);
  if (new Date(`${calendar}T00:00:00.000Z`).toISOString().slice(0, 10) !== calendar) fail();
  return date;
}
function retryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]{1,10}$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : undefined;
}
function safeError(error: unknown): MondayReadError { return error instanceof MondayReadError ? error : new MondayReadError('offline'); }
function token(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192 || value !== value.trim() || /[^\x21-\x7e]/.test(value)) fail('invalid_request');
  return value;
}
function parseMapping(raw: unknown): MondayColumnAllowlist {
  const value = record(raw ?? {}); const result: MondayColumnAllowlist = {};
  for (const [boardId, columns] of Object.entries(value)) {
    if (!(MONDAY_READ_BOARD_IDS as readonly string[]).includes(boardId) || !Array.isArray(columns) || columns.length > 20) fail('invalid_request');
    const parsed = columns.map(column => {
      const row = record(column); keys(row, ['id', 'type', 'field']);
      const id = text(row.id, 96);
      if (!/^[A-Za-z0-9_]+$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || typeof row.field !== 'string' || !Object.hasOwn(FIELD_TYPES, row.field) || !FIELD_TYPES[row.field as MondayCommercialField].includes(row.type as MondayAllowedColumn['type'])) fail('invalid_request');
      return Object.freeze({ id, type: row.type as MondayAllowedColumn['type'], field: row.field as MondayCommercialField });
    });
    if (new Set(parsed.map(column => column.id)).size !== parsed.length || new Set(parsed.map(column => column.field)).size !== parsed.length) fail('invalid_request');
    result[boardId as MondayBoardId] = Object.freeze(parsed);
  }
  return Object.freeze(result);
}
function commercialText(raw: unknown, column: MondayAllowedColumn): { text: string | null; redacted: boolean } {
  if (raw === null) return { text: null, redacted: false };
  const value = text(raw, 160).trim();
  if (column.type === 'numbers') {
    if (!/^-?[0-9]{1,12}(?:\.[0-9]{1,4})?$/.test(value) && value !== '') fail();
    if (column.field === 'guest_count' && value && (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 1_000_000)) fail();
    return { text: value || null, redacted: false };
  }
  if (column.type === 'date') {
    if (!value) return { text: null, redacted: false };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
    sourceDate(value);
    return { text: value, redacted: false };
  }
  // No free-text columns are admitted. Even configured status/dropdown labels
  // are withheld if they resemble contacts, links, credentials or markup.
  const personal = /@|https?:\/\/|www\.|(?:\+?\d[\s().-]*){7,}|(?:bearer|token|secret|password|api[_ -]?key)\s*[:=]|[<>]|[A-Za-z0-9_-]{32,}/i.test(value);
  return { text: personal ? null : value || null, redacted: personal };
}

export function createMondayReadClient(options: MondayReadClientOptions = {}): MondayReadClient {
  const enabled = options.enabled === true;
  const send = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const mapping = parseMapping(options.columnAllowlist);
  const mappingVersion = options.mappingVersion ?? 'unconfigured-v1';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(mappingVersion)) fail('invalid_request');
  function now(): number { const at = clock(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) fail('invalid_request'); return at; }
  function validateInput(raw: MondayReadInput) {
    const input = record(raw); keys(input, ['boardId', 'actorId', 'accessToken', 'expiresAt', 'scopes'], ['signal']);
    if (!(MONDAY_READ_BOARD_IDS as readonly unknown[]).includes(input.boardId)) fail('forbidden_board');
    sourceId(input.actorId); token(input.accessToken);
    if (!Array.isArray(input.scopes) || input.scopes.length !== MONDAY_READ_SCOPES.length || new Set(input.scopes).size !== input.scopes.length || input.scopes.some(scope => !(MONDAY_READ_SCOPES as readonly unknown[]).includes(scope))) fail('scopes_mismatch');
    const expiresAt = sourceDate(input.expiresAt);
    if (!expiresAt || !expiresAt.includes('T') || Date.parse(expiresAt) <= now()) fail('expired');
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('invalid_request');
    return { boardId: input.boardId as MondayBoardId, actorId: input.actorId as string, accessToken: input.accessToken as string, expiresAtMs: Date.parse(expiresAt), signal: input.signal as AbortSignal | undefined };
  }
  async function request(kind: keyof typeof QUERIES, accessToken: string, variables: Row, signal?: AbortSignal): Promise<Row> {
    if (!enabled) fail('disabled');
    if (signal?.aborted) fail('aborted');
    const credential = token(accessToken);
    let response: Response;
    try {
      response = await send(ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: credential, 'API-Version': MONDAY_API_VERSION }, body: JSON.stringify({ query: QUERIES[kind], variables }), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch { fail(signal?.aborted ? 'aborted' : 'offline'); }
    if (signal?.aborted) fail('aborted');
    const wait = retryAfter(response.headers.get('retry-after'), now());
    if (response.status === 429) throw new MondayReadError('rate_limited', wait);
    if (response.status === 401) fail('unauthorized');
    if (response.status === 403) fail('forbidden');
    if (!response.ok) fail('offline');
    if (response.url && response.url !== ENDPOINT || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || response.headers.has('api-version') && response.headers.get('api-version') !== MONDAY_API_VERSION) fail();
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_RESPONSE_BYTES || !response.body) fail();
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let body = ''; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail(); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) { if (error instanceof MondayReadError) throw error; fail(signal?.aborted ? 'aborted' : 'incompatible'); }
    let payload: Row;
    try { payload = record(JSON.parse(body)); } catch { fail(); }
    if (Object.hasOwn(payload, 'errors')) {
      if (!Array.isArray(payload.errors)) fail();
      if (payload.errors.length) {
        const quotaCodes = ['COMPLEXITY_BUDGET_EXHAUSTED', 'ComplexityException', 'DAILY_LIMIT_EXCEEDED', 'IP_RATE_LIMIT_EXCEEDED', 'maxConcurrencyExceeded', 'RATE_LIMIT_EXCEEDED', 'MINUTE_LIMIT_EXCEEDED', 'RateLimitException'];
        let rateLimited = false; let forbidden = false; let unauthorized = false; let seconds = wait;
        for (const error of payload.errors) {
          const row = record(error); const extensions = row.extensions === undefined ? {} : record(row.extensions);
          if (quotaCodes.includes(extensions.code as string)) rateLimited = true;
          if (['UserUnauthorizedException', 'USER_ACCESS_DENIED', 'missingRequiredPermissions'].includes(extensions.code as string)) forbidden = true;
          if (['InvalidTokenException', 'UNAUTHENTICATED', 'Unauthorized'].includes(extensions.code as string)) unauthorized = true;
          const retry = extensions.retry_in_seconds ?? row.retry_in_seconds;
          if (Number.isSafeInteger(retry) && (retry as number) >= 0) seconds = retry as number;
        }
        throw new MondayReadError(rateLimited ? 'rate_limited' : unauthorized ? 'unauthorized' : forbidden ? 'forbidden' : 'provider_partial', seconds);
      }
    }
    if (!Object.hasOwn(payload, 'data')) fail();
    return record(payload.data);
  }
  async function getIdentity(accessToken: string, signal?: AbortSignal): Promise<MondayIdentity> {
    const data = await request('identity', accessToken, {}, signal); keys(data, ['me']);
    const me = record(data.me); keys(me, ['id', 'email']);
    const email = text(me.email, 254).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail();
    return { id: sourceId(me.id), email, readAt: new Date(now()).toISOString() };
  }
  async function verifyBoardAccess(accessToken: string, signal?: AbortSignal): Promise<MondayBoardAccess> {
    const data = await request('boardAccess', accessToken, { boardIds: [...MONDAY_READ_BOARD_IDS] }, signal);
    keys(data, ['boards']);
    if (!Array.isArray(data.boards) || data.boards.length !== MONDAY_READ_BOARD_IDS.length) fail('forbidden_board');
    const ids = data.boards.map(value => {
      const board = record(value); keys(board, ['id']);
      const id = sourceId(board.id);
      if (!(MONDAY_READ_BOARD_IDS as readonly string[]).includes(id)) fail('forbidden_board');
      return id;
    });
    if (new Set(ids).size !== MONDAY_READ_BOARD_IDS.length || MONDAY_READ_BOARD_IDS.some(id => !ids.includes(id))) fail('forbidden_board');
    return { boardIds: Object.freeze([...MONDAY_READ_BOARD_IDS]), readAt: new Date(now()).toISOString() };
  }
  async function read<T extends MondayReadItem | MondayUpdateItem>(raw: MondayReadInput, kind: 'board' | 'updates'): Promise<MondayReadResult<T>> {
    // Invalid envelopes throw a fixed safe error before a board/cursor can be
    // placed into an outbound query. A disabled client never makes a request.
    const input = validateInput(raw);
    const result: MondayReadResult<T> = { status: 'blocked', boardId: input.boardId, mappingVersion, readAt: new Date(now()).toISOString(), pages: 0, items: [] };
    if (!enabled) return { ...result, reason: 'disabled' };
    const columns = mapping[input.boardId];
    if (kind === 'board' && !columns?.length) return { ...result, reason: 'columns_unconfigured' };
    const bound = Object.freeze({ boardId: input.boardId, actorId: input.actorId, mappingVersion, expiresAtMs: Math.min(now() + CURSOR_TTL_MS, input.expiresAtMs) });
    let cursor: string | null = null; const seenCursors = new Set<string>(); const seenItems = new Set<string>(); let updatesTruncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        if (now() >= bound.expiresAtMs) fail('cursor_expired');
        if (bound.boardId !== input.boardId || bound.actorId !== input.actorId || bound.mappingVersion !== mappingVersion) fail('invalid_request');
        const variables: Row = { boardIds: [bound.boardId], cursor, ...(kind === 'board' ? { columnIds: columns!.map(column => column.id) } : {}) };
        const data = await request(kind, input.accessToken, variables, input.signal);
        if (now() >= bound.expiresAtMs) fail('cursor_expired');
        keys(data, ['boards']);
        if (!Array.isArray(data.boards) || data.boards.length !== 1) fail();
        const board = record(data.boards[0]); keys(board, ['id', 'items_page']); if (board.id !== bound.boardId) fail();
        const batch = record(board.items_page); keys(batch, ['cursor', 'items']);
        if (!Array.isArray(batch.items) || batch.items.length > PAGE_SIZE) fail();
        const readAt = new Date(now()).toISOString();
        const rows = batch.items.map(value => {
          const item = record(value); keys(item, ['id', 'updated_at', kind === 'board' ? 'column_values' : 'updates']);
          const id = sourceId(item.id); if (seenItems.has(id)) fail();
          const base = { id, boardId: bound.boardId, sourceUpdatedAt: sourceDate(item.updated_at), readAt };
          if (kind === 'board') {
            if (!Array.isArray(item.column_values) || item.column_values.length !== columns!.length) fail();
            const projected = item.column_values.map(value => {
              const row = record(value); keys(row, ['id', 'type', 'text']);
              const allowed = columns!.find(column => column.id === row.id); if (!allowed || row.type !== allowed.type) fail();
              return { id: allowed.id, field: allowed.field, type: allowed.type, ...commercialText(row.text, allowed) };
            });
            if (new Set(projected.map(column => column.id)).size !== projected.length) fail();
            return { ...base, columns: projected } as T;
          }
          if (!Array.isArray(item.updates) || item.updates.length > 20) fail();
          if (item.updates.length === 20) updatesTruncated = true;
          const updates = item.updates.map(value => { const row = record(value); keys(row, ['id', 'created_at', 'updated_at']); return { id: sourceId(row.id), createdAt: sourceDate(row.created_at), sourceUpdatedAt: sourceDate(row.updated_at), readAt }; });
          if (new Set(updates.map(update => update.id)).size !== updates.length) fail();
          return { ...base, updates } as T;
        });
        const nextCursor = batch.cursor === null ? null : text(batch.cursor, 2048);
        if (nextCursor !== null && (!nextCursor || seenCursors.has(nextCursor))) fail('cursor_cycle');
        if (new Set(rows.map(item => item.id)).size !== rows.length) fail();
        rows.forEach(item => seenItems.add(item.id)); result.items.push(...rows); result.pages++; result.readAt = readAt;
        if (nextCursor === null) return { ...result, status: updatesTruncated ? 'partial' : 'complete', ...(updatesTruncated ? { reason: 'updates_limit' } : {}) };
        seenCursors.add(nextCursor); cursor = nextCursor;
      } catch (error) {
        const failure = safeError(error);
        return { ...result, status: result.pages || failure.code === 'provider_partial' ? 'partial' : 'blocked', reason: failure.code, ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) };
      }
    }
    return { ...result, status: 'partial', reason: 'page_limit' };
  }
  return Object.freeze({ getIdentity, verifyBoardAccess, readBoard: (input: MondayReadInput) => read<MondayReadItem>(input, 'board'), readUpdates: (input: MondayReadInput) => read<MondayUpdateItem>(input, 'updates') });
}
