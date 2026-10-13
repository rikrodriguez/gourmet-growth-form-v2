import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createGmailReadClient, GmailReadError, GMAIL_READ_SCOPE } from '../../src/office/backend/gmail-read';
import type { GmailReadInput } from '../../src/office/backend/gmail-read';

const AT = Date.parse('2026-10-12T20:00:00.000Z');
const TOKEN = 'synthetic-gmail-access-token';
const EMAIL = 'felipe.office+fixture@example.test';
const THREAD = 'synthetic-thread-001';
const ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const accountId = (email: string) => createHash('sha256').update(email).digest('hex');
function input(extra: Partial<GmailReadInput> = {}): GmailReadInput {
  return { mailbox: 'felipe', expectedAccountEmail: EMAIL, accessToken: TOKEN, expiresAt: '2026-10-12T21:00:00.000Z', scopes: [GMAIL_READ_SCOPE], threadId: THREAD, ...extra };
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
function profile(emailAddress = EMAIL) { return { emailAddress, messagesTotal: 7, threadsTotal: 3, historyId: '900' }; }
function plain(body = 'Synthetic conversation text.') { return { partId: '', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { size: Buffer.byteLength(body), data: Buffer.from(body).toString('base64url') } }; }
function message(id = 'synthetic-message-001') {
  return { id, threadId: THREAD, historyId: '901', internalDate: String(AT - 1000), labelIds: ['INBOX'], snippet: 'omit synthetic snippet', sizeEstimate: 700, payload: { ...plain(), headers: [
    { name: 'From', value: '"Synthetic, Contact" <CONTACT+event@example.test>' }, { name: 'To', value: `Synthetic Office <${EMAIL}>` },
    { name: 'Cc', value: 'assistant@example.test, Other <other@example.test>' }, { name: 'Subject', value: '=?UTF-8?B?U3ludGhldGljIGNhZsOp?=' },
    { name: 'Content-Type', value: 'text/plain; charset=UTF-8' }, { name: 'Received', value: 'synthetic-private-header-marker' },
  ] } };
}
function thread(messages: unknown[] = [message()], extra: Record<string, unknown> = {}) { return { id: THREAD, historyId: '901', messages, ...extra }; }
function fixture(responses: Array<Response | (() => Response)>, options: Parameters<typeof createGmailReadClient>[0] = {}) {
  const requests: Array<{ endpoint: string; init: RequestInit }> = [];
  const fetch = async (endpoint: string | URL | Request, init?: RequestInit) => {
    assert(init); requests.push({ endpoint: String(endpoint), init });
    const response = responses.shift(); assert(response, 'No automatic retry, attachment download or extra request');
    return typeof response === 'function' ? response() : response;
  };
  return { client: createGmailReadClient({ enabled: true, fetch: fetch as typeof globalThis.fetch, clock: () => AT, ...options }), requests };
}
const code = (expected: string) => (error: unknown) => error instanceof GmailReadError && error.code === expected && !String(error).includes(TOKEN);

describe('Gmail private readonly preparation adapter', () => {
  it('defaults to disabled and exposes only a read operation with no outbound work', async () => {
    let calls = 0;
    const client = createGmailReadClient({ fetch: (async () => { calls++; throw new Error(TOKEN); }) as typeof fetch, clock: () => AT });
    await assert.rejects(client.readThread(input()), code('disabled'));
    assert.deepEqual(Object.keys(client), ['readThread']); assert.equal(calls, 0);
  });

  it('verifies the exact profile, performs two fixed GETs and returns selected-thread evidence without secrets or raw headers', async () => {
    const { client, requests } = fixture([json(profile(EMAIL.toUpperCase())), json(thread())]);
    const result = await client.readThread(input({ expectedAccountEmail: ` ${EMAIL.toUpperCase()} ` }));
    const id = accountId(EMAIL);
    assert.deepEqual(result.account, { kind: 'account', source: 'gmail', sourceKey: `felipe:${id}`, providerVersion: `identity-v1:${id}`, observedAtMs: AT, data: { mailbox: 'felipe', accountId: id, email: EMAIL, verified: true } });
    assert.equal(result.thread.sourceKey, `felipe:${id}:${THREAD}`); assert.equal(result.thread.providerVersion, '901');
    assert.equal(result.thread.observedAtMs, AT); assert.deepEqual(result.thread.data.coverage, { scope: 'selected_thread', incoming: 'complete', outgoing: 'complete' });
    assert.deepEqual(result.thread.data.messages, [{ id: 'synthetic-message-001', from: ['contact+event@example.test'], to: [EMAIL], cc: ['assistant@example.test', 'other@example.test'], subject: 'Synthetic café', bodyText: 'Synthetic conversation text.', attachments: [] }]);
    assert.deepEqual(requests.map(request => request.endpoint), [`${ROOT}/profile`, `${ROOT}/threads/${THREAD}?format=full`]);
    for (const request of requests) {
      assert.equal(request.init.method, 'GET'); assert.equal(request.init.body, undefined); assert.equal(request.init.redirect, 'error');
      assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.referrerPolicy, 'no-referrer');
      assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${TOKEN}`); assert(request.init.signal instanceof AbortSignal);
    }
    assert(!/synthetic-private-header-marker|omit synthetic snippet|synthetic-gmail-access-token|internalDate|labelIds/.test(JSON.stringify(result)));
  });

  it('keeps Felipe and Info thread keys separate even when a provider thread ID repeats', async () => {
    const first = fixture([json(profile()), json(thread())]);
    const secondEmail = 'info.office@example.test';
    const second = fixture([json(profile(secondEmail)), json(thread())]);
    const a = await first.client.readThread(input());
    const b = await second.client.readThread(input({ mailbox: 'info', expectedAccountEmail: secondEmail, accessToken: 'synthetic-info-own-grant' }));
    assert.notEqual(a.account.data.accountId, b.account.data.accountId); assert.notEqual(a.thread.sourceKey, b.thread.sourceKey);
    assert.equal(b.thread.data.mailbox, 'info'); assert.equal(b.account.data.email, secondEmail);
  });

  it('does not collapse dots or plus aliases and stops before reading a mismatched account', async () => {
    for (const emailAddress of ['felipeoffice+fixture@example.test', 'felipe.office@example.test', 'info.office@example.test']) {
      const { client, requests } = fixture([json(profile(emailAddress))]);
      await assert.rejects(client.readThread(input()), code('account_mismatch')); assert.equal(requests.length, 1);
    }
  });

  it('rejects unknown fields, alternate hosts, mutating scopes, expiry, malformed identity and paths before fetching', async () => {
    const { client, requests } = fixture([]);
    const cases: unknown[] = [
      { ...input(), endpoint: 'https://other.example.test' }, { ...input(), query: 'client query' }, { ...input(), method: 'POST' },
      input({ mailbox: 'other' as 'felipe' }), input({ expectedAccountEmail: 'Display <office@example.test>' }), input({ threadId: '../other?format=raw' }),
      input({ scopes: [] }), input({ scopes: [GMAIL_READ_SCOPE, 'https://www.googleapis.com/auth/gmail.send'] }), input({ scopes: [GMAIL_READ_SCOPE, GMAIL_READ_SCOPE] }),
      input({ expiresAt: '2026-10-12T19:59:59.000Z' }), input({ expiresAt: '2026-02-30T21:00:00.000Z' }), input({ accessToken: 'synthetic\ninvalid-header' }),
      Object.defineProperty({ ...input() }, 'accessToken', { enumerable: true, get() { throw new Error(TOKEN); } }),
    ];
    for (const value of cases) await assert.rejects(client.readThread(value as GmailReadInput), (error: unknown) => error instanceof GmailReadError && !String(error).includes(TOKEN));
    assert.equal(requests.length, 0);
  });

  it('validates expiration again between profile and thread requests', async () => {
    let now = AT;
    const { client, requests } = fixture([() => { now += 3_600_001; return json(profile()); }], { clock: () => now });
    await assert.rejects(client.readThread(input()), code('expired')); assert.equal(requests.length, 1);
  });

  it('rejects mismatched threads, duplicate messages and absent provider versions', async () => {
    const cases = [thread(undefined, { id: 'other-thread' }), thread(undefined, { historyId: undefined }), thread([message(), message()]), thread([{ ...message(), threadId: 'other-thread' }]), thread([])];
    for (const payload of cases) {
      const { client } = fixture([json(profile()), json(payload)]);
      await assert.rejects(client.readThread(input()), code('incompatible'));
    }
  });

  it('handles multipart plain text and attachment metadata without fetching attachments or claiming their digest', async () => {
    const payload = message();
    payload.payload = { ...payload.payload, mimeType: 'multipart/mixed', body: { size: 0, data: '' }, parts: [
      { partId: '0', mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: [
        { ...plain('Synthetic multipart text.'), partId: '0.0' },
        { partId: '0.1', mimeType: 'text/html', filename: '', headers: [], body: { size: 10, data: Buffer.from('<b>synthetic HTML marker</b>').toString('base64url') } },
      ] },
      { partId: '1', mimeType: 'application/pdf', filename: 'synthetic-event.pdf', headers: [], body: { attachmentId: 'synthetic-attachment-001', size: 140 } },
    ] } as typeof payload.payload;
    const { client, requests } = fixture([json(profile()), json(thread([payload]))]);
    const result = await client.readThread(input());
    assert.equal(result.thread.data.messages[0].bodyText, 'Synthetic multipart text.');
    assert.deepEqual(result.thread.data.messages[0].attachments, [{ id: 'synthetic-message-001:1', filename: 'synthetic-event.pdf', mimeType: 'application/pdf', sha256: null }]);
    assert.equal(requests.length, 2); assert(!JSON.stringify(result).includes('synthetic HTML marker'));
  });

  it('blocks HTML-only, unknown charset, malformed base64 and ambiguous duplicate plain bodies', async () => {
    const variants = [
      { ...plain(), mimeType: 'text/html' },
      { ...plain(), headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }] },
      { ...plain(), body: { size: 3, data: 'bad$' } },
      { ...plain(), mimeType: 'multipart/mixed', parts: [{ ...plain(), partId: '0' }, { ...plain(), partId: '1' }] },
    ];
    for (const variant of variants) {
      const original = message(); const payload = { ...original, payload: { ...variant, headers: [...original.payload.headers.filter(header => header.name !== 'Content-Type'), ...(variant.headers ?? [])] } };
      const { client } = fixture([json(profile()), json(thread([payload]))]);
      await assert.rejects(client.readThread(input()), (error: unknown) => error instanceof GmailReadError && ['content_unavailable', 'incompatible'].includes(error.code));
    }
  });

  it('unfolds safe headers and decodes UTF-8 quoted-printable subjects', async () => {
    const payload = message();
    payload.payload.headers = payload.payload.headers.map(header => header.name === 'Subject' ? { ...header, value: '=?UTF-8?Q?Synthetic_caf=C3=A9?=' } : header.name === 'To' ? { ...header, value: `Office <${EMAIL}>,\r\n second@example.test` } : header);
    const { client } = fixture([json(profile()), json(thread([payload]))]);
    const result = await client.readThread(input()); assert.equal(result.thread.data.messages[0].subject, 'Synthetic café');
    assert.deepEqual(result.thread.data.messages[0].to, [EMAIL, 'second@example.test']);
  });

  it('blocks ambiguous address groups, injected headers and duplicate identity headers', async () => {
    for (const headers of [
      [{ name: 'From', value: 'team: one@example.test, two@example.test;' }],
      [{ name: 'From', value: 'one@example.test\r\nBcc: hidden@example.test' }],
      [{ name: 'From', value: 'one@example.test' }, { name: 'From', value: 'two@example.test' }],
    ]) {
      const payload = message(); payload.payload.headers = [...payload.payload.headers.filter(header => header.name !== 'From'), ...headers];
      const { client } = fixture([json(profile()), json(thread([payload]))]);
      await assert.rejects(client.readThread(input()), code('content_unavailable'));
    }
  });

  it('bounds response bytes, message count, MIME depth and body bytes without returning partial complete evidence', async () => {
    const deep = plain() as Record<string, unknown>;
    let branch = deep;
    for (let index = 0; index < 10; index++) { branch.mimeType = 'multipart/mixed'; const child = plain() as Record<string, unknown>; branch.parts = [child]; branch = child; }
    const hugeText = message(); hugeText.payload.body = plain('x'.repeat(65_537)).body;
    const cases = [json({ excess: 'x'.repeat(524_289) }), json(thread(Array.from({ length: 101 }, (_, index) => message(`synthetic-message-${index}`)))), json(thread([{ ...message(), payload: { ...deep, headers: message().payload.headers } }])), json(thread([hugeText]))];
    for (const response of cases) {
      const { client } = fixture([json(profile()), response]);
      await assert.rejects(client.readThread(input()), (error: unknown) => error instanceof GmailReadError && ['incompatible', 'content_unavailable'].includes(error.code));
    }
  });

  it('sanitizes HTTP, transport and malformed-provider failures and never retries', async () => {
    const marker = 'synthetic-private-provider-marker';
    for (const [status, reason] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [503, 'offline']] as const) {
      const { client, requests } = fixture([json({ message: `${marker}:${TOKEN}` }, status)]);
      await assert.rejects(client.readThread(input()), (error: unknown) => error instanceof GmailReadError && error.code === reason && !String(error).includes(marker) && !JSON.stringify(error).includes(TOKEN));
      assert.equal(requests.length, 1);
    }
    const failed = createGmailReadClient({ enabled: true, clock: () => AT, fetch: (async () => { throw new Error(`${marker}:${TOKEN}`); }) as typeof fetch });
    await assert.rejects(failed.readThread(input()), code('offline'));
    for (const response of [new Response('{bad json', { headers: { 'Content-Type': 'application/json' } }), json(profile(), 200, { 'Content-Type': 'text/html' })]) {
      const { client } = fixture([response]); await assert.rejects(client.readThread(input()), code('incompatible'));
    }
  });

  it('rejects redirected response identities and pre-aborted requests', async () => {
    const response = json(profile()); Object.defineProperty(response, 'url', { value: 'https://other.example.test/profile' });
    const redirected = fixture([response]); await assert.rejects(redirected.client.readThread(input()), code('incompatible'));
    const controller = new AbortController(); controller.abort();
    const { client, requests } = fixture([]); await assert.rejects(client.readThread(input({ signal: controller.signal })), code('aborted'));
    assert.equal(requests.length, 0);
  });
});
