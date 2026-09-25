import { randomUUID, timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { BackendConfig } from './config';
import type { GrowthDataStore } from './contracts';
import type { PhoneEncryptor } from './crypto';
import { DataConflictError } from './postgres-store';
import {
  isUuid,
  validateCapturePhone,
  validateEvent,
  validateLeadPatch,
} from './validation';

const MAX_EVENT_BATCH_SIZE = 50;

type AppDependencies = {
  config: BackendConfig;
  store: GrowthDataStore;
  phoneEncryptor: PhoneEncryptor;
};

function safeSecretEquals(actual: string | undefined, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestIsQa(request: FastifyRequest, config: BackendConfig): boolean {
  const requested = request.headers['x-gourmet-qa-test'] === 'true';
  if (!requested) return false;
  return safeSecretEquals(request.headers['x-gourmet-qa-secret'] as string | undefined, config.qaMarkerSecret);
}

function hasInvalidQaMarker(request: FastifyRequest, config: BackendConfig): boolean {
  return request.headers['x-gourmet-qa-test'] === 'true'
    && !safeSecretEquals(request.headers['x-gourmet-qa-secret'] as string | undefined, config.qaMarkerSecret);
}

export async function buildApp({ config, store, phoneEncryptor }: AppDependencies): Promise<FastifyInstance> {
  const eventCounts = new WeakMap<FastifyRequest, number>();
  const requestStarts = new WeakMap<FastifyRequest, number>();
  const app = Fastify({
    logger: {
      level: config.environment === 'test' ? 'silent' : 'info',
      serializers: {
        req(request) {
          return { method: request.method, url: request.routeOptions?.url ?? request.url.split('?')[0] };
        },
      },
    },
    bodyLimit: config.bodyLimitBytes,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'x-gourmet-session-id', 'x-gourmet-qa-test', 'x-gourmet-qa-secret'],
    origin(origin, callback) {
      if (!origin) return callback(null, config.allowMissingOrigin);
      callback(null, config.allowedOrigins.includes(origin));
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });

  app.addHook('onRequest', async (request, reply) => {
    requestStarts.set(request, performance.now());
    reply.header('x-request-id', request.id);
    if (request.method !== 'POST' && request.method !== 'PATCH') return;
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_content_type_required' });
    }
    const origin = request.headers.origin;
    if (!origin && !config.allowMissingOrigin) return reply.code(403).send({ error: 'origin_required' });
    if (origin && !config.allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'origin_not_allowed' });
    if (hasInvalidQaMarker(request, config)) return reply.code(403).send({ error: 'invalid_qa_marker' });
  });

  app.addHook('onResponse', async (request, reply) => {
    const started = requestStarts.get(request) ?? performance.now();
    request.log.info({
      request_id: request.id,
      route: request.routeOptions.url,
      status: reply.statusCode,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      event_count: eventCounts.get(request),
    }, 'request_completed');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DataConflictError) {
      return reply.code(409).send({ error: 'conflict', request_id: request.id });
    }
    const errorStatus = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof error.statusCode === 'number' ? error.statusCode : null;
    const statusCode = errorStatus ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
    if (statusCode === 413) return reply.code(413).send({ error: 'payload_too_large', request_id: request.id });
    if (statusCode === 429) return reply.code(429).send({ error: 'rate_limited', request_id: request.id });
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'invalid_request', request_id: request.id });
    }
    request.log.error({
      request_id: request.id,
      error_name: error instanceof Error ? error.name : 'UnknownError',
    }, 'request_failed');
    return reply.code(503).send({ error: 'database_unavailable', request_id: request.id });
  });

  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await store.health();
      return reply.send({
        status: 'ok',
        database: 'connected',
        version: config.appVersion,
        git_sha: config.gitSha,
      });
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        database: 'unavailable',
        version: config.appVersion,
        git_sha: config.gitSha,
      });
    }
  });

  app.post('/v1/events/batch', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('events' in body)) {
      return reply.code(400).send({ error: 'invalid_batch' });
    }
    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENT_BATCH_SIZE) {
      return reply.code(400).send({ error: 'invalid_batch_size', max_batch_size: MAX_EVENT_BATCH_SIZE });
    }
    eventCounts.set(request, events.length);

    const accepted = [];
    const rejected = [];
    for (const [index, candidate] of events.entries()) {
      const result = validateEvent(candidate);
      if (result.event) accepted.push(result.event);
      else rejected.push({ index, ...result.rejection! });
    }
    if (accepted.length === 0) {
      return reply.code(422).send({ accepted: 0, duplicates: 0, rejected: rejected.length, rejections: rejected });
    }

    const stored = await store.ingestEvents(accepted, requestIsQa(request, config));
    return reply.send({
      accepted: stored.accepted_event_ids.length,
      duplicates: stored.duplicate_event_ids.length,
      rejected: rejected.length,
      acknowledged_event_ids: [...stored.accepted_event_ids, ...stored.duplicate_event_ids],
      rejections: rejected,
    });
  });

  app.post('/v1/leads/capture-phone', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const validated = validateCapturePhone(request.body);
    if (!validated.input || !validated.phone) return reply.code(422).send({ error: validated.code });
    const encryptedPhone = phoneEncryptor.encrypt(validated.phone);
    const isQa = requestIsQa(request, config);
    const consent = validated.input.measurement_consent;
    const enhancedConversionEligible = config.measurementEnvironment === 'production'
      && Boolean(config.googleAdsCustomerId && config.googleAdsConversionActionId)
      && !isQa
      && consent?.ad_storage === 'granted'
      && consent.ad_user_data === 'granted';
    const result = await store.captureLead(
      { ...validated.input, encryptedPhone, enhancedConversionEligible },
      isQa,
    );
    return reply.code(result.status === 'created' ? 201 : 200).send({
      lead_id: result.leadId,
      conversion_id: result.conversionId,
      status: result.status,
    });
  });

  app.patch('/v1/leads/:leadId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { leadId } = request.params as { leadId?: string };
    const sessionId = request.headers['x-gourmet-session-id'];
    if (!isUuid(leadId) || !isUuid(sessionId)) return reply.code(422).send({ error: 'invalid_uuid' });
    const answers = validateLeadPatch(request.body);
    if (!answers || Object.keys(answers).length === 0) return reply.code(422).send({ error: 'invalid_lead_update' });
    const updated = await store.updateLead(leadId, sessionId, answers);
    if (!updated) return reply.code(404).send({ error: 'lead_not_found' });
    return reply.send({ lead_id: leadId, status: 'updated' });
  });

  app.addHook('onClose', async () => {
    await store.close();
  });

  return app;
}
