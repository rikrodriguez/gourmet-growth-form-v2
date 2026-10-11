import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const composePath = fileURLToPath(new URL('../../compose.staging.yml', import.meta.url));
const resourceUuid = 'TEST_ONLY-resource-uuid';
const host = 'office-staging.gourmet-corporation.com';

function render(resource: string | undefined) {
  // No inherited credentials or .env file. This is the build-phase contract:
  // Coolify supplies its UUID before it loads the application's runtime secrets.
  const result = spawnSync('docker', [
    'compose', '--env-file', '/dev/null', '--project-name', 'gourmet-office-compose-contract',
    '-f', composePath, 'config', '--format', 'json',
  ], {
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      ...(resource === undefined ? {} : { COOLIFY_RESOURCE_UUID: resource }),
    },
    encoding: 'utf8',
  });
  return result;
}

function effectiveCompose() {
  const result = render(resourceUuid);
  assert.equal(result.status, 0, `Compose must load without runtime secrets: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('Coolify Raw Compose staging boundaries without runtime credentials', () => {
  it('keeps PostgreSQL solely on its internal network with no published ports or proxy routing', () => {
    const compose = effectiveCompose();
    const db = compose.services['office-db'];
    const web = compose.services['office-web'];
    assert.deepEqual(Object.keys(db.networks), ['database']);
    assert.equal(compose.networks.database.internal, true);
    assert.equal(compose.networks.database.external, undefined);
    assert.deepEqual([...Object.keys(web.networks)].sort(), ['database', 'frontend']);
    assert.equal(compose.networks.frontend.external, true);
    assert.equal(compose.networks.frontend.name, 'coolify');
    assert.equal((db.ports ?? []).length, 0);
    assert.equal((web.ports ?? []).length, 0);
    assert.deepEqual(db.labels, { 'traefik.enable': 'false' });
    assert.equal(db.volumes[0].source, 'office-stage-postgres');
    assert.equal(db.environment.POSTGRES_INITDB_ARGS, '--auth-host=scram-sha-256');
  });

  it('routes only the staging host through HTTPS to web port 4180 on the existing proxy network', () => {
    const compose = effectiveCompose();
    const labels = compose.services['office-web'].labels;
    const http = `traefik.http.routers.office-staging-http-${resourceUuid}`;
    const https = `traefik.http.routers.office-staging-https-${resourceUuid}`;
    const middleware = `traefik.http.middlewares.office-staging-https-${resourceUuid}`;
    const service = `traefik.http.services.office-staging-web-${resourceUuid}`;
    assert.equal(labels['traefik.enable'], 'true');
    assert.equal(labels['traefik.docker.network'], 'coolify');
    assert.equal(labels[`${http}.rule`], `Host(\`${host}\`)`);
    assert.equal(labels[`${https}.rule`], `Host(\`${host}\`)`);
    assert.equal(labels[`${http}.entrypoints`], 'http');
    assert.equal(labels[`${http}.middlewares`], `office-staging-https-${resourceUuid}`);
    assert.equal(labels[`${middleware}.redirectscheme.scheme`], 'https');
    assert.equal(labels[`${middleware}.redirectscheme.permanent`], 'true');
    assert.equal(labels[`${https}.entrypoints`], 'https');
    assert.equal(labels[`${https}.tls`], 'true');
    assert.equal(labels[`${https}.tls.certresolver`], 'letsencrypt');
    assert.equal(labels[`${https}.service`], `office-staging-web-${resourceUuid}`);
    assert.equal(labels[`${service}.loadbalancer.server.port`], '4180');
    assert.equal(labels[`${service}.loadbalancer.passhostheader`], 'true');
    assert.equal(labels[`${https}.middlewares`], undefined);
  });

  it('allows build interpolation without runtime secrets, retaining authenticated health and runtime validation', () => {
    const compose = effectiveCompose();
    const web = compose.services['office-web'];
    assert.equal(web.build.target, 'runtime');
    assert.equal(Object.keys(web.build.args ?? {}).length, 0);
    for (const key of ['OFFICE_STAGING_ORIGIN', 'OFFICE_STAGING_USERNAME', 'OFFICE_STAGING_PASSWORD', 'OFFICE_STAGING_DB_PASSWORD']) {
      assert.equal(web.environment[key], '');
    }
    assert.equal(web.environment.OFFICE_RUNTIME_MODE, 'staging');
    assert.equal(web.environment.OFFICE_STAGING_ROLE, 'viewer');
    assert.equal(web.environment.OFFICE_STAGING_TRUSTED_PROXY_CIDRS, '127.0.0.1/32,');
    assert.equal(compose.services['office-db'].environment.POSTGRES_PASSWORD, '');
    assert.deepEqual(web.healthcheck.test, ['CMD', 'node', 'scripts/office-staging-health.mjs']);
    assert.equal(web.read_only, true);
    assert.deepEqual(web.cap_drop, ['ALL']);
  });

  it('requires the Coolify resource UUID for resource-scoped routing identifiers', () => {
    const result = render(undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Coolify resource UUID is required/);
  });
});
