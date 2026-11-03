import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from './generate-reviewed-fixture.mjs';

const { values } = parseArgs({ options: { adapter: { type: 'string' }, php: { type: 'string' } } });
assert.ok(values.adapter && values.php, 'Configura --adapter y --php con rutas locales revisadas.');
const directory = await mkdtemp(join(tmpdir(), 'generator-contract-fixture-'));
try {
  const outputDirectory = join(directory, 'output');
  const result = await main([
    '--vault-fixture', resolve('examples/context/vault-fixture.json'),
    '--review', resolve('examples/context/reviewed-evidence.json'),
    '--monday', resolve('examples/context/monday-fixture.json'),
    '--adapter', values.adapter, '--php', values.php, '--out', outputDirectory,
  ]);
  const request = JSON.parse(await readFile(join(outputDirectory, 'paypal-request.fixture.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(outputDirectory, 'review-report.json'), 'utf8'));
  const html = await readFile(join(outputDirectory, 'preview.html'), 'utf8');
  assert.equal(result.status, 'fixture-only-generated');
  assert.equal(request.body.line_items[0].unit_amount.value, '300.00');
  assert.equal(request.body.line_items[0].unit_amount.currency_code, 'USD');
  assert.equal(report.evidence.agreedTotal.value, '1200.00');
  assert.equal(report.evidence.depositAmount.value, '300.00');
  assert.equal(report.monday.fields.depositAmount.mondayValue, '250.00');
  assert.equal(report.monday.status, 'conflict');
  assert.equal(report.source, 'vault');
  assert.equal(report.historyComplete, false);
  assert.equal(report.provenance.authorization.captureConfirmed, true);
  assert.equal(report.provenance.review.operatorConfirmed, true);
  assert.equal(report.provenance.verification.method, 'fixture');
  assert.equal(report.provenance.verification.exportMetadata.fileNameIdentifierKind, 'message-id');
  assert.equal(report.provenance.verification.exportMetadata.queryPath, 'Batch/CustomBatchInfo/Query');
  assert.equal(report.constraints.paymentExecutionAllowed, false);
  assert.match(html, /300\.00/);
  assert.match(html, /DEMO LOCAL/);
  assert.doesNotMatch(html, /\s(?:href|src|action)\s*=|<script\b/i);
  assert.deepEqual(result.execution, { networkUsed: false, paymentCreated: false, published: false });
  console.log('PASS external generator fixture: reviewed 1200.00/300.00 USD, stale Monday 1000.00/250.00 retained, partial Vault provenance, disabled local preview. No real Vault reader or PayPal resource verified.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
