# Extension of the original Gourmet Payments receiver

This directory extends Dropbox `Gourmet Corporation/gourmet-payments` through
additive PHP classes, SQLite 0006 and a unified patch of its original Application,
Request, service, repository and migrator. It provides no replacement application.

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

`InternalPaymentPlanV2` remains the pure canonical-wire validator. Original
`Money::agreement` enforces the USD 49 branch; retainer and full payment retain
their explicit v2 invariants. The existing isolated 114 v1 and 100 v2 checks
retain their separate guarded processes and historical reference bytes.

`OperationalPaymentAgreementV2` binds the immutable operation, source/configuration
and stable idempotency identity to a fresh Office assertion. The patched original
Application authenticates creation and read-only lookup with its existing bearer,
guard and replay cipher. Its new service method commits actual agreements and
schedules with encrypted replay/audit, without calling v1's link-generating
`create`. SQLite 0006 retains v1 policy and adds immutable, tokenless,
providerless `DRAFT_INTERNAL` rows for all three modes. Its atomic rebuild rolls
back schema and migration receipt together.

V2 and commercial/production acceptance are independently off by default. V2's
opt-in cannot enable v1 links. Office requires an explicit server composition and
transport host/bearer resolver. Tests use loopback and public synthetic fixture
values plus a fake of the actual PayPal transport interface, asserting zero calls.
No real credential, public token, URL, consent or provider execution is needed.

The [existing quote workflow](../../docs/payment-draft-v2.md) commits its intent
before delivery, reconciles ambiguous outcomes and displays the verified agreement
UUID in the same card. Service authentication is not customer consent; there is
no PostgreSQL/SQLite distributed transaction. These files are code for draft-PR
review; no original Dropbox write, remote migration, merge or deployment occurred.
