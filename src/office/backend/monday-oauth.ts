import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MondayStore, MondayStoredRecord, MondayVault } from './monday-store';
import { MONDAY_READ_BOARD_IDS, MONDAY_RECORD_BOARD_IDS, MONDAY_READ_SCOPES, type MondayBoardId, type MondayReadClient, type MondayReadItem, type MondayReadResult, type MondayUpdateItem } from './monday-read';
import { withMondayConfigurationDiagnostic, type MondayConfigurationField, type MondayConfigurationReason } from './monday-diagnostics';
import type { MondayOAuthCallbackStage } from '../monday-oauth-return';

export const MONDAY_OWNER_ID = 'ricardo' as const;
// This release authorizes one pilot identity. The account ID is corroborated
// configuration metadata; these scopes do not verify account membership.
export const MONDAY_AUTHORIZED_USER_ID = '78158865' as const;
export const MONDAY_AUTHORIZED_USER_EMAIL = 'info@gourmet-corp.com' as const;
export const MONDAY_CONFIGURED_ACCOUNT_ID = '29907909' as const;
export const MONDAY_OAUTH_ORIGIN = 'https://office-staging.gourmet-corporation.com';
export const MONDAY_OAUTH_CALLBACK = `${MONDAY_OAUTH_ORIGIN}/office-api/monday/oauth/callback`;
export const MONDAY_AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';
export const MONDAY_TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token';
export const MONDAY_REVOKE_URL = 'https://auth.monday.com/oauth_ms/oauth/revoke';
const CONNECTION_KEY = 'monday-connection-ricardo';
const STATE_TTL_MS = 5 * 60_000;
// An acceptance ceiling, not an assumed provider lifetime. Actual expiry comes
// only from exp, and an unsigned claim can shorten availability, never prove IAM.
const MAX_EXPIRY_AHEAD_MS = 366 * 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const OAUTH_CODES = ['disabled', 'configuration_invalid', 'owner_forbidden', 'oauth_state_invalid', 'oauth_state_expired', 'oauth_denied', 'operation_in_progress', 'code_exchange_uncertain', 'token_invalid', 'scope_mismatch', 'identity_mismatch', 'board_access_unverified', 'refresh_uncertain', 'expired', 'not_connected', 'connection_changed', 'revoke_uncertain', 'read_unavailable', 'storage_unavailable'] as const;
export type MondayOAuthCode = typeof OAUTH_CODES[number];
export class MondayOAuthError extends Error {
  constructor(readonly code: MondayOAuthCode, readonly httpStatus = 400) { super(`Monday OAuth unavailable: ${code}.`); this.name = 'MondayOAuthError'; }
}
export type MondayConfiguration = { enabled: false } | {
  enabled: true; clientId: string; clientSecret: string; tokenEncryptionKey: Buffer;
  expectedAccountEmail: string; expectedUserId: string; expectedAccountId: string; redirectUri: typeof MONDAY_OAUTH_CALLBACK;
};
export type MondayOAuthStatus = {
  state: 'disabled' | 'connected' | 'disconnected' | 'error' | 'expired'; code: MondayOAuthCode | null;
  actorId: string | null; accountId: null; accountVerified: false; configuredAccountId: string | null;
  boardAccessVerified: boolean; boardAccessReadAt: string | null; scopes: readonly string[]; expiresAt: string | null;
  connectedAt: string | null; identityReadAt: string | null; lastReadAt: string | null; updatedAt: string | null; pending: boolean;
};
export type MondayOAuthCallbackParams = { state: string; code?: string; error?: string; status?: string };
export type MondayOAuthStart = { authorizationUrl: string; expiresAt: string };
export interface MondayOAuthService {
  status(): Promise<MondayOAuthStatus>;
  startOAuth(input: { ownerId: string; browserNonce: string }): Promise<MondayOAuthStart>;
  callback(params: MondayOAuthCallbackParams, browserNonce: string, onStage?: (stage: MondayOAuthCallbackStage) => void): Promise<MondayOAuthStatus>;
  refresh(): Promise<MondayOAuthStatus>;
  readBoard(boardId: MondayBoardId): Promise<MondayReadResult<MondayReadItem>>;
  readUpdates(boardId: MondayBoardId): Promise<MondayReadResult<MondayUpdateItem>>;
  disconnect(): Promise<MondayOAuthStatus>;
}
export type MondayOAuthOptions = {
  configuration: MondayConfiguration; store: MondayStore; vault: Pick<MondayVault, 'seal' | 'open'>; readClient: MondayReadClient;
  fetch?: typeof fetch; clock?: () => number; requestTimeoutMs?: number;
};

type Row = Record<string, unknown>;
function fail(code: MondayOAuthCode, httpStatus = 400): never { throw new MondayOAuthError(code, httpStatus); }
function row(value: unknown, code: MondayOAuthCode): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail(code);
  }
  return value as Row;
}
function exact(value: Row, required: readonly string[], optional: readonly string[] = [], code: MondayOAuthCode = 'token_invalid'): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail(code);
}
function printable(value: unknown, maximum: number, code: MondayOAuthCode): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value !== value.trim() || /[^\x21-\x7e]/.test(value)) fail(code);
  return value;
}
function callbackField(value: unknown, maximum: number): void {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail('oauth_state_invalid');
}
function identifier(value: unknown, code: MondayOAuthCode): string {
  const result = printable(value, 30, code); if (!/^[1-9][0-9]*$/.test(result)) fail(code); return result;
}
function email(value: unknown, code: MondayOAuthCode): string {
  const result = printable(value, 254, code).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) fail(code); return result;
}
function iso(value: unknown, code: MondayOAuthCode): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return value;
}
function opaque(value: unknown, code: MondayOAuthCode): string {
  const result = printable(value, 43, code); if (!/^[A-Za-z0-9_-]{43}$/.test(result) || Buffer.from(result, 'base64url').length !== 32 || Buffer.from(result, 'base64url').toString('base64url') !== result) fail(code); return result;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function nonceHash(value: unknown): string {
  return hash(opaque(value, 'oauth_state_invalid'));
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}

export function parseMondayConfiguration(env: Readonly<Record<string, string | undefined>>, origin: string): MondayConfiguration {
  const invalid = (field: MondayConfigurationField, reason: MondayConfigurationReason, status = 503) =>
    withMondayConfigurationDiagnostic(new MondayOAuthError('configuration_invalid', status), field, reason);
  const configured = <T>(field: MondayConfigurationField, validate: (value: unknown) => T): T => {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(env, field); }
    catch { throw invalid(field, 'invalid_format'); }
    if (descriptor && !('value' in descriptor)) throw invalid(field, 'invalid_format');
    const value: unknown = descriptor?.value;
    try { return validate(value); }
    catch (error) {
      // The validators below emit fixed MondayOAuthError instances. Preserve
      // their existing codes/statuses and attach metadata without new fields.
      throw withMondayConfigurationDiagnostic(error as MondayOAuthError, field, value === undefined || value === '' ? 'missing' : 'invalid_format');
    }
  };
  // Deliberately return before touching any credential-bearing property.
  let enabled: string | undefined;
  try { enabled = env.MONDAY_OAUTH_ENABLED; }
  catch { throw invalid('MONDAY_OAUTH_ENABLED', 'invalid_format'); }
  if (enabled === undefined || enabled === '' || enabled === 'false') return { enabled: false };
  if (enabled !== 'true') throw invalid('MONDAY_OAUTH_ENABLED', 'invalid_format');
  if (origin !== MONDAY_OAUTH_ORIGIN) throw invalid('OFFICE_STAGING_ORIGIN', 'policy_mismatch');
  const clientId = configured('MONDAY_CLIENT_ID', value => printable(value, 200, 'configuration_invalid'));
  const clientSecret = configured('MONDAY_CLIENT_SECRET', value => printable(value, 4096, 'configuration_invalid'));
  const encoded = configured('MONDAY_TOKEN_ENCRYPTION_KEY', value => printable(value, 44, 'configuration_invalid'));
  const tokenEncryptionKey = Buffer.from(encoded, 'base64');
  if (tokenEncryptionKey.length !== 32 || tokenEncryptionKey.toString('base64') !== encoded) throw invalid('MONDAY_TOKEN_ENCRYPTION_KEY', 'invalid_format');
  const expectedAccountEmail = configured('MONDAY_EXPECTED_ACCOUNT_EMAIL', value => email(value, 'configuration_invalid'));
  const expectedUserId = configured('MONDAY_EXPECTED_USER_ID', value => identifier(value, 'configuration_invalid'));
  const expectedAccountId = configured('MONDAY_EXPECTED_ACCOUNT_ID', value => identifier(value, 'configuration_invalid'));
  if (expectedAccountEmail !== MONDAY_AUTHORIZED_USER_EMAIL) throw invalid('MONDAY_EXPECTED_ACCOUNT_EMAIL', 'policy_mismatch');
  if (expectedUserId !== MONDAY_AUTHORIZED_USER_ID) throw invalid('MONDAY_EXPECTED_USER_ID', 'policy_mismatch');
  if (expectedAccountId !== MONDAY_CONFIGURED_ACCOUNT_ID) throw invalid('MONDAY_EXPECTED_ACCOUNT_ID', 'policy_mismatch');
  return {
    enabled: true, clientId, clientSecret, tokenEncryptionKey, expectedAccountEmail, expectedUserId, expectedAccountId, redirectUri: MONDAY_OAUTH_CALLBACK,
  };
}

function snapshotConfiguration(input: MondayConfiguration): MondayConfiguration {
  const flag = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'enabled') : undefined;
  if (!flag || !('value' in flag) || typeof flag.value !== 'boolean') fail('configuration_invalid', 503);
  if (!flag.value) return { enabled: false };
  const value = row(input, 'configuration_invalid');
  exact(value, ['enabled', 'clientId', 'clientSecret', 'tokenEncryptionKey', 'expectedAccountEmail', 'expectedUserId', 'expectedAccountId', 'redirectUri'], [], 'configuration_invalid');
  if (value.redirectUri !== MONDAY_OAUTH_CALLBACK || !Buffer.isBuffer(value.tokenEncryptionKey) || value.tokenEncryptionKey.length !== 32) fail('configuration_invalid', 503);
  // Freeze the semantic configuration at construction. Neither a mutable
  // caller object nor a browser callback can change its identity/redirect policy.
  return parseMondayConfiguration({
    MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: value.clientId as string, MONDAY_CLIENT_SECRET: value.clientSecret as string,
    MONDAY_TOKEN_ENCRYPTION_KEY: value.tokenEncryptionKey.toString('base64'), MONDAY_EXPECTED_ACCOUNT_EMAIL: value.expectedAccountEmail as string,
    MONDAY_EXPECTED_USER_ID: value.expectedUserId as string, MONDAY_EXPECTED_ACCOUNT_ID: value.expectedAccountId as string,
  }, MONDAY_OAUTH_ORIGIN);
}

type Tokens = { accessToken: string; refreshToken: string; expiresAt: string; scopes: string[] };
type BoardProof = { actorId: string; boardIds: MondayBoardId[]; readAt: string; tokenDigest: string };
type Attempt = { id: string; kind: 'authorize' | 'exchange' | 'refresh' | 'read' | 'revoke'; deadline: number };
type Connection = {
  version: 1; ownerId: typeof MONDAY_OWNER_ID; binding: string; state: Exclude<MondayOAuthStatus['state'], 'disabled'>;
  code: MondayOAuthCode | null; generation: string; tokens: Tokens | null; actorId: string | null; boardProof: BoardProof | null;
  connectedAt: string | null; identityReadAt: string | null; lastReadAt: string | null; updatedAt: string;
  attempt: Attempt | null;
};
type Authorization = { version: 1; ownerId: typeof MONDAY_OWNER_ID; binding: string; nonceHash: string; verifier: string; attemptId: string; createdAt: number; expiresAt: number };

function checkedBoards(value: unknown, code: MondayOAuthCode): MondayBoardId[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== MONDAY_READ_BOARD_IDS.length || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  const boardIds: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string' || !(MONDAY_READ_BOARD_IDS as readonly string[]).includes(descriptor.value)) fail(code);
    boardIds.push(descriptor.value);
  }
  if (new Set(boardIds).size !== MONDAY_READ_BOARD_IDS.length) fail(code);
  return [...MONDAY_READ_BOARD_IDS];
}

function parsedTokens(value: unknown, nowMs: number, previous?: Tokens): Tokens {
  const data = row(value, 'token_invalid');
  // Extra transport metadata cannot supply identity or account proof.
  if (data.token_type !== 'Bearer' || typeof data.scope !== 'string') fail('token_invalid');
  const scopes = data.scope.split(' ');
  if (scopes.length !== MONDAY_READ_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !(MONDAY_READ_SCOPES as readonly string[]).includes(scope))) fail('scope_mismatch');
  const accessToken = printable(data.access_token, 8192, 'token_invalid');
  const refreshToken = printable(data.refresh_token, 8192, 'token_invalid');
  if (previous && (equal(previous.refreshToken, refreshToken) || equal(previous.accessToken, accessToken))) fail('token_invalid');
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail('token_invalid');
  let payload: Row;
  try {
    const bytes = Buffer.from(parts[1], 'base64url');
    if (bytes.toString('base64url') !== parts[1] || bytes.length > 8192) fail('token_invalid');
    payload = row(JSON.parse(bytes.toString('utf8')), 'token_invalid');
  } catch { fail('token_invalid'); }
  const expiryMs = typeof payload.exp === 'number' ? payload.exp * 1000 : NaN;
  if (!Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(expiryMs) || expiryMs <= nowMs || expiryMs - nowMs > MAX_EXPIRY_AHEAD_MS) fail('token_invalid');
  return { accessToken, refreshToken, expiresAt: new Date(expiryMs).toISOString(), scopes: [...MONDAY_READ_SCOPES] };
}

export function createMondayOAuthService(options: MondayOAuthOptions): MondayOAuthService {
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('configuration_invalid', 503);
  const config = snapshotConfiguration(options.configuration);
  const fetcher = options.fetch ?? globalThis.fetch;
  const binding = config.enabled ? hash(JSON.stringify([config.clientId, config.expectedUserId, config.expectedAccountId, config.expectedAccountEmail, config.redirectUri])) : 'disabled';
  const stamp = () => new Date(clock()).toISOString();
  const random = () => randomBytes(32).toString('base64url');
  const disabled: MondayOAuthStatus = { state: 'disabled', code: 'disabled', actorId: null, accountId: null, accountVerified: false, configuredAccountId: null, boardAccessVerified: false, boardAccessReadAt: null, scopes: [], expiresAt: null, connectedAt: null, identityReadAt: null, lastReadAt: null, updatedAt: null, pending: false };
  function enabled(): Extract<MondayConfiguration, { enabled: true }> { if (!config.enabled) fail('disabled', 503); return config; }
  function fresh(): Connection { return { version: 1, ownerId: MONDAY_OWNER_ID, binding, state: 'disconnected', code: null, generation: random(), tokens: null, actorId: null, boardProof: null, connectedAt: null, identityReadAt: null, lastReadAt: null, updatedAt: stamp(), attempt: null }; }
  function decode(stored: MondayStoredRecord): Connection {
    try {
      const value = row(options.vault.open(stored.value, CONNECTION_KEY), 'storage_unavailable');
      exact(value, ['version', 'ownerId', 'binding', 'state', 'code', 'generation', 'tokens', 'actorId', 'boardProof', 'connectedAt', 'identityReadAt', 'lastReadAt', 'updatedAt', 'attempt'], [], 'storage_unavailable');
      if (value.version !== 1 || value.ownerId !== MONDAY_OWNER_ID || value.binding !== binding || !['connected', 'disconnected', 'error', 'expired'].includes(value.state as string)) fail('storage_unavailable');
      opaque(value.generation, 'storage_unavailable'); iso(value.updatedAt, 'storage_unavailable');
      if (value.code !== null && !(OAUTH_CODES as readonly unknown[]).includes(value.code)) fail('storage_unavailable');
      for (const key of ['connectedAt', 'identityReadAt', 'lastReadAt']) if (value[key] !== null) iso(value[key], 'storage_unavailable');
      if (value.attempt !== null) {
        const attempt = row(value.attempt, 'storage_unavailable'); exact(attempt, ['id', 'kind', 'deadline'], [], 'storage_unavailable'); opaque(attempt.id, 'storage_unavailable');
        if (!['authorize', 'exchange', 'refresh', 'read', 'revoke'].includes(attempt.kind as string) || !Number.isSafeInteger(attempt.deadline)) fail('storage_unavailable');
      }
      if (value.tokens !== null) {
        const tokens = row(value.tokens, 'storage_unavailable'); exact(tokens, ['accessToken', 'refreshToken', 'expiresAt', 'scopes'], [], 'storage_unavailable');
        printable(tokens.accessToken, 8192, 'storage_unavailable'); printable(tokens.refreshToken, 8192, 'storage_unavailable'); iso(tokens.expiresAt, 'storage_unavailable');
        if (!Array.isArray(tokens.scopes) || JSON.stringify(tokens.scopes) !== JSON.stringify(MONDAY_READ_SCOPES)) fail('storage_unavailable');
        if (value.actorId !== (config.enabled ? config.expectedUserId : null)) fail('storage_unavailable');
        for (const key of ['connectedAt', 'identityReadAt']) iso(value[key], 'storage_unavailable');
        const proof = row(value.boardProof, 'storage_unavailable'); exact(proof, ['actorId', 'boardIds', 'readAt', 'tokenDigest'], [], 'storage_unavailable');
        if (proof.actorId !== value.actorId || proof.tokenDigest !== hash(tokens.accessToken as string)) fail('storage_unavailable');
        checkedBoards(proof.boardIds, 'storage_unavailable'); iso(proof.readAt, 'storage_unavailable');
      } else if (value.state === 'connected' || value.state === 'expired' || value.boardProof !== null || value.actorId !== null || value.connectedAt !== null || value.identityReadAt !== null || value.lastReadAt !== null) fail('storage_unavailable');
      return value as Connection;
    } catch { fail('storage_unavailable', 503); }
  }
  async function raw(): Promise<{ record: Connection; revision: MondayStoredRecord['revision'] | null }> {
    try { const stored = await options.store.read(CONNECTION_KEY); return stored ? { record: decode(stored), revision: stored.revision } : { record: fresh(), revision: null }; }
    catch { fail('storage_unavailable', 503); }
  }
  async function cas(revision: MondayStoredRecord['revision'] | null, value: Connection): Promise<boolean> {
    try { return await options.store.compareAndSet(CONNECTION_KEY, revision, options.vault.seal(value, CONNECTION_KEY)); }
    catch { fail('storage_unavailable', 503); }
  }
  function project(value: Connection): MondayOAuthStatus {
    const expired = value.tokens !== null && Date.parse(value.tokens.expiresAt) <= clock();
    return { state: expired ? 'expired' : value.state, code: expired ? 'expired' : value.code, actorId: value.actorId, accountId: null, accountVerified: false, configuredAccountId: config.enabled ? config.expectedAccountId : null, boardAccessVerified: value.tokens !== null && value.boardProof !== null, boardAccessReadAt: value.boardProof?.readAt ?? null, scopes: value.tokens ? [...value.tokens.scopes] : [], expiresAt: value.tokens?.expiresAt ?? null, connectedAt: value.connectedAt, identityReadAt: value.identityReadAt, lastReadAt: value.lastReadAt, updatedAt: value.updatedAt, pending: value.attempt !== null };
  }
  function terminal(value: Connection, code: MondayOAuthCode): Connection {
    return { ...value, state: value.tokens ? (Date.parse(value.tokens.expiresAt) <= clock() ? 'expired' : 'connected') : code === 'revoke_uncertain' ? 'disconnected' : 'error', code, attempt: null, updatedAt: stamp() };
  }
  async function current(): Promise<Awaited<ReturnType<typeof raw>>> {
    // Pending records are never replayed. A bounded lease allows a live worker
    // in another process to finish; after a restart its expiry records uncertainty.
    for (let retry = 0; retry < 4; retry++) {
      const result = await raw(); const attempt = result.record.attempt;
      if (!attempt || attempt.deadline > clock()) return result;
      const code: MondayOAuthCode = attempt.kind === 'refresh' ? 'refresh_uncertain' : attempt.kind === 'revoke' ? 'revoke_uncertain' : attempt.kind === 'read' ? 'read_unavailable' : attempt.kind === 'authorize' ? 'oauth_state_expired' : 'code_exchange_uncertain';
      if (await cas(result.revision, terminal(result.record, code))) continue;
    }
    fail('operation_in_progress', 409);
  }
  async function finish(attemptId: string, update: (record: Connection) => Connection): Promise<MondayOAuthStatus> {
    const result = await current();
    if (result.record.attempt?.id !== attemptId) fail('connection_changed', 409);
    if (!await cas(result.revision, { ...update(result.record), updatedAt: stamp(), attempt: null })) fail('connection_changed', 409);
    return project((await raw()).record);
  }
  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([action(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MondayOAuthError('code_exchange_uncertain', 502)); }, timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function post(endpoint: string, body: Row): Promise<unknown> {
    return bounded(async signal => {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal });
      if (!response.ok || response.url && response.url !== endpoint || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('token_invalid', 502);
      if (response.headers.get('content-length') && Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) fail('token_invalid', 502);
      if (!response.body) fail('token_invalid', 502);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('token_invalid', 502); } chunks.push(next.value); }
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { fail('token_invalid', 502); }
    });
  }
  async function verify(tokens: Tokens, onStage?: (stage: MondayOAuthCallbackStage) => void): Promise<{ actorId: string; identityReadAt: string; boardProof: BoardProof }> {
    const cfg = enabled();
    onStage?.('identity_check');
    const identity = row(await bounded(signal => options.readClient.getIdentity(tokens.accessToken, signal)), 'identity_mismatch');
    exact(identity, ['id', 'email', 'readAt'], [], 'identity_mismatch');
    if (identifier(identity.id, 'identity_mismatch') !== cfg.expectedUserId || email(identity.email, 'identity_mismatch') !== cfg.expectedAccountEmail) fail('identity_mismatch', 403);
    const identityReadAt = iso(identity.readAt, 'identity_mismatch');
    if (Date.parse(identityReadAt) > clock() + 30_000 || Date.parse(identityReadAt) < clock() - STATE_TTL_MS) fail('identity_mismatch', 403);
    let proof: Row;
    onStage?.('board_access_check');
    try { proof = row(await bounded(signal => options.readClient.verifyBoardAccess(tokens.accessToken, signal)), 'board_access_unverified'); }
    catch { fail('board_access_unverified', 403); }
    exact(proof, ['boardIds', 'readAt'], [], 'board_access_unverified');
    const boardIds = checkedBoards(proof.boardIds, 'board_access_unverified');
    const readAt = iso(proof.readAt, 'board_access_unverified');
    if (Date.parse(readAt) > clock() + 30_000 || Date.parse(readAt) < clock() - STATE_TTL_MS) fail('board_access_unverified', 403);
    return { actorId: cfg.expectedUserId, identityReadAt, boardProof: { actorId: cfg.expectedUserId, boardIds, readAt, tokenDigest: hash(tokens.accessToken) } };
  }
  async function read<T>(boardId: MondayBoardId, kind: 'readBoard' | 'readUpdates'): Promise<MondayReadResult<T>> {
    enabled(); if (!(MONDAY_RECORD_BOARD_IDS as readonly string[]).includes(boardId)) fail('read_unavailable', 403);
    const result = await current(); const previous = result.record;
    if (previous.attempt) fail('operation_in_progress', 409);
    if (!previous.tokens || previous.state !== 'connected') fail('not_connected', 409);
    if (Date.parse(previous.tokens.expiresAt) <= clock()) fail('expired', 409);
    const attempt: Attempt = { id: random(), kind: 'read', deadline: clock() + timeoutMs + 1000 };
    if (!await cas(result.revision, { ...previous, attempt, updatedAt: stamp() })) fail('operation_in_progress', 409);
    try {
      const response = await bounded<MondayReadResult<MondayReadItem | MondayUpdateItem>>(signal => options.readClient[kind]({ boardId, actorId: previous.actorId!, accessToken: previous.tokens!.accessToken, expiresAt: previous.tokens!.expiresAt, scopes: [...previous.tokens!.scopes], signal }));
      await finish(attempt.id, value => ({ ...value, code: null, lastReadAt: stamp() }));
      return response as MondayReadResult<T>;
    } catch (error) {
      if (error instanceof MondayOAuthError && error.code === 'connection_changed') throw error;
      await finish(attempt.id, value => terminal(value, 'read_unavailable')); fail('read_unavailable', 502);
    }
  }
  return {
    async status() { if (!config.enabled) return { ...disabled, scopes: [] }; return project((await current()).record); },
    async startOAuth(input) {
      const cfg = enabled(); const checked = row(input, 'oauth_state_invalid'); exact(checked, ['ownerId', 'browserNonce'], [], 'oauth_state_invalid');
      if (checked.ownerId !== MONDAY_OWNER_ID) fail('owner_forbidden', 403);
      const browserHash = nonceHash(checked.browserNonce); const previous = await current();
      if (previous.record.attempt) fail('operation_in_progress', 409);
      const state = random(); const verifier = random(); const attemptId = random(); const createdAt = clock(); const expiresAt = createdAt + STATE_TTL_MS;
      const attempt: Attempt = { id: attemptId, kind: 'authorize', deadline: expiresAt };
      if (!await cas(previous.revision, { ...previous.record, code: null, attempt, updatedAt: stamp() })) fail('operation_in_progress', 409);
      const key = `monday-oauth-state-${hash(state)}`;
      const authorization: Authorization = { version: 1, ownerId: MONDAY_OWNER_ID, binding, nonceHash: browserHash, verifier, attemptId, createdAt, expiresAt };
      try { if (!await options.store.compareAndSet(key, null, options.vault.seal(authorization, key))) fail('storage_unavailable', 503); }
      catch { await finish(attemptId, value => terminal(value, 'storage_unavailable')); fail('storage_unavailable', 503); }
      const url = new URL(MONDAY_AUTHORIZE_URL);
      for (const [key, value] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: MONDAY_READ_SCOPES.join(' '), state, code_challenge: hash(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
      return { authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
    },
    async callback(params, browserNonce, onStage) {
      const reportStage = (stage: MondayOAuthCallbackStage) => {
        try { onStage?.(stage); } catch { /* Request-local diagnostics never change OAuth. */ }
      };
      reportStage('callback_state');
      const cfg = enabled(); const checked = row(params, 'oauth_state_invalid'); exact(checked, ['state'], ['code', 'error', 'status'], 'oauth_state_invalid');
      const state = opaque(checked.state, 'oauth_state_invalid'); const browserHash = nonceHash(browserNonce);
      if (checked.status !== undefined) callbackField(checked.status, 100);
      if (checked.error !== undefined) callbackField(checked.error, 200);
      if (checked.code !== undefined) printable(checked.code, 4096, 'oauth_state_invalid');
      const key = `monday-oauth-state-${hash(state)}`; let saved: MondayStoredRecord | null; let authorization: Authorization;
      try {
        saved = await options.store.read(key); if (!saved) fail('oauth_state_invalid');
        const value = row(options.vault.open(saved.value, key), 'oauth_state_invalid');
        exact(value, ['version', 'ownerId', 'binding', 'nonceHash', 'verifier', 'attemptId', 'createdAt', 'expiresAt'], [], 'oauth_state_invalid');
        if (value.version !== 1 || value.ownerId !== MONDAY_OWNER_ID || value.binding !== binding || !equal(value.nonceHash as string, browserHash)) fail('oauth_state_invalid');
        opaque(value.verifier, 'oauth_state_invalid'); opaque(value.attemptId, 'oauth_state_invalid');
        if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) - (value.createdAt as number) !== STATE_TTL_MS) fail('oauth_state_invalid');
        authorization = value as Authorization;
      } catch (error) { if (error instanceof MondayOAuthError) throw error; fail('oauth_state_invalid'); }
      // Compare-and-delete wins once, before any token endpoint or identity call.
      let consumed: boolean;
      try { consumed = await options.store.compareAndSet(key, saved.revision, null); }
      catch { fail('storage_unavailable', 503); }
      if (!consumed) fail('oauth_state_invalid');
      if (authorization.expiresAt <= clock()) { await current(); fail('oauth_state_expired'); }
      const connection = await current();
      if (connection.record.attempt?.id !== authorization.attemptId || connection.record.attempt.kind !== 'authorize') fail('oauth_state_invalid');
      reportStage('provider_decision');
      if (checked.error !== undefined || checked.code === undefined) {
        try { return await finish(authorization.attemptId, value => terminal(value, 'oauth_denied')); }
        catch (error) { reportStage('persist_connection'); throw error; }
      }
      const attempt: Attempt = { id: authorization.attemptId, kind: 'exchange', deadline: clock() + timeoutMs * 3 + 1000 };
      reportStage('persist_connection');
      if (!await cas(connection.revision, { ...connection.record, attempt, updatedAt: stamp() })) fail('connection_changed', 409);
      reportStage('token_exchange');
      try {
        const response = await post(MONDAY_TOKEN_URL, { grant_type: 'authorization_code', client_id: cfg.clientId, client_secret: cfg.clientSecret, code: checked.code, redirect_uri: cfg.redirectUri, code_verifier: authorization.verifier });
        reportStage('token_response');
        const tokens = parsedTokens(response, clock());
        const identity = await verify(tokens, reportStage);
        reportStage('persist_connection');
        return await finish(attempt.id, value => ({ ...value, ...identity, state: 'connected', code: null, generation: random(), tokens, connectedAt: stamp(), lastReadAt: null }));
      } catch (error) {
        if (error instanceof MondayOAuthError && error.code === 'connection_changed') throw error;
        const code = error instanceof MondayOAuthError ? error.code : 'code_exchange_uncertain';
        try { return await finish(attempt.id, value => terminal(value, code)); }
        catch (cleanupError) { reportStage('persist_connection'); throw cleanupError; }
      }
    },
    async refresh() {
      const cfg = enabled(); const result = await current(); const previous = result.record;
      if (previous.attempt) fail('operation_in_progress', 409);
      if (!previous.tokens || !['connected', 'expired'].includes(previous.state)) fail('not_connected', 409);
      const attempt: Attempt = { id: random(), kind: 'refresh', deadline: clock() + timeoutMs * 3 + 1000 };
      // Remove both tokens durably before dispatch; a crash cannot retry a
      // refresh token whose rotation outcome is unknown.
      if (!await cas(result.revision, { ...fresh(), generation: previous.generation, state: 'disconnected', code: 'operation_in_progress', attempt })) fail('operation_in_progress', 409);
      try {
        const tokens = parsedTokens(await post(MONDAY_TOKEN_URL, { grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: previous.tokens.refreshToken }), clock(), previous.tokens);
        const identity = await verify(tokens);
        return await finish(attempt.id, value => ({ ...value, ...identity, state: 'connected', code: null, tokens, generation: random(), connectedAt: previous.connectedAt, lastReadAt: previous.lastReadAt }));
      } catch (error) {
        if (error instanceof MondayOAuthError && error.code === 'connection_changed') throw error;
        return finish(attempt.id, value => terminal(value, 'refresh_uncertain'));
      }
    },
    readBoard(boardId) { return read<MondayReadItem>(boardId, 'readBoard'); },
    readUpdates(boardId) { return read<MondayUpdateItem>(boardId, 'readUpdates'); },
    async disconnect() {
      const cfg = enabled(); const result = await current(); const previous = result.record;
      if (previous.attempt?.kind === 'revoke') fail('operation_in_progress', 409);
      const attempt: Attempt = { id: random(), kind: 'revoke', deadline: clock() + timeoutMs * 2 + 1000 };
      // Disconnect invalidates all in-flight completions and discards local
      // credentials even if the provider cannot confirm remote revocation.
      if (!await cas(result.revision, { ...fresh(), attempt })) fail('operation_in_progress', 409);
      let uncertain = previous.attempt?.kind === 'exchange' || previous.attempt?.kind === 'refresh';
      if (previous.tokens) for (const [token, hint] of [[previous.tokens.refreshToken, 'refresh_token'], [previous.tokens.accessToken, 'access_token']]) {
        try { const response = row(await post(MONDAY_REVOKE_URL, { token, client_id: cfg.clientId, client_secret: cfg.clientSecret, token_type_hint: hint }), 'revoke_uncertain'); if (response.success !== true) uncertain = true; }
        catch { uncertain = true; }
      }
      return finish(attempt.id, value => ({ ...value, state: 'disconnected', code: uncertain ? 'revoke_uncertain' : null }));
    },
  };
}
