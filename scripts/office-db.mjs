import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const container = 'gourmet-office-postgres-candidate-dev';
const image = 'postgres:16-alpine';
const dataDirectory = fileURLToPath(new URL('../.office-dev/postgres', import.meta.url));
const label = 'com.gourmet.office.synthetic-development';
const action = process.argv[2] ?? 'status';
const docker = (...args) => exec('docker', args, { maxBuffer: 1024 * 1024 });

async function inspect() {
  try { const result = await docker('inspect', container); return JSON.parse(result.stdout)[0]; }
  catch (error) { if (error.code === 1 && String(error.stderr).includes('No such')) return null; throw error; }
}
function requireOwned(info) {
  if (!info || info.Config.Labels?.[label] !== 'true' || !info.HostConfig.PortBindings?.['5432/tcp']?.every(item => item.HostIp === '127.0.0.1' && item.HostPort === '55433') || !info.Mounts.some(item => item.Source === dataDirectory && item.Destination === '/var/lib/postgresql/data')) throw new Error('Container is not the expected synthetic loopback development database.');
}
async function ready() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { await docker('exec', container, 'pg_isready', '-U', 'office_candidate', '-d', 'gourmet_office_candidate_dev'); return; }
    catch { await pause(250); }
  }
  throw new Error('Development PostgreSQL did not become ready within 45 seconds.');
}
try {
  if (process.env.OFFICE_RUNTIME_MODE !== undefined && process.env.OFFICE_RUNTIME_MODE !== 'development') throw new Error('Development database commands require development mode.');
  const info = await inspect();
  if (action === 'start') {
    if (info) { requireOwned(info); if (!info.State.Running) await docker('start', container); }
    else {
      await mkdir(dataDirectory, { recursive: true });
      await docker('run', '-d', '--name', container, '--label', `${label}=true`, '-p', '127.0.0.1:55433:5432', '--mount', `type=bind,source=${dataDirectory},target=/var/lib/postgresql/data`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=office_candidate', '-e', 'POSTGRES_DB=gourmet_office_candidate_dev', image);
    }
    await ready();
    process.stdout.write('Synthetic candidate PostgreSQL ready at 127.0.0.1:55433/gourmet_office_candidate_dev; local data preserved. API startup applies the verified migration.\n');
  } else if (action === 'stop' || action === 'restart') {
    requireOwned(info);
    await docker(action, container);
    if (action === 'restart') await ready();
    process.stdout.write(`Synthetic development PostgreSQL ${action === 'stop' ? 'stopped' : 'restarted'}; stored data preserved.\n`);
  } else if (action === 'status') {
    if (!info) process.stdout.write('Synthetic development PostgreSQL has not been created.\n');
    else { requireOwned(info); process.stdout.write(`Synthetic candidate PostgreSQL: ${info.State.Running ? 'running' : 'stopped'}; loopback 55433; local data.\n`); }
  } else if (action === 'migrate') {
    requireOwned(info); await ready();
    const { tsImport } = await import('tsx/esm/api');
    const { PostgresOfficeStore } = await tsImport('../src/office/backend/postgres-store.ts', import.meta.url);
    const store = new PostgresOfficeStore();
    try { await store.initialize(); process.stdout.write('Synthetic development migration checksum verified and existing office preserved.\n'); }
    finally { await store.close(); }
  } else throw new Error('Supported commands: start, status, stop, restart, migrate.');
} catch (error) {
  const reason = error.message.startsWith('Command failed:') ? 'Docker development operation failed; no network or production settings were changed.' : error.message;
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
