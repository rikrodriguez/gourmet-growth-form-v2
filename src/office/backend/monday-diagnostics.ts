const CONFIGURATION_FIELDS = [
  'MONDAY_OAUTH_ENABLED', 'MONDAY_OWNER_USERNAME', 'MONDAY_OWNER_PASSWORD',
  'MONDAY_CLIENT_ID', 'MONDAY_CLIENT_SECRET', 'MONDAY_TOKEN_ENCRYPTION_KEY',
  'MONDAY_EXPECTED_ACCOUNT_EMAIL', 'MONDAY_EXPECTED_USER_ID', 'MONDAY_EXPECTED_ACCOUNT_ID',
  'MONDAY_BOARD_COLUMNS_JSON', 'OFFICE_STAGING_ORIGIN',
] as const;
const CONFIGURATION_REASONS = ['missing', 'invalid_format', 'not_separate', 'policy_mismatch'] as const;

export type MondayConfigurationField = typeof CONFIGURATION_FIELDS[number];
export type MondayConfigurationReason = typeof CONFIGURATION_REASONS[number];
export type MondayConfigurationDiagnostic = Readonly<
  | { code: 'configuration_invalid'; field?: never; reason?: never }
  | { code: 'configuration_invalid'; field: MondayConfigurationField; reason: MondayConfigurationReason }
  | { code: 'disabled'; field: 'MONDAY_OAUTH_ENABLED'; reason?: 'missing' }
>;

// Neither errors nor caller-supplied diagnostic objects are reflected or
// serialized. Only metadata issued here can reach the startup formatter.
const errorDiagnostics = new WeakMap<object, MondayConfigurationDiagnostic>();
const issuedDiagnostics = new WeakMap<object, MondayConfigurationDiagnostic>();
const generic: MondayConfigurationDiagnostic = Object.freeze({ code: 'configuration_invalid' });

function object(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
function issue(diagnostic: MondayConfigurationDiagnostic): MondayConfigurationDiagnostic {
  const frozen = Object.freeze(diagnostic);
  issuedDiagnostics.set(frozen, frozen);
  return frozen;
}

export function withMondayConfigurationDiagnostic<T extends Error>(error: T, field: MondayConfigurationField, reason: MondayConfigurationReason): T {
  if (object(error) && typeof field === 'string' && (CONFIGURATION_FIELDS as readonly string[]).includes(field)
    && typeof reason === 'string' && (CONFIGURATION_REASONS as readonly string[]).includes(reason)) {
    errorDiagnostics.set(error, issue({ code: 'configuration_invalid', field, reason }));
  }
  return error;
}

export function getMondayConfigurationDiagnostic(error: unknown): MondayConfigurationDiagnostic | undefined {
  return object(error) ? errorDiagnostics.get(error) : undefined;
}

export function createMondayDisabledDiagnostic(missing: boolean): MondayConfigurationDiagnostic {
  return issue(missing
    ? { code: 'disabled', field: 'MONDAY_OAUTH_ENABLED', reason: 'missing' }
    : { code: 'disabled', field: 'MONDAY_OAUTH_ENABLED' });
}

export function formatMondayStartupDiagnostic(diagnostic: unknown): string {
  const safe = object(diagnostic) ? issuedDiagnostics.get(diagnostic) ?? generic : generic;
  // The object is a frozen, internally constructed record of enum literals.
  return JSON.stringify(safe);
}
