import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildDashboardApp } from '../../src/dashboard/app';
import { hashStaffPassword } from '../../src/dashboard/auth';
import type { DashboardConfig } from '../../src/dashboard/config';
import type { AuthenticatedStaff, DashboardStore, StaffUser } from '../../src/dashboard/contracts';

const config: DashboardConfig = {
  environment: 'test', host: '127.0.0.1', port: 3002, databaseUrl: 'unused',
  origin: 'https://dashboard.gourmet-corporation.com', cookieName: 'gourmet_staff_session_v1',
  sessionTtlHours: 12, abandonmentGraceMinutes: 10, reportingTimezone: 'America/Los_Angeles',
  gitSha: 'dashboard-test-sha', trustProxy: false, staticDirectory: 'unused',
};

let passwordHash = '';
before(async () => { passwordHash = await hashStaffPassword('correct-horse-battery-staple'); });

function fakeStore(options: { enabled?: boolean } = {}): DashboardStore & { revoked: Set<string> } {
  const user: StaffUser = {
    staffUserId: randomUUID(), email: 'admin@gourmet-corporation.com', passwordHash,
    role: 'admin', enabled: options.enabled ?? true,
  };
  const sessions = new Map<string, AuthenticatedStaff>();
  const revoked = new Set<string>();
  return {
    revoked,
    async health() {},
    async findStaffByEmail(email) { return email === user.email ? user : null; },
    async rotateStaffSession(_userId, tokenHash, expiresAt) {
      sessions.clear();
      sessions.set(tokenHash, { staffSessionId: randomUUID(), expiresAt: expiresAt.toISOString(), ...user });
    },
    async authenticateStaff(tokenHash) { return revoked.has(tokenHash) ? null : sessions.get(tokenHash) ?? null; },
    async revokeStaffSession(tokenHash) { revoked.add(tokenHash); },
    async recordLogin() {},
    async overview() { return { metrics: { sessions: 0 } }; },
    async funnel() { return { steps: [] }; },
    async sessions() { return { rows: [], next_cursor: null }; },
    async sessionDetail() { return null; },
    async leads() { return { rows: [], next_cursor: null }; },
    async leadDetail() { return null; },
    async attribution() { return { groups: {} }; },
    async close() {},
  };
}

const apps: FastifyInstance[] = [];
async function appFor(store = fakeStore()) {
  const app = await buildDashboardApp({ config, store, serveStatic: false });
  apps.push(app); return { app, store };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function login(app: FastifyInstance, password = 'correct-horse-battery-staple') {
  return app.inject({
    method: 'POST', url: '/v1/admin/auth/login',
    headers: { origin: config.origin, 'content-type': 'application/json' },
    payload: { email: 'ADMIN@GOURMET-CORPORATION.COM', password },
  });
}

describe('dashboard staff authentication', () => {
  it('rejects unauthenticated admin data and visitor IDs', async () => {
    const { app } = await appFor();
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/overview' });
    assert.equal(unauthenticated.statusCode, 401);
    const visitorIdentity = await app.inject({
      method: 'GET', url: '/v1/admin/overview', headers: { 'x-gourmet-session-id': randomUUID() },
    });
    assert.equal(visitorIdentity.statusCode, 401);
  });

  it('sets a secure cookie, authenticates, logs out, and rejects the revoked session', async () => {
    const { app } = await appFor();
    const response = await login(app);
    assert.equal(response.statusCode, 200);
    const setCookie = response.headers['set-cookie'];
    assert.match(setCookie, /gourmet_staff_session_v1=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
    const cookie = setCookie.split(';')[0];
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } })).statusCode, 200);
    const logout = await app.inject({
      method: 'POST', url: '/v1/admin/auth/logout', headers: { cookie, origin: config.origin, 'content-type': 'application/json' }, payload: {},
    });
    assert.equal(logout.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } })).statusCode, 401);
  });

  it('uses generic failures and rejects disabled staff users', async () => {
    const { app } = await appFor();
    const invalid = await login(app, 'this-password-is-wrong');
    assert.equal(invalid.statusCode, 401);
    assert.deepEqual(invalid.json(), { error: 'invalid_credentials' });
    const disabled = await appFor(fakeStore({ enabled: false }));
    const rejected = await login(disabled.app);
    assert.equal(rejected.statusCode, 401);
    assert.deepEqual(rejected.json(), { error: 'invalid_credentials' });
  });

  it('requires the exact dashboard origin and rate limits login attempts', async () => {
    const { app } = await appFor();
    const forbidden = await app.inject({
      method: 'POST', url: '/v1/admin/auth/login',
      headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' },
      payload: { email: 'admin@gourmet-corporation.com', password: 'correct-horse-battery-staple' },
    });
    assert.equal(forbidden.statusCode, 403);
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) lastStatus = (await login(app, 'this-password-is-wrong')).statusCode;
    assert.equal(lastStatus, 429);
  });
});
