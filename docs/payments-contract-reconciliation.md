# Gourmet Payments contract reconciliation

Candidate inspected: PR 2, `faa7001ef26b8aa8ca0419b191b59c57ffba13ff`.
The original receiver remains the owner of payment agreement creation. This
application only persists internal, unsent preparations. Its original schema 2
rules and records remain intact. The subsequent product decision adds explicit
50/50, full upfront and exceptional USD 49 modes under a separate contract v2
and schema 3 ledger; see [the current v2 boundary](payment-agreement-v2.md).

## Sources inspected on 2026-10-14

The canonical Dropbox folder is `Gourmet Corporation/gourmet-payments`:

- [API contract](https://www.dropbox.com/scl/fi/ar6lugcu7uq7mbtdmjvrg),
  `docs/internal-payment-agreement-api.md`.
- [Original request parser](https://www.dropbox.com/scl/fi/tbl2di73vuzj1dr86mo2h),
  `src/Http/InternalPaymentAgreementRequest.php`.
- [Original agreement service](https://www.dropbox.com/scl/fi/h52bpwx91g9tgemk9k8vb),
  `src/Domain/PaymentAgreementService.php`.
- [Original money invariant](https://www.dropbox.com/scl/fi/krboohcbw072j5qelqyjy),
  `src/Domain/Money.php`.

The October 5 TypeScript adapter, original tests, five dependency modules and
partial PHP source were transferred byte for byte and reused under
`tests/payments-contract/references`. All 17 per-file hashes and byte counts match
the parent transfer manifest. These references do not replace the current
Dashboard application or establish present authorization.

## Original v1 semantic boundary

| Property | Persistent quote preparation | Original Payments receiver |
| --- | --- | --- |
| Meaning | Unaccepted quote, internally approved and unsent | Creates an agreement in `PENDING_RESERVATION` |
| Currency | USD technical boundary | USD only |
| Initial amount | Percentage from the approved catalogue, preserved in cents | Fixed reservation of 4900 cents |
| Total | Exact stored quote total | Integer total strictly greater than 4900 cents |
| Remaining amount | Quote total minus quoted deposit | Total minus 4900 cents, one future balance schedule |
| Conditions | Exact stored catalogue text | Receiver policy; request has no field for quoted deposit or catalogue conditions |
| Dates | Brief date is free text; catalogue expiry limits quote validity | Approved local minute dates, IANA timezone and link expiration |
| Identity | Tenant/event/quote/approval/artifact pins | Canonical lead, quote ID/version, optional Monday item ID |
| Permission | Existing write and internal approval authorization | Separate service authentication, configuration and commercial authority |

A quote deposit of 4900 cents does not establish fixed-reservation semantics,
acceptance of the receiver's conditions or authority to create an agreement.
The current catalogue expresses deposits as percentages and has no structured,
authorized fixed-reservation agreement. Its terms cannot be silently omitted,
translated or overwritten by the receiver's policy. Internal approval is not
customer consent or dispatch permission. A brief date must not supply the balance
schedule, and catalogue validity must not supply link expiration.

Structural acceptance by a pure adapter or PHP request parser cannot establish
these missing facts. The PHP parser accepts totals from one cent, whereas the
domain money invariant rejects totals at or below 4900 cents; parser-only success
is therefore insufficient even for structural interoperability.

## Isolated checks and limits

`npm run test:payments-contract` runs 114 tests using the recovered original
adapter, original in-memory consumer and actual PHP parsing/fixture code. This
includes 46 new structural round-trip/rejection tests. Standalone synthetic
fixed-reservation fixtures preserve exact integer cents, source references,
recipient, event and balance dates, timezone and expiration on TS → PHP → TS.
Custom expiration instants survive timezone conversion; relative expiration
choices retain their conditions. The original PHP producer creates seven actual
source rows in memory and passes five request/date checks before the Node tests
use its fresh output. No historical result is substituted.

The current application has four separate boundary tests with actual service and
HTTP handlers. Percentage quotes `10000/3000` at 30% and `9800/4900` at 50% retain
their exact stored conditions, dates and financial snapshot after preparation,
idempotent retry and read. Sixteen injected requests are rejected with HTTP 400
and no mutation, including legacy agreement creation, schedules, timezone,
expiration and consent flags. Neither percentage quote is passed to the original
structural adapter. The existing pending/obsolete panel is reused.

Coverage and material limits:

- Percentage deposits different from 4900 cents and a 50% deposit of exactly
  4900 cents; neither may become a provider-ready request.
- The structural adapter blocks totals at or below the original reservation,
  fractional/unsafe cents, incomplete references, invalid dates, lossy precision,
  unsupported timezones and daylight-saving gaps/folds. The original event
  adapter rejects unsupported currency and financial events lacking evidence.
- The original parser/date methods independently reject malformed requests,
  calendar inputs and past balance/expiration dates even when TS reports
  structural readiness. The pure TS adapter does not guarantee future dates or
  authorization; those remain receiver/service checks.
- Stale quote, approval, preparation, catalogue or artifact bindings; altered
  recipient, cross-scope references, absent write/approval rights and expiry.
- The wire request has no deposit, quoted-conditions or consent authorization
  field. Structural `ready` must never authorize dropping quote conditions or
  changing the initial amount. In particular, a matching 4900-cent percentage
  deposit remains blocked.

The existing immutable preparation remains blocked and preserves its financial
snapshot through reads, retries and restart. No provider client is instantiated,
and no live endpoint, credential, launch flag or deferred send is enabled. Do not
start the recovered PHP application or run its legacy E2E/database cleanup routine.

The tests do not invoke `PaymentAgreementService::create`, create an agreement,
or execute the full receiver. The fixed reservation/balance policy was inspected
in its original `Money.php` and service source; the new round-trip checks exercise
request/date fidelity rather than claiming execution of that domain service.

## Current verification and provenance

Completed locally on 2026-10-14:

- `GOURMET_CONTRACT_PHP_BIN=/tmp/gourmet-php/bin/php npm run test:payments-contract`:
  114 passed, no skipped cases, using fresh PHP output and all 17 verified files.
- `node --import tsx --test tests/office/payment-preparation.test.tsx tests/office/payment-preparation-review.test.ts tests/office/gourmet-payments-boundary.test.ts`:
  44 passed. The existing pending UI test now fixes its clock to the fixture time,
  so catalogue expiry is deterministic.
- `./node_modules/.bin/tsc --noEmit -p tests/payments-contract/tsconfig.json`:
  pure adapter and new round-trip types pass. No full historical integrations
  type-check is claimed; its original type-only `FetchLike` graph is not copied.
- `npm run typecheck`, `npm run build`, `npm run office:build` and
  `git diff --check` completed successfully.
- Actual runtimes: Node 24.19.0, tsx 4.23.15, TypeScript 7.0.2 and isolated
  PHP 8.4.26 with mbstring/PDO SQLite. Dependency versions were not changed.

The original bundle is Library file
`libfile_7d330c581d00819186bae438e36c9814`, pinned OpenAI file
`file_0000000014a881f5a05236c7f70232de`, named
`Gourmet-SalesOS-Payments-contract-v1-reviewed-20261005.zip`.
Expected size: 337041 bytes; expected SHA-256:
`89324626d53323f4e89c1720e40c690c5a0279ec9d07a4a5bf4180c3e63f191e`.

Library `prepare_materialize` returned a signed transfer URL and
`workspace_path:null`. Download attempts using default, additional-network and
escalated execution all failed with `Tunnel connection failed: 403 Forbidden`.
The archive was not downloaded, extracted or hash-verified. The subsequent
message transfer supplied the exact individual files; their separate hashes and
byte counts were verified before import. See `tests/payments-contract/README.md`
and `references/TRANSFER-SHA256SUMS.json` for the executable checks and limits.

No `AGENTS.md` was found in `/`, `/workspace`, the repository or its candidate
tree, and the parent confirmed the recovered bundle contains none. No legacy
PHP E2E, recovered persistent database, provider activation, payment call,
migration, merge or deployment is part of this work. The candidate's successful
CI 38510606784 belongs to `faa7001e`; it does not validate these later changes.
