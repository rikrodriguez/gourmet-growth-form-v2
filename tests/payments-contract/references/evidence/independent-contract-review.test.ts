import test from "node:test";
import assert from "node:assert/strict";
import { prepareGourmetPaymentsAgreementV1 as prepare } from "../candidate/packages/integrations/src/gourmet-payments-contract-v1.ts";

const base = {
  lead_id: "lead-synthetic", quote_id: "quote-synthetic", quote_version: "v1",
  recipient: { name: "Synthetic Customer", email: "synthetic@example.test" },
  event: { service_name: "Synthetic Service" },
  total_cents: 5000, balance_due_date: "2027-07-01T18:00:00Z",
  timezone: "America/New_York", link_expiration: "7d",
};

for (const timezone of ["CST", "PST", "+01:00"]) {
  test(`IANA contract must reject ambiguous abbreviation or numeric offset ${timezone}`, () => {
    assert.equal(prepare({ ...base, timezone }).status, "blocked");
  });
}
for (const date of ["2026-11-01T01:30", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2027-03-14T02:30"]) {
  test(`New York gap or fold is blocked: ${date}`, () => {
    assert.equal(prepare({ ...base, balance_due_date: date }).status, "blocked");
  });
}
for (const date of ["2027-04-04T01:45", "2027-10-03T02:15"]) {
  test(`Lord Howe half-hour DST gap or fold is blocked: ${date}`, () => {
    assert.equal(prepare({ ...base, timezone: "Australia/Lord_Howe", balance_due_date: date }).status, "blocked");
  });
}
test("calendar day skipped in Apia is blocked", () => {
  assert.equal(prepare({ ...base, timezone: "Pacific/Apia", balance_due_date: "2011-12-30T12:00" }).status, "blocked");
});
for (const [timezone, date, want] of [
  ["America/New_York", "2027-07-01T18:00:00Z", "2027-07-01T14:00"],
  ["Asia/Kathmandu", "2027-07-01T18:00:00Z", "2027-07-01T23:45"],
  ["Pacific/Kiritimati", "2027-07-01T18:00:00Z", "2027-07-02T08:00"],
  ["UTC", "2027-07-01T18:00:00+05:45", "2027-07-01T12:15"],
]) {
  test(`exact date conversion for ${timezone}`, () => {
    const result = prepare({ ...base, timezone, balance_due_date: date });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.request.balance_due_date, want);
  });
}
test("PHP-trimmed NUL must not silently alter canonical references", () => {
  assert.equal(prepare({ ...base, lead_id: "\u0000lead-synthetic\u0000" }).status, "blocked");
});
for (const [timezone, date] of [
  ["UTC", "0001-01-01T00:00"],
  ["UTC", "0000-01-01T00:00"],
  ["UTC", "1000-01-01T00:00"],
  ["Pacific/Kiritimati", "9999-12-31T23:00:00Z"],
]) {
  test(`calendar boundaries return a result instead of throwing: ${timezone} ${date}`, () => {
    const result = prepare({ ...base, timezone, balance_due_date: date });
    if (result.status === "ready") assert.match(result.request.balance_due_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    else assert.equal(result.status, "blocked");
  });
}
