import { OfficeError } from './state';

// These strings are fixed operator guidance, never derived from runtime values.
const requirements = {
  OFFICE_RUNTIME_MODE: 'staging',
  OFFICE_STAGING_ORIGIN: 'one exact HTTPS origin without path, credentials, query or fragment',
  OFFICE_STAGING_USERNAME: '3–64 ASCII letters, digits, dots, underscores or hyphens',
  OFFICE_STAGING_PASSWORD: '24–256 printable ASCII characters from ! to ~, without spaces',
  OFFICE_STAGING_ROLE: 'viewer or operator',
  OFFICE_STAGING_TRUSTED_PROXY_CIDRS: 'explicit bounded private proxy CIDRs; loopback must be an exact host',
  OFFICE_STAGING_DB_HOST: 'office-db',
  OFFICE_STAGING_DB_PORT: '5432',
  OFFICE_STAGING_DB_USER: 'office_stage',
  OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo',
  OFFICE_STAGING_DB_PASSWORD: '24–256 characters without U+0000–001F or U+007F controls',
  OFFICE_DATABASE_URL: 'unset in staging', DATABASE_URL: 'unset in staging',
  PGHOST: 'unset in staging', PGHOSTADDR: 'unset in staging', PGPORT: 'unset in staging',
  PGDATABASE: 'unset in staging', PGUSER: 'unset in staging', PGPASSWORD: 'unset in staging',
  PGOPTIONS: 'unset in staging', PGSSLMODE: 'unset in staging', PGSERVICE: 'unset in staging',
  PGSERVICEFILE: 'unset in staging', PGPASSFILE: 'unset in staging',
} as const;
export type StagingVariable = keyof typeof requirements;

export class StagingVariableError extends OfficeError {
  constructor(code: 'INVALID_STAGING_CONFIGURATION' | 'INVALID_STAGING_DATABASE', readonly variable: StagingVariable) {
    super(code, 503);
  }
}

const stageFailures = {
  configuration: 'STAGING_CONFIGURATION_FAILED',
  'database-construction': 'STAGING_DATABASE_CONFIGURATION_FAILED',
  'ui-build': 'STAGING_UI_FAILED',
  'app-ready': 'STAGING_APP_READY_FAILED',
  'database-initialize': 'STAGING_DATABASE_INITIALIZATION_FAILED',
  listen: 'STAGING_LISTEN_FAILED',
  shutdown: 'STAGING_SHUTDOWN_FAILED',
} as const;
export type StagingStartupStage = keyof typeof stageFailures;

const officeCodes = new Set([
  'INVALID_STAGING_CONFIGURATION', 'INVALID_STAGING_DATABASE', 'INVALID_STATE_ID',
  'STAGING_BUILD_REQUIRED', 'MIGRATION_CHECKSUM_MISMATCH', 'OFFICE_STATE_INVALID',
  'OFFICE_PROVENANCE_INVALID', 'INVALID_COMMERCIAL_CONTEXT', 'OFFICE_STATE_MISSING',
  'OFFICE_STORAGE_UNAVAILABLE', 'INVALID_CLOCK',
]);
const databaseCodes = new Map([
  ['28P01', 'STAGING_DATABASE_AUTHENTICATION_FAILED'],
  ['28000', 'STAGING_DATABASE_AUTHORIZATION_FAILED'],
  ['3D000', 'STAGING_DATABASE_NOT_FOUND'],
  ['42501', 'STAGING_DATABASE_PERMISSION_DENIED'],
  ['ENOTFOUND', 'STAGING_DATABASE_HOST_UNRESOLVED'],
  ['EAI_AGAIN', 'STAGING_DATABASE_HOST_UNRESOLVED'],
  ['ECONNREFUSED', 'STAGING_DATABASE_CONNECTION_REFUSED'],
  ['ETIMEDOUT', 'STAGING_DATABASE_CONNECTION_TIMEOUT'],
]);

export function stagingStartupDiagnostic(stage: StagingStartupStage, error: unknown): string {
  const safeStage = Object.hasOwn(stageFailures, stage) ? stage : 'configuration';
  const diagnostic: Record<string, string> = { event: 'office_staging_startup_failed', stage: safeStage, code: stageFailures[safeStage] };
  try {
    const code: unknown = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string') {
      if (error instanceof OfficeError && officeCodes.has(code)) diagnostic.code = code;
      else if (safeStage === 'database-initialize') diagnostic.code = databaseCodes.get(code) ?? diagnostic.code;
    }
    const variable: unknown = error instanceof StagingVariableError ? error.variable : undefined;
    if (typeof variable === 'string' && Object.hasOwn(requirements, variable)) {
      diagnostic.variable = variable;
      diagnostic.requirement = requirements[variable as StagingVariable];
    }
  } catch { /* Unexpected error accessors also stay inside the safe boundary. */ }
  // Never serialize the error: messages, stacks, detail, paths or DSNs may be secret.
  return JSON.stringify(diagnostic);
}

export async function closeStagingResources(resources: Array<{ close(): Promise<unknown> } | undefined>): Promise<boolean> {
  let failed = false;
  for (const resource of resources) {
    try { await resource?.close(); } catch { failed = true; }
  }
  return failed;
}
