// Currency-agnostic integer arithmetic shared by quote adapters. Callers own
// catalog, currency, identity, and line-schema validation.
const MAX_CENTS = 1_000_000_000n;
const BASIS_POINTS = 10_000n;

export class QuoteCalculationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'QuoteCalculationError';
    this.code = code;
  }
}

function fail(code) { throw new QuoteCalculationError(code); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_integer');
  return BigInt(value);
}
function halfUp(amount, bps) {
  return (amount * bps + BASIS_POINTS / 2n) / BASIS_POINTS;
}

export function calculateQuoteTotals(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_input');
  const { lines, taxBps, depositBps } = input;
  if (!Array.isArray(lines) || lines.length === 0) fail('invalid_lines');
  let subtotal = 0n;
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail('invalid_lines');
    subtotal += integer(line.qty, 1) * integer(line.unitPriceCents);
  }
  const tax = halfUp(subtotal, integer(taxBps, 0, 10_000));
  const total = subtotal + tax;
  const deposit = halfUp(total, integer(depositBps, 0, 10_000));
  // Check before any Number conversion, including unsafe BigInt products/sums.
  if (total > MAX_CENTS) fail('quote_total_limit');
  return {
    subtotalCents: Number(subtotal),
    taxCents: Number(tax),
    totalCents: Number(total),
    depositCents: Number(deposit),
  };
}
