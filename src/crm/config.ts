export type CrmWorkerConfig = {
  databaseUrl: string;
  token: string;
  boardId: string;
  groupId: string;
  batchSize: number;
  concurrency: number;
  pollMs: number;
  maxAttempts: number;
  leaseMs: number;
  ambiguousWindowMs: number;
  encryptionKeyBase64: string;
  encryptionKeyId: string;
  gitSha: string | null;
};

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} is invalid.`);
  return value;
}

export function loadCrmWorkerConfig(env: NodeJS.ProcessEnv = process.env): CrmWorkerConfig {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  return {
    databaseUrl: required('DATABASE_URL'),
    token: required('MONDAY_API_TOKEN'),
    boardId: env.MONDAY_BOARD_ID ?? '18403945258',
    groupId: required('MONDAY_GROUP_ID'),
    batchSize: integer(env, 'CRM_WORKER_BATCH_SIZE', 10, 1, 100),
    concurrency: integer(env, 'CRM_WORKER_CONCURRENCY', 2, 1, 8),
    pollMs: integer(env, 'CRM_WORKER_POLL_MS', 10_000, 1_000, 300_000),
    maxAttempts: integer(env, 'CRM_WORKER_MAX_ATTEMPTS', 8, 1, 30),
    leaseMs: integer(env, 'CRM_WORKER_LEASE_MS', 120_000, 30_000, 900_000),
    ambiguousWindowMs: integer(env, 'CRM_AMBIGUOUS_CREATE_WINDOW_MS', 1_500_000, 60_000, 1_740_000),
    encryptionKeyBase64: required('LEAD_ENCRYPTION_KEY_BASE64'),
    encryptionKeyId: env.LEAD_ENCRYPTION_KEY_ID ?? 'v1',
    gitSha: env.GIT_SHA?.slice(0, 64) || null,
  };
}

