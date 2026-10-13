import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EventQuoteError, type EventQuoteService, type QuoteActor, type QuoteScope } from './event-quote-contracts';

export const EVENT_QUOTE_API = '/api/office/event-quotes';
export const EVENT_QUOTE_CSRF_HEADER = 'x-event-quote-csrf';
export type EventQuoteIdentity = { scope: QuoteScope; actor: Omit<QuoteActor, 'expiresAtMs'>; csrfToken: string; expiresAtMs: number };
export type EventQuoteStatusResponse = Awaited<ReturnType<EventQuoteService['status']>> & {
  session: { mode: QuoteScope['mode']; canWrite: boolean; canApprove: boolean; csrfToken: string; expiresAtMs: number };
  externalEffectsEnabled: false;
};
export type EventQuoteHttpDependencies = {
  service: EventQuoteService;
  /** Must resolve an already authenticated, server-owned session. Never a chooser or body/header identity. */
  resolveIdentity(request: FastifyRequest): EventQuoteIdentity | null | Promise<EventQuoteIdentity | null>;
  allowedOrigin: string;
  clock?: () => number;
};
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
function fail(status: number): never { throw new EventQuoteError('REQUEST_REJECTED', status); }
function eventId(request: FastifyRequest): string {
  const id = (request.params as Record<string, string>).eventId;
  if (!ID.test(id) || ['status', 'constructor', 'prototype', '__proto__'].includes(id)) fail(400);
  return id;
}
function equalToken(left: unknown, right: string): boolean {
  return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function identityValid(identity: EventQuoteIdentity, now: number): boolean {
  return !!identity.scope && !!identity.actor && ['test', 'commercial'].includes(identity.scope.mode)
    && [identity.scope.organizationId, identity.scope.workspaceId, identity.actor.actorId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128)
    && typeof identity.actor.durable === 'boolean' && typeof identity.actor.canWrite === 'boolean' && typeof identity.actor.canApprove === 'boolean'
    && (identity.scope.mode !== 'commercial' || identity.actor.durable === true)
    && typeof identity.csrfToken === 'string' && /^[a-zA-Z0-9_-]{16,512}$/.test(identity.csrfToken)
    && Number.isSafeInteger(identity.expiresAtMs) && identity.expiresAtMs > now;
}

/** Opt-in only: no call site in the demo server, staging server, or Dashboard. */
export function registerEventQuoteRoutes(app: FastifyInstance, dependencies: EventQuoteHttpDependencies): void {
  const origin = new URL(dependencies.allowedOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== dependencies.allowedOrigin) throw new Error('Invalid event quote origin');
  const clock = dependencies.clock ?? Date.now;
  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer').header('Content-Security-Policy', CSP);
      if (request.headers.host !== origin.host || request.headers['sec-fetch-site'] === 'cross-site') fail(403);
      if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) fail(403);
      if (request.url.includes('?')) fail(400);
      if (request.method === 'POST') {
        if (request.headers.origin !== origin.origin) fail(403);
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415);
      }
    });
    routes.setErrorHandler((error, _request, reply) => {
      const rawStatus = error instanceof EventQuoteError ? error.status : (error as { statusCode?: number }).statusCode;
      const status = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 503;
      const code = status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'REVISION_CONFLICT' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST';
      return reply.code(status).send({ error: code });
    });
    const authorize = async (request: FastifyRequest) => {
      const identity = await dependencies.resolveIdentity(request);
      if (!identity || !identityValid(identity, clock())) fail(401);
      return { ...identity, actor: { ...identity.actor, expiresAtMs: identity.expiresAtMs } };
    };
    routes.get(`${EVENT_QUOTE_API}/status`, async request => {
      const identity = await authorize(request);
      const status = await dependencies.service.status(identity.scope, identity.actor);
      const result: EventQuoteStatusResponse = { ...status, session: {
        mode: identity.scope.mode, canWrite: identity.actor.canWrite, canApprove: identity.actor.canApprove,
        csrfToken: identity.csrfToken, expiresAtMs: identity.expiresAtMs,
      }, externalEffectsEnabled: false };
      return result;
    });
    routes.get(`${EVENT_QUOTE_API}/:eventId`, async request => {
      const { scope, actor } = await authorize(request);
      return dependencies.service.read(scope, actor, eventId(request));
    });
    routes.post(`${EVENT_QUOTE_API}/:eventId/commands`, { bodyLimit: 65_536 }, async request => {
      const identity = await authorize(request);
      if (!identity.actor.canWrite || !equalToken(request.headers[EVENT_QUOTE_CSRF_HEADER], identity.csrfToken)) fail(403);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400);
      if (['scope', 'actor', 'actorId', 'organizationId', 'workspaceId', 'mode', 'tenantId'].some(key => Object.hasOwn(body, key))) fail(400);
      if ((body as { action?: unknown }).action === 'approve' && !identity.actor.canApprove) fail(403);
      return dependencies.service.execute(identity.scope, identity.actor, eventId(request), body);
    });
    routes.get(`${EVENT_QUOTE_API}/:eventId/quotes/:version/artifact`, async (request, reply) => {
      const { scope, actor } = await authorize(request);
      const id = eventId(request);
      const rawVersion = (request.params as { version: string }).version;
      if (!/^[1-9][0-9]{0,8}$/.test(rawVersion)) fail(404);
      const view = await dependencies.service.read(scope, actor, id);
      const quote = view.record.quotes.find(item => item.version === Number(rawVersion));
      if (!quote) fail(404);
      const artifact = quote.artifact;
      if (artifact.mediaType !== 'text/html; charset=utf-8' || Buffer.byteLength(artifact.html, 'utf8') !== artifact.bytes
        || createHash('sha256').update(artifact.html, 'utf8').digest('hex') !== artifact.sha256) fail(503);
      return reply.header('Content-Disposition', `inline; filename="${id}-v${quote.version}.html"`)
        .type('text/html; charset=utf-8').send(artifact.html);
    });
  });
}

/** A bare, local-composition API. It does not listen, create identities or provision storage. */
export function createEventQuoteApi(dependencies: EventQuoteHttpDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 65_536, trustProxy: false });
  registerEventQuoteRoutes(app, dependencies);
  return app;
}
