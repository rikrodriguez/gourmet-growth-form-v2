import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { validateLeadLinkResponse, type LeadLinkResponseScope } from '../lead-link-response';
import type { LeadLinkView, VerifiedLeadAgreement } from '../lead-link-view-contracts';

export const LEAD_LINK_API = '/api/office/lead-links';
export type LeadLinkIdentity = {
  /** Opaque cache-isolation key supplied by the existing authenticated session. Never a credential. */
  identityKey: string;
  durableIdentity: boolean;
  scope: LeadLinkResponseScope;
  expiresAtMs: number;
  canRead: boolean;
  canOpen?: boolean;
  csrfToken?: string;
  leadIds: readonly string[];
};
export type LeadLinkReadSource = {
  /** Must enforce a trusted account/board/item mapping inside this exact server-owned tenant scope. */
  read(scope: Readonly<LeadLinkResponseScope>, leadId: string): Promise<{ history: LeadLinkView; agreement: VerifiedLeadAgreement | null }>;
};
export type LeadLinkHttpDependencies = {
  /** Existing revocation-aware, server-owned identity only. Called before and after source I/O. Never trust caller identity headers. */
  resolveIdentity(request: FastifyRequest): LeadLinkIdentity | null | Promise<LeadLinkIdentity | null>;
  source: LeadLinkReadSource;
  allowedOrigin: string;
  clock?: () => number;
};
export class LeadLinkHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 503) { super('Lead link request rejected'); }
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RESERVED = new Set(['status', 'session', 'grant', 'grants', 'constructor', 'prototype', '__proto__']);
function fail(status: 400 | 401 | 403 | 404 | 503): never { throw new LeadLinkHttpError(status); }
function securityHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer').header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && !RESERVED.has(value); }
function snapshotIdentity(identity: LeadLinkIdentity | null, now: number): LeadLinkIdentity {
  if (!identity || !identity.scope || !Number.isFinite(now)
    || typeof identity.identityKey !== 'string' || !KEY.test(identity.identityKey)
    || typeof identity.durableIdentity !== 'boolean' || typeof identity.canRead !== 'boolean'
    || identity.canOpen !== undefined && typeof identity.canOpen !== 'boolean'
    || identity.canOpen === true && (typeof identity.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(identity.csrfToken))
    || !['test', 'commercial'].includes(identity.scope.mode)
    || ![identity.scope.organizationId, identity.scope.workspaceId].every(value => typeof value === 'string' && SCOPE_ID.test(value) && !RESERVED.has(value))
    || (identity.scope.mode === 'commercial' && !identity.durableIdentity)
    || !Number.isSafeInteger(identity.expiresAtMs) || identity.expiresAtMs <= now
    || !Array.isArray(identity.leadIds) || identity.leadIds.length > 1_000 || !identity.leadIds.every(validId)) fail(401);
  return {
    identityKey: identity.identityKey, durableIdentity: identity.durableIdentity,
    scope: Object.freeze({ organizationId: identity.scope.organizationId, workspaceId: identity.scope.workspaceId, mode: identity.scope.mode }),
    expiresAtMs: identity.expiresAtMs, canRead: identity.canRead, canOpen: identity.canOpen === true, csrfToken: identity.canOpen ? identity.csrfToken : undefined, leadIds: Object.freeze([...identity.leadIds]),
  };
}

/** Fastify rejects malformed URLs before route hooks. A composing host must install this at creation. */
export const leadLinkFrameworkErrors: NonNullable<FastifyServerOptions['frameworkErrors']> = (error, _request, reply) => {
  securityHeaders(reply);
  const invalidRequest = error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH';
  const response: FastifyReply = reply;
  response.code(invalidRequest ? 400 : 503).send({ error: invalidRequest ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE' });
};

/** Opt-in only. Host must use frameworkErrors: leadLinkFrameworkErrors. No demo/staging registration or writes. */
export function registerLeadLinkRoutes(app: FastifyInstance, dependencies: LeadLinkHttpDependencies): void {
  const origin = new URL(dependencies.allowedOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== dependencies.allowedOrigin) throw new Error('Invalid lead link origin');
  const clock = dependencies.clock ?? Date.now;
  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      securityHeaders(reply);
      const fetchSite = request.headers['sec-fetch-site'];
      if (request.headers.host !== origin.host || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
        || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) fail(403);
      if (request.url.includes('?') || request.raw.url?.includes('?')) fail(400);
      if (request.method === 'GET' && (request.headers['transfer-encoding'] !== undefined
        || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) fail(400);
    });
    routes.setErrorHandler((error, _request, reply) => {
      securityHeaders(reply);
      const status = error instanceof LeadLinkHttpError ? error.status : 503;
      return reply.code(status).send({ error: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED'
        : status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE' });
    });
    routes.setNotFoundHandler((_request, reply) => {
      securityHeaders(reply);
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
    routes.get<{ Params: { leadId: string } }>('/:leadId', { exposeHeadRoute: false }, async request => {
      const leadId = request.params.leadId;
      if (leadId === '') fail(404);
      if (!validId(leadId)) fail(400);
      const identity = snapshotIdentity(await dependencies.resolveIdentity(request), clock());
      if (!identity.canRead) fail(403);
      if (!identity.leadIds.includes(leadId)) fail(404);
      const source = await dependencies.source.read(identity.scope, leadId);
      // Re-resolve after I/O so a logout, revoked grant, or changed tenant cannot release an in-flight response.
      const current = snapshotIdentity(await dependencies.resolveIdentity(request), clock());
      const completedAt = clock();
      if (!Number.isFinite(completedAt) || identity.expiresAtMs <= completedAt || current.expiresAtMs <= completedAt
        || current.identityKey !== identity.identityKey || current.durableIdentity !== identity.durableIdentity
        || current.canOpen !== identity.canOpen || current.csrfToken !== identity.csrfToken
        || current.scope.organizationId !== identity.scope.organizationId || current.scope.workspaceId !== identity.scope.workspaceId
        || current.scope.mode !== identity.scope.mode) fail(401);
      if (!current.canRead) fail(403);
      if (!current.leadIds.includes(leadId)) fail(404);
      return validateLeadLinkResponse({ identityKey: identity.identityKey, scope: identity.scope, leadId,
        history: { ...source.history, links: source.history.links.map(link => ({ ...link, opening: current.canOpen ? link.opening : null })) }, agreement: source.agreement,
        openingSession: { canOpen: current.canOpen === true, csrfToken: current.canOpen ? current.csrfToken! : null, expiresAtMs: Math.min(identity.expiresAtMs,current.expiresAtMs) } });
    });
  }, { prefix: LEAD_LINK_API });
}

/** Local composition for explicit callers and socket-free tests; creates no identity, storage or listener. */
export function createLeadLinkApi(dependencies: LeadLinkHttpDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_024, trustProxy: false, frameworkErrors: leadLinkFrameworkErrors });
  registerLeadLinkRoutes(app, dependencies);
  return app;
}
