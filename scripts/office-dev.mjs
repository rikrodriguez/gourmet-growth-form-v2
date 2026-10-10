import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
function launch(command, args) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  children.add(child);
  child.once('error', () => stop(1));
  child.once('exit', code => {
    children.delete(child);
    if (!stopping) stop(code || 1);
  });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

async function prepareDatabase() {
  const child = spawn(process.execPath, ['scripts/office-db.mjs', 'start'], { cwd, stdio: 'inherit' });
  children.add(child);
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  children.delete(child);
  if (status !== 0 || stopping) throw new Error('Development database startup failed.');
}
async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (stopping) throw new Error('Development startup stopped.');
    try {
      const response = await fetch('http://127.0.0.1:4180/office-api/health', { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.mode === 'demo' && health.storage === 'postgres') return;
    } catch { /* The API may still be applying its development migration. */ }
    await pause(250);
  }
  throw new Error('Development API did not become ready.');
}
try {
  if (process.env.OFFICE_RUNTIME_MODE !== undefined && process.env.OFFICE_RUNTIME_MODE !== 'development') throw new Error('Development launch requires development mode.');
  await prepareDatabase();
  launch(process.execPath, ['--import', 'tsx', 'src/office/backend/server.ts']);
  await waitForApi();
  launch(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.office.config.ts']);
  process.stdout.write('Open http://127.0.0.1:4175/office/ and choose Abrir sesión de desarrollo. Ctrl+C stops UI/API; PostgreSQL and its synthetic data are preserved.\n');
} catch {
  process.stderr.write('Gourmet Office development could not start; no fallback storage was created.\n');
  stop(1);
}
