import { MONDAY_API_VERSION, MONDAY_READ_SCOPES } from './monday-read';
import type { Observation } from './communications-contracts';

// Private preparation only. Not composed into the OAuth runtime or any HTTP
// route. The existing commercial projection intentionally remains unchanged.
export const MONDAY_LEAD_BOARD_ID = '18403945258';
export const MONDAY_LEAD_MAPPING_VERSION = 'lead-contact-event-v1';
const COLUMN_IDS = Object.freeze(['email_mm1k9cjw', 'phone_mm1en86x', 'date_mm1ehb3s', 'text_mm1er9bx', 'text_mm1e3hn', 'text_mm1ed0nr']);
const ENDPOINT = 'https://api.monday.com/v2';
const MAX_BYTES = 128 * 1024;
// Typed email is an address; EmailValue.text can instead contain a label and
// address. Names and event text are display data, never matching authorities.
const QUERY = 'query OfficeMondayLeadRead($itemIds: [ID!]!, $columnIds: [String!]!) { items(ids: $itemIds) { id name updated_at board { id } column_values(ids: $columnIds) { id type ... on EmailValue { email } ... on PhoneValue { phone country_short_name } ... on DateValue { date } ... on TextValue { text } } } }';

export type MondayLeadReadInput = { itemId: string; actorId: string; accessToken: string; expiresAt: string; scopes: string[]; signal?: AbortSignal };
export type MondayLeadReadOptions = { enabled?: boolean; fetch?: typeof fetch; clock?: () => number };
export type MondayLeadReadErrorCode = 'disabled' | 'invalid_request' | 'scopes_mismatch' | 'expired' | 'aborted' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'provider_partial' | 'offline' | 'not_found' | 'incompatible';
export class MondayLeadReadError extends Error {
  constructor(readonly code: MondayLeadReadErrorCode) { super(`Monday lead read unavailable: ${code}.`); this.name = 'MondayLeadReadError'; }
}
type Row = Record<string, unknown>;
function fail(code: MondayLeadReadErrorCode = 'incompatible'): never { throw new MondayLeadReadError(code); }
function row(value: unknown): Row {
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
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function id(value: unknown): string { const result = text(value, 30); if (!/^[1-9][0-9]{0,29}$/.test(result)) fail(); return result; }
function date(value: unknown): string {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) fail();
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result)) || Number(result.slice(11, 13)) > 23 || Number(result.slice(14, 16)) > 59 || Number(result.slice(17, 19)) > 59) fail();
  date(result.slice(0, 10)); return result;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value).trim() || null; }
function email(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 254).trim().toLowerCase();
  if (!result) return null;
  const parts = result.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || /[\s<>(),:;"\\\[\]]/.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..') || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(parts[1])) fail();
  return result;
}
function phone(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 40).trim();
  if (!result) return null;
  if (!/^\+?[0-9 ().-]+$/.test(result) || !/[0-9]/.test(result)) fail();
  return result;
}

export function createMondayLeadReadClient(options: MondayLeadReadOptions = {}) {
  const enabled = options.enabled === true;
  const send = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail('invalid_request');
    return value;
  }
  function input(raw: MondayLeadReadInput) {
    let value: Row;
    try {
      value = row(raw); keys(value, ['itemId', 'actorId', 'accessToken', 'expiresAt', 'scopes'], ['signal']);
      id(value.itemId); id(value.actorId);
      if (typeof value.accessToken !== 'string' || !value.accessToken.length || value.accessToken.length > 8192 || /[^\x21-\x7e]/.test(value.accessToken)) fail();
      timestamp(value.expiresAt);
      if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) fail();
    } catch { fail('invalid_request'); }
    let scopes: unknown[];
    try { scopes = array(value.scopes, MONDAY_READ_SCOPES.length); } catch { fail('scopes_mismatch'); }
    if (scopes.length !== MONDAY_READ_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !(MONDAY_READ_SCOPES as readonly unknown[]).includes(scope))) fail('scopes_mismatch');
    const expiresAtMs = Date.parse(value.expiresAt as string);
    if (expiresAtMs <= now()) fail('expired');
    return { itemId: value.itemId as string, accessToken: value.accessToken as string, expiresAtMs, signal: value.signal as AbortSignal | undefined };
  }
  async function readLead(raw: MondayLeadReadInput): Promise<Observation & { kind: 'lead'; source: 'monday' }> {
    const selected = input(raw);
    if (!enabled) fail('disabled');
    if (selected.signal?.aborted) fail('aborted');
    let response: Response;
    try {
      response = await send(ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: selected.accessToken, 'API-Version': MONDAY_API_VERSION }, body: JSON.stringify({ query: QUERY, variables: { itemIds: [selected.itemId], columnIds: [...COLUMN_IDS] } }), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: selected.signal ? AbortSignal.any([selected.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch { fail(selected.signal?.aborted ? 'aborted' : 'offline'); }
    if (selected.signal?.aborted) fail('aborted');
    if (response.status === 401) fail('unauthorized');
    if (response.status === 403) fail('forbidden');
    if (response.status === 429) fail('rate_limited');
    if (!response.ok) fail('offline');
    if (response.url && response.url !== ENDPOINT || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || response.headers.has('api-version') && response.headers.get('api-version') !== MONDAY_API_VERSION || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) fail();
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let body = ''; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); fail(); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) { if (error instanceof MondayLeadReadError) throw error; fail(selected.signal?.aborted ? 'aborted' : 'incompatible'); }
    let payload: Row;
    try { payload = row(JSON.parse(body)); } catch { fail(); }
    keys(payload, [], ['data', 'errors']);
    if (payload.errors !== undefined) {
      const errors = array(payload.errors, 100);
      if (errors.length) {
        const codes = errors.map(error => { const value = row(error); return value.extensions === undefined ? null : row(value.extensions).code; });
        if (codes.some(code => ['InvalidTokenException', 'UNAUTHENTICATED', 'Unauthorized'].includes(code as string))) fail('unauthorized');
        if (codes.some(code => ['UserUnauthorizedException', 'USER_ACCESS_DENIED', 'missingRequiredPermissions'].includes(code as string))) fail('forbidden');
        if (codes.some(code => ['COMPLEXITY_BUDGET_EXHAUSTED', 'ComplexityException', 'DAILY_LIMIT_EXCEEDED', 'IP_RATE_LIMIT_EXCEEDED', 'maxConcurrencyExceeded', 'RATE_LIMIT_EXCEEDED', 'MINUTE_LIMIT_EXCEEDED', 'RateLimitException'].includes(code as string))) fail('rate_limited');
        fail('provider_partial');
      }
    }
    const data = row(payload.data); keys(data, ['items']); const items = array(data.items, 1);
    if (!items.length) fail('not_found');
    const item = row(items[0]); keys(item, ['id', 'name', 'updated_at', 'board', 'column_values']);
    if (id(item.id) !== selected.itemId) fail();
    const board = row(item.board); keys(board, ['id']); if (id(board.id) !== MONDAY_LEAD_BOARD_ID) fail('forbidden');
    const updatedAt = timestamp(item.updated_at); const displayName = text(item.name, 300);
    const columns = new Map<string, Row>();
    for (const rawColumn of array(item.column_values, COLUMN_IDS.length)) {
      const column = row(rawColumn); const columnId = text(column.id, 96);
      if (!COLUMN_IDS.includes(columnId) || columns.has(columnId)) fail();
      columns.set(columnId, column);
    }
    if (columns.size !== COLUMN_IDS.length) fail();
    function column(index: number, type: string, fields: string[]) {
      const value = columns.get(COLUMN_IDS[index])!; keys(value, ['id', 'type', ...fields]);
      if (value.type !== type) fail(); return value;
    }
    const emailColumn = column(0, 'email', ['email']); const phoneColumn = column(1, 'phone', ['phone', 'country_short_name']); const dateColumn = column(2, 'date', ['date']);
    const contactPhone = phone(phoneColumn.phone); const country = phoneColumn.country_short_name === null ? null : text(phoneColumn.country_short_name, 2);
    if (country !== null && !/^[A-Z]{2}$/.test(country) || contactPhone === null && country !== null) fail();
    const eventDate = dateColumn.date === null || dateColumn.date === '' ? null : date(dateColumn.date);
    const observedAtMs = now(); if (selected.signal?.aborted) fail('aborted'); if (selected.expiresAtMs <= observedAtMs) fail('expired');
    return { kind: 'lead', source: 'monday', sourceKey: `${MONDAY_LEAD_BOARD_ID}:${selected.itemId}`, providerVersion: `${updatedAt}:${MONDAY_LEAD_MAPPING_VERSION}`, observedAtMs, data: { boardId: MONDAY_LEAD_BOARD_ID, itemId: selected.itemId, displayName, email: email(emailColumn.email), phone: contactPhone, phoneCountry: country, eventDate, guestsText: nullableText(column(3, 'text', ['text']).text), eventTypeText: nullableText(column(4, 'text', ['text']).text), serviceStyleText: nullableText(column(5, 'text', ['text']).text), mappingVersion: MONDAY_LEAD_MAPPING_VERSION } };
  }
  return Object.freeze({ readLead });
}
