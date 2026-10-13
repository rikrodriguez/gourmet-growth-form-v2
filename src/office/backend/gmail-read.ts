import { createHash } from 'node:crypto';
import type { AttachmentData, MailboxKey, MessageData, Observation } from './communications-contracts';

// Private and uncomposed: callers must supply each mailbox's own trusted grant.
// Official REST documentation checked 2026-10-12: users.getProfile,
// users.threads.get (full), users.messages and users.messages.attachments.
// No OAuth flow, mailbox discovery, attachment download, draft or send exists here.
const ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 100;
const MAX_PARTS = 100;
const MAX_MIME_DEPTH = 8;

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly' as const;
export type GmailReadInput = { mailbox: MailboxKey; expectedAccountEmail: string; accessToken: string; expiresAt: string; scopes: readonly string[]; threadId: string; signal?: AbortSignal };
export type GmailReadReason = 'disabled' | 'invalid_request' | 'scopes_mismatch' | 'expired' | 'account_mismatch' | 'incompatible' | 'content_unavailable' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'offline' | 'aborted';
export type GmailReadResult = { account: Extract<Observation, { kind: 'account' }>; thread: Extract<Observation, { kind: 'thread' }> };
export type GmailReadClientOptions = { enabled?: boolean; fetch?: typeof fetch; clock?: () => number };
export class GmailReadError extends Error {
  constructor(readonly code: GmailReadReason) { super(`Gmail read unavailable: ${code}.`); this.name = 'GmailReadError'; }
}
type Row = Record<string, unknown>;
function fail(reason: GmailReadReason = 'incompatible'): never { throw new GmailReadError(reason); }
function record(value: unknown, reason: GmailReadReason = 'incompatible'): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(reason);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail(reason);
  }
  return value as Row;
}
function text(value: unknown, maximum = 200, reason: GmailReadReason = 'incompatible'): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(reason);
  return value;
}
function email(value: unknown, reason: GmailReadReason = 'incompatible'): string {
  const result = text(value, 254, reason).trim().toLowerCase();
  // Explicit trim/case policy only: dots and plus suffixes remain identity data.
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(result)) fail(reason);
  const local = result.slice(0, result.indexOf('@'));
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) fail(reason);
  return result;
}
function id(value: unknown, reason: GmailReadReason = 'incompatible'): string {
  const result = text(value, 96, reason);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(result)) fail(reason);
  return result;
}
function version(value: unknown): string {
  const result = text(value, 40); if (!/^[0-9]{1,40}$/.test(result)) fail(); return result;
}
function date(value: unknown): number {
  const result = text(value, 40, 'invalid_request');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) fail('invalid_request');
  if (Number(result.slice(11, 13)) > 23 || Number(result.slice(14, 16)) > 59 || Number(result.slice(17, 19)) > 59 || new Date(`${result.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== result.slice(0, 10)) fail('invalid_request');
  return Date.parse(result);
}
function headerValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) fail('content_unavailable');
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ');
  if (/[\u0000-\u001f\u007f]/.test(unfolded)) fail('content_unavailable');
  return unfolded.trim();
}
function headers(raw: unknown): Map<string, string> {
  if (!Array.isArray(raw) || raw.length > 100) fail('content_unavailable');
  const result = new Map<string, string>();
  for (const entry of raw) {
    const row = record(entry); const name = text(row.name, 96, 'content_unavailable').toLowerCase();
    if (!['from', 'to', 'cc', 'subject', 'content-type'].includes(name)) continue;
    if (result.has(name)) fail('content_unavailable');
    result.set(name, headerValue(row.value));
  }
  return result;
}
function addresses(value: string | undefined, required = false): string[] {
  if (value === undefined || value === '') { if (required) fail('content_unavailable'); return []; }
  // Conservative RFC mailbox subset. Quoted display names and folded lists work;
  // groups/comments/quoted local parts are withheld instead of guessed identities.
  const values: string[] = []; let start = 0; let quoted = false; let escaped = false; let angle = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (['(', ')', ':', ';'].includes(character)) fail('content_unavailable');
    if (character === '<') { if (angle) fail('content_unavailable'); angle = true; }
    if (character === '>') { if (!angle) fail('content_unavailable'); angle = false; }
    if (character === ',' && !angle) { values.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || angle || escaped) fail('content_unavailable');
  values.push(value.slice(start).trim()); if (values.length > 50) fail('content_unavailable');
  const result = values.map(item => {
    const match = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(item);
    if (!match || match[1] && !item.endsWith('>')) fail('content_unavailable');
    return email(match[1] ?? match[2], 'content_unavailable');
  });
  return [...new Set(result)];
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('content_unavailable'); }
}
function subject(value = ''): string {
  const adjacent = value.replace(/(\?=)[ \t]+(?==\?)/g, '$1');
  const decoded = adjacent.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_all, charset: string, encoding: string, encoded: string) => {
    if (!['utf-8', 'us-ascii'].includes(charset.toLowerCase())) fail('content_unavailable');
    let bytes: Uint8Array;
    if (encoding.toLowerCase() === 'b') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('content_unavailable');
      bytes = Buffer.from(encoded, 'base64');
    } else {
      const converted = encoded.replace(/_/g, ' ');
      const values: number[] = [];
      for (let index = 0; index < converted.length; index++) {
        if (converted[index] === '=') {
          const pair = converted.slice(index + 1, index + 3); if (!/^[A-Fa-f0-9]{2}$/.test(pair)) fail('content_unavailable');
          values.push(Number.parseInt(pair, 16)); index += 2;
        } else { const byte = converted.charCodeAt(index); if (byte < 32 || byte > 126) fail('content_unavailable'); values.push(byte); }
      }
      bytes = Uint8Array.from(values);
    }
    if (charset.toLowerCase() === 'us-ascii' && bytes.some(byte => byte > 127)) fail('content_unavailable');
    return utf8(bytes);
  });
  if (decoded.includes('=?')) fail('content_unavailable');
  return text(decoded, 8192, 'content_unavailable');
}
function bodyText(body: Row, contentType?: string): string {
  const charset = contentType?.match(/;\s*charset\s*=\s*(?:"([^";]+)"|([^;\s]+))/i);
  const selected = (charset?.[1] ?? charset?.[2] ?? 'utf-8').toLowerCase();
  if (!['utf-8', 'us-ascii'].includes(selected) || typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_BODY_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)) fail('content_unavailable');
  const normalized = body.data.replace(/=+$/, '');
  const bytes = Buffer.from(normalized, 'base64url');
  if (bytes.length > MAX_BODY_BYTES || bytes.toString('base64url') !== normalized || !Number.isSafeInteger(body.size) || body.size !== bytes.length || selected === 'us-ascii' && bytes.some(byte => byte > 127)) fail('content_unavailable');
  const result = utf8(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) fail('content_unavailable');
  return result;
}
function message(raw: unknown, threadId: string): MessageData {
  const row = record(raw); const messageId = id(row.id);
  if (id(row.threadId) !== threadId) fail();
  const payload = record(row.payload); const topHeaders = headers(payload.headers);
  const attachments: AttachmentData[] = []; const plain: string[] = []; let count = 0;
  function part(rawPart: unknown, depth: number, parentMime = '') {
    if (depth > MAX_MIME_DEPTH || ++count > MAX_PARTS) fail('content_unavailable');
    const current = record(rawPart); const mime = text(current.mimeType, 128, 'content_unavailable').toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) fail('content_unavailable');
    const filename = text(current.filename ?? '', 254, 'content_unavailable'); const body = record(current.body);
    if (filename || body.attachmentId !== undefined) {
      const partId = text(current.partId, 96, 'content_unavailable');
      if (!partId || !/^[A-Za-z0-9._-]+$/.test(partId) || attachments.length >= 25) fail('content_unavailable');
      if (body.attachmentId !== undefined) text(body.attachmentId, 1024, 'content_unavailable');
      attachments.push({ id: `${messageId}:${partId}`, filename, mimeType: mime, sha256: null }); return;
    }
    if (['multipart/mixed', 'multipart/alternative', 'multipart/related'].includes(mime)) {
      if (!Array.isArray(current.parts) || !current.parts.length || current.parts.length > MAX_PARTS) fail('content_unavailable');
      for (const child of current.parts) part(child, depth + 1, mime);
      return;
    }
    if (Array.isArray(current.parts) && current.parts.length || current.parts !== undefined && !Array.isArray(current.parts)) fail('content_unavailable');
    if (mime === 'text/plain') { plain.push(bodyText(body, headers(current.headers ?? []).get('content-type'))); return; }
    if (mime === 'text/html' && parentMime === 'multipart/alternative') return;
    fail('content_unavailable');
  }
  part(payload, 0);
  if (plain.length !== 1 || new Set(attachments.map(attachment => attachment.id)).size !== attachments.length) fail('content_unavailable');
  const from = addresses(topHeaders.get('from'), true); if (from.length !== 1) fail('content_unavailable');
  return { id: messageId, from, to: addresses(topHeaders.get('to')), cc: addresses(topHeaders.get('cc')), subject: subject(topHeaders.get('subject')), bodyText: plain[0], attachments };
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal, caller?: AbortSignal): Promise<T> {
  if (signal.aborted) fail(caller?.aborted ? 'aborted' : 'offline');
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { listener = () => reject(new GmailReadError(caller?.aborted ? 'aborted' : 'offline')); signal.addEventListener('abort', listener, { once: true }); })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}

export function createGmailReadClient(options: GmailReadClientOptions = {}): { readThread(input: GmailReadInput): Promise<GmailReadResult> } {
  const configuration = record(options, 'invalid_request');
  if (Object.keys(configuration).some(key => !['enabled', 'fetch', 'clock'].includes(key)) || options.enabled !== undefined && typeof options.enabled !== 'boolean' || options.fetch !== undefined && typeof options.fetch !== 'function' || options.clock !== undefined && typeof options.clock !== 'function') fail('invalid_request');
  const enabled = options.enabled === true; const send = options.fetch ?? globalThis.fetch; const clock = options.clock ?? Date.now;
  function now() { const at = clock(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) fail('invalid_request'); return at; }
  function validate(raw: GmailReadInput) {
    const row = record(raw, 'invalid_request');
    const required = ['mailbox', 'expectedAccountEmail', 'accessToken', 'expiresAt', 'scopes', 'threadId'];
    if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => ![...required, 'signal'].includes(key)) || !['felipe', 'info'].includes(row.mailbox as string)) fail('invalid_request');
    const expectedEmail = email(row.expectedAccountEmail, 'invalid_request'); const threadId = id(row.threadId, 'invalid_request');
    const token = text(row.accessToken, 8192, 'invalid_request'); if (!token.length || token !== token.trim() || /[^\x21-\x7e]/.test(token)) fail('invalid_request');
    if (!Array.isArray(row.scopes) || row.scopes.length !== 1 || row.scopes[0] !== GMAIL_READ_SCOPE) fail('scopes_mismatch');
    const expiresAtMs = date(row.expiresAt); if (expiresAtMs <= now()) fail('expired');
    if (row.signal !== undefined && !(row.signal instanceof AbortSignal)) fail('invalid_request');
    return { mailbox: row.mailbox as MailboxKey, expectedEmail, threadId, token, expiresAtMs, signal: row.signal as AbortSignal | undefined };
  }
  async function request(url: string, input: ReturnType<typeof validate>): Promise<Row> {
    if (input.signal?.aborted) fail('aborted'); if (input.expiresAtMs <= now()) fail('expired');
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await bounded(send(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` }, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal }), signal, input.signal);
    } catch (error) { if (error instanceof GmailReadError) throw error; fail(input.signal?.aborted ? 'aborted' : 'offline'); }
    if (input.signal?.aborted) fail('aborted');
    if (response.status === 401) fail('unauthorized'); if (response.status === 403) fail('forbidden'); if (response.status === 429) fail('rate_limited'); if (!response.ok) fail('offline');
    if (response.redirected || response.url && response.url !== url || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) fail();
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let raw = ''; let bytes = 0;
    try {
      while (true) {
        const chunk = await bounded(reader.read(), signal, input.signal); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); fail(); }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } catch (error) { void reader.cancel().catch(() => {}); if (error instanceof GmailReadError) throw error; fail(input.signal?.aborted ? 'aborted' : 'incompatible'); }
    try { return record(JSON.parse(raw)); } catch { fail(); }
  }
  return { async readThread(raw) {
    try {
      if (!enabled) fail('disabled');
      const input = validate(raw); const profile = await request(`${ENDPOINT}/profile`, input); const verifiedEmail = email(profile.emailAddress);
      if (verifiedEmail !== input.expectedEmail) fail('account_mismatch');
      const accountId = createHash('sha256').update(verifiedEmail).digest('hex');
      const thread = await request(`${ENDPOINT}/threads/${encodeURIComponent(input.threadId)}?format=full`, input);
      if (id(thread.id) !== input.threadId || !Array.isArray(thread.messages) || !thread.messages.length || thread.messages.length > MAX_MESSAGES) fail();
      const providerVersion = version(thread.historyId); const messages = thread.messages.map(rawMessage => message(rawMessage, input.threadId));
      if (new Set(messages.map(value => value.id)).size !== messages.length) fail();
      if (input.signal?.aborted) fail('aborted'); if (input.expiresAtMs <= now()) fail('expired');
      const observedAtMs = now();
      return {
        account: { kind: 'account', source: 'gmail', sourceKey: `${input.mailbox}:${accountId}`, providerVersion: `identity-v1:${accountId}`, observedAtMs, data: { mailbox: input.mailbox, accountId, email: verifiedEmail, verified: true } },
        thread: { kind: 'thread', source: 'gmail', sourceKey: `${input.mailbox}:${accountId}:${input.threadId}`, providerVersion, observedAtMs, data: { mailbox: input.mailbox, accountId, threadId: input.threadId, messages, coverage: { scope: 'selected_thread', incoming: 'complete', outgoing: 'complete' } } },
      };
    } catch (error) { if (error instanceof GmailReadError) throw error; fail('incompatible'); }
  } };
}
