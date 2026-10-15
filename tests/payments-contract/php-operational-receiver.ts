import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Explicit test composition. No production import, credentials, default
// transport, live recipient, original E2E or ambient application environment.
const php = process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const fixturePath = fileURLToPath(new URL('./operational-fixture.php', import.meta.url));
const routerPath = fileURLToPath(new URL('./operational-router.php', import.meta.url));
const materializerUrl = new URL('../../scripts/prepare-gourmet-payments-operational.mjs', import.meta.url);
const disabledFunctions = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';
const phpOptions = ['-d', 'xdebug.mode=off', '-d', 'allow_url_fopen=0', '-d', 'allow_url_include=0', '-d', `disable_functions=${disabledFunctions}`];
export const operationalFixtureSharedSecret = 'synthetic-operational-fixture-no-authority';
const baseEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C',
  INTERNAL_API_ENABLED: 'false', INTERNAL_V2_ENABLED: 'true',
  INTERNAL_V2_COMMERCIAL_DRAFT_ENABLED: 'false',
  INTERNAL_API_SHARED_SECRET: operationalFixtureSharedSecret,
  PAYMENT_LINK_ENCRYPTION_KEY: 'cd'.repeat(32),
};

export type OperationalLedgerSnapshotV2 = {
  counts: Record<string, number>; agreements: Record<string, any>[]; schedules: Record<string, any>[];
  idempotency: Record<string, any>[]; audit: Record<string, any>[];
  migrations: string[]; foreignKeyViolations: unknown[];
};
type FixtureResult = {
  snapshot: OperationalLedgerSnapshotV2; providerCalls: number;
  response?: { status: number; body: string }; applied?: string[];
  legacyBeforeMigration?: Record<string, any>[];
  legacyMoney?: { totalCents: number; reservationCents: number; balanceCents: number; currency: string };
  callbackCalls?: number; seenInside?: Record<string, any>; before?: OperationalLedgerSnapshotV2;
  transactionOpen?: boolean;
  migrationFault?: { failed: boolean; transactionOpen: boolean; before: Record<string, any>;
    afterFailure: Record<string, any>; applied: string[]; reapplied: string[]; afterSuccess: Record<string, any> };
};
export type OperationalFixtureV2 = {
  directory: string; runtime: string; initial: FixtureResult;
  invoke(input: Record<string, unknown>, environment?: NodeJS.ProcessEnv): FixtureResult;
  close(): Promise<void>;
};

export async function createOperationalPaymentFixtureV2(options: { seedLegacy?: boolean } = {}): Promise<OperationalFixtureV2> {
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-payments-operational-'));
  const runtime = join(directory, 'runtime');
  try {
    await writeFile(join(directory, 'synthetic-fixture-only'), 'Disposable synthetic payment proof\n', { mode: 0o600 });
    await mkdir(join(directory, 'storage'), { mode: 0o700 });
    // Importing this module has no CLI side effect. The materializer verifies
    // every original source before applying the reviewed patch/new migration.
    const { prepareGourmetPaymentsOperationalRuntime } = await import(materializerUrl.href);
    await prepareGourmetPaymentsOperationalRuntime({ destination: runtime });
    if (options.seedLegacy) {
      const legacy = join(directory, 'legacy-migrations', 'sqlite');
      await mkdir(legacy, { recursive: true });
      for (const name of await readdir(join(runtime, 'migrations', 'sqlite'))) {
        if (/^000[1245]_.*\.sql$/.test(name))
          await copyFile(join(runtime, 'migrations', 'sqlite', name), join(legacy, name));
      }
    }
    const invoke = (input: Record<string, unknown>, environment: NodeJS.ProcessEnv = {}): FixtureResult => {
      const child = spawnSync(php, [...phpOptions, fixturePath, runtime, directory], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 2_097_152,
        cwd: directory, env: { ...baseEnvironment, ...environment },
      });
      assert.ifError(child.error);
      assert.equal(child.signal, null, 'Synthetic PHP fixture must finish without termination');
      assert.equal(child.status, 0, `Operational PHP fixture failed: ${child.stderr}`);
      assert.equal(child.stderr, '', 'Operational PHP fixture must not emit warnings');
      const result = JSON.parse(child.stdout) as FixtureResult;
      assert.equal(result.providerCalls, 0, 'Draft must never call the injected original provider transport');
      assert.deepEqual(result.snapshot.foreignKeyViolations, [], 'Actual SQLite foreign keys must remain valid');
      return result;
    };
    const initial = invoke({ action: 'initialize', seedLegacy: options.seedLegacy === true });
    return { directory, runtime, initial, invoke, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export type OperationalPaymentReceiverV2 = {
  readonly baseUrl: string; readonly sharedSecret: string;
  inspect(): Promise<OperationalLedgerSnapshotV2 & { providerCalls: number }>;
  restart(): Promise<void>; close(): Promise<void>;
};

/** Real loopback HTTP -> original Request/Application -> original SQLite. The
 * router supplies only explicit synthetic composition and a blocked provider. */
export async function startOperationalPaymentReceiverV2(): Promise<OperationalPaymentReceiverV2> {
  const fixture = await createOperationalPaymentFixtureV2();
  let child: ChildProcess | undefined, stderr = '', closed = false;
  const port = await new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') { reservation.close(); reject(new Error('No loopback fixture port')); return; }
      reservation.close(error => error ? reject(error) : resolve(address.port));
    });
  }).catch(async error => { await fixture.close(); throw error; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = async () => {
    const running = child; child = undefined;
    if (!running || !running.pid || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise<void>(resolve => {
      running.once('exit', () => resolve());
      running.kill('SIGTERM');
      const timer = setTimeout(() => running.kill('SIGKILL'), 1000); timer.unref();
      running.once('exit', () => clearTimeout(timer));
    });
  };
  const start = async () => {
    stderr = '';
    const running = spawn(php, [...phpOptions, '-S', `127.0.0.1:${port}`, routerPath], {
      cwd: fixture.directory, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...baseEnvironment, GOURMET_SYNTHETIC_RUNTIME_ROOT: fixture.runtime,
        GOURMET_SYNTHETIC_FIXTURE_DIRECTORY: fixture.directory },
    });
    child = running;
    let startError: Error | undefined;
    running.once('error', error => { startError = error; });
    running.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-65_536); });
    for (let attempt = 0; attempt < 50; ++attempt) {
      if (startError || running.exitCode !== null || running.signalCode !== null)
        throw new Error(`Synthetic operational HTTP server failed: ${startError?.message || stderr}`);
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
        if (response.status === 200) return;
      } catch { /* Server has not bound its loopback socket yet. */ }
      await delay(100);
    }
    throw new Error(`Synthetic operational HTTP server did not become ready: ${stderr}`);
  };
  try { await start(); }
  catch (error) { await stop(); await fixture.close(); throw error; }
  return {
    baseUrl, sharedSecret: operationalFixtureSharedSecret,
    async inspect() {
      const snapshot = fixture.invoke({ action: 'snapshot' }).snapshot;
      const attempts = await readFile(join(fixture.directory, 'provider-attempts.log'), 'utf8').catch(error => {
        if (error?.code === 'ENOENT') return ''; throw error;
      });
      return { ...snapshot, providerCalls: attempts.split('\n').filter(Boolean).length };
    },
    async restart() {
      if (closed) throw new Error('Synthetic operational HTTP receiver is closed');
      await stop(); await start();
    },
    async close() {
      if (closed) return; closed = true;
      await stop(); await fixture.close();
    },
  };
}
