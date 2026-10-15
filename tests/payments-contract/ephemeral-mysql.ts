import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const label = 'com.gourmet.payments.ephemeral-storage';
const images = {
  mariadb: 'mariadb:11.4@sha256:1292844148b311e4ed4300022a996d39083f415a963e970cf47cad1b3b18e3a6',
  mysql: 'mysql:8.4@sha256:24989179f58856db763f418010c1169fecc944e3ec1ea7e921572d83eb070f70',
} as const;
export type EphemeralPaymentDatabaseBindingV2 = Readonly<{
  engine: 'mariadb' | 'mysql'; host: '127.0.0.1'; port: number;
  database: string; user: 'root'; password: ''; containerId: string; ownershipToken: string;
}>;
const issued = new WeakSet<object>();
const retired = new WeakSet<object>();
const docker = async (...args: string[]) => exec('docker', args, { timeout: 180_000, maxBuffer: 1_048_576 });
const info = async (id: string) => JSON.parse((await docker('inspect', id)).stdout)[0];

/** Binding is issued only after this helper starts a uniquely owned container.
 * A browser body, arbitrary DSN, ambient DB credential or copied plain object
 * cannot designate a database. No host directory is ever mounted.
 */
export async function assertEphemeralPaymentDatabaseV2(binding: EphemeralPaymentDatabaseBindingV2): Promise<void> {
  assert.ok(issued.has(binding) && !retired.has(binding), 'An active helper-issued ephemeral database is required');
  assert.equal(binding.host, '127.0.0.1');
  assert.match(binding.database, /^gourmet_payment_test_[a-f0-9]{32}$/);
  const current = await info(binding.containerId);
  assert.equal(current.Id, binding.containerId);
  assert.equal(current.Config.Labels?.[label], binding.ownershipToken);
  assert.equal(current.Config.Image, images[binding.engine]);
  assert.equal(current.State.Running, true);
  const ports = current.NetworkSettings.Ports?.['3306/tcp'];
  assert.deepEqual(ports, [{ HostIp: '127.0.0.1', HostPort: String(binding.port) }]);
  for (const [port, mappings] of Object.entries(current.NetworkSettings.Ports ?? {}))
    if (port !== '3306/tcp') assert.equal(mappings, null, 'No other database port may be published');
  assert.ok(current.Mounts.every((mount: { Type: string; Destination: string }) =>
    mount.Type === 'volume' && mount.Destination === '/var/lib/mysql'), 'Only anonymous engine storage is permitted');
  assert.equal(binding.user, 'root'); assert.equal(binding.password, '');
}

/** Read-only test-infrastructure probe over the exact published PDO path.
 * A Docker proxy can accept TCP while only MySQL's temporary UNIX-socket
 * initialization server is available; neither proves this connection ready.
 */
export async function ephemeralPaymentDatabaseTcpReadyV2(port: number, database: string): Promise<boolean> {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.match(database, /^gourmet_payment_test_[a-f0-9]{32}$/);
  const php = process.env.GOURMET_CONTRACT_MYSQL_PHP_BIN || process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
  try {
    const result = await exec(php, ['-d', 'xdebug.mode=off', '-d', 'mysqlnd.net_read_timeout=1', '-r', `
      try {
        $pdo = new PDO('mysql:host=127.0.0.1;port=' . $argv[1] . ';dbname=' . $argv[2] . ';charset=utf8mb4', 'root', '', [
          PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false,
          PDO::ATTR_STRINGIFY_FETCHES => false, PDO::ATTR_TIMEOUT => 1,
        ]);
        $query = $pdo->prepare('SELECT DATABASE(), 1'); $query->execute();
        $row = $query->fetch(PDO::FETCH_NUM);
        if (!is_array($row) || $row[0] !== $argv[2] || (int) $row[1] !== 1) { exit(1); }
        echo 'database_ready';
      } catch (Throwable) { exit(1); }
    `, String(port), database], { timeout: 2500, maxBuffer: 4096,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' } });
    return result.stdout === 'database_ready' && result.stderr === '';
  } catch { return false; }
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Real disposable engine, empty-password synthetic root, unique database,
 * loopback port, event scheduler OFF, and owner-checked cleanup of its volume.
 * This is test infrastructure, never imported by an application server.
 */
export async function startEphemeralPaymentDatabaseV2(engine: 'mariadb' | 'mysql') {
  assert.ok(Object.hasOwn(images, engine), 'Explicit supported engine required');
  await docker('version', '--format', '{{.Server.Version}}');
  const image = images[engine];
  try { await docker('image', 'inspect', image); } catch { await docker('pull', image); }
  const ownershipToken = randomUUID(), database = `gourmet_payment_test_${randomUUID().replaceAll('-', '')}`;
  const name = `gourmet-payment-${engine}-test-${randomUUID().slice(0, 8)}`;
  const prefix = engine === 'mariadb' ? 'MARIADB' : 'MYSQL';
  const allow = engine === 'mariadb' ? 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1' : 'MYSQL_ALLOW_EMPTY_PASSWORD=yes';
  let containerId: string | undefined, binding: EphemeralPaymentDatabaseBindingV2 | undefined, closed = false;
  const sql = async (query: string) => {
    assert.ok(containerId);
    const client = engine === 'mariadb' ? 'mariadb' : 'mysql';
    return (await docker('exec', containerId, client, '--protocol=socket', '-uroot', '--batch', '--skip-column-names', database, '-e', query)).stdout.trim();
  };
  const requireOwner = async () => {
    assert.ok(containerId);
    const current = await info(containerId);
    assert.equal(current.Id, containerId); assert.equal(current.Config.Labels?.[label], ownershipToken);
    assert.equal(current.Config.Image, image);
    assert.ok(current.Mounts.every((mount: { Type: string; Destination: string }) => mount.Type === 'volume' && mount.Destination === '/var/lib/mysql'));
    return current;
  };
  const close = async () => {
    if (closed) return;
    if (containerId) { await requireOwner(); await docker('rm', '-f', '-v', containerId); }
    if (binding) retired.add(binding);
    closed = true;
  };
  const ready = async () => {
    assert.ok(binding);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = await requireOwner();
      if (!current.State.Running) throw new Error('Synthetic storage engine exited before readiness');
      if (await ephemeralPaymentDatabaseTcpReadyV2(binding.port, binding.database)) return;
      await delay(250);
    }
    throw new Error('Synthetic storage engine readiness timed out');
  };
  try {
    // Docker's automatic host port may change on restart. Reserve a concrete
    // loopback port for the lifetime of this immutable fixture binding. A race
    // for that port fails startup rather than selecting another destination.
    const hostPort = await availableLoopbackPort();
    const started = await docker('run', '-d', '--name', name, '--label', `${label}=${ownershipToken}`,
      '-p', `127.0.0.1:${hostPort}:3306`, '--mount', 'type=volume,destination=/var/lib/mysql',
      '-e', allow, '-e', `${prefix}_ROOT_HOST=%`, '-e', `${prefix}_DATABASE=${database}`,
      image, '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin',
      '--default-time-zone=+00:00', '--event-scheduler=OFF', '--skip-name-resolve', '--skip-log-bin');
    containerId = started.stdout.trim(); assert.match(containerId, /^[a-f0-9]{64}$/);
    const current = await requireOwner(), port = Number(current.NetworkSettings.Ports?.['3306/tcp']?.[0]?.HostPort);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    binding = Object.freeze({ engine, host: '127.0.0.1', port, database, user: 'root', password: '', containerId, ownershipToken });
    issued.add(binding);
    await ready(); await assertEphemeralPaymentDatabaseV2(binding);
    return {
      binding,
      async inspect() {
        await assertEphemeralPaymentDatabaseV2(binding!);
        const facts = (await sql('SELECT VERSION(), @@version_comment, @@session.time_zone, @@event_scheduler')).split('\t');
        return { engine, image, containerId, database, version: facts[0], versionComment: facts[1],
          serverTimezone: facts[2], eventScheduler: facts[3], loopback: true };
      },
      async restart() {
        if (closed) throw new Error('Synthetic storage engine is closed');
        await requireOwner(); await docker('restart', containerId!); await ready();
      },
      close,
    };
  } catch (error) {
    // A timed-out docker run may have created the container before returning
    // its ID. Resolve only our unpredictable name and verify ownership before
    // cleanup; never enumerate or remove another test's container.
    if (!containerId) {
      try {
        const candidate = await info(name);
        if (candidate.Config.Labels?.[label] === ownershipToken && candidate.Config.Image === image) containerId = candidate.Id;
      } catch { /* No owned container was created. */ }
    }
    try { await close(); } catch { /* Preserve original startup failure. Owner check prevents unrelated cleanup. */ }
    throw error;
  }
}
