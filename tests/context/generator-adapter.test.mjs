import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runFixtureAdapter, validateFixtureResult } from '../../src/context/generator-adapter.mjs';
import { fakeGeneratorOutput } from '../fixtures/fake-generator-process.mjs';

const input = () => ({ schemaVersion: 1, mode: 'fixture-only', reservation: { depositAmount: '300.00', currency: 'USD' }, provenance: { historyComplete: false } });
const command = { command: process.execPath, args: [resolve('tests/fixtures/fake-generator-process.mjs')] };

test('local process protocol preserves provenance and exact money without inheriting secrets', () => {
  const old = process.env.CONTEXT_TEST_SECRET;
  process.env.CONTEXT_TEST_SECRET = 'fixture-never-forward';
  try {
    const result = runFixtureAdapter(input(), command);
    assert.equal(result.paypalRequest.body.line_items[0].unit_amount.value, '300.00');
    assert.deepEqual(result.provenance, input().provenance);
    assert.match(result.landingHtml, /DEMO LOCAL/);
    assert.match(result.landingHtml, /Content-Security-Policy/);
    assert.doesNotMatch(result.landingHtml, /href\s*=/i);
    assert.deepEqual(result.execution, { networkUsed: false, paymentCreated: false, published: false });
  } finally {
    if (old === undefined) delete process.env.CONTEXT_TEST_SECRET;
    else process.env.CONTEXT_TEST_SECRET = old;
  }
});

test('rejects execution modes, child failure and malformed output without disclosing child data', () => {
  assert.throws(() => runFixtureAdapter({ ...input(), mode: 'live' }, command), /fixture-only/);
  assert.throws(() => runFixtureAdapter(input(), {}), /UNAVAILABLE/);
  for (const flag of ['--fail', '--malformed']) {
    assert.throws(() => runFixtureAdapter(input(), { ...command, args: [...command.args, flag] }), error =>
      /GENERATOR_/.test(error.message) && !error.message.includes('PRIVATE CHILD'));
  }
});

test('rejects altered money, authorization, execution flags, payable return URLs and active HTML', () => {
  const variants = [
    output => { output.paypalRequest.body.line_items[0].unit_amount.value = '250.00'; },
    output => { output.provenance = { historyComplete: true }; },
    output => { output.execution.paymentCreated = true; },
    output => { output.paypalRequest.headers.push('Authorization: Bearer SECRET'); },
    output => { output.paypalRequest.body.return_url = 'https://example.com/checkout'; },
    output => { output.landingHtml = '<html><head></head><body><script>alert(1)</script></body></html>'; },
    output => { output.landingHtml = '<html><head></head><body><img onerror="alert(1)"></body></html>'; },
    output => { output.landingHtml = '<html><head><meta http-equiv="refresh" content="0;url=https://example.com"></head><body></body></html>'; },
    output => { output.landingHtml = '<html><head><meta http-equiv="&#114;efresh" content="0;url=https://example.com"></head><body></body></html>'; },
    output => { output.landingHtml = '<html><head></head><body><svg><a xlink:href="https://example.com">Go</a></svg></body></html>'; },
  ];
  for (const change of variants) {
    const output = fakeGeneratorOutput(structuredClone(input()));
    change(output);
    assert.throws(() => validateFixtureResult(input(), output));
  }
});
