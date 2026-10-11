import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createMondayOAuthService, MONDAY_OAUTH_ORIGIN, parseMondayConfiguration } from './monday-oauth';
import type { MondayOAuthService } from './monday-oauth';
import { MondayOwnerSessions, parseMondayOwnerConfiguration } from './monday-owner';
import { createMondayReadClient, MONDAY_READ_BOARD_IDS } from './monday-read';
import type { MondayColumnAllowlist } from './monday-read';
import { MondayVault, PostgresMondayStore } from './monday-store';

export type MondayRuntime = Readonly<{
  enabled: boolean;
  configured: boolean;
  ownerSessions: MondayOwnerSessions;
  oauthService?: MondayOAuthService;
  configurationFailure?: 'configuration_invalid';
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
  const unavailable = (invalid = false): MondayRuntime => Object.freeze({
    enabled: false, configured: false, ownerSessions: new MondayOwnerSessions(),
    ...(invalid ? { configurationFailure: 'configuration_invalid' as const } : {}),
  });
  try {
    const flag = env.MONDAY_OAUTH_ENABLED;
    if (flag === undefined || flag === '' || flag === 'false') return unavailable();
    if (flag !== 'true' || stagingOrigin !== MONDAY_OAUTH_ORIGIN) return unavailable(true);
    const ownerConfiguration = parseMondayOwnerConfiguration(env);
    if (!ownerConfiguration.available) return unavailable(true);
    const configuration = parseMondayConfiguration(env, stagingOrigin);
    if (!configuration.enabled) return unavailable(true);
    const readClient = createMondayReadClient({ enabled: true, ...columns(env.MONDAY_BOARD_COLUMNS_JSON) });
    const oauthService = createMondayOAuthService({
      configuration, store: new PostgresMondayStore(pool),
      vault: new MondayVault(configuration.tokenEncryptionKey), readClient,
    });
    return Object.freeze({ enabled: true, configured: true, ownerSessions: new MondayOwnerSessions(ownerConfiguration), oauthService });
  } catch {
    // No raw error, field value, client configuration or credential is exposed.
    return unavailable(true);
  }
}
