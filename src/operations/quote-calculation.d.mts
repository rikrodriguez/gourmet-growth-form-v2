export type QuoteCalculationErrorCode = 'invalid_input' | 'invalid_lines' | 'invalid_integer' | 'quote_total_limit';

export class QuoteCalculationError extends Error {
  readonly code: QuoteCalculationErrorCode;
  constructor(code: QuoteCalculationErrorCode);
}

export interface QuoteCalculationInput {
  readonly lines: ReadonlyArray<{ readonly qty: number; readonly unitPriceCents: number }>;
  readonly taxBps: number;
  readonly depositBps: number;
}

export interface QuoteTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
}

export function calculateQuoteTotals(input: QuoteCalculationInput): QuoteTotals;
