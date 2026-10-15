# Quote conditions to an original Payments agreement draft

The existing payment card has an opt-in operational route: review explicit
conditions, confirm them separately, persist an Office delivery intent, and
create a non-executable agreement through the original Payments application.
The authenticated PHP receiver persists the actual agreement and schedules in
SQLite. Office verifies its receipt and displays its agreement ID in the same
card. No provider, customer consent, public token or payment URL is created.
Commercial execution is disabled by default.

## Original source and versioned extension

The canonical source is Dropbox `Gourmet Corporation/gourmet-payments`, including
its [API contract](https://www.dropbox.com/scl/fi/ar6lugcu7uq7mbtdmjvrg).
`tests/payments-contract/operational-originals/SOURCES.json` records Dropbox
revisions, byte counts, Dropbox content hashes and SHA-256 values for 64 original
runtime files. These are an immutable baseline of the actual application,
authentication, service, repositories, provider interfaces and migrations.

The current original Connection uses SQLite with WAL and foreign keys. Its
active migrations are SQLite 0001, 0002, 0004 and 0005; the three root-level MySQL
migrations are historical. No SQLite 0003 was invented. New SQLite 0006 preserves
v1 rows and the fixed USD 49 reservation policy, adding explicitly versioned v2
drafts. The new atomic-rebuild migrator branch commits schema changes, FK
verification and the migration receipt together, with rollback on failure.
Original migration branches retain their behavior.

`integrations/gourmet-payments-v2/patches/operational-v2.patch` extends five
original files. Additive classes and 0006 are beside it. The materializer
`scripts/prepare-gourmet-payments-operational.mjs` verifies every original hash
before applying the extension into an empty directory. It starts no service,
reads no environment file and applies no migration. No credential, original
database or customer file is included. The destructive original PHP E2E is
neither included nor executed. No remote migration or Dropbox write was made.

## Existing review and operational endpoint

`configure_payment_v2` still saves explicit conditions, change reason, schedule,
IANA timezone and expiration against the immutable preparation. The existing
card displays those facts with a separate unchecked confirmation. When the
server advertises `paymentAgreementsEnabled`, confirmation calls:

```text
POST /api/office/event-quotes/:eventId/payment-agreements/v2
{ key, configurationId, configurationDigest, expectedReviewDigest,
  operation: "create" | "reconcile" }
```

The browser supplies no actor, recipient, tenant, lead or receiver payload.
Existing origin, JSON, CSRF, access revision, durable session, event rights,
current catalogue and approval checks remain authoritative. The server resolves
the exact lead/service relationship and derives the recipient from the approved
quote and brief. Tests provide an explicit synthetic mapping; email and free
text cannot select a lead. No real commercial data is needed to test this code.

The earlier pure structural-registration command remains compatible when this
operational composition is absent. It is not a prerequisite for creating the
actual agreement. Aggregate schemas 1–4 and historical registrations retain
their original meaning.

## Cross-service persistence and recovery

Office commits an encrypted intent and append-only audit inside its existing
authorization transaction before contacting Payments. A stable operation ID
binds scope, event, configuration ID/digest and preparation digest. The complete
immutable operation and idempotency key survive browser retries and actor
changes. A fresh, bounded Office assertion accompanies each creation attempt
outside the operation digest.

`migrations/office/007_payment_agreement_handoffs.up.sql` contains the reviewable
Office persistence schema. Normal application startup does not apply it. The
explicit loopback fixture initializer uses that same SQL in its disposable
namespace; no production or remote namespace was provisioned.

Delivery runs outside PostgreSQL locks. PostgreSQL and SQLite do not have a
shared transaction: losing a response after SQLite commits leaves the Office
handoff reconciliation-required, without claiming a remote rollback. Retry
first performs authenticated lookup. A lost response recovers the same receipt
and agreement. An in-progress original idempotency guard remains pending;
lookup never creates. Only an authenticated absence plus an
explicit create operation and fresh authority can resend the same stable key.
Current authority is rechecked before new dispatch and private result access.

The original Application adds authenticated `POST /internal/v2/payment-agreements`
and its read-only `/reconcile` route, using its original bearer authenticator,
idempotency guard and replay cipher. `PaymentAgreementService::createDraftV2`
commits agreement, schedules, audit and encrypted receipt in one SQLite
transaction, rechecking current time/assertion/calendar before commit.
Historical lookup does not reinterpret expired dates as a new creation.

`INTERNAL_V2_ENABLED` is off by default and independent of v1's
`INTERNAL_API_ENABLED`: enabling drafts cannot enable link creation. Commercial
or production draft acceptance needs a separate opt-in, also off. The Office
composition remains explicitly injected and test-only; normal servers discover
neither hosts nor credentials. The transport requires HTTPS except for an
explicit loopback test option. No provider or executable-link path is enabled.

## Preserved commercial facts

| Mode | Initial amount | Future balance | Reservation field |
| --- | --- | --- | --- |
| `retainer_50` | Half rounded up to the cent | Exact remainder and explicit event/balance schedule | NULL |
| `full_upfront` | Exact total | Zero; no balance schedule or timezone | NULL |
| `fixed_49_reservation` | Exactly 4900 cents | Exact agreed remainder and due date | 4900 |

The source quote's percentage, deposit, terms, recipient, version, artifact and
approval remain unchanged evidence. A percentage equal to USD 49 does not
authorize the reservation exception. Stored operations and verified receipts
preserve all amounts, dates, times, timezones, reasons and expiration.

V2 rows are immutable `DRAFT_INTERNAL`, with provider/token NULL and draft-only
schedules. SQL constraints and existing checkout/revoke/replace guards block
conversion. The existing administrator detail displays a read-only draft.
No payment attempt, consent, provider resource, financial event or
`payment_link.created` event is produced.

The receipt reports `draft_persisted`, a real SQLite agreement UUID,
`serviceAuthenticated:true`, `authorizationVerified:false`, `executable:false`,
`providerEnabled:false` and `publicPaymentUrl:null`. Authentication of the service
does not establish customer consent or commercial dispatch authority.

## Verification

`npm run test:payments-contract` retains 114 original/v1 and 100 pure v2 checks
in separate network-blocked subprocesses. Operational tests join
`npm run test:office`, using the verified original application, real SQLite and
migrations, and a fake of its actual PayPal transport interface. They exercise
three modes, legacy preservation, authenticated replay, rejection and rollback.

`npm run test:event-quotes:e2e` exercises the existing Chromium card through
Office HTTP, PostgreSQL, the original Payments Application/Request over HTTP,
and SQLite. Its test-only router injects the fake transport; it does not claim
to test the exact original public front-controller bootstrap. Evidence and
desktop/mobile screenshots are written under `test-results/` after assertions
pass. Exact counts, SHA and CI are reported in draft PR 3 for this continuation.

Local verification on 2026-10-15 passed 1243 Office cases, 99 operations cases,
114 original/v1 and 100 pure v2 contract cases, application/contract/changed-test
types and both builds. The final Chromium rerun created exactly three original
agreements through real HTTP, made four read-only lookups, recovered a response
lost after commit across Office/PHP restart, retained historical projections
after later commands, and showed all three saved UUIDs after reload. The provider
counter and every financial/dispatch outbox remained zero. Independent code and
four retainer detail screenshots were reviewed without blocking findings.

Real source integration, customer consent, credentials, provider activation,
payment links, remote migrations, merge and deployment remain separate work.
