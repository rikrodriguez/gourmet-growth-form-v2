import { BlockList, isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { OfficeError } from './state';
import { validateStagingDatabaseOptions } from './postgres-store';
import type { StagingDatabaseOptions } from './postgres-store';

export type StagingAccess = Readonly<{
  mode: 'staging';
  origin: string;
  host: string;
  role: 'viewer' | 'operator';
  trustedPeer: (address: string | undefined) => boolean;
  authenticated: (authorization: string | undefined) => boolean;
}>;
export type OfficeStagingRuntime = Readonly<{ access: StagingAccess; database: StagingDatabaseOptions }>;

// No implicit staging, hostname discovery, URL credentials or production DB names.
// Secrets enter through explicit environment fields and never appear in errors.
export function parseOfficeStagingEnvironment(env: Record<string, string | undefined>): OfficeStagingRuntime {
  const invalid = () => new OfficeError('INVALID_STAGING_CONFIGURATION', 503);
  if (env.OFFICE_RUNTIME_MODE !== 'staging') throw invalid();
  for (const key of ['OFFICE_DATABASE_URL', 'DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE']) {
    if (env[key] !== undefined) throw invalid();
  }
  let origin: URL;
  try { origin = new URL(env.OFFICE_STAGING_ORIGIN ?? ''); } catch { throw invalid(); }
  // WHATWG URL preserves IPv6 brackets; node:net.isIP expects their contents.
  const hostname = origin.hostname.startsWith('[') ? origin.hostname.slice(1, -1) : origin.hostname;
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || env.OFFICE_STAGING_ORIGIN !== origin.origin || !hostname || isIP(hostname) || hostname === 'localhost' || (origin.port && origin.port !== '443')) throw invalid();
  const username = env.OFFICE_STAGING_USERNAME;
  const password = env.OFFICE_STAGING_PASSWORD;
  const role = env.OFFICE_STAGING_ROLE ?? 'viewer';
  if (!username || !/^[A-Za-z0-9._-]{3,64}$/.test(username) || !password || password.length < 24 || password.length > 256 || !/^[\x21-\x7e]+$/.test(password) || !['viewer', 'operator'].includes(role)) throw invalid();
  const peers = proxyPeers(env.OFFICE_STAGING_TRUSTED_PROXY_CIDRS, invalid);
  const expected = digest(Buffer.from(`${username}:${password}`, 'utf8'));
  const authenticated = (value: string | undefined) => {
    // Canonical bounded Basic header; compare digests even on invalid input.
    const match = typeof value === 'string' && value.length <= 1024 ? /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value) : null;
    const decoded = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
    const valid = !!match && decoded.toString('base64') === match[1];
    const equal = timingSafeEqual(expected, digest(decoded));
    return valid && equal;
  };
  const trustedPeer = (value: string | undefined) => {
    if (!value) return false;
    const address = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
    const family = isIP(address);
    return family !== 0 && peers.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
  const database = validateStagingDatabaseOptions({ host: env.OFFICE_STAGING_DB_HOST, port: env.OFFICE_STAGING_DB_PORT === '5432' ? 5432 : NaN, user: env.OFFICE_STAGING_DB_USER, database: env.OFFICE_STAGING_DB_NAME, password: env.OFFICE_STAGING_DB_PASSWORD });
  return Object.freeze({ access: Object.freeze({ mode: 'staging', origin: origin.origin, host: origin.host, role: role as 'viewer' | 'operator', trustedPeer, authenticated }), database });
}

function digest(value: Buffer) { return createHash('sha256').update(value).digest(); }
function proxyPeers(value: string | undefined, invalid: () => OfficeError) {
  const entries = value?.split(',');
  if (!entries || entries.length === 0 || entries.length > 16 || new Set(entries).size !== entries.length) throw invalid();
  const peers = new BlockList();
  const privateV4 = new BlockList();
  const privateV6 = new BlockList();
  for (const [address, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) privateV4.addSubnet(address, bits, 'ipv4');
  privateV6.addSubnet('fc00::', 7, 'ipv6');
  for (const entry of entries) {
    const match = /^([^/\s]+)\/(\d{1,3})$/.exec(entry);
    if (!match) throw invalid();
    const address = match[1];
    const family = isIP(address);
    const bits = Number(match[2]);
    if (!family || bits < (family === 4 ? 24 : 64) || bits > (family === 4 ? 32 : 128)) throw invalid();
    // Keep families separate: Node BlockList also matches IPv4-mapped IPv6.
    // Otherwise ::ffff:10.0.0.1/64 or an expanded ::1/64 could trust public IPv4.
    const canonicalV6 = family === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : '';
    const allowed = family === 4
      ? privateV4.check(address, 'ipv4') || (address === '127.0.0.1' && bits === 32)
      : privateV6.check(address, 'ipv6') || (canonicalV6 === '::1' && bits === 128);
    if (!allowed) throw invalid();
    peers.addSubnet(address, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return peers;
}
