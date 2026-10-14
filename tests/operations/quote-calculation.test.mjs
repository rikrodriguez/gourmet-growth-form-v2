import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateQuoteTotals, QuoteCalculationError } from '../../src/operations/quote-calculation.mjs';

const input = (overrides = {}) => ({
  lines: [{ qty: 3, unitPriceCents: 101 }], taxBps: 500, depositBps: 5000, ...overrides,
});
function assertError(code, operation) {
  assert.throws(operation, error => error instanceof QuoteCalculationError && error.code === code);
}

test('calculates the existing quote totals without mutating caller data', () => {
  const quote = Object.freeze({
    lines: Object.freeze([Object.freeze({ qty: 3, unitPriceCents: 101 })]),
    taxBps: 500, depositBps: 5000,
  });
  assert.deepEqual(calculateQuoteTotals(quote), {
    subtotalCents: 303, taxCents: 15, totalCents: 318, depositCents: 159,
  });
});

test('rounds half up once on aggregate subtotal and once on the tax-inclusive deposit', () => {
  assert.deepEqual(calculateQuoteTotals(input({
    lines: [{ qty: 1, unitPriceCents: 1 }], taxBps: 5000, depositBps: 2500,
  })), { subtotalCents: 1, taxCents: 1, totalCents: 2, depositCents: 1 });
  assert.deepEqual(calculateQuoteTotals(input({
    lines: [{ qty: 1, unitPriceCents: 1 }, { qty: 1, unitPriceCents: 1 }],
    taxBps: 2500, depositBps: 5000,
  })), { subtotalCents: 2, taxCents: 1, totalCents: 3, depositCents: 2 });
  assert.deepEqual(calculateQuoteTotals(input({
    lines: [{ qty: 1, unitPriceCents: 1 }], taxBps: 4999, depositBps: 4999,
  })), { subtotalCents: 1, taxCents: 0, totalCents: 1, depositCents: 0 });
});

test('handles zero prices and zero/full basis-point rates exactly', () => {
  assert.deepEqual(calculateQuoteTotals(input({
    lines: [{ qty: 1, unitPriceCents: 0 }], taxBps: 10_000, depositBps: 10_000,
  })), { subtotalCents: 0, taxCents: 0, totalCents: 0, depositCents: 0 });
  assert.deepEqual(calculateQuoteTotals(input({ taxBps: 0, depositBps: 0 })), {
    subtotalCents: 303, taxCents: 0, totalCents: 303, depositCents: 0,
  });
  assert.deepEqual(calculateQuoteTotals(input({ taxBps: 10_000, depositBps: 10_000 })), {
    subtotalCents: 303, taxCents: 303, totalCents: 606, depositCents: 606,
  });
});

test('enforces the existing total ceiling before converting BigInt to Number', () => {
  const line = { qty: 1000, unitPriceCents: 1_000_000 };
  assert.deepEqual(calculateQuoteTotals(input({ lines: [line], taxBps: 0, depositBps: 10_000 })), {
    subtotalCents: 1_000_000_000, taxCents: 0, totalCents: 1_000_000_000, depositCents: 1_000_000_000,
  });
  for (const overrides of [
    { lines: [line], taxBps: 1 },
    { lines: [line, line], taxBps: 0 },
    { lines: [{ qty: Number.MAX_SAFE_INTEGER, unitPriceCents: Number.MAX_SAFE_INTEGER }] },
    { lines: [{ qty: 1, unitPriceCents: Number.MAX_SAFE_INTEGER }, { qty: 1, unitPriceCents: 1 }] },
  ]) assertError('quote_total_limit', () => calculateQuoteTotals(input(overrides)));
});

for (const field of ['qty', 'unitPriceCents', 'taxBps', 'depositBps']) {
  test(`independently rejects invalid ${field} values`, () => {
    for (const value of [-1, 0.5, true, '1', null, undefined, NaN, Infinity, -Infinity, 1n, Number.MAX_SAFE_INTEGER + 1]) {
      const quote = input();
      if (field === 'qty' || field === 'unitPriceCents') quote.lines[0][field] = value;
      else quote[field] = value;
      assertError('invalid_integer', () => calculateQuoteTotals(quote));
    }
  });
}

test('rejects zero quantity and basis-point rates above the existing bound', () => {
  assertError('invalid_integer', () => calculateQuoteTotals(input({ lines: [{ qty: 0, unitPriceCents: 1 }] })));
  assertError('invalid_integer', () => calculateQuoteTotals(input({ taxBps: 10_001 })));
  assertError('invalid_integer', () => calculateQuoteTotals(input({ depositBps: 10_001 })));
});

test('rejects missing, malformed and sparse lines', () => {
  for (const value of [undefined, null, false, [], 'quote']) {
    assertError('invalid_input', () => calculateQuoteTotals(value));
  }
  for (const lines of [undefined, null, {}, [], [null], [false], [[]], Array(1)]) {
    assertError('invalid_lines', () => calculateQuoteTotals(input({ lines })));
  }
  assertError('invalid_integer', () => calculateQuoteTotals(input({ lines: [{}] })));
});
