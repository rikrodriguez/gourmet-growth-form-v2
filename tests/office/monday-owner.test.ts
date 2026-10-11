import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DevelopmentSessions } from '../../src/office/backend/session';
import { OfficeError } from '../../src/office/backend/state';
import {
  MondayOwnerSessions, MONDAY_OWNER_COOKIE, MONDAY_OWNER_LOGIN_COOKIE,
  MONDAY_OWNER_LOGIN_TTL_MS, MONDAY_OWNER_SESSION_TTL_MS, parseMondayOwnerConfiguration,
} from '../../src/office/backend/monday-owner';

const AT = Date.parse('2026-10-11T20:00:00.000Z');
const credentials = { username: 'synthetic_owner', password: 'SYNTHETIC_OWNER_ONLY_MANUAL_PASSWORD_123' };
const environment = {
  MONDAY_OWNER_USERNAME: credentials.username, MONDAY_OWNER_PASSWORD: credentials.password,
  OFFICE_STAGING_USERNAME: 'synthetic_shared', OFFICE_STAGING_PASSWORD: 'SYNTHETIC_SHARED_ONLY_PASSWORD_456',
};
const config = () => parseMondayOwnerConfiguration({ ...environment });
const header = (setCookie: string) => setCookie.split(';')[0];
const error = (code: string, status?: number) => (value: unknown) => value instanceof OfficeError && value.code === code && (status === undefined || value.statusCode === status);
function authenticated(owner: MondayOwnerSessions, existingCookie?: string) {
  const challenge = owner.issueLoginChallenge();
  return owner.login(credentials, [header(challenge.cookie), existingCookie].filter(Boolean).join('; '), challenge.csrfToken);
}

describe('separate manually configured Monday owner', () => {
  it('stays unavailable by default and does not inspect unrelated configuration values', () => {
    let reads = 0;
    const env: Record<string, string | undefined> = {};
    Object.defineProperty(env, 'OFFICE_STAGING_PASSWORD', { get() { reads += 1; throw new Error('synthetic forbidden read'); } });
    const configuration = parseMondayOwnerConfiguration(env);
    assert.deepEqual(configuration, { available: false }); assert.equal(reads, 0);
    const owner = new MondayOwnerSessions(configuration, () => AT);
    assert.deepEqual(owner.status(undefined), { authenticated: false });
    assert.throws(() => owner.issueLoginChallenge(), error('MONDAY_OWNER_UNAVAILABLE', 503));
    assert.throws(() => owner.login(credentials, undefined, undefined), error('MONDAY_OWNER_UNAVAILABLE', 503));
    assert.throws(() => owner.authorize(undefined), error('MONDAY_OWNER_UNAVAILABLE', 503));
  });

  it('rejects incomplete, non-ASCII or shared Basic credentials without reflecting values', () => {
    for (const env of [
      { MONDAY_OWNER_USERNAME: credentials.username },
      { MONDAY_OWNER_PASSWORD: credentials.password },
      { ...environment, MONDAY_OWNER_PASSWORD: 'too-short' },
      { ...environment, MONDAY_OWNER_PASSWORD: `${credentials.password}\n` },
      { ...environment, MONDAY_OWNER_PASSWORD: `${credentials.password}é` },
      { ...environment, MONDAY_OWNER_USERNAME: environment.OFFICE_STAGING_USERNAME },
      { ...environment, MONDAY_OWNER_PASSWORD: environment.OFFICE_STAGING_PASSWORD },
    ]) assert.throws(() => parseMondayOwnerConfiguration(env), value => {
      assert(value instanceof OfficeError); assert.equal(value.code, 'INVALID_MONDAY_OWNER_CONFIGURATION');
      assert.equal(value.message, value.code); assert(!value.message.includes(credentials.password)); return true;
    });
    const configuration = config(); assert(configuration.available);
    assert.equal(configuration.authenticated(credentials.username, credentials.password), true);
    assert.equal(configuration.authenticated(environment.OFFICE_STAGING_USERNAME, environment.OFFICE_STAGING_PASSWORD), false);
    assert.equal(configuration.authenticated(credentials.username, 'SYNTHETIC_INCORRECT_PASSWORD_000'), false);
    assert.equal(configuration.authenticated(undefined, undefined), false);
    assert.equal(JSON.stringify(configuration), '{"available":true}');
  });

  it('rejects accessor credentials without executing getters', () => {
    let reads = 0;
    const env: Record<string, string | undefined> = { MONDAY_OWNER_PASSWORD: credentials.password };
    Object.defineProperty(env, 'MONDAY_OWNER_USERNAME', { get() { reads += 1; return credentials.username; } });
    assert.throws(() => parseMondayOwnerConfiguration(env), error('INVALID_MONDAY_OWNER_CONFIGURATION'));
    assert.equal(reads, 0);
  });
});

describe('owner login challenges and session boundaries', () => {
  it('issues separate Strict Secure HttpOnly cookies and returns only the fixed owner principal', () => {
    const owner = new MondayOwnerSessions(config(), () => AT);
    const challenge = owner.issueLoginChallenge();
    assert.match(challenge.cookie, new RegExp(`^${MONDAY_OWNER_LOGIN_COOKIE}=[a-f0-9]{64};`));
    assert.match(challenge.cookie, /Path=\/office-api\/monday; HttpOnly; Secure; SameSite=Strict; Max-Age=300$/u);
    assert(!challenge.cookie.includes('Domain=')); assert.notEqual(header(challenge.cookie).split('=')[1], challenge.csrfToken);
    const login = owner.login(credentials, header(challenge.cookie), challenge.csrfToken);
    assert.match(login.cookie, new RegExp(`^${MONDAY_OWNER_COOKIE}=[a-f0-9]{64};`));
    assert.match(login.cookie, /Path=\/office-api\/monday; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/u);
    assert.equal(login.principal, 'ricardo'); assert.equal(owner.authorize(header(login.cookie)), 'ricardo');
    const status = owner.status(header(login.cookie));
    assert.deepEqual(status, { authenticated: true, principal: 'ricardo', csrfToken: login.csrfToken, expiresAt: login.expiresAt });
    assert(!JSON.stringify(status).includes(header(login.cookie).split('=')[1]));
  });

  it('requires matching bootstrap cookie and CSRF before checking credentials', () => {
    const owner = new MondayOwnerSessions(config(), () => AT);
    const challenge = owner.issueLoginChallenge();
    assert.throws(() => owner.login(credentials, undefined, challenge.csrfToken), error('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED', 403));
    assert.throws(() => owner.login(credentials, header(challenge.cookie), undefined), error('MONDAY_OWNER_CSRF_REQUIRED', 403));
    assert.throws(() => owner.login(credentials, header(challenge.cookie), '0'.repeat(64)), error('MONDAY_OWNER_CSRF_REQUIRED', 403));
    assert.equal(owner.login(credentials, header(challenge.cookie), challenge.csrfToken).principal, 'ricardo');
  });

  it('rejects cross-browser challenges and consumes a validated challenge exactly once', () => {
    const owner = new MondayOwnerSessions(config(), () => AT);
    const first = owner.issueLoginChallenge(); const second = owner.issueLoginChallenge();
    assert.throws(() => owner.login(credentials, header(first.cookie), second.csrfToken), error('MONDAY_OWNER_CSRF_REQUIRED'));
    owner.login(credentials, header(first.cookie), first.csrfToken);
    assert.throws(() => owner.login(credentials, header(first.cookie), first.csrfToken), error('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED'));
    assert.equal(owner.login(credentials, header(second.cookie), second.csrfToken).principal, 'ricardo');
  });

  it('consumes incorrect-credential attempts and requires a new challenge for retry', () => {
    const owner = new MondayOwnerSessions(config(), () => AT); const challenge = owner.issueLoginChallenge();
    assert.throws(() => owner.login({ ...credentials, password: 'SYNTHETIC_WRONG_PASSWORD_000' }, header(challenge.cookie), challenge.csrfToken), error('MONDAY_OWNER_UNAUTHORIZED', 401));
    assert.throws(() => owner.login(credentials, header(challenge.cookie), challenge.csrfToken), error('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED'));
    assert.equal(authenticated(owner).principal, 'ricardo');
  });

  it('rejects browser-chosen identity, roles and accessor bodies without invoking getters', () => {
    const owner = new MondayOwnerSessions(config(), () => AT);
    for (const body of [{ ...credentials, principal: 'ricardo' }, { ...credentials, role: 'operator' }, { ...credentials, actorId: 'OFFICE_DEMO_OPERATOR' }]) {
      const challenge = owner.issueLoginChallenge();
      assert.throws(() => owner.login(body, header(challenge.cookie), challenge.csrfToken), error('INVALID_MONDAY_OWNER_LOGIN', 400));
    }
    let reads = 0; const body = { password: credentials.password };
    Object.defineProperty(body, 'username', { enumerable: true, get() { reads += 1; return credentials.username; } });
    const challenge = owner.issueLoginChallenge();
    assert.throws(() => owner.login(body, header(challenge.cookie), challenge.csrfToken), error('INVALID_MONDAY_OWNER_LOGIN'));
    assert.equal(reads, 0);
  });

  it('denies DEMO sessions, raw bearer tokens and duplicate cookie names', () => {
    const owner = new MondayOwnerSessions(config(), () => AT); const login = authenticated(owner);
    const demo = new DevelopmentSessions(() => AT).create({ role: 'operator' });
    for (const candidate of [`gourmet_office_demo=${demo.token}`, `${MONDAY_OWNER_COOKIE}=${demo.token}`, login.cookie.split('=')[1].split(';')[0], `${header(login.cookie)}; ${header(login.cookie)}`, `${header(login.cookie)}; ${MONDAY_OWNER_COOKIE}=${'0'.repeat(64)}`]) {
      assert.throws(() => owner.authorize(candidate), error('MONDAY_OWNER_UNAUTHORIZED', 401));
      assert.deepEqual(owner.status(candidate), { authenticated: false });
    }
    assert.equal(owner.authorize(header(login.cookie)), 'ricardo');
  });

  it('requires session-specific CSRF on mutations, including an explicit missing header', () => {
    const owner = new MondayOwnerSessions(config(), () => AT);
    const first = authenticated(owner); const second = authenticated(owner);
    assert.throws(() => owner.authorize(header(first.cookie), undefined), error('MONDAY_OWNER_CSRF_REQUIRED', 403));
    assert.throws(() => owner.authorize(header(first.cookie), second.csrfToken), error('MONDAY_OWNER_CSRF_REQUIRED', 403));
    assert.throws(() => owner.authorize(header(first.cookie), '0'.repeat(64)), error('MONDAY_OWNER_CSRF_REQUIRED'));
    assert.equal(owner.authorize(header(first.cookie), first.csrfToken), 'ricardo');
    assert.equal(owner.authorize(header(first.cookie)), 'ricardo');
  });

  it('expires bootstrap at five minutes and owner session at fifteen without extending on reads', () => {
    let at = AT; const owner = new MondayOwnerSessions(config(), () => at);
    const challenge = owner.issueLoginChallenge(); at += MONDAY_OWNER_LOGIN_TTL_MS;
    assert.throws(() => owner.login(credentials, header(challenge.cookie), challenge.csrfToken), error('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED'));
    const login = authenticated(owner); const started = at;
    at = started + MONDAY_OWNER_SESSION_TTL_MS - 1;
    assert.equal(owner.authorize(header(login.cookie)), 'ricardo');
    at += 1;
    assert.throws(() => owner.authorize(header(login.cookie)), error('MONDAY_OWNER_UNAUTHORIZED'));
    assert.deepEqual(owner.status(header(login.cookie)), { authenticated: false });
  });

  it('rotates a current owner session and discards sessions and challenges on restart', () => {
    const owner = new MondayOwnerSessions(config(), () => AT); const first = authenticated(owner);
    const second = authenticated(owner, header(first.cookie));
    assert.notEqual(header(second.cookie), header(first.cookie)); assert.notEqual(second.csrfToken, first.csrfToken);
    assert.throws(() => owner.authorize(header(first.cookie)), error('MONDAY_OWNER_UNAUTHORIZED'));
    assert.equal(owner.authorize(header(second.cookie)), 'ricardo');
    const challenge = owner.issueLoginChallenge(); const restarted = new MondayOwnerSessions(config(), () => AT);
    assert.throws(() => restarted.authorize(header(second.cookie)), error('MONDAY_OWNER_UNAUTHORIZED'));
    assert.throws(() => restarted.login(credentials, header(challenge.cookie), challenge.csrfToken), error('MONDAY_OWNER_LOGIN_CHALLENGE_REQUIRED'));
  });

  it('requires CSRF for logout, revokes the session and clears only its owner cookie', () => {
    const owner = new MondayOwnerSessions(config(), () => AT); const login = authenticated(owner);
    assert.throws(() => owner.logout(header(login.cookie), undefined), error('MONDAY_OWNER_CSRF_REQUIRED'));
    assert.equal(owner.authorize(header(login.cookie)), 'ricardo');
    const cleared = owner.logout(header(login.cookie), login.csrfToken);
    assert.equal(cleared, `${MONDAY_OWNER_COOKIE}=; Path=/office-api/monday; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    assert.throws(() => owner.authorize(header(login.cookie)), error('MONDAY_OWNER_UNAUTHORIZED'));
    assert.deepEqual(owner.status(header(login.cookie)), { authenticated: false });
  });

  it('bounds attempts globally, then permits retry after the five-minute rate window', () => {
    let at = AT; const owner = new MondayOwnerSessions(config(), () => at);
    const challenges = Array.from({ length: 9 }, () => owner.issueLoginChallenge());
    for (const challenge of challenges.slice(0, 8)) assert.throws(() => owner.login({ ...credentials, password: 'SYNTHETIC_WRONG_PASSWORD_000' }, header(challenge.cookie), challenge.csrfToken), error('MONDAY_OWNER_UNAUTHORIZED'));
    assert.throws(() => owner.login(credentials, header(challenges[8].cookie), challenges[8].csrfToken), error('MONDAY_OWNER_LOGIN_RATE_LIMIT', 429));
    assert.throws(() => owner.issueLoginChallenge(), error('MONDAY_OWNER_LOGIN_RATE_LIMIT'));
    at += MONDAY_OWNER_LOGIN_TTL_MS;
    assert.equal(authenticated(owner).principal, 'ricardo');
  });

  it('bounds outstanding bootstrap records and prunes expired challenges', () => {
    let at = AT; const owner = new MondayOwnerSessions(config(), () => at);
    for (let index = 0; index < 128; index += 1) owner.issueLoginChallenge();
    assert.throws(() => owner.issueLoginChallenge(), error('MONDAY_OWNER_CHALLENGE_LIMIT', 429));
    at += MONDAY_OWNER_LOGIN_TTL_MS;
    assert.equal(authenticated(owner).principal, 'ricardo');
  });
});
