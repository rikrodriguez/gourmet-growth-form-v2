export type AdsDeliveryMode = 'disabled' | 'validate-only' | 'live';

export type AdsWorkerConfig = {
  databaseUrl: string;
  customerId: string;
  conversionActionId: string;
  deliveryMode: AdsDeliveryMode;
  measurementEnvironment: 'staging' | 'production';
  batchSize: number;
  concurrency: number;
  pollMs: number;
  maxAttempts: number;
  leaseMs: number;
  encryptionKeyBase64: string;
  encryptionKeyId: string;
  gitSha: string | null;
};

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} is invalid.`);
  return value;
}

function requiredNumeric(env: NodeJS.ProcessEnv, key: string, min: number, max: number): string {
  const value = env[key] ?? '';
  if (!new RegExp(`^\\d{${min},${max}}$`).test(value)) throw new Error(`${key} is invalid.`);
  return value;
}

export function loadAdsWorkerConfig(env: NodeJS.ProcessEnv = process.env): AdsWorkerConfig {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  const deliveryMode = env.GOOGLE_ADS_DELIVERY_MODE === 'live'
    ? 'live'
    : env.GOOGLE_ADS_DELIVERY_MODE === 'validate-only' ? 'validate-only' : 'disabled';
  const measurementEnvironment = env.MEASUREMENT_ENVIRONMENT === 'production' ? 'production' : 'staging';
  if (deliveryMode === 'live' && measurementEnvironment !== 'production') {
    throw new Error('Live Google Ads delivery requires MEASUREMENT_ENVIRONMENT=production.');
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    customerId: requiredNumeric(env, 'GOOGLE_ADS_CUSTOMER_ID', 10, 10),
    conversionActionId: requiredNumeric(env, 'GOOGLE_ADS_CONVERSION_ACTION_ID', 1, 20),
    deliveryMode,
    measurementEnvironment,
    batchSize: integer(env, 'MEASUREMENT_WORKER_BATCH_SIZE', 10, 1, 100),
    concurrency: integer(env, 'MEASUREMENT_WORKER_CONCURRENCY', 2, 1, 8),
    pollMs: integer(env, 'MEASUREMENT_WORKER_POLL_MS', 10_000, 1_000, 300_000),
    maxAttempts: integer(env, 'MEASUREMENT_WORKER_MAX_ATTEMPTS', 8, 1, 30),
    leaseMs: integer(env, 'MEASUREMENT_WORKER_LEASE_MS', 120_000, 30_000, 900_000),
    encryptionKeyBase64: required('LEAD_ENCRYPTION_KEY_BASE64'),
    encryptionKeyId: env.LEAD_ENCRYPTION_KEY_ID ?? 'v1',
    gitSha: env.GIT_SHA?.slice(0, 64) || null,
  };
}
