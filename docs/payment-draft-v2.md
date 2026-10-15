# Quote conditions, original Payments draft and related checkout

The existing payment card has an opt-in operational route: review explicit
conditions, confirm them separately, persist an Office delivery intent, and
create a non-executable agreement through the original Payments application.
The authenticated PHP receiver persists the actual agreement and schedules in
its configured Payments ledger. SQLite remains the default; this continuation
adds an explicit MySQL/MariaDB storage option to the same receiver. Office
verifies its receipt and displays its agreement ID in the same card. A separate,
manually reviewed issuance action can create one related checkout from that
persisted draft. The parent remains immutable and tokenless; the versioned child
has its own UUID and opaque customer URL. Issuance does not activate PayPal,
collect buyer consent or record a payment. This continuation uses synthetic
fixtures, with processing off by default and no real customer delivery or
deployed-ledger migration.

## Original source and versioned extension

The canonical source is Dropbox `Gourmet Corporation/gourmet-payments`, including
its [API contract](https://www.dropbox.com/scl/fi/ar6lugcu7uq7mbtdmjvrg).
`tests/payments-contract/operational-originals/SOURCES.json` records Dropbox
revisions, byte counts, Dropbox content hashes and SHA-256 values for 64 original
runtime files. These are an immutable baseline of the actual application,
authentication, service, repositories, provider interfaces and migrations. The
two original public checkout assets were retrieved read-only from Dropbox;
their separate revision, byte-count and hash manifest is
`tests/payments-contract/operational-assets/SOURCES.json`. The materializer
verifies these assets without changing the 64-file baseline or the 17 earlier
immutable contract references.

The recovered README and Composer metadata describe MariaDB/MySQL, while the
recovered Connection and CLI actually select SQLite with WAL and foreign keys.
This source discrepancy does not establish which engine any deployed system
uses. All seven original SQL files remain unchanged: SQLite 0001, 0002, 0004 and
0005, plus the three root-level MySQL migrations. No SQLite 0003 was invented.
New SQLite 0006 preserves v1 rows and the fixed USD 49 reservation policy while
adding versioned v2 drafts; SQLite 0007 adds related checkout children. Atomic
rebuilds commit schema changes, FK verification and migration receipts together,
with rollback on failure.

The optional MySQL/MariaDB path uses the unchanged root migrations followed by
new root 0004, 0005 and 0006. It preserves existing v1 identifiers, customer foreign
keys, snapshots, timestamps and USD 49 policy while adding the current ledger
fields, versioned drafts and checkout children. MySQL-family DDL is not transactionally rolled
back: the CLI journals each migration file and blocks an incomplete retry.
See [storage compatibility and recovery](payments-storage-compatibility.md).

`integrations/gourmet-payments-v2/patches/operational-v2.patch` extends the
original PHP files. Additive classes and versioned SQL migrations are beside it.
The materializer `scripts/prepare-gourmet-payments-operational.mjs` verifies every
original hash before applying the extension into an empty directory. It starts no service,
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

Delivery runs outside PostgreSQL locks. PostgreSQL and the Payments ledger do not
have a shared transaction: losing a response after Payments commits leaves the
Office handoff reconciliation-required, without claiming a remote rollback. Retry
first performs authenticated lookup. A lost response recovers the same receipt
and agreement. An in-progress original idempotency guard remains pending;
lookup never creates. Only an authenticated absence plus an
explicit create operation and fresh authority can resend the same stable key.
Current authority is rechecked before new dispatch and the issuance endpoint's
result. Normal event read ACLs continue to govern viewing already stored receipts.

The original Application adds authenticated `POST /internal/v2/payment-agreements`
and its read-only `/reconcile` route, using its original bearer authenticator,
idempotency guard and replay cipher. `PaymentAgreementService::createDraftV2`
commits agreement, schedules, audit and encrypted receipt in one ledger
transaction, rechecking current time/assertion/calendar before commit. The
MySQL/MariaDB option requires InnoDB, native prepared statements, UTC and an
explicitly migrated, checksum-attested schema. Its HTTP bootstrap checks
readiness without executing DDL; SQLite retains its existing bootstrap behavior.
Historical lookup does not reinterpret expired dates as a new creation.

`INTERNAL_V2_ENABLED` is off by default and independent of v1's
`INTERNAL_API_ENABLED`: enabling drafts cannot enable link creation. Commercial
or production draft acceptance needs a separate opt-in, also off. The Office
composition remains explicitly injected and test-only; normal servers discover
neither hosts nor credentials. The transport requires HTTPS except for an
explicit loopback test option. Creating a v2 draft enables no provider or link.

## Related checkout issuance in the same card

The persisted parent exposes a server-derived `checkoutConditionsDigest`.
`CheckoutConditionsV1` and its TypeScript mirror bind the complete immutable
operation: source quote and approval pins, recipient and service, source
percentage and deposit, selected mode and amounts, exact terms and change
reasons, local dates/times, timezone, resolved instants and expiration. The
conditions digest identifies those facts; it is not authority or buyer consent.

The existing card displays those facts and requires another unchecked review
confirmation before issuing. The browser sends only:

```text
POST /api/office/event-quotes/:eventId/payment-checkouts/v1
{ key, configurationId, configurationDigest, expectedReviewDigest,
  expectedConditionsDigest, operation: "issue" | "reconcile" }
```

The status capability `paymentCheckoutsEnabled` requires an explicitly injected
server resolver for `canIssueCheckout` with purpose
`issue_payment_checkout_v1`. Issuance re-resolves this authority for the concrete
event; it is independent of `canApprove`. Origin, CSRF, current access revision,
durable session and event approval rights still apply. New issuance also checks
the current source, quote, catalogue validity and calendar after lookup; its
bounded authorization cannot outlive that catalogue. No real role, grant or
credential is created by these contracts, fixtures or UI controls.

Office commits checkout intent in the existing encrypted handoff payload and
append-only journal. No new PostgreSQL schema or aggregate mutation is added.
It first looks up the stable receiver identity; only an explicit `issue` and an
authenticated absence permit creation. `reconcile` is read-only on Payments,
can recover historical expired conditions and never creates a child. Ambiguous
responses remain reconciliation-required, with a manual recovery control and
no automatic sending, navigation or replacement checkout.

The original Application accepts authenticated
`POST /internal/payment-checkouts/v1` and read-only
`POST /internal/payment-checkouts/v1/reconcile`. Its original service locks the
persisted v2 draft, derives the exact conditions and atomically commits a
contract-version-3 `PENDING_CHECKOUT` child in `payment_agreements`, schedules,
the `payment_checkout_issuances` relation, audit and encrypted replay receipt.
The relation has a unique parent and child. Its stable issuance key is derived
from the parent, operation and conditions, so different browser keys cannot
create a second checkout. Authority and dates are rechecked before committing;
historical receipt recovery rechecks fresh authority without reopening dates.

The parent retains its original `draft_persisted` receipt, UUID,
`executable:false`, `providerEnabled:false` and `publicPaymentUrl:null`.
The separate `checkout_issued` receipt identifies the child and its opaque
`/pay/<token>` URL, with the same false execution/provider flags. The receiver
stores the token hash and encrypts the replay receipt; Office also encrypts the
receipt and URL. The server pins `publicCheckoutOrigin`; the browser accepts
only the exact HTTPS origin or an explicit loopback test origin, the expected
token path, and no credentials/query/fragment. The same card labels the child
as issued with processing disabled, without claiming a charge or consent.

`INTERNAL_CHECKOUT_V1_ENABLED` and `PAYMENT_CHECKOUTS_PROVIDER_ENABLED` both
default to `false`. The former enables separately authenticated checkout
issuance; the latter gates provider processing. Checkout issuance is test-only
and production is blocked; provider processing is also blocked in production.
No normal server composition, real provider call, customer delivery or remote
migration is enabled by adding the code.

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
`payment_link.created` event is produced by draft persistence or checkout issuance.

The receipt reports `draft_persisted`, a persisted Payments agreement UUID,
`serviceAuthenticated:true`, `authorizationVerified:false`, `executable:false`,
`providerEnabled:false` and `publicPaymentUrl:null`. Authentication of the service
does not establish customer consent or commercial dispatch authority.

## Customer conditions and provider representation

| Mode | Provider representation | Buyer authorization |
| --- | --- | --- |
| `retainer_50` | Original Subscriptions mechanism, variable initial setup fee and exactly one future balance cycle | Exact initial sum and one future sum/date under the displayed terms |
| `full_upfront` | Orders v2 `CAPTURE` for the exact total | One payment, no subscription or future balance |
| `fixed_49_reservation` | Explicit USD 49 initial sum and one finite balance through Subscriptions | Exact selected exception and agreed future sum/date |

The extension reuses the original OAuth client and HTTP transport, repositories,
idempotency guard and replay cipher. Provider resources and responses are bound
to the child, conditions, amounts/currency and finite plan or order; approval
alone is not completed financial evidence. A source quote's internal approval
does not authorize the buyer's charge. The customer sees the exact saved terms
and accepts mode-specific initial/future or one-time consent; v1's
non-refundable-reservation wording is not inherited by other modes.

With processing disabled, customer GETs render the agreement without provider,
consent or financial writes. Expired versioned links return an unavailable page
without invoking v1's expiration outbox mutation. Explicitly enabled synthetic
provider fixtures exercise customer POST/CSRF/consent, bound Subscriptions or
Orders responses and recovery. A GET return never captures an order; one-time
capture requires an explicit buyer POST. Subsequent status lookup can reconcile
already completed provider evidence, without starting another payment.

## Verification

`npm run test:payments-contract` retains the isolated original/v1 and pure v2
contract suites, plus complete TS/PHP checkout-condition round trips. The
provider contract fixture uses the actual original client with a scripted fake
HTTP transport; fake OAuth/provider request counts are separate from zero
external provider calls. It checks exact money, dates, terms, finite balance
representation, one-time Orders binding/capture and lost-response recovery.
Operational tests join `npm run test:office`, using the verified original
application and migrations with synthetic data. They cover unique child
issuance for all three modes, immutable parents, encrypted token replay,
rollback, concurrent attempts, fresh authority/catalogue boundaries and
recovery across restart. The engine suite selects disposable MariaDB
11.4 and MySQL 8.4 containers in CI and exercises the same Application, Connection,
service and repositories. A selected engine must run or fail; it cannot silently
fall back to SQLite. Unselected local engines report `NOT_VALIDATED`.

`npm run test:event-quotes:e2e` exercises the existing Chromium card through
Office HTTP, PostgreSQL, the original Payments Application/Request over HTTP,
and SQLite. Its test-only router injects the fake transport; it does not claim
to test the exact original public front-controller bootstrap. Evidence and
desktop/mobile screenshots are written under `test-results/` after assertions
pass. This browser harness uses SQLite; it does not establish browser coverage
on both added engines.

For explicit local engine selection, use
`GOURMET_CONTRACT_TEST_ENGINES=mariadb,mysql npm run test:office` with the
fixture's required local PHP/PDO and Docker capabilities. A selected engine
must execute or fail; unselected engines are explicitly `NOT_VALIDATED`.
Issuance fixtures assert zero external provider calls and zero financial or
consent effects; enabled fake-provider cases report their simulated calls
separately. Generated evidence records the actual engine versions and results.
This document makes no claim that the new continuation's CI has passed;
publication SHA, terminal CI and aggregate counts must come from its exact run
in draft PR 3. Earlier checkpoint totals do not attest the checkout changes.

Real source integration, real buyer consent, credentials, provider activation,
customer delivery, remote migrations, merge and deployment remain separate work.
No deployed database, hosting configuration or remote infrastructure was
inspected for this storage continuation.
