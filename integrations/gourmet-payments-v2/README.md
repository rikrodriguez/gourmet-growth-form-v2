# Extension of the original Gourmet Payments receiver

This directory extends Dropbox `Gourmet Corporation/gourmet-payments` through
additive PHP classes, versioned SQL migrations and a unified patch of the original
PHP files. It keeps the same Application, Request, authentication, service,
repositories, OAuth client, idempotency guard and encrypted replay cipher.
The extension persists disabled agreement drafts and, with separate authority,
issues a related customer checkout in that same Payments ledger.

64 original runtime files and all seven original migrations are preserved byte
for byte under `tests/payments-contract/operational-originals`, with Dropbox
revision, content hash, byte count and SHA-256 in `SOURCES.json`. Materialize a
reviewable isolated runtime with:

```sh
node scripts/prepare-gourmet-payments-operational.mjs /absolute/empty/directory
```

That command verifies hashes, applies the patch and copies additive files. It
performs no migration, startup, environment-file read or network request. No
credentials, original database/customer files or destructive E2E are included.
The two original checkout assets, `app.css` and `app.js`, were retrieved read-only
from Dropbox and have a separate revision/size/hash manifest under
`tests/payments-contract/operational-assets/SOURCES.json`. They supplement the
unchanged 64-file baseline; the 17 earlier contract references remain immutable.

`InternalPaymentPlanV2` remains the pure canonical-wire validator. Original
`Money::agreement` enforces the USD 49 branch; retainer and full payment retain
their explicit v2 invariants. The isolated contract suites retain their separate
guarded processes and historical reference bytes.

`OperationalPaymentAgreementV2` binds the immutable operation, source/configuration
and stable idempotency identity to a fresh Office assertion. The patched original
Application authenticates creation and read-only lookup with its existing bearer,
guard and replay cipher. Its new service method commits actual agreements and
schedules with encrypted replay/audit, without calling v1's link-generating
`create`. SQLite 0006 retains v1 policy and adds immutable, tokenless,
providerless `DRAFT_INTERNAL` rows for all three modes. SQLite 0007 adds checkout
children and their immutable relation; its atomic rebuild preserves existing
rows and commits schema and migration receipt together. The unchanged original
root SQL 0001–0003 plus root 0004/0005/0006 supply the opt-in MySQL/MariaDB path;
all seven original SQL files remain byte-for-byte intact.

`CheckoutConditionsV1` and its TypeScript mirror bind the complete persisted
draft operation, including source quote, recipient, approval, terms and reasons,
amounts, dates, timezone and expiration. A fresh issuance command names those
exact conditions. The original service locks the source draft and commits a
contract-version-3 `PENDING_CHECKOUT` child, schedules, unique parent/child
relation, audit and encrypted receipt atomically. `UNIQUE(parent_draft_id)` and
the stable issuance identity prevent a second checkout even with different
browser command keys. The source v2 draft remains unchanged and its receipt
keeps `executable:false`, `providerEnabled:false` and `publicPaymentUrl:null`.
The separate child receipt carries its UUID and opaque `/pay/` URL. Office
accepts that URL only on its server-pinned checkout origin, with HTTPS or an
explicit loopback test origin; issuance does not mean that payment occurred.

The approved 50/50 mode reuses the original finite Subscriptions mechanism with
a variable initial setup fee and exactly one future balance. Full payment uses
Orders v2 `CAPTURE`, for one payment of the total with no future balance or
subscription. USD 49 remains an explicitly selected exception. The quote's
percentage is preserved, and no mode inherits v1's non-refundable reservation
wording. Source approval is internal evidence; the customer must accept the
exact displayed conditions before an explicitly enabled provider POST.

The recovered README/Composer describe MySQL/MariaDB, but the recovered
Connection and migration CLI select SQLite. SQLite stays the default.
`PAYMENTS_LEDGER_DRIVER=mysql` explicitly selects the added PDO MySQL path for
MariaDB 11.4.x or MySQL 8.4.x, with native prepares, UTC, strict SQL mode, utf8mb4
and InnoDB. Server-owned structured configuration supplies the connection;
HTTP requests cannot choose a DSN, engine or credentials. HTTP bootstrap only
checks MySQL schema readiness; migrations run through the explicit CLI.

The MySQL migrator uses an advisory lock and a SHA-256 `STARTED`/`APPLIED`
journal for each file. Partial DDL requires explicit operator recovery, with no
automatic replay or claim of DDL rollback. Untracked schemas and legacy version
rows without checksum attestation are blocked. The [storage compatibility
document](../../docs/payments-storage-compatibility.md) details these boundaries.

V2 draft acceptance is independently off by default; its opt-in cannot enable
v1 links. Checkout issuance additionally requires `INTERNAL_CHECKOUT_V1_ENABLED`
and the original bearer authentication. `PAYMENT_CHECKOUTS_PROVIDER_ENABLED`
separately gates provider actions. Both flags default to `false`, the Office
composition is test-only, and the PHP checkout routes block production
execution. Office obtains a fresh server-resolved `canIssueCheckout` capability
for the separate `issue_payment_checkout_v1` purpose; quote approval alone does
not provide it. No real role, grant, credential or runtime composition is installed.

The [existing quote workflow](../../docs/payment-draft-v2.md) commits its intent
before delivery, reconciles ambiguous outcomes and displays the verified parent
and child UUIDs in the same card. Checkout intent and receipt extend the existing
encrypted Office handoff and append-only journal; they add no PostgreSQL schema.
Review, issue and recovery are manual actions, with no automatic sending.
There is no distributed transaction between PostgreSQL and the Payments ledger.
Historical recovery never creates a checkout. Customer page GETs do not start or
capture payments, and an expired v3 link bypasses v1's expiration outbox mutation.

`npm run test:payments-contract` covers isolated original/v2 contracts, the full
TS/PHP conditions mirror and provider payload/response validation through an
explicit fake of the original HTTP transport. Fake OAuth/provider requests are
counted separately from external provider calls. `npm run test:office` includes
actual local Office/PostgreSQL-to-PHP issuance, encrypted replay, rollback,
concurrency and authority/expiry checks. Its engine tests use helper-owned
disposable MariaDB/MySQL containers: selected engines must run or fail, with no
skip or SQLite fallback. `npm run test:event-quotes:e2e` covers the existing
Chromium card and original PHP HTTP receiver with SQLite and synthetic data.
These fixtures require zero external provider calls; explicitly enabled fake
provider POSTs verify payment handling without contacting PayPal. Results for
this continuation must be taken from its exact commit/run, not earlier totals.
No deployed database or hosting configuration was inspected, and no remote
migration, original Dropbox write, merge, deployment or real customer delivery occurred.
