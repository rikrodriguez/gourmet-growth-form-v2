import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hashSessionToken,
  hashStaffPassword,
  isAcceptablePassword,
  isValidStaffEmail,
  issueSessionToken,
  normalizeStaffEmail,
  verifyStaffPassword,
} from './auth';
import type { DashboardConfig } from './config';
import type { AuthenticatedStaff, DashboardStore } from './contracts';
import { InvalidDashboardFilterError, parseListFilters, parseReportingRange } from './filters';

type DashboardAppDependencies = {
  config: DashboardConfig;
  store: DashboardStore;
  serveStatic?: boolean;
};

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export async function buildDashboardApp({ config, store, serveStatic = true }: DashboardAppDependencies): Promise<FastifyInstance> {
  const authenticated = new WeakMap<FastifyRequest, AuthenticatedStaff>();
  const app = Fastify({
    logger: {
      level: config.environment === 'test' ? 'silent' : 'info',
      serializers: { req: (request) => ({ method: request.method, url: request.routeOptions?.url ?? request.url.split('?')[0] }) },
    },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: 32_768,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', request.url.startsWith('/v1/admin/') ? 'no-store' : 'no-cache');
    if (request.method !== 'POST') return;
    const origin = request.headers.origin;
    if (origin !== config.origin) return reply.code(403).send({ error: 'origin_not_allowed' });
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_content_type_required' });
    }
  });

  const requireStaff = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[config.cookieName];
    if (!token || token.length > 128) return reply.code(401).send({ error: 'unauthorized' });
    const staff = await store.authenticateStaff(hashSessionToken(token));
    if (!staff) return reply.code(401).send({ error: 'unauthorized' });
    authenticated.set(request, staff);
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InvalidDashboardFilterError) {
      return reply.code(400).send({ error: 'invalid_filter', request_id: request.id });
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 429) return reply.code(429).send({ error: 'rate_limited', request_id: request.id });
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: 'invalid_request', request_id: request.id });
    request.log.error({ error_name: error instanceof Error ? error.name : 'UnknownError' }, 'dashboard_request_failed');
    return reply.code(503).send({ error: 'service_unavailable', request_id: request.id });
  });

  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await store.health();
      return reply.send({ status: 'ok', database: 'connected', version: '0.1.0', git_sha: config.gitSha });
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unavailable', version: '0.1.0', git_sha: config.gitSha });
    }
  });

  const dummyHash = await hashStaffPassword('invalid-password-value-used-only-for-constant-work');

  app.post('/v1/admin/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === 'string' ? normalizeStaffEmail(body.email) : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const emailValid = isValidStaffEmail(email);
    const passwordValid = isAcceptablePassword(password);
    const user = emailValid ? await store.findStaffByEmail(email) : null;
    const passwordMatches = await verifyStaffPassword(user?.passwordHash ?? dummyHash, password);
    if (!emailValid || !passwordValid || !user || !user.enabled || !passwordMatches) {
      request.log.info({ action: 'staff_login', success: false, request_id: request.id }, 'staff_auth_event');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const { token, tokenHash } = issueSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000);
    await store.rotateStaffSession(user.staffUserId, tokenHash, expiresAt);
    await store.recordLogin(user.staffUserId);
    reply.setCookie(config.cookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });
    request.log.info({ staff_user_id: user.staffUserId, action: 'staff_login', success: true, request_id: request.id }, 'staff_auth_event');
    return reply.send({ user: { staff_user_id: user.staffUserId, email: user.email, role: user.role }, expires_at: expiresAt.toISOString() });
  });

  app.post('/v1/admin/auth/logout', { preHandler: requireStaff }, async (request, reply) => {
    const token = request.cookies[config.cookieName]!;
    const staff = authenticated.get(request)!;
    await store.revokeStaffSession(hashSessionToken(token));
    reply.clearCookie(config.cookieName, { path: '/', secure: true, sameSite: 'strict', httpOnly: true });
    request.log.info({ staff_user_id: staff.staffUserId, action: 'staff_logout', success: true, request_id: request.id }, 'staff_auth_event');
    return reply.code(204).send();
  });

  app.get('/v1/admin/auth/me', { preHandler: requireStaff }, async (request) => {
    const staff = authenticated.get(request)!;
    return { user: { staff_user_id: staff.staffUserId, email: staff.email, role: staff.role }, expires_at: staff.expiresAt };
  });

  app.get('/v1/admin/overview', { preHandler: requireStaff }, async (request) => ({
    ...(await store.overview(parseReportingRange(request.query as Record<string, unknown>), config.abandonmentGraceMinutes)),
    reporting_timezone: config.reportingTimezone,
    git_sha: config.gitSha,
  }));
  app.get('/v1/admin/funnel', { preHandler: requireStaff }, async (request) =>
    store.funnel(parseReportingRange(request.query as Record<string, unknown>)));
  app.get('/v1/admin/sessions', { preHandler: requireStaff }, async (request) =>
    store.sessions(parseListFilters(request.query as Record<string, unknown>), config.abandonmentGraceMinutes));
  app.get('/v1/admin/sessions/:sessionId', { preHandler: requireStaff }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId;
    if (!isUuid(sessionId)) throw new InvalidDashboardFilterError('Invalid session id.');
    const range = parseReportingRange(request.query as Record<string, unknown>);
    const detail = await store.sessionDetail(sessionId, range.includeQa, config.abandonmentGraceMinutes);
    return detail ?? reply.code(404).send({ error: 'session_not_found' });
  });
  app.get('/v1/admin/leads', { preHandler: requireStaff }, async (request) =>
    store.leads(parseListFilters(request.query as Record<string, unknown>)));
  app.get('/v1/admin/leads/:leadId', { preHandler: requireStaff }, async (request, reply) => {
    const leadId = (request.params as { leadId?: string }).leadId;
    if (!isUuid(leadId)) throw new InvalidDashboardFilterError('Invalid lead id.');
    const range = parseReportingRange(request.query as Record<string, unknown>);
    const detail = await store.leadDetail(leadId, range.includeQa);
    return detail ?? reply.code(404).send({ error: 'lead_not_found' });
  });
  app.get('/v1/admin/attribution', { preHandler: requireStaff }, async (request) =>
    store.attribution(parseReportingRange(request.query as Record<string, unknown>)));
  app.get('/v1/admin/crm/health', { preHandler: requireStaff }, async () => store.crmHealth());

  if (serveStatic) {
    await app.register(fastifyStatic, { root: config.staticDirectory, prefix: '/', index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  app.addHook('onClose', async () => store.close());
  return app;
}
