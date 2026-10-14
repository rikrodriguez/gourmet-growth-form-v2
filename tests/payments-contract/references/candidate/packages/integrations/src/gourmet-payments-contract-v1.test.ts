import assert from "node:assert/strict";
import test from "node:test";
import * as integration from "./gourmet-payments.js";
import { InMemoryPaymentOrchestrationStore, PaymentEventService } from "../../payments/src/index.js";
import type { PaymentProviderEvent } from "@gourmet-sales/contracts";

// Synthetic fixtures copied from the schema produced by the inspected PHP
// SalesOsEventOutbox.php. These tests do not execute PHP or a provider.
const UUID = "4ce21b13-dbc2-4dcb-bae6-842100f344b1";
const payload = {
  payment_agreement_id: "agreement-synthetic",
  lead_id: "lead-synthetic",
  monday_item_id: "123456789",
  quote_id: "quote-synthetic",
  quote_version: "v1",
  event_type: "reservation.paid",
  occurred_at: "2026-10-01T12:00:00Z",
  amount_cents: 4900,
  currency: "USD",
  provider_transaction_id: "synthetic-transaction-1",
};
function row(patch: Record<string, unknown> = {}, id = UUID) {
  const body = { ...payload, ...patch };
  return { public_uuid: id, event_type: body.event_type, payload_json: JSON.stringify(body) };
}
function adapt(input: unknown) {
  const fn = (integration as unknown as Record<string, unknown>).adaptGourmetPaymentsOutboxV1;
  assert.equal(typeof fn, "function", "the explicit PHP-outbox v1 adapter must exist");
  return (fn as (value: unknown) => { status: string; event?: PaymentProviderEvent; code?: string })(input);
}
function prepare(input: unknown) {
  const fn = (integration as unknown as Record<string, unknown>).prepareGourmetPaymentsAgreementV1;
  assert.equal(typeof fn, "function", "the explicit request-contract v1 adapter must exist");
  return (fn as (value: unknown) => { status: string; request?: Record<string, unknown>; code?: string; fields?: string[] })(input);
}
function request(patch: Record<string, unknown> = {}) {
  return {
    lead_id: "lead-synthetic", monday_item_id: "123456789", quote_id: "quote-synthetic", quote_version: "v1",
    recipient: { name: "Synthetic Customer", email: "synthetic@example.test", phone: null },
    event: { service_name: "Synthetic Catering", event_at: "2026-12-15T18:00:00.000Z", location: "Synthetic venue" },
    total_cents: 125000, balance_due_date: "2026-12-01T18:00:00.000Z", timezone: "America/New_York", link_expiration: "7d",
    confirmed_intent: true, has_active_payment_agreement: false, ...patch,
  };
}

test("current consumer rejects a raw PHP flat payload: the baseline mismatch remains explicit", async () => {
  await assert.rejects(new PaymentEventService(new InMemoryPaymentOrchestrationStore()).ingest(payload as unknown as PaymentProviderEvent));
});
test("PHP v1 reservation fixture adapts to the unchanged real domain consumer and deduplicates", async () => {
  const input = row(); const before = structuredClone(input);
  const result = adapt(input); assert.equal(result.status, "ready"); assert.ok(result.event);
  assert.deepEqual(input, before); assert.equal(result.event.event_id, UUID);
  assert.equal(result.event.data.balance_due_date, null); assert.equal(result.event.data.public_payment_url, null);
  const store = new InMemoryPaymentOrchestrationStore(); const service = new PaymentEventService(store);
  assert.deepEqual(await service.ingest(result.event), { duplicate: false });
  assert.deepEqual(await service.ingest(result.event), { duplicate: true });
  assert.equal(store.projection("agreement-synthetic")?.state, "RESERVATION_PAID");
  assert.equal(store.outbox().length, 3);
});
test("distinct durable PHP outbox IDs remain distinct even for identical payloads", () => {
  const a = adapt(row()), b = adapt(row({}, "0ca729d7-f5a5-402b-95a0-29685841102a"));
  assert.notEqual(a.event?.event_id, b.event?.event_id);
});
test("financial sequence and late failure use the unchanged consumer transition rules", async () => {
  const store = new InMemoryPaymentOrchestrationStore(); const service = new PaymentEventService(store);
  for (const [type,id] of [["balance.scheduled","0ca729d7-f5a5-402b-95a0-29685841102a"],["balance.paid","afe29553-e9bf-42e7-932f-afccf9f434a4"],["payment.failed","6dd9f16f-14bd-46d7-aa85-7e5ff571bec9"]]) {
    const result = adapt(row({ event_type:type, amount_cents:120100 },id)); assert.equal(result.status,"ready"); assert.ok(result.event); await service.ingest(result.event);
  }
  assert.equal(store.projection("agreement-synthetic")?.state,"FULLY_PAID");
});
test("URL-free link-created remains blocked rather than manufacturing a link or messaging intent", () => {
  const result = adapt(row({event_type:"payment_link.created",amount_cents:undefined,currency:undefined,provider_transaction_id:undefined}));
  assert.equal(result.status,"blocked"); assert.equal(result.code,"PAYMENT_LINK_URL_UNAVAILABLE"); assert.equal(result.event,undefined);
});
test("source rows cannot inject a URL into the URL-free PHP contract", () => {
  assert.equal(adapt(row({public_payment_url:"https://example.test/pay/forged"})).status,"blocked");
});
for (const [name,patch] of [
  ["missing lead",{lead_id:null}], ["missing quote",{quote_id:null}], ["missing version",{quote_version:null}],
  ["NUL in canonical lead",{lead_id:"\u0000lead-synthetic\u0000"}],
  ["control in transaction",{provider_transaction_id:"transaction\nother"}],
  ["missing payment amount",{amount_cents:undefined}], ["fractional cents",{amount_cents:0.5}],
  ["wrong currency",{currency:"PEN"}], ["missing paid transaction",{provider_transaction_id:undefined}],
  ["invalid date",{occurred_at:"2026-02-30T12:00:00Z"}], ["ambiguous local date",{occurred_at:"2026-10-01T12:00:00"}],
  ["recipient leakage",{recipient:{name:"Unexpected"}}], ["unknown type",{event_type:"refund.invented"}],
] as const) test(`PHP v1 adapter blocks ${name}`,()=>assert.equal(adapt(row(patch)).status,"blocked"));
test("malformed JSON, absent durable ID and mismatched type cannot be acknowledged",()=>{
  for(const r of [{...row(),payload_json:"{"},{...row(),public_uuid:""},{...row(),event_type:"balance.paid"},null,[]]) assert.equal(adapt(r).status,"blocked");
});
test("nonfinancial missing optional values normalize to null, never zero or USD",()=>{
  const r=adapt(row({event_type:"payment_link.expired",amount_cents:undefined,currency:undefined,provider_transaction_id:undefined}));
  assert.equal(r.status,"ready");assert.equal(r.event?.data.amount_cents,null);assert.equal(r.event?.data.currency,null);
});
test("request v1 converts explicit ISO instants to PHP wall time without changing the source",()=>{
  const input=request();const before=structuredClone(input);const result=prepare(input);
  assert.equal(result.status,"ready");assert.deepEqual(input,before);
  assert.equal(result.request?.balance_due_date,"2026-12-01T13:00");
  assert.equal((result.request?.event as Record<string,unknown>).event_at,"2026-12-15T13:00");
  assert.equal(result.request?.confirmed_intent,undefined);assert.equal(result.request?.has_active_payment_agreement,undefined);
});
test("already local PHP request and supported expiration retain their values",()=>{
  for(const expiry of ["24h","48h","72h","7d","never","2026-12-01T13:00"]) {
    const r=prepare(request({balance_due_date:"2026-12-01T13:00",link_expiration:expiry})); assert.equal(r.status,"ready"); assert.equal(r.request?.link_expiration,expiry);
  }
});
test("historical four-digit wall years never throw (receiver still enforces future dates)",()=>{
  for(const date of ["0001-01-01T00:00","1000-01-01T00:00"]) {
    assert.doesNotThrow(()=>prepare(request({timezone:"UTC",balance_due_date:date})));
  }
});
test("timezone conversion outside the four-digit PHP transport year stays blocked",()=>{
  const result=prepare(request({timezone:"Pacific/Kiritimati",balance_due_date:"9999-12-31T23:00:00Z"}));
  assert.equal(result.status,"blocked");
});
for(const [name,patch] of [
  ["legacy mock event without service name",{event:{event_type:"Wedding",guest_count:80}}],
  ["null expiration",{link_expiration:null}], ["fake Monday reference",{monday_item_id:"monday-1"}],
  ["NUL must not be silently trimmed by PHP",{lead_id:"\u0000lead-synthetic\u0000"}],
  ["control characters in service name",{event:{service_name:"Synthetic\nCatering"}}],
  ["unknown timezone",{timezone:"Mars/Olympus"}], ["lost second precision",{balance_due_date:"2026-12-01T18:00:01Z"}],
  ["CST abbreviation differs across PHP and Intl",{timezone:"CST",balance_due_date:"2027-07-01T18:00:00Z"}],
  ["PST abbreviation differs across PHP and Intl",{timezone:"PST",balance_due_date:"2027-07-01T18:00:00Z"}],
  ["EST abbreviation differs across PHP and Intl",{timezone:"EST",balance_due_date:"2027-07-01T18:00:00Z"}],
  ["numeric offset is not the agreed IANA timezone",{timezone:"+05:00"}],
  ["ambiguous DST wall time",{balance_due_date:"2026-11-01T01:30"}],
  ["nonexistent DST wall time",{balance_due_date:"2027-03-14T02:30"}],
  ["invalid local date",{balance_due_date:"2026-02-30T12:00"}], ["under-reservation total",{total_cents:4900}],
  ["invalid recipient email",{recipient:{name:"Synthetic",email:"invalid",phone:null}}],
] as const) test(`request v1 blocks ${name} before transport`,()=>assert.equal(prepare(request(patch)).status,"blocked"));
