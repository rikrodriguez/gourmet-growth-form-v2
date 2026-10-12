import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createMondayOAuthService, MONDAY_OAUTH_ORIGIN, parseMondayConfiguration } from './monday-oauth';
import type { MondayOAuthService } from './monday-oauth';
import { MondayOwnerSessions, parseMondayOwnerConfiguration } from './monday-owner';
import { createMondayReadClient, MONDAY_READ_BOARD_IDS } from './monday-read';
import type { MondayColumnAllowlist } from './monday-read';
import { MondayVault, PostgresMondayStore } from './monday-store';
import { createMondayRenewalScheduler } from './monday-renewal';
import { createMondayDisabledDiagnostic, getMondayConfigurationDiagnostic, withMondayConfigurationDiagnostic, type MondayConfigurationDiagnostic, type MondayConfigurationField, type MondayConfigurationReason } from './monday-diagnostics';

export type MondayRuntime = Readonly<{
  enabled: boolean;
  configured: boolean;
  ownerSessions: MondayOwnerSessions;
  oauthService?: MondayOAuthService;
  renewalScheduler?: ReturnType<typeof createMondayRenewalScheduler>;
  configurationFailure?: 'configuration_invalid';
  startupDiagnostic?: MondayConfigurationDiagnostic;
}>;

const MAX_COLUMNS_JSON_BYTES = 32 * 1024;
function columns(raw: unknown): { columnAllowlist?: MondayColumnAllowlist; mappingVersion: string } {
  if (raw === undefined || raw === '') return { mappingVersion: 'unconfigured-v1' };
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_COLUMNS_JSON_BYTES) throw new Error();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const names = Object.keys(value);
  if (names.length !== MONDAY_READ_BOARD_IDS.length || names.some(name => !(MONDAY_READ_BOARD_IDS as readonly string[]).includes(name))) throw new Error();
  // Column objects, their exact fields, compatible types and duplicate IDs or
  // commercial fields are validated by the existing server-only read client.
  const mapping = value as MondayColumnAllowlist;
  for (const boardId of MONDAY_READ_BOARD_IDS) {
    const configured = mapping[boardId];
    if (!Array.isArray(configured) || configured.length > 20) throw new Error();
  }
  const digest = createHash('sha256').update(JSON.stringify(MONDAY_READ_BOARD_IDS.map(id => [id, mapping[id]]))).digest('hex');
  return { columnAllowlist: mapping, mappingVersion: `sha256-${digest}` };
}

// No credentials are read and no store, vault or provider client is constructed
// while the flag is off. Invalid optional configuration never blocks DEMO boot.
export function createMondayRuntime(env: Readonly<Record<string, string | undefined>>, stagingOrigin: string, pool: Pool): MondayRuntime {
  const invalid = (field: MondayConfigurationField, reason: MondayConfigurationReason) =>
    withMondayConfigurationDiagnostic(new Error(), field, reason);
  const unavailable = (diagnostic: MondayConfigurationDiagnostic): MondayRuntime => Object.freeze({
    enabled: false, configured: false, ownerSessions: new MondayOwnerSessions(),
    ...(diagnostic.code === 'configuration_invalid' ? { configurationFailure: 'configuration_invalid' as const } : {}),
    startupDiagnostic: diagnostic,
  });
  try {
    let flag: string | undefined;
    try { flag = env.MONDAY_OAUTH_ENABLED; }
    catch { throw invalid('MONDAY_OAUTH_ENABLED', 'invalid_format'); }
    if (flag === undefined || flag === '' || flag === 'false') return unavailable(createMondayDisabledDiagnostic(flag !== 'false'));
    if (flag !== 'true') throw invalid('MONDAY_OAUTH_ENABLED', 'invalid_format');
    if (stagingOrigin !== MONDAY_OAUTH_ORIGIN) throw invalid('OFFICE_STAGING_ORIGIN', 'policy_mismatch');
    const ownerConfiguration = parseMondayOwnerConfiguration(env);
    if (!ownerConfiguration.available) throw invalid('MONDAY_OWNER_USERNAME', 'missing');
    const configuration = parseMondayConfiguration(env, stagingOrigin);
    if (!configuration.enabled) throw invalid('MONDAY_OAUTH_ENABLED', 'invalid_format');
    let readClient: ReturnType<typeof createMondayReadClient>;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(env, 'MONDAY_BOARD_COLUMNS_JSON');
      if (descriptor && !('value' in descriptor)) throw new Error();
      readClient = createMondayReadClient({ enabled: true, ...columns(descriptor?.value) });
    } catch { throw invalid('MONDAY_BOARD_COLUMNS_JSON', 'invalid_format'); }
    const store = new PostgresMondayStore(pool);
    const vault = new MondayVault(configuration.tokenEncryptionKey);
    const oauthService = createMondayOAuthService({ configuration, store, vault, readClient });
    // Deliberately fixed off. This lot has no environment switch or HTTP route
    // that can activate background refresh of the existing grant.
    const renewalScheduler = createMondayRenewalScheduler({ enabled: false, service: oauthService, store, vault });
    return Object.freeze({ enabled: true, configured: true, ownerSessions: new MondayOwnerSessions(ownerConfiguration), oauthService, renewalScheduler });
  } catch (error) {
    // No raw error, field value, client configuration or credential is exposed.
    return unavailable(getMondayConfigurationDiagnostic(error) ?? Object.freeze({ code: 'configuration_invalid' }));
  }
}
