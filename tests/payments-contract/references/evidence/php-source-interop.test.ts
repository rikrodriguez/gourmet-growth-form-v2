import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adaptGourmetPaymentsOutboxV1 } from "../candidate/packages/integrations/src/gourmet-payments-contract-v1.js";
import { InMemoryPaymentOrchestrationStore, PaymentEventService } from "../candidate/packages/payments/src/index.js";
import type { PaymentProviderEvent } from "@gourmet-sales/contracts";

// This test is deliberately NOT RUN until the actual PHP fixture output exists.
const filename = process.env.GOURMET_PHP_FIXTURE_OUTPUT;
if (!filename) throw new Error("GOURMET_PHP_FIXTURE_OUTPUT must name the actual isolated PHP result; do not substitute synthetic output.");
const result = JSON.parse(readFileSync(filename, "utf8"));

test("actual isolated PHP producer returns seven source rows and passes five request/date checks", () => {
  assert.equal(result.producer_executed, true);
  assert.equal(result.storage, "sqlite::memory:");
  assert.equal(result.external_calls, 0);
  assert.match(result.php_version, /^8\./);
  assert.equal(result.rows.length, 7);
  assert.equal(result.request_checks.length, 5);
  assert.ok(result.request_checks.every((item: { status: string }) => item.status === "PASS"));
});
for (const row of result.rows) {
  test(`genuine PHP ${row.event_type}: raw incompatible, explicit adapter preserves intended result`, async () => {
    const service = new PaymentEventService(new InMemoryPaymentOrchestrationStore());
    await assert.rejects(service.ingest(JSON.parse(row.payload_json) as PaymentProviderEvent));
    const adapted = adaptGourmetPaymentsOutboxV1(row);
    if (row.event_type === "payment_link.created") {
      assert.equal(adapted.status, "blocked");
      if (adapted.status === "blocked") assert.equal(adapted.code, "PAYMENT_LINK_URL_UNAVAILABLE");
      return;
    }
    assert.equal(adapted.status, "ready");
    if (adapted.status !== "ready") throw new Error("Unexpected incompatible PHP fixture");
    assert.equal(adapted.event.event_id, row.public_uuid);
    assert.equal(adapted.event.data.public_payment_url, null);
    assert.equal(adapted.event.data.balance_due_date, null);
    assert.deepEqual(await service.ingest(adapted.event), { duplicate: false });
    assert.deepEqual(await service.ingest(adapted.event), { duplicate: true });
  });
}
