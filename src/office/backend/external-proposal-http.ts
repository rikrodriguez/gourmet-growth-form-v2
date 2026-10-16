import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { createDurableTestProposalService } from './external-proposal-durable';
import type { ExistingQuoteSession } from './quote-access-postgres';
import { EventQuoteError } from './event-quote-contracts';
import { validateLeadLinkResponse } from '../lead-link-response';
import type { ExternalProposalCommand } from '../external-proposal-contracts';
import { TEST_PROPOSAL_API, TEST_PROPOSAL_IDENTITY, TEST_PROPOSAL_CSRF } from '../external-proposal-contracts';
export { TEST_PROPOSAL_API, TEST_PROPOSAL_IDENTITY, TEST_PROPOSAL_CSRF } from '../external-proposal-contracts';
/** Explicit loopback TEST_ONLY adapter. Never registered by normal servers.
 * Target/scope/actor come from the fixed durable composition, not the browser. */
export function createTestProposalApi(options: {
  service: ReturnType<typeof createDurableTestProposalService>; allowedOrigin: string;
  resolveExistingSession(request: FastifyRequest): ExistingQuoteSession | null | Promise<ExistingQuoteSession | null>;
}) {
  const origin = new URL(options.allowedOrigin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.origin !== options.allowedOrigin) throw new Error('Test origin required');
  const app = Fastify({ logger: false, bodyLimit: 8192, trustProxy: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== origin.host || request.headers.origin !== undefined && request.headers.origin !== origin.origin
      || request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new EventQuoteError('ACCESS_DENIED', 403);
    if (request.url.includes('?')) throw new EventQuoteError('INVALID_REQUEST', 400);
    if (request.method === 'POST' && (request.headers.origin !== origin.origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/json')) throw new EventQuoteError('INVALID_REQUEST', 403);
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof EventQuoteError ? error.status : 503;
    return reply.code(status).send({ error: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : status === 409 ? 'REVIEW_CHANGED' : 'REQUEST_REJECTED' });
  });
  const identity = (request: FastifyRequest) => {
    const value = request.headers[TEST_PROPOSAL_IDENTITY];
    if (typeof value !== 'string' || !/^proposal-[A-Za-z0-9_-]{43}$/.test(value)) throw new EventQuoteError('ACCESS_CHANGED', 403);
    return value;
  };
  app.get(`${TEST_PROPOSAL_API}/access`, async request => options.service.access(await options.resolveExistingSession(request)));
  app.get(`${TEST_PROPOSAL_API}/history`, async request => validateLeadLinkResponse(await options.service.leadHistory(await options.resolveExistingSession(request), identity(request))));
  app.get(`${TEST_PROPOSAL_API}/proposal`, async request => options.service.read(await options.resolveExistingSession(request), identity(request)));
  app.post(`${TEST_PROPOSAL_API}/commands`, async request => {
    const proof = await options.resolveExistingSession(request), csrf = request.headers[TEST_PROPOSAL_CSRF];
    if (!proof || typeof csrf !== 'string' || Buffer.byteLength(csrf) !== Buffer.byteLength(proof.csrfToken)
      || !timingSafeEqual(Buffer.from(csrf), Buffer.from(proof.csrfToken))) throw new EventQuoteError('ACCESS_DENIED', 403);
    const body = request.body as ExternalProposalCommand;
    if (!body || typeof body !== 'object' || !['associate', 'approve'].includes(body.action)) throw new EventQuoteError('INVALID_REQUEST', 400);
    return options.service.execute(proof, body, identity(request));
  });
  return app;
}
