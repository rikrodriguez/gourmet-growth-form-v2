import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { executeOfficeCommand } from './commands';
import { OfficeError, currentTime, parseOfficeCommand, projectOfficeSnapshot } from './state';
import type { OfficeStore } from './state';
import { DevelopmentSessions, SESSION_COOKIE, SESSION_TTL_MS, authorizeCommand, scopeSnapshot } from './session';
import type { StagingAccess } from './staging';

const ORIGINS = new Set(['http://127.0.0.1:4175', 'http://localhost:4175', 'http://127.0.0.1:4180', 'http://localhost:4180']);
const HOSTS = new Set([...ORIGINS].map(origin => new URL(origin).host));
export function createOfficeApi(store: OfficeStore, options: { clock?: () => number; staging?: StagingAccess; staticRoot?: string } = {}) {
  const clock = options.clock ?? Date.now;
  const sessions = new DevelopmentSessions(clock);
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const staging = options.staging;
    if (staging) {
      reply.header('Strict-Transport-Security', 'max-age=31536000').header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
      if (!staging.authenticated(request.headers.authorization)) {
        reply.header('WWW-Authenticate', 'Basic realm="Gourmet synthetic staging", charset="UTF-8"');
        throw new OfficeError('STAGING_AUTHENTICATION_REQUIRED', 401);
      }
      // Read the original socket peer. Forwarded headers never select a peer or
      // hostname and cannot make an untrusted direct connection trusted.
      if (!staging.trustedPeer(request.raw.socket.remoteAddress)) throw new OfficeError('UNTRUSTED_STAGING_PROXY', 403);
      if (request.headers.host !== staging.host || (request.headers['x-forwarded-host'] !== undefined && request.headers['x-forwarded-host'] !== staging.host)) throw new OfficeError('FORBIDDEN_STAGING_HOST', 403);
      if (request.headers['x-forwarded-proto'] !== 'https' || request.headers.forwarded !== undefined) throw new OfficeError('HTTPS_PROXY_REQUIRED', 403);
    } else if (!HOSTS.has(request.headers.host ?? '') || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new OfficeError('DEVELOPMENT_LOCAL_ONLY', 403);
    const origin = request.headers.origin;
    const allowedOrigin = (value: string) => staging ? value === staging.origin : ORIGINS.has(value);
    if (origin && !allowedOrigin(origin)) throw new OfficeError('FORBIDDEN_ORIGIN', 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (!origin || !allowedOrigin(origin))) throw new OfficeError('FORBIDDEN_ORIGIN', 403);
    if (request.method === 'POST' && request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new OfficeError('JSON_REQUIRED', 415);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OfficeError) return reply.code(error.statusCode).send({ error: error.code });
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: 'INVALID_REQUEST' });
    // Never reflect PostgreSQL, raw request or dependency error messages.
    return reply.code(503).send({ error: 'OFFICE_STORAGE_UNAVAILABLE' });
  });
  app.get('/office-api/health', async () => {
    await store.snapshot();
    return { status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 };
  });
  app.post('/office-api/session', async (request, reply) => {
    // A session never claims storage is healthy before reading it successfully.
    await store.snapshot();
    sessions.remove(request.headers.cookie);
    const scope = options.staging ? stagingScope(request.body, options.staging.role) : request.body;
    const result = sessions.create(scope);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${result.token}; Path=/office-api; HttpOnly; SameSite=Strict${options.staging ? '; Secure' : ''}; Max-Age=${SESSION_TTL_MS / 1000}`);
    return result.session;
  });
  app.get('/office-api/session', async request => sessions.get(request.headers.cookie));
  app.delete('/office-api/session', async (request, reply) => {
    sessions.remove(request.headers.cookie);
    return reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/office-api; HttpOnly; SameSite=Strict${options.staging ? '; Secure' : ''}; Max-Age=0`).code(204).send();
  });
  app.get('/office-api/snapshot', async request => {
    const session = sessions.get(request.headers.cookie);
    return scopeSnapshot(projectOfficeSnapshot(await store.snapshot(), currentTime(clock)), session);
  });
  const command = async (request: FastifyRequest) => {
    const session = sessions.get(request.headers.cookie);
    const parsed = parseOfficeCommand(request.body);
    authorizeCommand(session, parsed);
    const result = await executeOfficeCommand(store, parsed, clock);
    return { snapshot: scopeSnapshot(result.snapshot, session), replayed: result.replayed };
  };
  app.post('/office-api/commands', command);
  app.post('/office-api/command', command);
  if (options.staticRoot) {
    app.register(fastifyStatic, { root: options.staticRoot, prefix: '/office/', index: false, dotfiles: 'deny', cacheControl: false });
    app.get('/', (_request, reply) => reply.redirect('/office/'));
    app.get('/office', (_request, reply) => reply.redirect('/office/'));
    app.get('/office/', (_request, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler((request, reply) => {
      // HTML deep links may use the SPA; missing assets and unknown APIs stay 404.
      const path = new URL(request.url, 'http://office.invalid').pathname;
      if (['GET', 'HEAD'].includes(request.method) && path.startsWith('/office/') && !path.split('/').some(part => part.includes('.')) && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  }
  return app;
}

function stagingScope(value: unknown, maximum: 'viewer' | 'operator') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficeError('INVALID_SESSION_SCOPE');
  const body = value as Record<string, unknown>;
  if (maximum === 'viewer' && body.role !== undefined && body.role !== 'viewer') throw new OfficeError('FORBIDDEN_STAGING_ROLE', 403);
  return { ...body, role: body.role ?? maximum };
}
