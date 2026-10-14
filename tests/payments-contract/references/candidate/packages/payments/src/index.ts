import { createHash, randomUUID } from "node:crypto";
import type {
  PaymentAgreementClient,
  PaymentAgreementRequest,
  PaymentAgreementResponse,
  PaymentProviderEvent,
  PaymentProviderEventType,
} from "@gourmet-sales/contracts";
import { paymentProviderEventTypes } from "@gourmet-sales/contracts";

export type PaymentAutomationPolicy = { enabled: boolean };

/** Payments remain disabled unless a separate production go-live gate changes this. */
export function paymentAutomationPolicyFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): PaymentAutomationPolicy {
  return { enabled: env.PAYMENT_AUTOMATION_ENABLED === "true" };
}

export const DEFAULT_PAYMENT_AUTOMATION_POLICY: PaymentAutomationPolicy = {
  enabled: false,
};

export type PaymentLinkOperation = {
  idempotencyKey: string;
  requestDigest: string;
  request: PaymentAgreementRequest;
  response: PaymentAgreementResponse | null;
  status: "REQUESTED" | "COMPLETED";
  createdAt: string;
};

export type SalesPaymentState =
  | "LINK_CREATED"
  | "RESERVATION_PAID"
  | "BALANCE_SCHEDULED"
  | "FULLY_PAID"
  | "ATTENTION_REQUIRED"
  | "LINK_EXPIRED"
  | "LINK_REVOKED";

export type PaymentAgreementProjection = {
  paymentAgreementId: string;
  leadId: string;
  mondayItemId: string | null;
  quoteId: string;
  quoteVersion: string;
  state: SalesPaymentState;
  reservationAmountCents: number | null;
  balanceAmountCents: number | null;
  balanceDueDate: string | null;
  providerTransactionId: string | null;
  closedAt: string | null;
  updatedAt: string;
};

export type SalesPaymentOutboxIntent = {
  id: string;
  eventId: string;
  leadId: string;
  topic:
    | "monday.project"
    | "messaging.prepare"
    | "next_action.prepare"
    | "revenue_conversion.prepare";
  dedupeKey: string;
  payload: Readonly<Record<string, string | number | null>>;
  createdAt: string;
};

/**
 * This port is implemented by a durable database repository in deployment.
 * The in-memory implementation is deliberately only for tests/local shadow runs.
 */
export interface PaymentOrchestrationStore {
  getOperation(idempotencyKey: string): Promise<PaymentLinkOperation | null>;
  saveOperation(operation: PaymentLinkOperation): Promise<void>;
  completeOperation(
    idempotencyKey: string,
    response: PaymentAgreementResponse,
  ): Promise<void>;
  applyProviderEvent(
    event: PaymentProviderEvent,
    projection: PaymentAgreementProjection,
    intents: readonly SalesPaymentOutboxIntent[],
  ): Promise<{ duplicate: boolean }>;
}

export class PaymentIdempotencyConflict extends Error {
  constructor() {
    super("Idempotency key was reused with a different payment-link request");
  }
}

export function stablePaymentIdempotencyKey(
  input: PaymentAgreementRequest,
): string {
  const base = [
    "payment-link",
    input.lead_id,
    input.quote_id,
    input.quote_version,
  ].join(":");
  return `gpay:${createHash("sha256").update(base).digest("base64url")}`;
}

export function paymentRequestDigest(input: PaymentAgreementRequest): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function paymentLinkEligibility(input: PaymentAgreementRequest): {
  eligible: boolean;
  reasons: readonly string[];
} {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(input.total_cents) || input.total_cents <= 4_900)
    reasons.push("TOTAL_MUST_EXCEED_RESERVATION");
  if (!input.confirmed_intent) reasons.push("CONFIRMED_INTENT_REQUIRED");
  if (!validIso(input.balance_due_date))
    reasons.push("BALANCE_DUE_DATE_REQUIRED");
  if (!input.timezone.trim()) reasons.push("TIMEZONE_REQUIRED");
  if (input.has_active_payment_agreement)
    reasons.push("ACTIVE_PAYMENT_AGREEMENT_EXISTS");
  return { eligible: reasons.length === 0, reasons };
}

export type PaymentLinkRequestResult =
  | {
      status: "NOT_ELIGIBLE";
      idempotencyKey: string;
      reasons: readonly string[];
    }
  | {
      status: "SHADOW";
      idempotencyKey: string;
      wouldCallPayments: true;
    }
  | {
      status: "CREATED" | "REPLAYED";
      idempotencyKey: string;
      response: PaymentAgreementResponse;
    };

/**
 * The sole Sales OS entry point for standard payment-link creation. A future
 * Sales OS workflow invokes this service; no LLM or admin UI calls a provider.
 */
export class PaymentLinkRequestService {
  constructor(
    private readonly store: PaymentOrchestrationStore,
    private readonly client: PaymentAgreementClient,
    private readonly policy: PaymentAutomationPolicy = DEFAULT_PAYMENT_AUTOMATION_POLICY,
  ) {}

  async requestPaymentLink(
    input: PaymentAgreementRequest,
  ): Promise<PaymentLinkRequestResult> {
    const idempotencyKey = stablePaymentIdempotencyKey(input);
    const requestDigest = paymentRequestDigest(input);
    const existing = await this.store.getOperation(idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new PaymentIdempotencyConflict();
      if (existing.response)
        return {
          status: "REPLAYED",
          idempotencyKey,
          response: existing.response,
        };
      if (!this.policy.enabled)
        return { status: "SHADOW", idempotencyKey, wouldCallPayments: true };
    }

    const eligibility = paymentLinkEligibility(input);
    if (!eligibility.eligible)
      return {
        status: "NOT_ELIGIBLE",
        idempotencyKey,
        reasons: eligibility.reasons,
      };

    if (!existing)
      await this.store.saveOperation({
        idempotencyKey,
        requestDigest,
        request: structuredClone(input),
        response: null,
        status: "REQUESTED",
        createdAt: new Date().toISOString(),
      });

    // The no-call path is intentional and is the production default.
    if (!this.policy.enabled)
      return { status: "SHADOW", idempotencyKey, wouldCallPayments: true };

    const { response } = await this.client.createPaymentAgreement(
      toProviderRequest(input),
      idempotencyKey,
    );
    await this.store.completeOperation(idempotencyKey, response);
    return { status: "CREATED", idempotencyKey, response };
  }
}

export class PaymentEventService {
  constructor(private readonly store: PaymentOrchestrationStore) {}

  async ingest(event: PaymentProviderEvent): Promise<{ duplicate: boolean }> {
    assertPaymentProviderEvent(event);
    const projection = projectionFor(event);
    return this.store.applyProviderEvent(event, projection, intentsFor(event));
  }
}

/** In-memory only: enables deterministic unit tests without a provider or DB. */
export class InMemoryPaymentOrchestrationStore
  implements PaymentOrchestrationStore
{
  private readonly operations = new Map<string, PaymentLinkOperation>();
  private readonly eventIds = new Set<string>();
  private readonly projections = new Map<string, PaymentAgreementProjection>();
  private readonly intents = new Map<string, SalesPaymentOutboxIntent>();

  async getOperation(
    idempotencyKey: string,
  ): Promise<PaymentLinkOperation | null> {
    return clone(this.operations.get(idempotencyKey) ?? null);
  }
  async saveOperation(operation: PaymentLinkOperation): Promise<void> {
    if (!this.operations.has(operation.idempotencyKey))
      this.operations.set(operation.idempotencyKey, clone(operation));
  }
  async completeOperation(
    idempotencyKey: string,
    response: PaymentAgreementResponse,
  ): Promise<void> {
    const operation = this.operations.get(idempotencyKey);
    if (!operation) throw new Error("Payment link operation was not found");
    operation.response = structuredClone(response);
    operation.status = "COMPLETED";
  }
  async applyProviderEvent(
    event: PaymentProviderEvent,
    projection: PaymentAgreementProjection,
    intents: readonly SalesPaymentOutboxIntent[],
  ): Promise<{ duplicate: boolean }> {
    if (this.eventIds.has(event.event_id)) return { duplicate: true };
    this.eventIds.add(event.event_id);
    const current = this.projections.get(projection.paymentAgreementId);
    if (current && !shouldAdvancePaymentProjection(current, projection))
      return { duplicate: false };
    this.projections.set(projection.paymentAgreementId, clone(projection));
    for (const intent of intents)
      if (!this.intents.has(intent.dedupeKey))
        this.intents.set(intent.dedupeKey, clone(intent));
    return { duplicate: false };
  }
  projection(paymentAgreementId: string): PaymentAgreementProjection | null {
    return clone(this.projections.get(paymentAgreementId) ?? null);
  }
  outbox(): readonly SalesPaymentOutboxIntent[] {
    return [...this.intents.values()].map(clone);
  }
}

function toProviderRequest(input: PaymentAgreementRequest) {
  const {
    confirmed_intent: _confirmedIntent,
    has_active_payment_agreement: _hasActiveAgreement,
    ...request
  } = input;
  return request;
}

function projectionFor(
  event: PaymentProviderEvent,
): PaymentAgreementProjection {
  const state = stateFor(event.event_type);
  const amount = event.data.amount_cents;
  return {
    paymentAgreementId: event.data.payment_agreement_id,
    leadId: event.data.lead_id,
    mondayItemId: event.data.monday_item_id,
    quoteId: event.data.quote_id,
    quoteVersion: event.data.quote_version,
    state,
    reservationAmountCents:
      event.event_type === "reservation.paid" ? amount : null,
    balanceAmountCents:
      event.event_type === "balance.scheduled" ||
      event.event_type === "balance.paid"
        ? amount
        : null,
    balanceDueDate: event.data.balance_due_date,
    providerTransactionId: event.data.provider_transaction_id,
    closedAt: event.event_type === "balance.paid" ? event.occurred_at : null,
    updatedAt: event.occurred_at,
  };
}

function intentsFor(
  event: PaymentProviderEvent,
): readonly SalesPaymentOutboxIntent[] {
  const data = event.data;
  const common = {
    payment_agreement_id: data.payment_agreement_id,
    lead_id: data.lead_id,
    monday_item_id: data.monday_item_id,
    quote_id: data.quote_id,
    quote_version: data.quote_version,
    amount_cents: data.amount_cents,
    currency: data.currency,
    provider_transaction_id: data.provider_transaction_id,
    public_payment_url: data.public_payment_url,
    occurred_at: event.occurred_at,
    ...operationalValues(event),
  };
  const topics =
    event.event_type === "reservation.paid"
      ? ([
          "monday.project",
          "messaging.prepare",
          "next_action.prepare",
        ] as const)
      : event.event_type === "balance.scheduled"
        ? (["monday.project", "next_action.prepare"] as const)
        : event.event_type === "balance.paid"
          ? ([
              "monday.project",
              "messaging.prepare",
              "revenue_conversion.prepare",
            ] as const)
          : event.event_type === "payment.failed"
            ? ([
                "monday.project",
                "messaging.prepare",
                "next_action.prepare",
              ] as const)
            : event.event_type === "payment_link.created"
              ? (["messaging.prepare"] as const)
              : (["monday.project"] as const);
  return topics.map((topic) => ({
    id: randomUUID(),
    eventId: event.event_id,
    leadId: data.lead_id,
    topic,
    dedupeKey: `payment-event:${event.event_id}:${topic}`,
    payload: common,
    createdAt: event.occurred_at,
  }));
}

/**
 * These are projection intents, not Monday column writes. The future mapped
 * Monday adapter owns translating them into the approved board columns.
 */
function operationalValues(
  event: PaymentProviderEvent,
): Readonly<Record<string, string | number | null>> {
  switch (event.event_type) {
    case "reservation.paid":
      return {
        payment_status: "Reservation Paid",
        deposit_received_cents: event.data.amount_cents,
      };
    case "balance.scheduled":
      return {
        payment_status: "Balance Scheduled",
        balance_due_date: event.data.balance_due_date,
      };
    case "balance.paid":
      return {
        payment_status: "Fully Paid",
        final_amount_cents: event.data.amount_cents,
        closed_at: event.occurred_at,
      };
    case "payment.failed":
      return { payment_status: "Attention Required" };
    case "payment_link.expired":
      return { payment_status: "Payment Link Expired" };
    case "payment_link.revoked":
      return { payment_status: "Payment Link Revoked" };
    case "payment_link.created":
      return { payment_status: "Payment Link Created" };
  }
}

function stateFor(type: PaymentProviderEventType): SalesPaymentState {
  switch (type) {
    case "payment_link.created":
      return "LINK_CREATED";
    case "reservation.paid":
      return "RESERVATION_PAID";
    case "balance.scheduled":
      return "BALANCE_SCHEDULED";
    case "balance.paid":
      return "FULLY_PAID";
    case "payment.failed":
      return "ATTENTION_REQUIRED";
    case "payment_link.expired":
      return "LINK_EXPIRED";
    case "payment_link.revoked":
      return "LINK_REVOKED";
  }
}

function assertPaymentProviderEvent(event: PaymentProviderEvent): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      event.occurred_at,
    )
  )
    throw new Error(
      "Payment event occurrence requires an ISO timestamp with explicit timezone",
    );
  const fractional = event.occurred_at.match(
    /\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i,
  )?.[1];
  if (fractional && fractional.length > 6)
    throw new Error(
      "Payment event timestamp supports at most microsecond precision",
    );
  if (!event.event_id.trim() || !validIso(event.occurred_at))
    throw new Error(
      "Payment event requires a stable id and ISO occurrence time",
    );
  if (!paymentProviderEventTypes.includes(event.event_type))
    throw new Error("Payment event type is unsupported");
  const data = event.data;
  if (
    !data.payment_agreement_id.trim() ||
    !data.lead_id.trim() ||
    !data.quote_id.trim() ||
    !data.quote_version.trim()
  )
    throw new Error("Payment event has incomplete agreement references");
  if (
    data.amount_cents !== null &&
    (!Number.isSafeInteger(data.amount_cents) || data.amount_cents < 0)
  )
    throw new Error("Payment event amount must be integer cents");
  if (data.currency !== null && data.currency !== "USD")
    throw new Error("Payment event currency must be USD");
  if (
    data.public_payment_url !== null &&
    !/^https:\/\//.test(data.public_payment_url)
  )
    throw new Error("Payment link URL must be HTTPS");
  if (event.event_type === "payment_link.created" && !data.public_payment_url)
    throw new Error("Payment link created event requires a public URL");
}

function validIso(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Receipt deduplication happens before this projection policy. Older events are
 * retained for audit but cannot emit obsolete downstream intents. A paid balance
 * is not undone by any event in the current contract (link revocation is not a
 * refund). Refund/reversal reconciliation needs its own explicit event model.
 * Equal timestamps permit only forward positive lifecycle progress; conflicting
 * same-time attention/link states require reconciliation rather than last-write.
 * Keep the PostgreSQL conditional upsert equivalent to this policy.
 */
export function shouldAdvancePaymentProjection(
  current: PaymentAgreementProjection,
  incoming: PaymentAgreementProjection,
): boolean {
  if (current.state === "FULLY_PAID" && incoming.state !== "FULLY_PAID")
    return false;
  // Confirmed paid evidence outranks later link/attention events as well as
  // earlier ones. Arrival order must not change the financial conclusion.
  if (incoming.state === "FULLY_PAID" && current.state !== "FULLY_PAID")
    return true;
  const currentAt = paymentTimestampMicros(current.updatedAt);
  const incomingAt = paymentTimestampMicros(incoming.updatedAt);
  if (incomingAt < currentAt) return false;
  if (incomingAt === currentAt)
    return (
      paymentProgressRank(incoming.state) > paymentProgressRank(current.state)
    );
  return true;
}

function paymentProgressRank(state: SalesPaymentState): number {
  switch (state) {
    case "LINK_CREATED":
      return 0;
    case "RESERVATION_PAID":
      return 1;
    case "BALANCE_SCHEDULED":
      return 2;
    case "FULLY_PAID":
      return 3;
    default:
      return -1;
  }
}

/** Compare source precision retained by PostgreSQL rather than Date's milliseconds. */
function paymentTimestampMicros(value: string): bigint {
  const fractional = value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i)?.[1] ?? "";
  const subMillis = Number((fractional.slice(3, 6) + "000").slice(0, 3));
  return BigInt(Date.parse(value)) * 1000n + BigInt(subMillis);
}
