import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CommunicationsError, type createCommunicationsWorkflow } from './communications';
import type { CommunicationsScope } from './communications-contracts';
import { COMMUNICATIONS_API, COMMUNICATIONS_CSRF_HEADER, type CommunicationsReviewView, type CommunicationsSessionView } from '../communications-api-contracts';

type Workflow = ReturnType<typeof createCommunicationsWorkflow>;
export type FixtureCommunicationsDependencies = {
  mode: 'fixture'; storage: 'ephemeral' | 'postgres';
  open: (scope: CommunicationsScope) => Promise<Workflow>;
  clock?: () => number;
};
const COOKIE = 'gourmet_communications_fixture';
const TTL = 15 * 60_000;
const ORIGINS = new Set(['http://127.0.0.1:4175', 'http://localhost:4175', 'http://127.0.0.1:4180', 'http://localhost:4180']);
const HOSTS = new Set([...ORIGINS].map(origin => new URL(origin).host));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TOKEN = /^[a-f0-9]{64}$/;
const hash = (value: string) => createHash('sha256').update(value).digest();
class HttpError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
type Session = { public: CommunicationsSessionView; expiresAtMs: number; workflow: Workflow };
function cookie(value: string, maxAge: number) { return `${COOKIE}=${value}; Path=${COMMUNICATIONS_API}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`; }
function token(request: FastifyRequest) {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length > 16_384) return undefined;
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  const value = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : '';
  return TOKEN.test(value) ? hash(value).toString('hex') : undefined;
}
function local(request: FastifyRequest, reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  // Socket peer, never forwarded headers or a browser-selected tenant, grants
  // this synthetic-only local surface. No CORS permission is emitted.
  if (!LOOPBACK.has(request.raw.socket.remoteAddress ?? '') || !HOSTS.has(request.headers.host ?? '') || request.headers.forwarded !== undefined || request.headers['x-forwarded-host'] !== undefined || request.headers['x-forwarded-for'] !== undefined) throw new HttpError('COMMUNICATIONS_LOCAL_ONLY', 403);
  if (Object.keys(request.query as object).length) throw new HttpError('invalid_request', 400);
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError('COMMUNICATIONS_ORIGIN_REQUIRED', 403);
  const origin = request.headers.origin;
  const sameOrigin = origin !== undefined && ORIGINS.has(origin) && origin === `http://${request.headers.host}`;
  if (origin !== undefined && !sameOrigin || !['GET', 'HEAD'].includes(request.method) && !sameOrigin) throw new HttpError('COMMUNICATIONS_ORIGIN_REQUIRED', 403);
  if (request.method === 'POST' && request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError('COMMUNICATIONS_JSON_REQUIRED', 415);
}

// Explicit opt-in only. This composition cannot activate a live account or
// accept observations, coverage, credentials, scope, actor or approval authority.
export function registerFixtureCommunicationsRoutes(app: FastifyInstance, dependencies?: FixtureCommunicationsDependencies) {
  if (!dependencies) return;
  if (dependencies.mode !== 'fixture' || !['ephemeral', 'postgres'].includes(dependencies.storage) || typeof dependencies.open !== 'function') throw new Error('Invalid fixture communications dependencies');
  const sessions = new Map<string, Session>();
  let opening = 0;
  const clock = dependencies.clock ?? Date.now;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000 - TTL) throw new HttpError('COMMUNICATIONS_UNAVAILABLE', 503); return value; }
  function prune(at: number) { for (const [key, value] of sessions) if (value.expiresAtMs <= at) sessions.delete(key); }
  function session(request: FastifyRequest, csrf = false) {
    prune(now()); const key = token(request); const value = key && sessions.get(key);
    if (!value) throw new HttpError('COMMUNICATIONS_SESSION_REQUIRED', 401);
    if (csrf) {
      const input = request.headers[COMMUNICATIONS_CSRF_HEADER];
      if (typeof input !== 'string' || !TOKEN.test(input) || !timingSafeEqual(hash(input), hash(value.public.csrfToken))) throw new HttpError('COMMUNICATIONS_CSRF_REQUIRED', 403);
    }
    return value;
  }
  async function view(value: Session): Promise<CommunicationsReviewView> {
    const workflow = await value.workflow.view();
    if (value.expiresAtMs <= now()) throw new HttpError('COMMUNICATIONS_SESSION_REQUIRED', 401);
    return { mode: 'fixture', session: structuredClone(value.public), workflow };
  }
  function handler(run: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try { local(request, reply); return await run(request, reply); }
      catch (error) {
        if (error instanceof HttpError) return reply.code(error.status).send({ error: error.code });
        if (error instanceof CommunicationsError) {
          const conflicts = ['revision_conflict', 'draft_changed', 'source_changed', 'source_version_conflict', 'idempotency_conflict'];
          const rules = ['association_mismatch', 'ambiguous', 'explicit_review_required', 'coverage_incomplete', 'attachment_unverified', 'recipient_mismatch'];
          const status = conflicts.includes(error.code) ? 409 : rules.includes(error.code) ? 422 : error.code === 'capacity_exceeded' ? 413 : error.code === 'invalid_request' ? 400 : 503;
          return reply.code(status).send({ error: status === 503 ? 'COMMUNICATIONS_UNAVAILABLE' : error.code });
        }
        return reply.code(503).send({ error: 'COMMUNICATIONS_UNAVAILABLE' });
      }
    };
  }
  app.post(`${COMMUNICATIONS_API}/session`, handler(async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length) throw new HttpError('invalid_request', 400);
    const at = now(); prune(at);
    const existing = token(request); const current = existing && sessions.get(existing);
    if (current) return view(current); // A repeated click never resets work.
    if (sessions.size + opening >= 32) throw new HttpError('COMMUNICATIONS_SESSION_LIMIT', 429);
    opening++;
    try {
      const raw = randomBytes(32).toString('hex'); const csrfToken = randomBytes(32).toString('hex');
      const scope: CommunicationsScope = { organizationId: 'gourmet-communications-fixture', actorId: `fixture-${randomUUID()}`, partition: 'external', dataMode: 'fixture' };
      const workflow = await dependencies.open(structuredClone(scope)); const expiresAtMs = now() + TTL;
      const value: Session = { workflow, expiresAtMs, public: { mode: 'fixture', actorId: scope.actorId, organizationId: scope.organizationId, csrfToken, expiresAt: new Date(expiresAtMs).toISOString(), storage: dependencies.storage, outboundEffects: 0 } };
      const result = await view(value); sessions.set(hash(raw).toString('hex'), value);
      reply.header('Set-Cookie', cookie(raw, TTL / 1000)); return result;
    } finally { opening--; }
  }));
  app.get(`${COMMUNICATIONS_API}/session`, handler(request => structuredClone(session(request).public)));
  app.delete(`${COMMUNICATIONS_API}/session`, handler((request, reply) => {
    session(request, true); sessions.delete(token(request)!);
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  }));
  app.get(COMMUNICATIONS_API, handler(request => view(session(request))));
  for (const [path, method] of [['associations', 'link'], ['drafts', 'saveDraft'], ['approvals', 'approve']] as const) {
    app.post(`${COMMUNICATIONS_API}/${path}`, { bodyLimit: method === 'saveDraft' ? 512 * 1024 : 16_384 }, handler(async request => {
      const value = session(request, true);
      // Authority is checked at admission. An admitted mutation may finish
      // after expiry/logout; neither event rolls back a committed decision.
      // Return its committed projection directly, never a post-commit 401
      // or a second read that could misreport a successful write as failure.
      const workflow = await value.workflow[method](request.body);
      return { mode: 'fixture' as const, session: structuredClone(value.public), workflow };
    }));
  }
  app.addHook('onClose', async () => { sessions.clear(); });
}
