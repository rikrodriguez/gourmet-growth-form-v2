import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runFixtureAdapter, validateFixtureResult } from '../../src/context/generator-adapter.mjs';
import { fakeGeneratorOutput } from '../fixtures/fake-generator-process.mjs';

const input = () => ({ schemaVersion: 1, mode: 'fixture-only', reservation: { depositAmount: '300.00', currency: 'USD' }, provenance: { historyComplete: false } });
const command = { command: process.execPath, args: [resolve('tests/fixtures/fake-generator-process.mjs')] };

test('fixture quantity cannot change the reviewed deposit', () => {
  for (const quantity of [2, '2', 0, -1, '0.5', null, true, {}, []]) {
    const output = fakeGeneratorOutput(input());
    output.paypalRequest.body.line_items[0].quantity = quantity;
    assert.throws(() => validateFixtureResult(input(), output), /GENERATOR_PROTOCOL_INVALID/, JSON.stringify(quantity));
  }
  for (const quantity of [1, '1']) {
    const output = fakeGeneratorOutput(input());
    output.paypalRequest.body.line_items[0].quantity = quantity;
    assert.equal(validateFixtureResult(input(), output).paypalRequest.body.line_items[0].quantity, quantity);
  }
  assert.doesNotThrow(() => validateFixtureResult(input(), fakeGeneratorOutput(input())));
});

test('preview policy and warning precede even comment-disguised template markers', () => {
  const output = fakeGeneratorOutput(input());
  output.landingHtml = '<!-- <head></head><body></body> --><html><head><title>Fixture</title></head><body>Local review</body></html>';
  const html = validateFixtureResult(input(), output).landingHtml;
  assert.match(html, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<!--'));
  assert.ok(html.indexOf('DEMO LOCAL') < html.indexOf('<!--'));
  assert.match(html, /Local review/);
});

test('preview links and assets are stripped with HTML slash separators and duplicates', () => {
  const variants = [
    '<a/href="https://one.invalid">Go</a>',
    '<a////href="https://one.invalid">Go</a>',
    '<a href="https://one.invalid"/href="https://two.invalid">Go</a>',
    '<area/href=https://one.invalid>',
    '<img/src="https://one.invalid" srcset="https://two.invalid 1x, https://three.invalid 2x">',
    '<button/formaction="https://one.invalid">Review</button>',
  ];
  for (const content of variants) {
    const output = fakeGeneratorOutput(input());
    output.landingHtml = `<html><head></head><body>${content}</body></html>`;
    const html = validateFixtureResult(input(), output).landingHtml;
    assert.doesNotMatch(html, /(?:href|src|srcset|formaction)\s*=/i, content);
    assert.doesNotMatch(html, /https:\/\//, content);
  }
});

test('removing a target preserves token boundaries instead of creating a new link', () => {
  const output = fakeGeneratorOutput(input());
  output.landingHtml = '<html><head></head><body><a h href="https://one.invalid"ref="https://two.invalid">Review</a></body></html>';
  const html = validateFixtureResult(input(), output).landingHtml;
  assert.doesNotMatch(html, /[\s/]href\s*=/i);
  assert.match(html, /<a h\s+ref=/);
});

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
