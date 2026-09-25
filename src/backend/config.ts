export type BackendConfig = {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  allowedOrigins: string[];
  allowMissingOrigin: boolean;
  bodyLimitBytes: number;
  rateLimitMax: number;
  rateLimitWindow: string;
  appVersion: string;
  gitSha: string | null;
  trustProxy: boolean;
  encryptionKeyBase64: string;
  encryptionKeyId: string;
  qaMarkerSecret: string | null;
  measurementEnvironment: 'staging' | 'production';
  googleAdsCustomerId: string | null;
  googleAdsConversionActionId: string | null;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function parseEnvironment(value: string | undefined): BackendConfig['environment'] {
  if (value === 'production' || value === 'test') return value;
  return 'development';
}

function validateOrigin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
  return parsed.origin;
}

function numericId(value: string | undefined, length: { min: number; max: number }): string | null {
  if (!value) return null;
  if (!new RegExp(`^\\d{${length.min},${length.max}}$`).test(value)) throw new Error('Invalid Google Ads numeric ID.');
  return value;
}

export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const environment = parseEnvironment(env.NODE_ENV);
  const databaseUrl = env.DATABASE_URL ?? '';
  const encryptionKeyBase64 = env.LEAD_ENCRYPTION_KEY_BASE64 ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (!encryptionKeyBase64) throw new Error('LEAD_ENCRYPTION_KEY_BASE64 is required.');

  const defaultOrigins = environment === 'production'
    ? ['https://gourmet-corporation.com']
    : ['https://gourmet-corporation.com', 'http://127.0.0.1:4173', 'http://localhost:5173'];
  const configuredOrigins = env.CORS_ALLOWED_ORIGINS?.split(',').map((item) => item.trim()).filter(Boolean);

  return {
    environment,
    host: env.API_HOST ?? '127.0.0.1',
    port: positiveInteger(env.API_PORT, 3001),
    databaseUrl,
    allowedOrigins: (configuredOrigins?.length ? configuredOrigins : defaultOrigins).map(validateOrigin),
    allowMissingOrigin: environment !== 'production' && env.ALLOW_MISSING_ORIGIN !== 'false',
    bodyLimitBytes: positiveInteger(env.API_BODY_LIMIT_BYTES, 262_144),
    rateLimitMax: positiveInteger(env.API_RATE_LIMIT_MAX, 120),
    rateLimitWindow: env.API_RATE_LIMIT_WINDOW ?? '1 minute',
    appVersion: env.npm_package_version ?? '0.1.0',
    gitSha: env.GIT_SHA?.slice(0, 64) || null,
    trustProxy: env.TRUST_PROXY === 'true',
    encryptionKeyBase64,
    encryptionKeyId: env.LEAD_ENCRYPTION_KEY_ID ?? 'v1',
    qaMarkerSecret: env.QA_MARKER_SECRET || null,
    measurementEnvironment: env.MEASUREMENT_ENVIRONMENT === 'production' ? 'production' : 'staging',
    googleAdsCustomerId: numericId(env.GOOGLE_ADS_CUSTOMER_ID, { min: 10, max: 10 }),
    googleAdsConversionActionId: numericId(env.GOOGLE_ADS_CONVERSION_ACTION_ID, { min: 1, max: 20 }),
  };
}
