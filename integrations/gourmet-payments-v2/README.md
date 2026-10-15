# Extension of the original Gourmet Payments receiver

This directory extends Dropbox `Gourmet Corporation/gourmet-payments` through
additive PHP classes, three new SQL files and a unified patch of 14 original PHP
files. It keeps the same Application, Request, authentication, service and
repositories, adding an explicit storage option rather than a replacement receiver.

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
their explicit v2 invariants. The isolated contract suites retain their separate
guarded processes and historical reference bytes.

`OperationalPaymentAgreementV2` binds the immutable operation, source/configuration
and stable idempotency identity to a fresh Office assertion. The patched original
Application authenticates creation and read-only lookup with its existing bearer,
guard and replay cipher. Its new service method commits actual agreements and
schedules with encrypted replay/audit, without calling v1's link-generating
`create`. SQLite 0006 retains v1 policy and adds immutable, tokenless,
providerless `DRAFT_INTERNAL` rows for all three modes. Its atomic rebuild rolls
back schema and migration receipt together. The unchanged original root SQL
0001–0003 plus new root 0004/0005 supply the opt-in MySQL/MariaDB path; all seven
original SQL files remain byte-for-byte intact.

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

V2 and commercial/production acceptance are independently off by default. V2's
opt-in cannot enable v1 links. Office requires an explicit server composition and
transport host/bearer resolver. Tests use loopback and public synthetic fixture
values plus a fake of the actual PayPal transport interface, asserting zero calls.
No real credential, public token, URL, consent or provider execution is needed.

The [existing quote workflow](../../docs/payment-draft-v2.md) commits its intent
before delivery, reconciles ambiguous outcomes and displays the verified agreement
UUID in the same card. Service authentication is not customer consent; there is
no distributed transaction between PostgreSQL and the Payments ledger. Engine
tests use only helper-owned disposable containers and synthetic fixtures; CI
selects both engines and selected engines cannot skip or fall back. On
2026-10-15 the original-runtime engine suite passed 22/22 cases on MariaDB
11.4.13 and MySQL 8.4.11, including 34 query/binary and 44 migration checks per
engine. Exact SHA and CI belong to draft PR 3. Checkpoint `2bd64c1` is evidence
for the earlier SQLite work only. No remote database or hosting configuration was
inspected; no original Dropbox write, remote migration, merge or deployment occurred.
