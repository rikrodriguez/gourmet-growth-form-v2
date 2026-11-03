import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('inspection CLI returns a recoverable report for invalid latest evidence and accepts a later correction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-inspect-'));
  try {
    const input = JSON.parse(await readFile(new URL('../../examples/context/vault-fixture.json', import.meta.url), 'utf8'));
    input.source = 'user-provided';
    input.captureMode = 'manual-text';
    delete input.verification;
    delete input.fixture;
    const file = join(directory, 'context.json');
    const run = () => spawnSync(process.execPath, [resolve('scripts/generate-reviewed-fixture.mjs'), '--context', file], { encoding: 'utf8' });
    input.text += '\nDepósito: 0 USD';
    await writeFile(file, JSON.stringify(input));
    const invalid = run();
    assert.equal(invalid.status, 0, invalid.stderr);
    const pending = JSON.parse(invalid.stdout);
    assert.ok(pending.missing.includes('depositAmount'));
    assert.equal(pending.evidence.fields.depositAmount.hasUnresolvedUpdate, true);
    assert.equal(pending.status, 'requires-explicit-review');
    input.text += '\nDepósito: 300.00 USD';
    await writeFile(file, JSON.stringify(input));
    const corrected = run();
    assert.equal(corrected.status, 0, corrected.stderr);
    const report = JSON.parse(corrected.stdout);
    assert.equal(report.evidence.fields.depositAmount.hasUnresolvedUpdate, false);
    assert.equal(report.evidence.fields.depositAmount.candidates.at(-1).value, '300.00');
    assert.equal(report.status, 'requires-explicit-review');
    assert.equal(report.request, undefined);
    assert.equal(report.historyComplete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
