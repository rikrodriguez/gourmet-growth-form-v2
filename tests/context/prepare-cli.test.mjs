import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/prepare-reservation-context.mjs');
test('manual workflow requires authorization, review, and never writes payment output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-context-test-'));
  try {
    const text = join(directory, 'conversation.txt');
    const confirmed = join(directory, 'confirmed.json');
    await writeFile(text, 'Mensaje privado ficticio: depósito $250.');
    await writeFile(confirmed, JSON.stringify({ depositAmount: '250.00' }));
    const execute = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const unauthorized = execute('--text', text);
    assert.equal(unauthorized.status, 1);
    assert.equal(unauthorized.stdout, '');
    assert.doesNotMatch(unauthorized.stderr, /Mensaje privado/);
    const unreviewed = execute('--text', text, '--confirm-authorized', '--confirmed', confirmed);
    assert.equal(unreviewed.status, 1);
    assert.equal(unreviewed.stdout, '');
    const reviewed = execute('--text', text, '--confirm-authorized', '--confirmed', confirmed, '--confirm-reviewed');
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const brief = JSON.parse(reviewed.stdout);
    assert.equal(brief.capture.source, 'user-provided');
    assert.equal(brief.capture.historyComplete, false);
    assert.equal(brief.reservation.depositAmount, '250.00');
    assert.equal(brief.constraints.paymentExecutionAllowed, false);
    assert.equal(brief.paypalUrl, undefined);
    assert.ok(brief.missingConfirmations.includes('agreedTotal'));
    assert.equal(execute('--text', text, '--capture', text).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
