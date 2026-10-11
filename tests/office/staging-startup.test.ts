import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OfficeError } from '../../src/office/backend/state';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { closeStagingResources, stagingStartupDiagnostic, StagingVariableError } from '../../src/office/backend/staging-diagnostics';

const marker = 'TEST_ONLY-canary-that-must-never-appear';
const root = fileURLToPath(new URL('../../', import.meta.url));
function fixture(extra: Record<string, string> = {}) {
  // Existing public synthetic fixtures, never provisioned credentials.
  return {
    OFFICE_RUNTIME_MODE: 'staging',
    OFFICE_STAGING_ORIGIN: 'https://office-staging.gourmet-corporation.com',
    OFFICE_STAGING_USERNAME: 'ricardo', OFFICE_STAGING_ROLE: 'operator',
    OFFICE_STAGING_PASSWORD: 'synthetic-auth-password-for-unit-tests-only',
    OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,172.16.1.2/32',
    OFFICE_STAGING_DB_HOST: 'office-db', OFFICE_STAGING_DB_PORT: '5432',
    OFFICE_STAGING_DB_USER: 'office_stage', OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo',
    OFFICE_STAGING_DB_PASSWORD: 'synthetic-database-password-for-unit-tests-only',
    ...extra,
  };
}

describe('safe staging startup diagnosis', () => {
  it('accepts the inspected nonsecret configuration with synthetic valid secrets', () => {
    const runtime = parseOfficeStagingEnvironment(fixture());
    assert.equal(runtime.access.role, 'operator');
    assert(runtime.access.trustedPeer('172.16.1.2'));
  });

  it('identifies invalid secret fields without weakening either password contract', () => {
    for (const [variable, values, code] of [
      ['OFFICE_STAGING_PASSWORD', ['short', 'a'.repeat(257), 'a'.repeat(23) + ' ', 'a'.repeat(23) + 'é'], 'INVALID_STAGING_CONFIGURATION'],
      ['OFFICE_STAGING_DB_PASSWORD', ['short', 'a'.repeat(257), marker + '\n'], 'INVALID_STAGING_DATABASE'],
    ] as const) {
      for (const value of values) {
        assert.throws(() => parseOfficeStagingEnvironment(fixture({ [variable]: value })), error => {
          assert(error instanceof StagingVariableError);
          assert.equal(error.code, code);
          const diagnostic = JSON.parse(stagingStartupDiagnostic('configuration', error));
          assert.equal(diagnostic.variable, variable);
          assert.match(diagnostic.requirement, /24–256/);
          assert(!JSON.stringify(diagnostic).includes(marker));
          return true;
        });
      }
    }
    // DB allows printable Unicode/spaces as before; HTTP Basic retains strict ASCII.
    parseOfficeStagingEnvironment(fixture({ OFFICE_STAGING_DB_PASSWORD: 'é'.repeat(24) + ' ' }));
  });

  it('maps database authentication failure without copying PostgreSQL detail or DSNs', () => {
    const error = Object.assign(new Error(`postgresql://user:${marker}@example.test/db`), {
      code: '28P01', detail: marker, hint: marker, stack: marker,
    });
    assert.deepEqual(JSON.parse(stagingStartupDiagnostic('database-initialize', error)), {
      event: 'office_staging_startup_failed', stage: 'database-initialize', code: 'STAGING_DATABASE_AUTHENTICATION_FAILED',
    });
    assert(!stagingStartupDiagnostic('app-ready', error).includes(marker));
  });

  it('permits only reviewed OfficeError codes and variable requirements', () => {
    assert.equal(JSON.parse(stagingStartupDiagnostic('ui-build', new OfficeError('STAGING_BUILD_REQUIRED', 503))).code, 'STAGING_BUILD_REQUIRED');
    const unknown = new OfficeError(marker, 503);
    unknown.stack = marker;
    const forged = new StagingVariableError('INVALID_STAGING_CONFIGURATION', marker as 'OFFICE_STAGING_PASSWORD');
    for (const error of [unknown, forged, { code: marker, message: marker, stack: marker }]) {
      assert(!stagingStartupDiagnostic('configuration', error).includes(marker));
    }
  });

  it('keeps throwing error accessors inside the safe diagnostic boundary', () => {
    const error = Object.defineProperty({}, 'code', { get() { throw new Error(marker); } });
    const diagnostic = stagingStartupDiagnostic('database-initialize', error);
    assert.equal(JSON.parse(diagnostic).code, 'STAGING_DATABASE_INITIALIZATION_FAILED');
    assert(!diagnostic.includes(marker));
  });

  it('reads changing error accessors once before validating their fixed allowlists', () => {
    let codeReads = 0;
    const error = Object.defineProperty(new OfficeError('INVALID_STAGING_CONFIGURATION', 503), 'code', {
      get() { return codeReads++ === 0 ? 'INVALID_STAGING_CONFIGURATION' : marker; },
    });
    assert.equal(JSON.parse(stagingStartupDiagnostic('configuration', error)).code, 'INVALID_STAGING_CONFIGURATION');
    assert.equal(codeReads, 1);

    let variableReads = 0;
    const variableError = Object.defineProperty(new StagingVariableError('INVALID_STAGING_CONFIGURATION', 'OFFICE_STAGING_PASSWORD'), 'variable', {
      get() { return variableReads++ === 0 ? 'OFFICE_STAGING_PASSWORD' : marker; },
    });
    const diagnostic = stagingStartupDiagnostic('configuration', variableError);
    assert.equal(JSON.parse(diagnostic).variable, 'OFFICE_STAGING_PASSWORD');
    assert.equal(variableReads, 1);
    assert(!diagnostic.includes(marker));

    const objectVariable = Object.defineProperty(new StagingVariableError('INVALID_STAGING_CONFIGURATION', 'OFFICE_STAGING_PASSWORD'), 'variable', {
      value: { toJSON() { return marker; } },
    });
    assert(!stagingStartupDiagnostic('configuration', objectVariable).includes(marker));
  });

  it('attempts every resource cleanup without letting an exception escape', async () => {
    const closed: number[] = [];
    const failed = await closeStagingResources([
      { async close() { closed.push(1); throw new Error(marker); } },
      undefined,
      { async close() { closed.push(2); } },
    ]);
    assert.equal(failed, true);
    assert.deepEqual(closed, [1, 2]);
    assert.equal(await closeStagingResources([undefined]), false);
  });

  it('prints only structured diagnosis and exits before DB access on invalid CLI configuration', () => {
    for (const extra of [
      { OFFICE_STAGING_ORIGIN: `https://user:${marker}@office.example.test` },
      { OFFICE_STAGING_PASSWORD: marker + ' ' },
      { OFFICE_STAGING_DB_PASSWORD: marker + '\n' },
    ]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/office/backend/staging-server.ts'], {
        cwd: root, env: { PATH: process.env.PATH ?? '', ...fixture(extra) }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert(!result.stderr.includes(marker));
      const diagnostic = JSON.parse(result.stderr.trim());
      assert.equal(diagnostic.event, 'office_staging_startup_failed');
      assert.equal(diagnostic.stage, 'configuration');
      assert.equal(diagnostic.variable, Object.keys(extra)[0]);
      assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'event', 'requirement', 'stage', 'variable']);
    }
  });
});
