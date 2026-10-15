/**
 * Payment orchestration is intentionally limited to operational references.
 * Payment identifiers and financial status are received from Gourmet Payments;
 * this package never owns a payment-provider credential or client.
 */
export const paymentProviderEventTypes = [
  "payment_link.created",
  "reservation.paid",
  "balance.scheduled",
  "balance.paid",
  "payment.failed",
  "payment_link.expired",
  "payment_link.revoked",
] as const;

export type PaymentProviderEventType =
  (typeof paymentProviderEventTypes)[number];

export type PaymentRecipientSnapshot = {
  name: string;
  email: string;
  phone: string | null;
};

export type PaymentEventSnapshot = Readonly<
  Record<string, string | number | null>
>;

/** Matches the disabled Gourmet Payments M2M request contract exactly. */
export type PaymentAgreementRequest = {
  lead_id: string;
  monday_item_id: string | null;
  quote_id: string;
  quote_version: string;
  recipient: PaymentRecipientSnapshot;
  event: PaymentEventSnapshot;
  total_cents: number;
  balance_due_date: string;
  timezone: string;
  link_expiration: string | null;
  /** Sales OS evidence; not forwarded to Gourmet Payments. */
  confirmed_intent: boolean;
  /** Prevents a second active agreement before any provider call. */
  has_active_payment_agreement: boolean;
};

export type PaymentAgreementResponse = {
  payment_agreement_id: string;
  public_payment_url: string;
  expires_at: string | null;
  status: string;
};

export type PaymentProviderEvent = {
  event_id: string;
  event_type: PaymentProviderEventType;
  occurred_at: string;
  data: {
    payment_agreement_id: string;
    lead_id: string;
    monday_item_id: string | null;
    quote_id: string;
    quote_version: string;
    amount_cents: number | null;
    currency: "USD" | null;
    provider_transaction_id: string | null;
    balance_due_date: string | null;
    /** Present only for payment_link.created; queued messaging can use it later. */
    public_payment_url: string | null;
  };
};

export type PaymentAgreementClient = {
  createPaymentAgreement(
    input: Pick<
      PaymentAgreementRequest,
      | "lead_id"
      | "monday_item_id"
      | "quote_id"
      | "quote_version"
      | "recipient"
      | "event"
      | "total_cents"
      | "balance_due_date"
      | "timezone"
      | "link_expiration"
    >,
    idempotencyKey: string,
  ): Promise<{ response: PaymentAgreementResponse; upstreamStatus: 200 | 201 }>;
};
