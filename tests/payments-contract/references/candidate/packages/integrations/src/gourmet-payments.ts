import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentAgreementClient,
  PaymentAgreementResponse,
} from "@gourmet-sales/contracts";
import type { FetchLike } from "./index.js";

export {
  adaptGourmetPaymentsOutboxV1,
  prepareGourmetPaymentsAgreementV1,
} from "./gourmet-payments-contract-v1.js";

export type GourmetPaymentsConfiguration = {
  enabled: boolean;
  baseUrl: string | undefined;
  serviceToken: string | undefined;
};

/**
 * Server-to-server client for the disabled Gourmet Payments contract. Its
 * caller owns the durable idempotency key; this adapter never generates one.
 */
export class GourmetPaymentsAdapter implements PaymentAgreementClient {
  constructor(
    private readonly config: GourmetPaymentsConfiguration,
    private readonly request: FetchLike = fetch,
  ) {}

  async createPaymentAgreement(
    input: Parameters<PaymentAgreementClient["createPaymentAgreement"]>[0],
    idempotencyKey: string,
  ): Promise<{
    response: PaymentAgreementResponse;
    upstreamStatus: 200 | 201;
  }> {
    if (!this.config.enabled)
      throw new Error("Gourmet Payments automation is disabled");
    if (!this.config.baseUrl || !this.config.serviceToken)
      throw new Error("Gourmet Payments service credentials are incomplete");
    const response = await this.request(
      `${this.config.baseUrl.replace(/\/$/, "")}/internal/v1/payment-agreements`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    const payload = (await response.json().catch(() => null)) as unknown;
    if (response.status === 409) throw new PaymentAgreementUpstreamConflict();
    if (response.status !== 200 && response.status !== 201)
      throw new Error(`Gourmet Payments request failed (${response.status})`);
    if (!isPaymentAgreementResponse(payload))
      throw new Error(
        "Gourmet Payments returned an invalid agreement response",
      );
    return { response: payload, upstreamStatus: response.status };
  }
}

export class PaymentAgreementUpstreamConflict extends Error {
  constructor() {
    super("Gourmet Payments rejected a reused idempotency key");
  }
}

export type GourmetPaymentsWebhookHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type GourmetPaymentsWebhookVerificationOptions = {
  secret: string | undefined;
  now?: number;
  replayWindowMs?: number;
};

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;

/** Verifies `v1=HMAC-SHA-256(timestamp + "." + exact-body)` before parsing. */
export function verifyGourmetPaymentsWebhookSignature(
  rawBody: string,
  headers: GourmetPaymentsWebhookHeaders,
  options: GourmetPaymentsWebhookVerificationOptions,
): boolean {
  if (!options.secret || !rawBody) return false;
  const timestamp = header(headers, "x-gourmet-timestamp");
  const supplied = header(headers, "x-gourmet-signature");
  if (!timestamp || !supplied || !/^v1=[a-f0-9]{64}$/i.test(supplied))
    return false;
  const timestampMs = new Date(timestamp).getTime();
  const now = options.now ?? Date.now();
  const windowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  if (
    !Number.isFinite(timestampMs) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 0 ||
    windowMs > DEFAULT_REPLAY_WINDOW_MS ||
    Math.abs(now - timestampMs) > windowMs
  )
    return false;
  const expected = `v1=${createHmac("sha256", options.secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function header(
  headers: GourmetPaymentsWebhookHeaders,
  expected: string,
): string | null {
  const matches = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === expected,
  );
  if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") return null;
  const value = matches[0][1];
  return value.trim() ? value : null;
}

function isPaymentAgreementResponse(
  value: unknown,
): value is PaymentAgreementResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.payment_agreement_id === "string" &&
    typeof item.public_payment_url === "string" &&
    (typeof item.expires_at === "string" || item.expires_at === null) &&
    typeof item.status === "string"
  );
}
