# Legacy payment-link preparation from an approved quote

The current Dashboard prepares the explicitly selected, versioned v2 draft
described in [Internal Payments v2 preparation](payment-agreement-v2.md). This
document preserves the original schema 2 behavior and compatibility boundary.
Legacy records are not converted, and `prepare_payment` remains supported under
its original rules. New v2 drafts use a separate schema 3 ledger and command.

This slice adds a useful internal handoff in Dashboard → Propuestas → Guardadas:
create a manual event, quote it from the authorized server catalogue, approve the
exact quote internally, and select **Preparar solicitud de enlace**. The server
saves one immutable preparation for that approved version. The UI displays
**Pendiente de revisión del proveedor · sin enlace** and the unresolved blockers.

This is an internal preparation, not an agreement accepted by the customer, an
invoice, a payment link, a reservation, a confirmed payment or permission to send.
No provider transport, credential, live URL, environment enable flag, outbox,
webhook, PayPal/Monday call or notification is added. Existing demo metrics and
payment reconciliation are unchanged. The normal demo/staging servers still do
not register the opt-in event-quote API.

## Original implementation reused as the boundary

The recovered Gourmet Payments receiver already owns link generation:

- [Original API contract](https://www.dropbox.com/scl/fi/ar6lugcu7uq7mbtdmjvrg)
- [Original request parser](https://www.dropbox.com/scl/fi/tbl2di73vuzj1dr86mo2h)
- Recovery source: `gourmet-payments/docs/internal-payment-agreement-api.md` and
  `src/Http/InternalPaymentAgreementRequest.php`, read 2026-10-14.

Its disabled `POST /internal/v1/payment-agreements` uses exact `quote_id` and
`quote_version` bindings plus caller-owned durable idempotency. The Dashboard
preparation preserves those concepts without duplicating or invoking its PHP
service. A preparation's stable identifier binds organization, workspace, mode,
event, exact quote version/digest and approval decision digest. It is not an
upstream idempotency key or a fabricated canonical lead ID.

The original agreement enforces USD 49 reservation terms and one future balance
schedule. Current quote totals, percentage-based deposit and catalogue terms
must never be converted to those terms silently. Even a deposit that happens to
be USD 49 is not evidence of semantic compatibility. Therefore every preparation
has these explicit blockers:

1. Provider disabled
2. Legacy agreement terms not reviewed/authorized for this quote
3. Canonical lead binding not supplied
4. Payment schedule, IANA timezone and link expiry not supplied/approved

A future integration must resolve these deliberately, reuse the original
receiver, and obtain the appropriate authority/configuration. It must not infer
acceptance or authorization from this internal preparation. There is no
provider-ready payload here and no automatic later dispatch.

## Persistence and access

The `prepare_payment` command supplies only an idempotency key, expected aggregate
revision and exact quote/approval/artifact pins. Recipient, total, deposit,
remaining quoted amount and terms come only from the approved stored version.
Injected prices, URLs, actors, tenants, schedules and extra fields fail closed.

Both write and approval permissions are required. HTTP uses the existing durable
approval target, event grant, same-origin/host checks, CSRF and optional opaque
Dashboard access revision. Identity, authorization and record mutation share the
existing bounded transaction. Revocation or expiry rolls back the entire write.

Records without preparations remain schema version 1, byte-for-byte compatible.
The first preparation upgrades that encrypted aggregate to schema version 2 and
adds the nonempty `paymentPreparations` ledger. No SQL migration is required:
prepared migration 005 continues to store encrypted content plus immutable audit
hashes. Old readers cannot read version 2 and fail closed; a rollback to old
application code requires accounting for these records. No deployed database or
runtime is changed by this slice.

A preparation records the preserved quote/decision bindings, original financial
terms, actor/time, pending state, `providerEnabled:false`, `publicPaymentUrl:null`,
and blockers. Its immutable audit and receipt commit atomically with it.
Validation replays the ledger, checks that approval preceded preparation, and
rejects changes, duplicates, schema downgrade or cross-tenant replay. Bounds
remain 100 revisions, 20 quotes and at most 20 preparations per event.

Identical retries return the authoritative current state without another write.
Another key cannot create a second preparation for the same quote. A brief or
catalogue change makes the historical preparation obsolete. It stays in history;
a newly quoted and internally approved version needs a new preparation. The UI
also detects catalogue expiry/replacement while open, locks stale actions,
blocks repeated clicks, discards late results on close/identity changes, and
requires a reload after an uncertain write. It renders no payment anchor.

## Focused verification

- `tests/office/payment-preparation.test.tsx`: workflow, amounts, exact pins,
  idempotency, concurrent requests, tenant/event isolation, CSRF/approval access,
  browser transport gate and inactive presentation.
- `tests/office/payment-preparation-review.test.ts`: independent adversarial
  ledger, tampering, queued expiry, historical and UI validity tests.
- `tests/office/payment-preparation-postgres.test.ts`: real loopback PostgreSQL,
  encrypted persistence, API and separate-process recovery, concurrent API
  instances, withdrawn authority and post-write rollback on session/membership/
  event-grant expiry.
- `tests/event-quote-browser/check.ts`: existing real React/HTTP/PostgreSQL
  harness additionally covers preparation, same-turn duplicate clicks,
  desktop/mobile layout, restart recovery, obsolete history and read-only state.
  It records two additional synthetic screenshots for CI inspection.

All fixtures and keys are test-only. PostgreSQL schemas are isolated and removed
by each suite. No recovered Payments E2E or deployed payment database is used.
