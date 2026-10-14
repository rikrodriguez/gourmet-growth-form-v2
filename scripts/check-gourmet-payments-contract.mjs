import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'tests/payments-contract');
const references = resolve(directory, 'references');
const manifest = JSON.parse(readFileSync(resolve(references, 'TRANSFER-SHA256SUMS.json'), 'utf8'));
assert.equal(Object.keys(manifest).length, 17, 'All 17 exact transferred references are required');
for (const [name, expected] of Object.entries(manifest)) {
  const path = resolve(references, name), within = relative(references, path);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Reference paths must remain local');
  const data = readFileSync(path);
  assert.equal(data.length, expected.bytes, `Reference byte count changed: ${name}`);
  assert.equal(createHash('sha256').update(data).digest('hex'), expected.sha256, `Reference changed: ${name}`);
}

const evidence = resolve(root, 'test-results/gourmet-payments-contract');
mkdirSync(evidence, { recursive: true });
const php = process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const environment = { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C', NODE_ENV: 'test' };
const guardProbes = [
  'try { fetch("https://example.invalid"); } catch {}',
  'import http from "node:http"; try { http.request("https://example.invalid"); } catch {}',
  'import net from "node:net"; const socket = new net.Socket(); try { socket.connect({host:"example.invalid",port:443}); } catch {} finally { socket.destroy(); }',
  'import dns from "node:dns"; try { dns.lookup("example.invalid",()=>{}); } catch {}',
];
for (const code of guardProbes) {
  const probe = spawnSync(process.execPath, ['--import', resolve(directory, 'no-network.mjs'), '--input-type=module', '-e', code], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
  });
  assert.ifError(probe.error);
  assert.equal(probe.status, 1, 'A caught network attempt must still fail the isolated process');
  assert.match(probe.stderr, /Blocked contract-test network attempts: 1/);
}
const disabled = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';
const producer = spawnSync(php, ['-d', 'allow_url_fopen=0', '-d', 'allow_url_include=0', '-d', `disable_functions=${disabled}`,
  resolve(references, 'producer-reference/generate-fixtures.php')], {
  cwd: directory, env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
});
writeFileSync(resolve(evidence, 'php-stderr.log'), producer.stderr || '');
assert.ifError(producer.error);
assert.equal(producer.signal, null, 'Isolated producer must finish within its deadline');
assert.equal(producer.status, 0, producer.stderr);
assert.equal(producer.stderr, '', 'Original producer must not emit warnings');
const result = JSON.parse(producer.stdout);
assert.equal(result.producer_executed, true);
assert.equal(result.storage, 'sqlite::memory:');
assert.equal(result.external_calls, 0);
assert.equal(result.rows.length, 7);
assert.equal(result.request_checks.length, 5);
assert.ok(result.request_checks.every(check => check.status === 'PASS'));
const fixtureOutput = resolve(evidence, 'php-result.json');
writeFileSync(fixtureOutput, producer.stdout);

const run = spawnSync(process.execPath, ['--import', resolve(directory, 'no-network.mjs'), '--import', 'tsx', '--test', '--test-reporter=tap',
  resolve(references, 'candidate/packages/integrations/src/gourmet-payments-contract-v1.test.ts'),
  resolve(references, 'evidence/independent-contract-review.test.ts'),
  resolve(references, 'evidence/php-source-interop.test.ts'), resolve(directory, 'roundtrip.test.ts')], {
  cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4194304,
  env: { ...environment, TSX_TSCONFIG_PATH: resolve(directory, 'tsconfig.json'),
    GOURMET_PHP_FIXTURE_OUTPUT: fixtureOutput, GOURMET_CONTRACT_PHP_BIN: php },
});
writeFileSync(resolve(evidence, 'node-tests.log'), `${run.stdout || ''}${run.stderr || ''}`);
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
assert.ifError(run.error);
assert.equal(run.signal, null, 'Contract tests must finish within their deadline');
assert.equal(run.status, 0, 'Original and round-trip contract tests must all pass');
const count = name => Number(run.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
assert.ok(Number.isSafeInteger(count('tests')) && count('tests') > 0, 'Retain the actual test counts');
assert.equal(count('fail'), 0);
assert.equal(count('skipped'), 0);
writeFileSync(resolve(evidence, 'summary.json'), JSON.stringify({
  nodeVersion: process.version, phpVersion: result.php_version, verifiedReferences: Object.keys(manifest).length,
  tsxVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/tsx/package.json'), 'utf8')).version,
  typescriptVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/typescript/package.json'), 'utf8')).version,
  tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
  storage: result.storage, producerRows: result.rows.length, requestChecks: result.request_checks.length,
  producerReportedExternalCalls: result.external_calls, networkGuardProbes: guardProbes.length,
  contractTestsExitCode: run.status,
  source: 'Current isolated execution; original references are byte verified; no application or provider started',
}, null, 2) + '\n');
console.log(`Current isolated evidence: ${relative(root, evidence)}`);
