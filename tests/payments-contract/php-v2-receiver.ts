import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit test composition only. Production code never imports this launcher.
const directory = fileURLToPath(new URL('.', import.meta.url));
const receiver = fileURLToPath(new URL('./receive-v2.php', import.meta.url));
const moneySource = fileURLToPath(new URL('./v2-originals/Money.php', import.meta.url));
const moneySha256 = 'd84e7bfb9c5b92357141e91bb9d1738099abce5ae95aa36abe2ccaebacad2cc1';
const disabledFunctions = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';

/** Spawn the real isolated PHP validator, preserving its raw receipt. The
 * optional observer counts actual child starts in tests, never PHP assertions. */
export async function receiveIsolatedPaymentContractV2(body: string, nowMs: number, signal: AbortSignal, onSpawn?: () => void): Promise<string> {
  if (signal.aborted) throw new Error('PAYMENT_CONTRACT_PHP_ABORTED');
  if (typeof body !== 'string' || Buffer.byteLength(body) > 131_072 || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error('INVALID_PAYMENT_CONTRACT_PHP_INPUT');
  const originalMoney = await readFile(moneySource);
  if (originalMoney.length !== 985 || createHash('sha256').update(originalMoney).digest('hex') !== moneySha256)
    throw new Error('ORIGINAL_PAYMENT_MONEY_REFERENCE_CHANGED');
  if (signal.aborted) throw new Error('PAYMENT_CONTRACT_PHP_ABORTED');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.GOURMET_CONTRACT_PHP_BIN || 'php', [
      '-d', 'xdebug.mode=off', '-d', 'allow_url_fopen=0', '-d', 'allow_url_include=0',
      '-d', `disable_functions=${disabledFunctions}`, receiver, String(nowMs),
    ], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); finish(new Error('PAYMENT_CONTRACT_PHP_DEADLINE'));
    }, 5000);
    timer.unref();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262_144) { child.kill('SIGKILL'); finish(new Error('PAYMENT_CONTRACT_PHP_OUTPUT_LIMIT')); }
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    child.stdin.on('error', () => finish(new Error('PAYMENT_CONTRACT_PHP_INPUT_FAILED')));
    child.once('error', () => finish(new Error(signal.aborted ? 'PAYMENT_CONTRACT_PHP_ABORTED' : 'PAYMENT_CONTRACT_PHP_START_FAILED')));
    child.once('spawn', () => { onSpawn?.(); });
    child.once('close', (code, terminatedBy) => {
      if (signal.aborted) finish(new Error('PAYMENT_CONTRACT_PHP_ABORTED'));
      else if (code !== 0 || terminatedBy !== null || errors.length) finish(new Error('PAYMENT_CONTRACT_PHP_VALIDATION_FAILED'));
      else finish(undefined, Buffer.concat(output).toString('utf8'));
    });
    child.stdin.end(body);
  });
}
