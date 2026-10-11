import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { currentTime, OfficeError } from './state';
import { withMondayConfigurationDiagnostic, type MondayConfigurationField, type MondayConfigurationReason } from './monday-diagnostics';

// Internal identifier for the manually configured owner capability. Possession
// of its separate credential does not verify Ricardo's real identity or the
// identity of a Monday account; the OAuth service must validate that separately.
export const MONDAY_OWNER_PRINCIPAL = 'ricardo' as const;
export type MondayOwnerPrincipal = typeof MONDAY_OWNER_PRINCIPAL;
export const MONDAY_OWNER_COOKIE = '__Secure-gourmet-monday-owner';
export const MONDAY_OWNER_LOGIN_COOKIE = '__Secure-gourmet-monday-owner-login';
export const MONDAY_OWNER_CSRF_HEADER = 'x-monday-owner-csrf';
export const MONDAY_OWNER_COOKIE_PATH = '/office-api/monday';
export const MONDAY_OWNER_SESSION_TTL_MS = 15 * 60_000;
export const MONDAY_OWNER_LOGIN_TTL_MS = 5 * 60_000;

export type MondayOwnerConfiguration = Readonly<
  | { available: false }
  | { available: true; authenticated: (username: unknown, password: unknown) => boolean }
>;
export type MondayOwnerLoginChallenge = { cookie: string; csrfToken: string; expiresAt: string };
export type MondayOwnerLoginResult = MondayOwnerLoginChallenge & { principal: MondayOwnerPrincipal };
export type MondayOwnerStatus = { authenticated: false } | {
  authenticated: true; principal: MondayOwnerPrincipal; csrfToken: string; expiresAt: string;
};

const MAX_CHALLENGES = 128;
const MAX_SESSIONS = 32;
const MAX_LOGIN_ATTEMPTS = 8;
const USERNAME = /^[A-Za-z0-9._-]{3,64}$/;
const PASSWORD = /^[\x21-\x7e]{24,256}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const tokenKey = (value: string) => hash(value).toString('hex');
const nonce = () => randomBytes(32).toString('hex');

// Only the four named fields of the passed backend configuration are inspected.
// No process.env fallback, credential generation or credential value is exposed.
export function parseMondayOwnerConfiguration(env: Record<string, string | undefined>): MondayOwnerConfiguration {
  const invalid = (name: MondayConfigurationField, reason: MondayConfigurationReason) =>
    withMondayConfigurationDiagnostic(new OfficeError('INVALID_MONDAY_OWNER_CONFIGURATION', 503), name, reason);
  const field = (name: string, diagnosticField: MondayConfigurationField): string | undefined => {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(env, name); }
    catch { throw invalid(diagnosticField, 'invalid_format'); }
    if (!descriptor) return undefined;
    if (!('value' in descriptor) || descriptor.value !== undefined && typeof descriptor.value !== 'string') throw invalid(diagnosticField, 'invalid_format');
    return descriptor.value;
  };
  const username = field('MONDAY_OWNER_USERNAME', 'MONDAY_OWNER_USERNAME');
  const password = field('MONDAY_OWNER_PASSWORD', 'MONDAY_OWNER_PASSWORD');
  if (username === undefined && password === undefined) return Object.freeze({ available: false });
  if (!username) throw invalid('MONDAY_OWNER_USERNAME', 'missing');
  if (!USERNAME.test(username)) throw invalid('MONDAY_OWNER_USERNAME', 'invalid_format');
  if (!password) throw invalid('MONDAY_OWNER_PASSWORD', 'missing');
  if (!PASSWORD.test(password)) throw invalid('MONDAY_OWNER_PASSWORD', 'invalid_format');
  if (username === field('OFFICE_STAGING_USERNAME', 'MONDAY_OWNER_USERNAME')) throw invalid('MONDAY_OWNER_USERNAME', 'not_separate');
  if (password === field('OFFICE_STAGING_PASSWORD', 'MONDAY_OWNER_PASSWORD')) throw invalid('MONDAY_OWNER_PASSWORD', 'not_separate');
  const expected = hash(`${username}:${password}`);
  return Object.freeze({ available: true, authenticated: (inputUsername: unknown, inputPassword: unknown) => {
    const valid = typeof inputUsername === 'string' && USERNAME.test(inputUsername)
      && typeof inputPassword === 'string' && PASSWORD.test(inputPassword);
    const equal = timingSafeEqual(expected, hash(valid ? `${inputUsername}:${inputPassword}` : ''));
    return valid && equal;
  } });
}

type Challenge = { csrfHash: Buffer; expiresAtMs: number };
type OwnerSession = { csrfToken: string; expiresAtMs: number };

function cookie(name: string, value: string, lifetimeMs: number) {
  return `${name}=${value}; Path=${MONDAY_OWNER_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${lifetimeMs / 1000}`;
}
function cookieToken(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string' || header.length > 16_384) return undefined;
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : undefined;
}
function csrfMatches(expected: Buffer, value: string | undefined) {
  const valid = typeof value === 'string' && TOKEN.test(value);
  const equal = timingSafeEqual(expected, hash(valid ? value : ''));
  return valid && equal;
}
function loginBody(raw: unknown): { username: string; password: string } {
  const invalid = () => new OfficeError('INVALID_MONDAY_OWNER_LOGIN', 400);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || keys.some(key => key !== 'username' && key !== 'password')) throw invalid();
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    values[key as string] = descriptor.value;
  }
  if (typeof values.username !== 'string' || values.username.length > 64 || typeof values.password !== 'string' || values.password.length > 256) throw invalid();
  return { username: values.username, password: values.password };
}

// The owner capability is separate from Basic Auth, DEMO roles and scopes.
// authenticated/status refers only to this bootstrap session, not proof of a
// person's identity. Session restart means logout; persistent OAuth transactions
// must bind their own independent nonce.
export class MondayOwnerSessions {
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, OwnerSession>();
  private attempts = 0;
  private attemptWindowStart: number | undefined;

  constructor(private readonly configuration: MondayOwnerConfiguration = Object.freeze({ available: false }), private readonly clock = Date.now) {}

  private configured(): Extract<MondayOwnerConfiguration, { available: true }> {
    if (!this.configuration.available) throw new OfficeError('MONDAY_OWNER_UNAVAILABLE', 503);
    return this.configuration;
  }
  private at() {
    const atMs = currentTime(this.clock);
    for (const [key, row] of this.challenges) if (row.expiresAtMs <= atMs) this.challenges.delete(key);
    for (const [key, row] of this.sessions) if (row.expiresAtMs <= atMs) this.sessions.delete(key);
    if (this.attemptWindowStart === undefined || atMs >= this.attemptWindowStart + MONDAY_OWNER_LOGIN_TTL_MS) {
      this.attemptWindowStart = atMs; this.attempts = 0;
    }
    return atMs;
  }
  private checkRate(charge: boolean) {
    if (this.attempts >= MAX_LOGIN_ATTEMPTS) throw new OfficeError('MONDAY_OWNER_LOGIN_RATE_LIMIT', 429);
    if (charge) this.attempts += 1;
  }
  private active(header: string | undefined) {
    this.configured(); this.at();
    const token = cookieToken(header, MONDAY_OWNER_COOKIE);
    const key = token ? tokenKey(token) : undefined;
    const session = key ? this.sessions.get(key) : undefined;
    if (!key || !session) throw new OfficeError('MONDAY_OWNER_UNAUTHORIZED', 401);
    return { key, session };
  }

  issueLoginChallenge(): MondayOwnerLoginChallenge {
    this.configured();
    const atMs = this.at(); this.checkRate(false);
    if (this.challenges.size >= MAX_CHALLENGES) throw new OfficeError('MONDAY_OWNER_CHALLENGE_LIMIT', 429);
    const token = nonce(); const csrfToken = nonce();
    const expiresAtMs = atMs + MONDAY_OWNER_LOGIN_TTL_MS;
    this.challenges.set(tokenKey(token), { csrfHash: hash(csrfToken), expiresAtMs });
    // cookie is for Set-Cookie only. HTTP responses must select csrfToken and
    // expiresAt explicitly rather than serializing this complete object.
    return { cookie: cookie(MONDAY_OWNER_LOGIN_COOKIE, token, MONDAY_OWNER_LOGIN_TTL_MS), csrfToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  login(body: unknown, cookieHeader: string | undefined, csrfHeader: string | undefined): MondayOwnerLoginResult {
    const configuration = this.configured();
    const atMs = this.at(); this.checkRate(true);
    const token = cookieToken(cookieHeader, MONDAY_OWNER_LOGIN_COOKIE);
    const key = token ? tokenKey(token) : undefined;
    const challenge = key ? this.challenges.get(key) : undefined;
    if (!key || !challenge) throw new OfficeError('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED', 403);
    if (!csrfMatches(challenge.csrfHash, csrfHeader)) throw new OfficeError('MONDAY_OWNER_CSRF_REQUIRED', 403);
    // A validated challenge is consumed even when the body/credentials fail.
    this.challenges.delete(key);
    const credentials = loginBody(body);
    if (!configuration.authenticated(credentials.username, credentials.password)) throw new OfficeError('MONDAY_OWNER_UNAUTHORIZED', 401);
    const previous = cookieToken(cookieHeader, MONDAY_OWNER_COOKIE);
    if (previous) this.sessions.delete(tokenKey(previous));
    if (this.sessions.size >= MAX_SESSIONS) throw new OfficeError('MONDAY_OWNER_SESSION_LIMIT', 429);
    const sessionToken = nonce(); const csrfToken = nonce();
    const expiresAtMs = atMs + MONDAY_OWNER_SESSION_TTL_MS;
    this.sessions.set(tokenKey(sessionToken), { csrfToken, expiresAtMs });
    return { cookie: cookie(MONDAY_OWNER_COOKIE, sessionToken, MONDAY_OWNER_SESSION_TTL_MS), csrfToken, expiresAt: new Date(expiresAtMs).toISOString(), principal: MONDAY_OWNER_PRINCIPAL };
  }

  // One argument authorizes a read. Supplying a second argument authorizes a
  // mutation and requires CSRF, including when its header value is undefined.
  authorize(cookieHeader: string | undefined, ...csrfHeader: [] | [string | undefined]): MondayOwnerPrincipal {
    const { session } = this.active(cookieHeader);
    if (csrfHeader.length && !csrfMatches(hash(session.csrfToken), csrfHeader[0])) throw new OfficeError('MONDAY_OWNER_CSRF_REQUIRED', 403);
    return MONDAY_OWNER_PRINCIPAL;
  }

  logout(cookieHeader: string | undefined, csrfHeader: string | undefined): string {
    const { key, session } = this.active(cookieHeader);
    if (!csrfMatches(hash(session.csrfToken), csrfHeader)) throw new OfficeError('MONDAY_OWNER_CSRF_REQUIRED', 403);
    this.sessions.delete(key);
    return cookie(MONDAY_OWNER_COOKIE, '', 0);
  }

  status(cookieHeader: string | undefined): MondayOwnerStatus {
    if (!this.configuration.available) return { authenticated: false };
    try {
      const { session } = this.active(cookieHeader);
      return { authenticated: true, principal: MONDAY_OWNER_PRINCIPAL, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAtMs).toISOString() };
    } catch (error) {
      if (error instanceof OfficeError && error.code === 'MONDAY_OWNER_UNAUTHORIZED') return { authenticated: false };
      throw error;
    }
  }
}
