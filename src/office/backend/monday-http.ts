import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OfficeError } from './state';
import { MondayOAuthError } from './monday-oauth';
import type { MondayOAuthCallbackParams, MondayOAuthService } from './monday-oauth';
import type { MondayOAuthStatus } from './monday-oauth';
import { getMondayBoardCapabilities } from '../monday-board-catalog';
import { MONDAY_OWNER_CSRF_HEADER, MONDAY_OWNER_LOGIN_COOKIE, MONDAY_OWNER_COOKIE_PATH } from './monday-owner';
import { MONDAY_READ_BOARD_IDS, MONDAY_RECORD_BOARD_IDS } from './monday-read';
import type { MondayBoardId } from './monday-read';
import type { MondayRuntime } from './monday-runtime';
import { isMondayOAuthCallbackStage, mondayOAuthCallbackReason, mondayOAuthErrorReturn, type MondayOAuthCallbackStage, MONDAY_CALLBACK_QUERY_REASONS } from '../monday-oauth-return';

export const MONDAY_CALLBACK_PATH = '/office-api/monday/oauth/callback';
export const MONDAY_OAUTH_NONCE_COOKIE = '__Secure-gourmet-monday-oauth-nonce';
const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function isEnabledMondayCallback(request: FastifyRequest, runtime?: MondayRuntime): boolean {
  return runtime?.enabled === true && runtime.configured && runtime.oauthService !== undefined
    && request.method === 'GET' && request.url.split('?')[0] === MONDAY_CALLBACK_PATH;
}

function nonceCookie(value: string, maxAge = 300) {
  return `${MONDAY_OAUTH_NONCE_COOKIE}=${value}; Path=${MONDAY_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function browserNonce(header: string | undefined) {
  if (!header || header.length > 16_384) throw new MondayOAuthError('oauth_state_invalid', 403);
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${MONDAY_OAUTH_NONCE_COOKIE}=`));
  const value = matches.length === 1 ? matches[0].slice(MONDAY_OAUTH_NONCE_COOKIE.length + 1) : '';
  if (!NONCE.test(value)) throw new MondayOAuthError('oauth_state_invalid', 403);
  return value;
}
function csrf(request: FastifyRequest): string | undefined {
  const value = request.headers[MONDAY_OWNER_CSRF_HEADER];
  return typeof value === 'string' ? value : undefined;
}
function body(request: FastifyRequest, expected: readonly string[]) {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficeError('INVALID_MONDAY_REQUEST');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) throw new OfficeError('INVALID_MONDAY_REQUEST');
  return record;
}
function readInput(request: FastifyRequest): { boardId: MondayBoardId; continuation?: string } {
  const value = body(request, request.body && typeof request.body === 'object' && Object.hasOwn(request.body, 'continuation') ? ['boardId', 'continuation'] : ['boardId']);
  const id = value.boardId;
  if (typeof id !== 'string' || !(MONDAY_RECORD_BOARD_IDS as readonly string[]).includes(id)) throw new OfficeError('FORBIDDEN_MONDAY_BOARD', 403);
  if (Object.hasOwn(value, 'continuation')) {
    const handle = value.continuation;
    if (typeof handle !== 'string' || !NONCE.test(handle) || Buffer.from(handle, 'base64url').toString('base64url') !== handle) throw new OfficeError('INVALID_MONDAY_REQUEST');
    return { boardId: id as MondayBoardId, continuation: handle };
  }
  return { boardId: id as MondayBoardId };
}
function publicStatus(value: MondayOAuthStatus) {
  // The renewal guard is server-only; no owner endpoint exposes its binding.
  const { grantFingerprint: _grantFingerprint, ...result } = value;
  return result;
}
class MondayCallbackQueryError extends Error {
  constructor(readonly reason: typeof MONDAY_CALLBACK_QUERY_REASONS[number]) {
    super('MONDAY_CALLBACK_QUERY_REJECTED');
  }
}
function callbackParams(url: string): MondayOAuthCallbackParams {
  const query = new URL(url, 'https://office.invalid').searchParams;
  // RFC 6749 section 4.1.2 requires ignoring unrecognized response fields.
  // Extract only these protocol fields; discarded metadata never reaches the
  // service, a redirect, persistence, logs or outbound requests.
  const duplicateReasons = {
    state: 'query_duplicate_state', code: 'query_duplicate_code', error: 'query_duplicate_error',
    status: 'query_duplicate_status', error_description: 'query_duplicate_description', scope: 'query_duplicate_scope',
  } as const;
  for (const [field, reason] of Object.entries(duplicateReasons)) {
    if (query.getAll(field).length > 1) throw new MondayCallbackQueryError(reason);
  }
  // Monday documents optional callback scope metadata. It never proves a grant:
  // discard it and keep validating the actual token's exact read-only scopes.
  const scope = query.get('scope');
  if (scope !== null && scope.length > 1024) throw new MondayCallbackQueryError('query_scope_too_long');
  if (scope !== null && /[\u0000-\u001f\u007f]/.test(scope)) throw new MondayCallbackQueryError('query_scope_control');
  // Provider descriptions are intentionally discarded, never logged/reflected.
  if ((query.get('error_description')?.length ?? 0) > 1024) throw new MondayCallbackQueryError('query_description_too_long');
  const state = query.get('state');
  if (state === null) throw new MondayCallbackQueryError('query_state_missing');
  if (state === '') throw new MondayCallbackQueryError('query_state_empty');
  const result: MondayOAuthCallbackParams = { state };
  for (const key of ['code', 'error', 'status'] as const) {
    const value = query.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

export function registerMondayRoutes(app: FastifyInstance, runtime?: MondayRuntime) {
  app.addHook('onReady', async () => { runtime?.renewalScheduler?.start(); });
  app.addHook('onClose', async () => { runtime?.renewalScheduler?.stop(); });
  const available = runtime?.enabled === true && runtime.configured && !!runtime.oauthService;
  const owner = () => {
    if (!available || !runtime) throw new OfficeError('MONDAY_OWNER_UNAVAILABLE', 503);
    return runtime.ownerSessions;
  };
  const service = (): MondayOAuthService => {
    owner();
    return runtime!.oauthService!;
  };
  const authorize = (request: FastifyRequest, mutation = false) => mutation
    ? owner().authorize(request.headers.cookie, csrf(request))
    : owner().authorize(request.headers.cookie);

  app.get('/office-api/monday/owner/session', async request => ({
    available, ...(available ? owner().status(request.headers.cookie) : { authenticated: false }),
  }));
  app.get('/office-api/monday/owner/login', async (_request, reply) => {
    const result = owner().issueLoginChallenge();
    reply.header('Set-Cookie', result.cookie);
    return { csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  });
  app.post('/office-api/monday/owner/login', async (request, reply) => {
    const result = owner().login(request.body, request.headers.cookie, csrf(request));
    reply.header('Set-Cookie', [result.cookie, `${MONDAY_OWNER_LOGIN_COOKIE}=; Path=${MONDAY_OWNER_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]);
    return { principal: result.principal, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  });
  app.post('/office-api/monday/owner/logout', async (request, reply) => {
    body(request, []);
    const cookie = owner().logout(request.headers.cookie, csrf(request));
    return reply.header('Set-Cookie', [cookie, nonceCookie('', 0)]).code(204).send();
  });
  app.get('/office-api/monday/status', async request => {
    authorize(request);
    const current = service();
    return { ...publicStatus(await current.status()), configured: true, allowedBoards: [...MONDAY_READ_BOARD_IDS],
      boardCapabilities: current.getBoardCapabilities?.() ?? getMondayBoardCapabilities({}, 'unconfigured-v1', true) };
  });
  app.post('/office-api/monday/oauth/start', async (request, reply) => {
    const ownerId = authorize(request, true);
    body(request, []);
    const nonce = randomBytes(32).toString('base64url');
    const result = await service().startOAuth({ ownerId, browserNonce: nonce });
    reply.header('Set-Cookie', nonceCookie(nonce));
    return { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt };
  });
  app.get(MONDAY_CALLBACK_PATH, async (request, reply) => {
    // Only this GET may bypass staging Basic Auth. Host, TLS, original peer and
    // Origin checks still run globally. OAuth state + Lax nonce bind the return;
    // Strict owner cookies are deliberately unnecessary on the provider return.
    let stage: MondayOAuthCallbackStage = 'callback_query';
    let reason = mondayOAuthCallbackReason(null);
    try {
      const params = callbackParams(request.url);
      stage = 'callback_nonce';
      const nonce = browserNonce(request.headers.cookie);
      stage = 'callback_state';
      const result = await service().callback(params, nonce, next => {
        if (isMondayOAuthCallbackStage(next)) stage = next;
      });
      // Clear only after state and nonce were validated and the callback finished.
      // An unbound callback must not erase a legitimate browser's live nonce.
      reply.header('Set-Cookie', nonceCookie('', 0));
      if (result.state === 'connected' && result.code === null && !result.pending) return reply.code(303).redirect('/office/monday?oauth=complete');
      reason = mondayOAuthCallbackReason(result.code);
    } catch (error) {
      reason = mondayOAuthCallbackReason(error instanceof MondayCallbackQueryError ? error.reason : error instanceof MondayOAuthError ? error.code : null);
    }
    return reply.code(303).redirect(mondayOAuthErrorReturn(stage, reason));
  });
  app.post('/office-api/monday/refresh', async request => {
    authorize(request, true); body(request, []);
    return publicStatus(await service().refresh());
  });
  app.post('/office-api/monday/disconnect', async request => {
    authorize(request, true); body(request, []);
    return publicStatus(await service().disconnect());
  });
  app.post('/office-api/monday/read-board', async request => {
    authorize(request, true);
    const input = readInput(request);
    return service().readBoard(input.boardId, input.continuation);
  });
  app.post('/office-api/monday/read-updates', async request => {
    authorize(request, true);
    const input = readInput(request);
    return service().readUpdates(input.boardId, input.continuation);
  });
}
