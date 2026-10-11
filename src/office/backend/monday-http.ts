import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OfficeError } from './state';
import { MondayOAuthError } from './monday-oauth';
import type { MondayOAuthCallbackParams, MondayOAuthService } from './monday-oauth';
import { MONDAY_OWNER_CSRF_HEADER, MONDAY_OWNER_LOGIN_COOKIE, MONDAY_OWNER_COOKIE_PATH } from './monday-owner';
import { MONDAY_READ_BOARD_IDS } from './monday-read';
import type { MondayBoardId } from './monday-read';
import type { MondayRuntime } from './monday-runtime';

export const MONDAY_CALLBACK_PATH = '/office-api/monday/oauth/callback';
export const MONDAY_OAUTH_NONCE_COOKIE = '__Secure-gourmet-monday-oauth-nonce';
const RETURN_PATH = '/office/monday';
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
function board(request: FastifyRequest): MondayBoardId {
  const id = body(request, ['boardId']).boardId;
  if (typeof id !== 'string' || !(MONDAY_READ_BOARD_IDS as readonly string[]).includes(id)) throw new OfficeError('FORBIDDEN_MONDAY_BOARD', 403);
  return id as MondayBoardId;
}
function callbackParams(url: string): MondayOAuthCallbackParams {
  const query = new URL(url, 'https://office.invalid').searchParams;
  const fields = ['state', 'code', 'error', 'status', 'error_description'];
  if ([...query.keys()].some(key => !fields.includes(key)) || fields.some(key => query.getAll(key).length > 1)) throw new MondayOAuthError('oauth_state_invalid', 403);
  // Provider descriptions are intentionally discarded, never logged/reflected.
  if ((query.get('error_description')?.length ?? 0) > 1024) throw new MondayOAuthError('oauth_state_invalid', 403);
  const state = query.get('state');
  if (!state) throw new MondayOAuthError('oauth_state_invalid', 403);
  const result: MondayOAuthCallbackParams = { state };
  for (const key of ['code', 'error', 'status'] as const) {
    const value = query.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

export function registerMondayRoutes(app: FastifyInstance, runtime?: MondayRuntime) {
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
    return { ...await service().status(), configured: true, allowedBoards: [...MONDAY_READ_BOARD_IDS] };
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
    let outcome = 'error';
    try {
      const result = await service().callback(callbackParams(request.url), browserNonce(request.headers.cookie));
      if (result.state === 'connected' && result.code === null && !result.pending) outcome = 'complete';
    } catch { /* Fixed redirect only; no raw codes, provider errors or secrets. */ }
    return reply.header('Set-Cookie', nonceCookie('', 0)).code(303).redirect(`${RETURN_PATH}?oauth=${outcome}`);
  });
  app.post('/office-api/monday/refresh', async request => {
    authorize(request, true); body(request, []);
    return service().refresh();
  });
  app.post('/office-api/monday/disconnect', async request => {
    authorize(request, true); body(request, []);
    return service().disconnect();
  });
  app.post('/office-api/monday/read-board', async request => {
    authorize(request, true);
    return service().readBoard(board(request));
  });
  app.post('/office-api/monday/read-updates', async request => {
    authorize(request, true);
    return service().readUpdates(board(request));
  });
}
