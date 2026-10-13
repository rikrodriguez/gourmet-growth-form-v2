import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { historicalLeadKey, normalizeHistoricalLink, type HistoricalLink } from './lead-link-history';
import type { LeadLinkIdentity } from './lead-link-http';
import type { LeadLinkResponseScope } from '../lead-link-response';

export const LEAD_LINK_OPEN_API = '/api/office/lead-link-open';
export type LeadLinkOpeningCategory = 'calculator' | 'lead_notes' | 'sales_closer' | 'quote';
export type LeadLinkAllowedDestination = Readonly<{ category: LeadLinkOpeningCategory; origin: string; pathname: string }>;
/** Reviewed public endpoint shapes only. Private quote filenames must be separately configured, exactly. */
export const REVIEWED_LEAD_LINK_DESTINATIONS: readonly LeadLinkAllowedDestination[] = Object.freeze([
  Object.freeze({ category: 'calculator' as const, origin: 'https://monday.gourmet-corporation.com', pathname: '/' }),
  Object.freeze({ category: 'lead_notes' as const, origin: 'https://gourmet-corporation.com', pathname: '/lead-ai/' }),
  Object.freeze({ category: 'sales_closer' as const, origin: 'https://gourmet-corporation.com', pathname: '/aisalescloser/' }),
]);
export type LeadLinkOpenIdentity = LeadLinkIdentity & { canOpen: boolean; csrfToken: string };
export type LeadLinkOpenRecord = {
  scope: LeadLinkResponseScope;
  leadId: string;
  referenceId: string;
  revision: string;
  /** Trusted mapping from the authenticated tenant to source IDs. Never derive this from URL parameters. */
  sourceBinding: { accountId: string; boardId: string; itemId: string };
  link: HistoricalLink;
};
export type LeadLinkOpeningSource = {
  /**
   * Return the current, immutable observation and trusted binding together, or null when withdrawn.
   * A real store must perform a consistent current-revision read. This route rereads before its decision;
   * it does not provide transaction locks or revoke a redirect that has already been emitted.
   */
  read(scope: Readonly<LeadLinkResponseScope>, leadId: string, referenceId: string): Promise<LeadLinkOpenRecord | null>;
};
export type LeadLinkOpenDependencies = {
  /** Existing revocation-aware authenticated session; token must rotate when its identity or scope changes. */
  resolveIdentity(request: FastifyRequest): LeadLinkOpenIdentity | null | Promise<LeadLinkOpenIdentity | null>;
  source: LeadLinkOpeningSource;
  allowedOrigin: string;
  /** Mandatory explicit server configuration. There is no default authorization from a historical status. */
  allowedDestinations: readonly LeadLinkAllowedDestination[];
  clock?: () => number;
};
export class LeadLinkOpenError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503) { super('Lead link opening rejected'); }
}
type Form = { identityKey: string; leadId: string; referenceId: string; revision: string; csrfToken: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const RESERVED = new Set(['constructor', 'prototype', '__proto__']);
const OPEN_CATEGORIES = new Set(['calculator', 'lead_notes', 'sales_closer', 'quote']);
const REDIRECT_KEYS = new Set(['redirect', 'redirecturl', 'redirecturi', 'redirectto', 'url', 'next', 'returnto', 'returnurl', 'returnuri', 'return', 'destination', 'dest', 'continue', 'callback', 'callbackurl', 'forward', 'forwardurl']);
const BODY_LIMIT = 2_048;
function fail(status: ConstructorParameters<typeof LeadLinkOpenError>[0]): never { throw new LeadLinkOpenError(status); }
function validId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && ID.test(value) && !RESERVED.has(value);
}
function plain(value: unknown, keys: readonly string[], status: 400 | 401 | 403 | 503 = 503): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(status);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(status);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) fail(status);
  }
  return value as Record<string, unknown>;
}
function sameScope(a: LeadLinkResponseScope, b: LeadLinkResponseScope): boolean {
  return a.organizationId === b.organizationId && a.workspaceId === b.workspaceId && a.mode === b.mode;
}
function copyScope(raw: unknown, status: 401 | 503): LeadLinkResponseScope {
  const scope = plain(raw, ['organizationId', 'workspaceId', 'mode'], status);
  if (!validId(scope.organizationId, 128) || !validId(scope.workspaceId, 128) || (scope.mode !== 'test' && scope.mode !== 'commercial')) fail(status);
  return Object.freeze({ organizationId: scope.organizationId, workspaceId: scope.workspaceId, mode: scope.mode });
}
function securityHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}
function staticError(reply: FastifyReply, status: ConstructorParameters<typeof LeadLinkOpenError>[0]) {
  securityHeaders(reply);
  return reply.code(status).send({ error: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED'
    : status === 404 ? 'NOT_FOUND' : status === 409 ? 'REVISION_CONFLICT' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST' });
}
export const leadLinkOpenFrameworkErrors: NonNullable<FastifyServerOptions['frameworkErrors']> = (error, _request, reply) => {
  staticError(reply, error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH' ? 400 : 503);
};
function equalToken(left: string, right: string): boolean {
  return Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function snapshotIdentity(raw: LeadLinkOpenIdentity | null, now: number): LeadLinkOpenIdentity {
  if (!raw || !Number.isFinite(now) || !validId(raw.identityKey, 256) || typeof raw.durableIdentity !== 'boolean'
    || typeof raw.canRead !== 'boolean' || typeof raw.canOpen !== 'boolean' || typeof raw.csrfToken !== 'string' || !TOKEN.test(raw.csrfToken)
    || !Number.isSafeInteger(raw.expiresAtMs) || raw.expiresAtMs <= now || !Array.isArray(raw.leadIds) || raw.leadIds.length > 1_000) fail(401);
  const leadIds = [...raw.leadIds];
  if (!leadIds.every(id => validId(id, 96))) fail(401);
  const scope = copyScope(raw.scope, 401);
  if (scope.mode === 'commercial' && !raw.durableIdentity) fail(401);
  return Object.freeze({ identityKey: raw.identityKey, durableIdentity: raw.durableIdentity, scope,
    expiresAtMs: raw.expiresAtMs, canRead: raw.canRead, canOpen: raw.canOpen, csrfToken: raw.csrfToken, leadIds: Object.freeze(leadIds) });
}
function authorize(identity: LeadLinkOpenIdentity, form: Form): void {
  if (identity.identityKey !== form.identityKey) fail(401);
  if (!identity.canRead || !identity.canOpen || !equalToken(form.csrfToken, identity.csrfToken)) fail(403);
  if (!identity.leadIds.includes(form.leadId)) fail(404);
}
function parseForm(body: string): Form {
  // Decode each key/value exactly once, rejecting ambiguous keys, duplicate fields and malformed escapes.
  const values: Record<string, string> = Object.create(null);
  const expected = ['identityKey', 'leadId', 'referenceId', 'revision', 'csrfToken'];
  if (!body || /[^\x20-\x7e]/.test(body)) fail(400);
  for (const part of body.split('&')) {
    const delimiter = part.indexOf('=');
    if (delimiter < 1 || part.indexOf('=', delimiter + 1) !== -1) fail(400);
    let key: string; let value: string;
    try { key = decodeURIComponent(part.slice(0, delimiter).replace(/\+/g, ' ')); value = decodeURIComponent(part.slice(delimiter + 1).replace(/\+/g, ' ')); }
    catch { fail(400); }
    if (!expected.includes(key) || Object.hasOwn(values, key)) fail(400);
    values[key] = value;
  }
  if (Object.keys(values).length !== expected.length || !validId(values.identityKey, 256) || !validId(values.leadId, 96)
    || !validId(values.referenceId, 128) || !validId(values.revision, 128) || !TOKEN.test(values.csrfToken)) fail(400);
  return values as Form;
}
function safePath(pathname: string): boolean {
  if (!pathname.startsWith('/') || /[\s\\?#*\u0000-\u001f\u007f]/.test(pathname) || pathname.includes('//')
    || /%(?:2e|2f|5c|25|3f|23|2a|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !/[\\?#*\u0000-\u001f\u007f]/.test(decoded) && !decoded.split('/').some(segment => segment === '.' || segment === '..');
}
function configuredDestinations(input: readonly LeadLinkAllowedDestination[]): readonly LeadLinkAllowedDestination[] {
  if (!Array.isArray(input) || input.length > 2_000) throw new Error('Invalid lead link opening configuration');
  try {
    return Object.freeze(input.map(entry => {
      const value = plain(entry, ['category', 'origin', 'pathname']);
      if (typeof value.category !== 'string' || !OPEN_CATEGORIES.has(value.category) || typeof value.origin !== 'string'
        || typeof value.pathname !== 'string' || !safePath(value.pathname)) fail(503);
      const origin = new URL(value.origin);
      if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password || origin.port) fail(503);
      const reviewed = REVIEWED_LEAD_LINK_DESTINATIONS.some(allowed => allowed.category === value.category && allowed.origin === value.origin && allowed.pathname === value.pathname);
      const quote = value.category === 'quote' && value.origin === 'https://gourmet-corporation.com'
        && /^\/quote\/[^/]+\.pdf$/.test(value.pathname) && new URL(value.pathname, origin).pathname === value.pathname;
      if (!reviewed && !quote) fail(503);
      return Object.freeze({ category: value.category as LeadLinkOpeningCategory, origin: value.origin, pathname: value.pathname });
    }));
  } catch { throw new Error('Invalid lead link opening configuration'); }
}
function normalizedLink(link: HistoricalLink): HistoricalLink {
  try {
    if (!link || typeof link !== 'object' || link.schemaVersion !== 1 || link.status !== 'historical' || !OPEN_CATEGORIES.has(link.category)
      || link.evidenceKind !== 'column_snapshot' || link.humanVisitEvidence !== false || !Array.isArray(link.issues) || link.issues.length
      || !link.outer || !link.provenance || link.provenance.columnId === null || link.provenance.updateId !== null) fail(403);
    const copy = normalizeHistoricalLink({ provenance: link.provenance, originalUrl: link.outer.originalUrl });
    if (copy.status !== 'historical' || copy.category !== link.category || copy.evidenceKind !== 'column_snapshot') fail(403);
    return copy;
  } catch { fail(403); }
}
function destinationForNormalizedLink(link: HistoricalLink, allowed: readonly LeadLinkAllowedDestination[]): string {
  const original = link.outer!.originalUrl;
  if (original.length > 8_192 || !original.startsWith('https://') || /[^\x21-\x7e]|\\/.test(original)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(original)) fail(403);
  let url: URL;
  try { url = new URL(original); } catch { fail(403); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail(403);
  const components = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?$/.exec(original);
  if (!components || !safePath(components[2]) || components[2] !== url.pathname
    || ![url.hostname, `${url.hostname}:443`].includes(components[1])) fail(403);
  // Inspect outer query names once. sourceUrl remains attribution evidence, never a redirect target.
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (REDIRECT_KEYS.has(normalizedKey) || key.includes('%') || /[\u0000-\u001f\u007f]/.test(key + value)) fail(403);
  }
  if (!allowed.some(entry => entry.category === link.category && entry.origin === url.origin && entry.pathname === url.pathname)) fail(403);
  return original;
}
/** Server-only predicate/projection helper. Returns exact original bytes; never fetches or exposes them in read responses. */
export function validateLeadLinkDestination(link: HistoricalLink, allowedDestinations: readonly LeadLinkAllowedDestination[]): string {
  return destinationForNormalizedLink(normalizedLink(link), configuredDestinations(allowedDestinations));
}
function snapshotRecord(raw: LeadLinkOpenRecord | null, identity: LeadLinkOpenIdentity, form: Form): { record: LeadLinkOpenRecord; fingerprint: string } {
  if (raw === null) fail(404);
  const source = plain(raw, ['scope', 'leadId', 'referenceId', 'revision', 'sourceBinding', 'link']);
  const scope = copyScope(source.scope, 503);
  if (!sameScope(scope, identity.scope) || source.leadId !== form.leadId || source.referenceId !== form.referenceId) fail(404);
  if (!validId(source.revision, 128)) fail(503);
  if (source.revision !== form.revision) fail(409);
  const binding = plain(source.sourceBinding, ['accountId', 'boardId', 'itemId']);
  for (const value of Object.values(binding)) if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(503);
  const sourceBinding = Object.freeze({ accountId: binding.accountId as string, boardId: binding.boardId as string, itemId: binding.itemId as string });
  const link = normalizedLink(source.link as HistoricalLink);
  if (historicalLeadKey(sourceBinding) !== historicalLeadKey(link.provenance)) fail(404);
  const record = Object.freeze({ scope, leadId: form.leadId, referenceId: form.referenceId, revision: source.revision, sourceBinding, link });
  return { record, fingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex') };
}

/** Explicit opt-in only; host must install frameworkErrors: leadLinkOpenFrameworkErrors. Never registered in real servers. */
export function registerLeadLinkOpenRoutes(app: FastifyInstance, dependencies: LeadLinkOpenDependencies): void {
  let origin: URL;
  try {
    origin = new URL(dependencies.allowedOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== dependencies.allowedOrigin) throw new Error();
  } catch { throw new Error('Invalid lead link opening configuration'); }
  const allowed = configuredDestinations(dependencies.allowedDestinations);
  const clock = dependencies.clock ?? Date.now;
  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      securityHeaders(reply);
      if (request.method !== 'POST') fail(404);
      if (request.url.includes('?') || request.raw.url?.includes('?')) fail(400);
      if (request.headers.host !== origin.host || request.headers['sec-fetch-site'] !== 'same-origin'
        || request.headers['sec-fetch-mode'] !== 'navigate' || request.headers['sec-fetch-dest'] !== 'document'
        || request.headers['sec-fetch-user'] !== '?1'
        || (request.headers.origin !== origin.origin && request.headers.origin !== 'null')) fail(403);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=UTF-8)?$/i.test(request.headers['content-type'] ?? '')) fail(415);
    });
    routes.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_request, body, done) => {
      try { done(null, parseForm(body as string)); } catch { done(new LeadLinkOpenError(400)); }
    });
    routes.setErrorHandler((error, _request, reply) => {
      const status = error instanceof LeadLinkOpenError ? error.status : (error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : 503;
      return staticError(reply, status);
    });
    routes.setNotFoundHandler((_request, reply) => staticError(reply, 404));
    const reauthenticate = async (request: FastifyRequest, original: LeadLinkOpenIdentity, form: Form) => {
      const current = snapshotIdentity(await dependencies.resolveIdentity(request), clock());
      const now = clock();
      if (!Number.isFinite(now) || original.expiresAtMs <= now || current.expiresAtMs <= now
        || current.identityKey !== original.identityKey || current.durableIdentity !== original.durableIdentity || !sameScope(current.scope, original.scope)
        || !equalToken(current.csrfToken, original.csrfToken)) fail(401);
      authorize(current, form);
    };
    routes.post('/', { bodyLimit: BODY_LIMIT, prefixTrailingSlash: 'no-slash', logLevel: 'silent' }, async (request, reply) => {
      const form = request.body as Form;
      const identity = snapshotIdentity(await dependencies.resolveIdentity(request), clock());
      authorize(identity, form);
      const first = snapshotRecord(await dependencies.source.read(identity.scope, form.leadId, form.referenceId), identity, form);
      const location = destinationForNormalizedLink(first.record.link, allowed);
      await reauthenticate(request, identity, form);
      const latest = snapshotRecord(await dependencies.source.read(identity.scope, form.leadId, form.referenceId), identity, form);
      if (latest.fingerprint !== first.fingerprint) fail(409);
      await reauthenticate(request, identity, form);
      // This redirect asks the user's browser to navigate. No provider fetch or body containing the private URL is made here.
      return reply.code(303).header('Location', location).send();
    });
  }, { prefix: LEAD_LINK_OPEN_API });
}

/** Local composition only: no listener, authentication setup, importer, persistence or outbound HTTP. */
export function createLeadLinkOpenApi(dependencies: LeadLinkOpenDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, trustProxy: false, frameworkErrors: leadLinkOpenFrameworkErrors });
  registerLeadLinkOpenRoutes(app, dependencies);
  return app;
}
