import { paymentProviderEventTypes } from "@gourmet-sales/contracts";
import type {
  PaymentAgreementClient,
  PaymentProviderEvent,
} from "@gourmet-sales/contracts";

type Blocked = { status: "blocked"; code: string; fields: readonly string[] };
type AgreementTransport = Parameters<
  PaymentAgreementClient["createPaymentAgreement"]
>[0];
type ReadyEvent = { status: "ready"; event: PaymentProviderEvent };
type ReadyAgreement = { status: "ready"; request: AgreementTransport };

const OUTBOX_KEYS = new Set([
  "payment_agreement_id",
  "lead_id",
  "monday_item_id",
  "quote_id",
  "quote_version",
  "event_type",
  "occurred_at",
  "amount_cents",
  "currency",
  "provider_transaction_id",
]);

/**
 * Explicit adapter for rows created by the inspected PHP SQLite outbox v1.
 * Pure and opt-in: no dispatcher, acknowledgement, signature bypass or HTTP.
 * The caller must verify/authenticate the original transport before ingestion.
 * Existing Sales OS envelopes are unchanged; do not guess this format at runtime.
 */
export function adaptGourmetPaymentsOutboxV1(
  input: unknown,
): ReadyEvent | Blocked {
  const row = object(input);
  if (!row || !uuid(row.public_uuid) || typeof row.payload_json !== "string" || Buffer.byteLength(row.payload_json, "utf8") > 131_072)
    return blocked("INVALID_OUTBOX_ROW", ["public_uuid", "payload_json"]);
  let payload: Record<string, unknown> | null;
  try {
    payload = object(JSON.parse(row.payload_json));
  } catch {
    return blocked("INVALID_OUTBOX_JSON", ["payload_json"]);
  }
  if (!payload) return blocked("INVALID_OUTBOX_JSON", ["payload_json"]);
  const extra = Object.keys(payload).filter((key) => !OUTBOX_KEYS.has(key));
  if (extra.length) return blocked("UNSUPPORTED_OUTBOX_FIELDS", extra);
  const eventType = payload.event_type;
  if (typeof eventType !== "string" || !paymentProviderEventTypes.includes(eventType as PaymentProviderEvent["event_type"]) || row.event_type !== eventType)
    return blocked("INVALID_EVENT_TYPE", ["event_type"]);
  const occurredAt = payload.occurred_at;
  if (!utcSecond(occurredAt)) return blocked("INVALID_OCCURRENCE", ["occurred_at"]);
  const refs = ["payment_agreement_id", "lead_id", "quote_id", "quote_version"];
  const missing = refs.filter((key) => !identifier(payload[key]));
  if (missing.length) return blocked("MISSING_CANONICAL_REFERENCES", missing);
  const monday = payload.monday_item_id ?? null;
  if (monday !== null && (typeof monday !== "string" || !/^\d{1,20}$/.test(monday)))
    return blocked("INVALID_MONDAY_REFERENCE", ["monday_item_id"]);
  // PHP deliberately excludes URLs/tokens from this outbox. Preserve that rule.
  // Existing link-created ingestion requires a URL to prepare a message, so stop.
  if (eventType === "payment_link.created")
    return blocked("PAYMENT_LINK_URL_UNAVAILABLE", ["public_payment_url"]);
  const amount = payload.amount_cents ?? null;
  const currency = payload.currency ?? null;
  if ((amount !== null && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)) ||
      (amount === null ? currency !== null : currency !== "USD"))
    return blocked("INVALID_FINANCIAL_AMOUNT", ["amount_cents", "currency"]);
  const transaction = payload.provider_transaction_id ?? null;
  if (transaction !== null && !identifier(transaction))
    return blocked("INVALID_TRANSACTION_REFERENCE", ["provider_transaction_id"]);
  if (["reservation.paid", "balance.paid", "balance.scheduled"].includes(eventType) && (amount === null || (amount as number) <= 0))
    return blocked("MISSING_FINANCIAL_EVIDENCE", ["amount_cents"]);
  if (["reservation.paid", "balance.paid"].includes(eventType) && transaction === null)
    return blocked("MISSING_FINANCIAL_EVIDENCE", ["provider_transaction_id"]);
  return {
    status: "ready",
    event: {
      event_id: row.public_uuid as string,
      event_type: eventType as PaymentProviderEvent["event_type"],
      occurred_at: occurredAt,
      data: {
        payment_agreement_id: payload.payment_agreement_id as string,
        lead_id: payload.lead_id as string,
        monday_item_id: monday as string | null,
        quote_id: payload.quote_id as string,
        quote_version: payload.quote_version as string,
        amount_cents: amount as number | null,
        currency: currency as "USD" | null,
        provider_transaction_id: transaction as string | null,
        balance_due_date: null,
        public_payment_url: null,
      },
    },
  };
}

/**
 * Pure, explicit preparation for the actual PHP payment-agreements v1 contract.
 * Missing commercial facts are blocked. ISO instants are converted to the named
 * timezone only when no precision or DST ambiguity is lost. This is structural
 * compatibility, not authorization, eligibility, a paid event or a future-date
 * guarantee; the existing service/receiver retain those checks.
 * No existing request, idempotency record or default network adapter is changed.
 */
export function prepareGourmetPaymentsAgreementV1(
  input: unknown,
): ReadyAgreement | Blocked {
  const value = object(input);
  if (!value) return blocked("INVALID_REQUEST", ["request"]);
  const recipient = object(value.recipient);
  const event = object(value.event);
  const fields: string[] = [];
  for (const key of ["lead_id", "quote_id", "quote_version"]) {
    if (!identifier(value[key])) fields.push(key);
  }
  const monday = value.monday_item_id ?? null;
  if (monday !== null && (typeof monday !== "string" || !/^\d{1,20}$/.test(monday))) fields.push("monday_item_id");
  if (!recipient || !text(recipient.name,200) || !text(recipient.email,320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient.email))) fields.push("recipient");
  if (recipient?.phone != null && !text(recipient.phone,32)) fields.push("recipient.phone");
  if (!event || !text(event.service_name,180)) fields.push("event.service_name");
  if (event?.location != null && !text(event.location,255)) fields.push("event.location");
  if (typeof value.total_cents !== "number" || !Number.isSafeInteger(value.total_cents) || value.total_cents <= 4900) fields.push("total_cents");
  const timezone = value.timezone;
  let formatter: Intl.DateTimeFormat | null = null;
  // PHP and Intl interpret abbreviations such as CST/PST differently around
  // DST. Require the agreed IANA area/location form, or explicit UTC.
  if (typeof timezone === "string" && timezone.trim() === timezone && timezone.length <= 64 && (timezone === "UTC" || timezone.includes("/"))) {
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        era: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      // Invalid timezone is reported below.
    }
  }
  if (!formatter) fields.push("timezone");
  const due = formatter ? localMinute(value.balance_due_date,formatter) : null;
  if (!due) fields.push("balance_due_date");
  const eventAt = event?.event_at == null ? null : formatter ? localMinute(event.event_at,formatter) : null;
  if (event?.event_at != null && !eventAt) fields.push("event.event_at");
  const expiration = value.link_expiration;
  const expires = typeof expiration === "string" && ["24h","48h","72h","7d","never"].includes(expiration)
    ? expiration : formatter ? localMinute(expiration,formatter) : null;
  if (!expires) fields.push("link_expiration");
  if (fields.length || !recipient || !event || !due || !expires || typeof timezone !== "string")
    return blocked("INCOMPATIBLE_PAYMENT_AGREEMENT_V1", fields);
  return {
    status: "ready",
    request: {
      lead_id: value.lead_id as string,
      monday_item_id: monday as string | null,
      quote_id: value.quote_id as string,
      quote_version: value.quote_version as string,
      recipient: {
        name: recipient.name as string,
        email: recipient.email as string,
        phone: (recipient.phone ?? null) as string | null,
      },
      event: {
        service_name: event.service_name as string,
        event_at: eventAt,
        location: (event.location ?? null) as string | null,
      },
      total_cents: value.total_cents as number,
      balance_due_date: due,
      timezone,
      link_expiration: expires,
    },
  };
}

function blocked(code: string, fields: readonly string[]): Blocked {
  return { status: "blocked", code, fields };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) &&
    Array.from(value).length <= max;
}
function identifier(value: unknown): value is string {
  return text(value, 180);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}
function utcSecond(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().replace(".000Z", "Z") === value;
}
function wallTime(date: Date, formatter: Intl.DateTimeFormat): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const p = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  if (p.era !== "AD" || !p.year || !/^\d{1,4}$/.test(p.year) || Number(p.year) < 1)
    return null;
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function validWall(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const date = new Date(`${value}:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
}
function unambiguousWall(value: string, formatter: Intl.DateTimeFormat): boolean {
  const naive = Date.parse(`${value}:00Z`);
  const offsets = new Set<number>();
  const matches = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const instant = naive + h * 3600000;
    const wall = wallTime(new Date(instant), formatter);
    if (wall === null) continue;
    const local = Date.parse(`${wall}:00Z`);
    if (Number.isFinite(local)) offsets.add(local - instant);
  }
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (wallTime(new Date(candidate), formatter) === value) matches.add(candidate);
  }
  return matches.size === 1;
}
function localMinute(value: unknown, formatter: Intl.DateTimeFormat): string | null {
  if (typeof value !== "string") return null;
  if (validWall(value)) return unambiguousWall(value, formatter) ? value : null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !validWall(value.slice(0, 16))) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCSeconds() !== 0 ||
      date.getUTCMilliseconds() !== 0) return null;
  const wall = wallTime(date, formatter);
  return wall !== null && unambiguousWall(wall, formatter) ? wall : null;
}
