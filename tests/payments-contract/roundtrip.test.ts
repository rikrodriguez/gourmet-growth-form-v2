import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareGourmetPaymentsAgreementV1 as prepare } from "./references/candidate/packages/integrations/src/gourmet-payments-contract-v1.ts";

// These fixtures describe standalone fixed-reservation agreements. They do not
// map or approve a percentage-deposit quote. Structural preparation cannot
// establish commercial compatibility, consent, authorization or provider state.
const FIXED_RESERVATION_CENTS = 4900;
const parserPath = fileURLToPath(new URL("./parse-original-request.php", import.meta.url));
const phpBinary = process.env.GOURMET_CONTRACT_PHP_BIN || "php";
const disabledFunctions = [
  "curl_exec", "curl_multi_exec", "fsockopen", "pfsockopen",
  "stream_socket_client", "stream_socket_server", "socket_create", "socket_connect",
  "socket_sendto", "dns_get_record", "gethostbyname", "gethostbynamel", "checkdnsrr",
  "mail", "exec", "shell_exec", "system", "passthru", "popen", "proc_open", "pcntl_exec",
].join(",");

type WireRequest = Extract<ReturnType<typeof prepare>, { status: "ready" }>["request"];
type ParsedRequest = {
  status: "parsed";
  php_version: string;
  source_hashes: Record<string, string>;
  request_hash: string;
  request: WireRequest;
  instants: { balance_due_date: string; event_at: string | null; link_expiration: string | null };
};
type ParsedResult = ParsedRequest | { status: "blocked"; exception: string };

function parseOriginalRaw(input: string): ParsedResult {
  const child = spawnSync(phpBinary, [
    "-d", "allow_url_fopen=0", "-d", "allow_url_include=0",
    "-d", `disable_functions=${disabledFunctions}`, parserPath,
  ], {
    input,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1048576,
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    // No app configuration, credentials or production environment is inherited.
    env: { PATH: process.env.PATH || "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `PHP parsing was interrupted: ${child.signal}`);
  assert.equal(child.status, 0, `Original PHP parsing failed: ${child.stderr}`);
  assert.equal(child.stderr, "", "Isolated PHP parsing must not emit warnings");
  return JSON.parse(child.stdout) as ParsedResult;
}

function parseOriginal(input: unknown): ParsedResult {
  return parseOriginalRaw(JSON.stringify(input));
}

function fixedAgreement(patch: Record<string, unknown> = {}) {
  return {
    lead_id: "lead-fixed-synthetic",
    monday_item_id: "123456789",
    quote_id: "quote-fixed-synthetic",
    quote_version: "v7-synthetic",
    recipient: { name: "Synthetic Customer", email: "synthetic@example.test", phone: null },
    event: { service_name: "Synthetic fixed-reservation catering", event_at: "2099-12-15T18:00:00Z", location: "Synthetic venue" },
    total_cents: 125001,
    balance_due_date: "2099-12-01T18:00:00Z",
    timezone: "America/New_York",
    link_expiration: "2099-11-20T18:00:00Z",
    ...patch,
  };
}

const fixedCases = [
  {
    name: "New York winter custom expiration",
    input: fixedAgreement(),
    due: "2099-12-01T13:00", eventAt: "2099-12-15T13:00", expiration: "2099-11-20T13:00",
    instants: { balance_due_date: "2099-12-01T18:00:00Z", event_at: "2099-12-15T18:00:00Z", link_expiration: "2099-11-20T18:00:00Z" },
  },
  {
    name: "Kathmandu fractional timezone custom expiration",
    input: fixedAgreement({
      total_cents: 9876543, timezone: "Asia/Kathmandu", balance_due_date: "2099-07-01T18:00:00Z",
      event: { service_name: "Synthetic fractional-offset service", event_at: "2099-07-15T18:00:00Z", location: "Synthetic venue" },
      link_expiration: "2099-06-20T18:00:00Z",
    }),
    due: "2099-07-01T23:45", eventAt: "2099-07-15T23:45", expiration: "2099-06-20T23:45",
    instants: { balance_due_date: "2099-07-01T18:00:00Z", event_at: "2099-07-15T18:00:00Z", link_expiration: "2099-06-20T18:00:00Z" },
  },
  {
    name: "UTC preserves explicit fractional offset instants",
    input: fixedAgreement({
      total_cents: 4901, timezone: "UTC", monday_item_id: null,
      balance_due_date: "2099-07-01T18:00:00+05:45",
      event: { service_name: "Synthetic minimum-positive-balance service", event_at: "2099-07-15T18:00:00+05:45", location: null },
      link_expiration: "2099-06-20T18:00:00+05:45",
    }),
    due: "2099-07-01T12:15", eventAt: "2099-07-15T12:15", expiration: "2099-06-20T12:15",
    instants: { balance_due_date: "2099-07-01T12:15:00Z", event_at: "2099-07-15T12:15:00Z", link_expiration: "2099-06-20T12:15:00Z" },
  },
];

for (const fixture of fixedCases) {
  test(`original TS -> original PHP -> original TS preserves ${fixture.name}`, () => {
    const source = structuredClone(fixture.input);
    const first = prepare(source);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") throw new Error("Synthetic fixed agreement must be structurally compatible");
    assert.deepEqual(source, fixture.input);
    assert.equal(first.request.balance_due_date, fixture.due);
    assert.equal(first.request.event.event_at, fixture.eventAt);
    assert.equal(first.request.link_expiration, fixture.expiration);

    const parsed = parseOriginal(first.request);
    assert.equal(parsed.status, "parsed");
    if (parsed.status !== "parsed") throw new Error("Original PHP parser rejected the prepared synthetic request");
    assert.match(parsed.php_version, /^8\./);
    assert.deepEqual(parsed.request, first.request);
    assert.deepEqual(parsed.instants, fixture.instants);
    assert.equal(parsed.request.total_cents, source.total_cents);
    assert.equal(parsed.request.total_cents - FIXED_RESERVATION_CENTS, source.total_cents - FIXED_RESERVATION_CENTS);
    assert.match(parsed.request_hash, /^[a-f0-9]{64}$/);

    const again = prepare(parsed.request);
    assert.deepEqual(again, first, "Parsing must not change refs, amounts, recipient, event, timezone or expiration");
    const fromInstants = prepare({
      ...parsed.request,
      balance_due_date: parsed.instants.balance_due_date,
      event: { ...parsed.request.event, event_at: parsed.instants.event_at },
      link_expiration: parsed.instants.link_expiration,
    });
    assert.deepEqual(fromInstants, first, "UTC instants from the original PHP date methods must recover identical wire dates");
  });
}

for (const expiration of ["24h", "48h", "72h", "7d", "never"]) {
  test(`original receiver retains the ${expiration} expiration condition without inventing an absolute expiry`, () => {
    const source = fixedAgreement({ link_expiration: expiration, event: { service_name: "Synthetic optional-event service" } });
    const first = prepare(source);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") throw new Error("Supported expiration must prepare");
    const parsed = parseOriginal(first.request);
    assert.equal(parsed.status, "parsed");
    if (parsed.status !== "parsed") throw new Error("Original PHP receiver must parse supported expiration");
    assert.deepEqual(parsed.request, first.request);
    assert.equal(parsed.request.link_expiration, expiration);
    assert.equal(parsed.request.event.event_at, null);
    assert.equal(parsed.instants.event_at, null);
    if (expiration === "never") assert.equal(parsed.instants.link_expiration, null);
    else assert.match(parsed.instants.link_expiration ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(prepare(parsed.request), first);
  });
}

const incompatible: readonly [string, Record<string, unknown>, string][] = [
  ["missing lead", { lead_id: undefined }, "lead_id"],
  ["missing quote", { quote_id: undefined }, "quote_id"],
  ["missing version", { quote_version: undefined }, "quote_version"],
  ["blank reference", { quote_id: "" }, "quote_id"],
  ["numeric reference", { lead_id: 123 }, "lead_id"],
  ["PHP-trimmed reference", { lead_id: "\u0000lead-fixed-synthetic\u0000" }, "lead_id"],
  ["overlong reference", { quote_version: "x".repeat(181) }, "quote_version"],
  ["noncanonical Monday reference", { monday_item_id: "monday-123" }, "monday_item_id"],
  ["unsafe integer cents", { total_cents: Number.MAX_SAFE_INTEGER + 1 }, "total_cents"],
  ["fractional cents", { total_cents: 125001.5 }, "total_cents"],
  ["missing total", { total_cents: undefined }, "total_cents"],
  ["reservation-only total", { total_cents: FIXED_RESERVATION_CENTS }, "total_cents"],
  ["under-reservation total", { total_cents: FIXED_RESERVATION_CENTS - 1 }, "total_cents"],
  ["negative total", { total_cents: -1 }, "total_cents"],
  ["missing schedule", { balance_due_date: undefined }, "balance_due_date"],
  ["null schedule", { balance_due_date: null }, "balance_due_date"],
  ["invalid calendar date", { balance_due_date: "2099-02-30T12:00" }, "balance_due_date"],
  ["second precision", { balance_due_date: "2099-12-01T18:00:01Z" }, "balance_due_date"],
  ["millisecond precision", { balance_due_date: "2099-12-01T18:00:00.001Z" }, "balance_due_date"],
  ["DST gap", { balance_due_date: "2027-03-14T02:30" }, "balance_due_date"],
  ["DST fold", { balance_due_date: "2026-11-01T01:30" }, "balance_due_date"],
  ["DST fold with an explicit instant", { balance_due_date: "2026-11-01T05:30:00Z" }, "balance_due_date"],
  ["missing timezone", { timezone: undefined }, "timezone"],
  ["unknown timezone", { timezone: "Mars/Olympus" }, "timezone"],
  ["timezone abbreviation", { timezone: "CST" }, "timezone"],
  ["numeric timezone offset", { timezone: "+05:45" }, "timezone"],
  ["missing expiration", { link_expiration: undefined }, "link_expiration"],
  ["null expiration", { link_expiration: null }, "link_expiration"],
  ["unsupported expiration", { link_expiration: "30d" }, "link_expiration"],
  ["ambiguous expiration", { link_expiration: "2026-11-01T01:30" }, "link_expiration"],
  ["expiration second precision", { link_expiration: "2099-11-20T18:00:01Z" }, "link_expiration"],
  ["missing service name", { event: { event_at: "2099-12-15T18:00:00Z" } }, "event.service_name"],
  ["ambiguous event", { event: { service_name: "Synthetic", event_at: "2026-11-01T01:30" } }, "event.event_at"],
  ["event second precision", { event: { service_name: "Synthetic", event_at: "2099-12-15T18:00:01Z" } }, "event.event_at"],
];

for (const [name, patch, field] of incompatible) {
  test(`original structural adapter blocks ${name} before PHP transport`, () => {
    const input = fixedAgreement(patch);
    const before = structuredClone(input);
    const result = prepare(input);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") throw new Error("Incompatible fixture unexpectedly prepared");
    assert.equal(result.code, "INCOMPATIBLE_PAYMENT_AGREEMENT_V1");
    assert.ok(result.fields.includes(field), `Expected explicit field ${field}: ${result.fields}`);
    assert.equal("request" in result, false);
    assert.deepEqual(input, before, "Blocking must not rewrite the original terms or references");
  });
}

test("original structural adapter blocks non-object input without preparing transport", () => {
  for (const input of [null, [], "agreement"]) {
    assert.deepEqual(prepare(input), { status: "blocked", code: "INVALID_REQUEST", fields: ["request"] });
  }
});

test("original PHP parser/date methods independently reject malformed prepared input", () => {
  const first = prepare(fixedAgreement());
  assert.equal(first.status, "ready");
  if (first.status !== "ready") throw new Error("Baseline fixture must prepare");
  for (const patch of [
    { lead_id: "" }, { quote_id: null }, { quote_version: undefined },
    { total_cents: 125001.5 }, { balance_due_date: "2099-02-30T12:00" },
    { balance_due_date: "2099-12-01T13:00:01" }, { link_expiration: null },
    { timezone: "Mars/Olympus" },
  ]) {
    assert.deepEqual(parseOriginal({ ...first.request, ...patch }), { status: "blocked", exception: "DomainException" });
  }
  assert.deepEqual(parseOriginalRaw("{"), { status: "blocked", exception: "DomainException" });
});

for (const field of ["balance_due_date", "link_expiration"]) {
  test(`structural readiness cannot bypass the original PHP future-date check for ${field}`, () => {
    const input = fixedAgreement({ [field]: "2000-01-01T12:00:00Z" });
    const before = structuredClone(input);
    const structural = prepare(input);
    assert.equal(structural.status, "ready", "The pure adapter deliberately does not authorize future dates");
    if (structural.status !== "ready") throw new Error("Past but valid wall times are structurally representable");
    assert.deepEqual(parseOriginal(structural.request), { status: "blocked", exception: "DomainException" });
    assert.deepEqual(input, before);
  });
}
