# Payments storage compatibility

This continuation adds an explicitly selected PDO MySQL storage path to the
original Payments receiver. The quote card, Office handoff and authenticated PHP
Application still use the same versioned operation and `createDraftV2` service.
It does not activate checkout, customer consent, provider execution or public
payment links. Commercial acceptance remains separately disabled by default.
Isolated execution passed on MariaDB `11.4.13-MariaDB-ubu2404` and MySQL
`8.4.11`; no remote infrastructure was inspected.

## Recovered source and preserved baseline

The canonical Dropbox README describes PDO MySQL, MariaDB/MySQL migrations and
a MariaDB 11.4 local environment. Composer requires `ext-pdo_mysql`. The recovered
`src/Database/Connection.php`, `Config.php`, `public/index.php` and migration CLI
instead select SQLite, its WAL/FK settings and `migrations/sqlite`. Documentation
alone cannot identify the engine in any deployed environment.

The 64 files in `tests/payments-contract/operational-originals` remain immutable,
with byte counts and hashes in `SOURCES.json`. The patch extends 14 original PHP
files in a materialized runtime; it does not rewrite the baseline. All seven
original migrations remain unchanged:

| Dialect | Original migration files | Added continuation |
| --- | --- | --- |
| SQLite | 0001 payment ledger, 0002 bootstrap, 0004 internal agreements, 0005 machine-to-machine contract | `sqlite/0006_versioned_payment_agreement_drafts.sql` |
| MySQL/MariaDB | 0001 payment foundation, 0002 PayPal sandbox PoC, 0003 checkout experience | `0004_current_payment_ledger.sql`, then `0005_versioned_payment_agreement_drafts.sql` |

The original root schema lacks fields and tables already used by the recovered
service. New 0004 adds recipient/source snapshots, replay ciphertext, missing
outboxes and the empty bootstrap-token table. It makes the customer reference
nullable for snapshot-based creation while preserving existing IDs and foreign
keys. Existing recipient snapshots come only from the referenced customer;
full names up to 201 characters and historical `updated_at` values are retained.
It neither invents a customer nor seeds administrator credentials. Duplicate
legacy consent types are rejected before the bridge starts; historical consent
rows are never silently merged or deleted.

New 0005 preserves v1 USD 49 reservation, exact remainder, token and future
balance rules. V2 rows use their explicit payment mode, immutable
`DRAFT_INTERNAL` status, NULL provider/token and draft schedules. Retainer/full
payments have NULL reservation fields; full payment has no balance due date or
timezone. CHECK constraints and triggers reject incompatible amounts, schedules,
mode strings and version changes. No provider resource, payment attempt, consent
or financial/dispatch event is created by draft persistence.

## Explicit selection and connection contract

| Setting | SQLite default | MySQL-family opt-in |
| --- | --- | --- |
| `PAYMENTS_LEDGER_DRIVER` | `sqlite` | `mysql` for either accepted server family |
| Accepted server | Existing SQLite PDO path | MariaDB 11.4.x or MySQL 8.4.x only |
| Migration directory | `migrations/sqlite` | `migrations` |
| HTTP bootstrap | Preserves existing SQLite migration behavior | Read-only `Migrator::assertCurrent()`; no DDL or history adoption |

The MySQL connection uses server-owned `PAYMENTS_MYSQL_HOST`,
`PAYMENTS_MYSQL_PORT`, `PAYMENTS_MYSQL_DATABASE`, `PAYMENTS_MYSQL_USER` and
`PAYMENTS_MYSQL_PASSWORD` configuration. An HTTP body cannot supply an engine,
DSN or credentials. Missing/unsupported configuration fails without falling
back to another ledger. Selecting storage does not enable the independent
`INTERNAL_V2_ENABLED`, v1 API or commercial acceptance flags.

PDO uses native prepared statements, exception mode, utf8mb4 and disabled
multi-statements. The connection establishes and checks UTC, binary connection
collation and strict SQL mode. Migration/readiness checks require InnoDB for all
ledger tables. UTC timestamps use `DATETIME(6)`; the operation separately
preserves the explicit business IANA timezone. Integer cents stay integers.
Canonical operation JSON is stored as `LONGTEXT` with `utf8mb4_bin`, not a
normalizing native JSON column. Encrypted replay uses `MEDIUMBLOB` with separate
binary nonce/tag fields. V2 mode comparisons use `BINARY` to reject padded forms.

## Explicit migrations and recovery

Materialization verifies source hashes and applies the reviewable patch without
opening a database, reading an environment file, starting PHP or running SQL.
After a separately authorized connection is configured, migration is an explicit
CLI operation in that materialized runtime:

```sh
php bin/migrate.php
```

The MySQL migrator acquires a database-scoped advisory lock. Before each trusted
migration file runs, it durably records its SHA-256 and `STARTED` state. After all
its statements succeed, the migration version and `APPLIED` receipt commit
together. New SQL uses explicit statement boundaries so compound triggers work
while PDO multi-statements remain disabled.

DDL can commit before an error on these engines. A failure or crash may therefore
leave some statements applied and a durable `STARTED` receipt. Both CLI retry and
HTTP readiness block that state, including when the attempted file has been
removed. Recovery requires an explicit operator review of the actual schema,
data and trusted migration bytes; there is no automatic rollback, destructive
reset, checksum replacement or synthesized success receipt.

An existing schema without migration tracking, or legacy version rows without
matching checksum-attested `APPLIED` receipts, is also blocked. The CLI can create
its tracking tables before rejecting unattested history; refusal does not imply
that no bookkeeping was written. This patch does not provide automatic adoption
of an existing deployment. A checksum mismatch, migration-version drift, active
migration or non-InnoDB table prevents readiness. This is a point-in-time gate;
it neither holds the migration lock through request handling nor introspects
every physical column, constraint and trigger.
SQLite 0006 has a separate atomic-rebuild branch; its rollback guarantee must
not be transferred to MySQL/MariaDB DDL.

## Isolated verification and evidence

`tests/payments-contract/php-operational-engines.test.ts` is included by
`npm run test:office`. With `CI=true`, it selects both `mariadb` and `mysql`.
Locally, `GOURMET_CONTRACT_TEST_ENGINES=mariadb,mysql` selects the same pair;
`GOURMET_CONTRACT_MYSQL_PHP_BIN` can identify the PHP binary with PDO MySQL.
An unselected local engine records `NOT_VALIDATED`. A selected engine without
the required PHP driver or Docker capability fails rather than skipping or
substituting SQLite.

The helper starts a uniquely owned, digest-pinned MariaDB 11.4 or MySQL 8.4
container with a random synthetic database, loopback-only port, anonymous
storage and event scheduler off. It validates ownership before using, restarting
or removing it. It does not accept an ambient database DSN, reuse an existing
database or mount host data. Fixture values and the fake original PayPal
transport require no real customer data or provider credentials. The original
destructive PHP E2E remains excluded.

The suite covers the original migration chain with a preexisting v1 agreement,
actual native PDO queries, three authenticated draft modes, rollback and retry,
encrypted replay/reconciliation, PHP/database restart and zero provider or
financial side effects. Scratch-schema cases exercise migration readiness,
checksums, locks and partial-DDL recovery gates. Evidence is written per engine
under `test-results/gourmet-payments-contract/engines/`; a result applies only to
the tested SHA and engine. Test definitions are not passing evidence.

On 2026-10-15 the engine suite passed **22/22 cases** against the actual engines
above. Each engine completed **34 query/binary checks** and **44 migration
checks**, including a real partial DDL failure observed from a second PDO
connection. Readiness issued zero DDL; the application ledger retained every
row and binary hash while probes used a separate disposable scratch schema.
Provider calls and financial/dispatch effects stayed zero. Both PHP and database
restart preserved committed rows. Tests also preserved historical dates and
201-character customer names, replay ciphertext of 90,003 bytes, Unicode terms
and future dates, and rejected padded modes and uppercase digest identities.

Checkpoint `2bd64c1` documents the earlier SQLite continuation. Its counts and
screenshots do not establish MariaDB/MySQL compatibility. The new publication
SHA, aggregate results and exact CI run are reported in draft PR 3; these
isolated results do not authorize deployment or attest any existing database.
