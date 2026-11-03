import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const malformed = 'SYNTHETIC_PRIVATE_CONTENT_MUST_NOT_APPEAR_IN_LOGS';
const execute = (script, args) => spawnSync(process.execPath, [resolve(`scripts/${script}.mjs`), ...args], { encoding: 'utf8' });

test('malformed JSON errors identify the input without echoing its private content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-input-errors-'));
  try {
    const bad = join(directory, 'private-input.json');
    const valid = join(directory, 'context.json');
    const output = join(directory, 'must-not-be-created');
    const context = JSON.parse(await readFile(new URL('../../examples/context/vault-fixture.json', import.meta.url), 'utf8'));
    context.source = 'user-provided'; context.captureMode = 'manual-text';
    delete context.fixture; delete context.verification;
    await writeFile(valid, JSON.stringify(context));
    await writeFile(bad, malformed);
    for (const [kind, script, args] of [
      ['CONTEXT', 'generate-reviewed-fixture', ['--context', bad]],
      ['CONTEXT', 'generate-reviewed-fixture', ['--vault-fixture', bad]],
      ['CONTEXT', 'prepare-reservation-context', ['--capture', bad]],
      ['MONDAY', 'generate-reviewed-fixture', ['--context', valid, '--monday', bad]],
      ['REVIEW', 'generate-reviewed-fixture', ['--context', valid, '--review', bad, '--adapter', 'not-executed.php', '--out', output]],
      ['CONFIRMED', 'prepare-reservation-context', ['--capture', valid, '--confirmed', bad, '--confirm-reviewed']],
    ]) {
      const result = execute(script, args);
      assert.equal(result.status, 1, kind);
      assert.equal(result.stdout, '', kind);
      assert.doesNotMatch(result.stderr, /SYNTHETIC_|PRIVATE_CONTENT|Unexpected token/, kind);
      assert.match(result.stderr, new RegExp(`${kind}_JSON_INVALID`), kind);
    }
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unreadable JSON and manual-text errors do not expose local input paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-input-errors-'));
  try {
    const absent = join(directory, 'SYNTHETIC_PRIVATE_FILENAME.json');
    for (const [script, flag] of [
      ['generate-reviewed-fixture', '--context'],
      ['prepare-reservation-context', '--capture'],
      ['prepare-reservation-context', '--text'],
    ]) {
      const result = execute(script, [flag, absent]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE_FILENAME|gourmet-input-errors-/);
      assert.match(result.stderr, /CONTEXT_READ_FAILED/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
