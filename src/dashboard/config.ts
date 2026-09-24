import { resolve } from 'node:path';

export type DashboardConfig = {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  origin: string;
  cookieName: string;
  sessionTtlHours: number;
  abandonmentGraceMinutes: number;
  reportingTimezone: 'America/Los_Angeles';
  gitSha: string | null;
  trustProxy: boolean;
  staticDirectory: string;
};

function positiveInteger(value: string | undefined, fallback?: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function normalizedOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('DASHBOARD_ORIGIN must be an HTTPS origin.');
  }
  return parsed.origin;
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const environment = env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (environment === 'production' && !env.ABANDONMENT_GRACE_MINUTES) {
    throw new Error('ABANDONMENT_GRACE_MINUTES is required in production.');
  }

  return {
    environment,
    host: env.DASHBOARD_HOST ?? '127.0.0.1',
    port: positiveInteger(env.DASHBOARD_PORT, 3002),
    databaseUrl,
    origin: normalizedOrigin(env.DASHBOARD_ORIGIN ?? 'https://dashboard.gourmet-corporation.com'),
    cookieName: 'gourmet_staff_session_v1',
    sessionTtlHours: positiveInteger(env.STAFF_SESSION_TTL_HOURS, 12),
    abandonmentGraceMinutes: positiveInteger(env.ABANDONMENT_GRACE_MINUTES, 10),
    reportingTimezone: 'America/Los_Angeles',
    gitSha: env.GIT_SHA?.slice(0, 64) || null,
    trustProxy: env.TRUST_PROXY === 'true',
    staticDirectory: resolve(process.cwd(), env.DASHBOARD_STATIC_DIR ?? 'dist-dashboard'),
  };
}

