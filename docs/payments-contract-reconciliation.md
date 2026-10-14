# Gourmet Payments contract reconciliation

Candidate inspected: PR 2, `faa7001ef26b8aa8ca0419b191b59c57ffba13ff`.
The original receiver remains the owner of payment agreement creation. This
application only persists an internal, unsent request; its existing schema 2,
approval checks, blockers and pending/obsolete presentation remain authoritative.

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

The October 5 TypeScript adapter must be transferred and reused, including its
dependencies and original contract tests. A recovered historical snapshot does
not replace the current Dashboard application or establish present authorization.

## Semantic boundary

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

## Required isolated checks

Round-trip tests must use synthetic fixtures and the recovered original adapter
and PHP parsing/fixture code. They must preserve exact integer cents, source
references, event and balance dates, timezone, expiration and conditions retained
outside the legacy wire request. Relevant rejection cases include:

- Percentage deposits different from 4900 cents and a 50% deposit of exactly
  4900 cents; neither may become a provider-ready request.
- Totals at or below the original reservation, unsupported currency, fractional
  or unsafe cents and a balance inconsistent with the declared initial amount.
- Missing or unapproved canonical lead, payment schedule, timezone or expiration;
  invalid dates, past balance/expiry, timezone conversion and daylight-saving
  ambiguities must follow the original contract rather than inferred brief text.
- Stale quote, approval, preparation, catalogue or artifact bindings; altered
  recipient, cross-scope references, absent write/approval rights and expiry.
- Additional wire fields purporting to change reservation or business conditions
  must never be treated as receiver support for them.

The existing immutable preparation remains blocked and preserves its financial
snapshot through reads, retries and restart. No live endpoint, provider client,
credential, launch flag or deferred send is part of these tests. Do not start the
recovered PHP application or run its legacy E2E/database cleanup routine.

## Current verification and transfer blocker

Completed locally on 2026-10-14:

- `node --import tsx --test tests/office/payment-preparation.test.tsx tests/office/payment-preparation-review.test.ts`:
  40 passed. The new 9800-cent total / 4900-cent percentage deposit case preserves
  quote conditions and the disabled preparation. The existing pending UI test now
  fixes its clock to the fixture time, so catalogue expiry is deterministic.
- `npm run typecheck`, `npm run build`, `npm run office:build` and
  `git diff --check` completed successfully.
- Isolated PHP CLI 8.4.26 with mbstring and PDO SQLite is available under
  `/tmp/gourmet-php`; its UTF-8 / in-memory SQLite smoke check passed. This is
  runtime availability evidence, not execution of the recovered contract tests.

The original bundle is Library file
`libfile_7d330c581d00819186bae438e36c9814`, pinned OpenAI file
`file_0000000014a881f5a05236c7f70232de`, named
`Gourmet-SalesOS-Payments-contract-v1-reviewed-20261005.zip`.
Expected size: 337041 bytes; expected SHA-256:
`89324626d53323f4e89c1720e40c690c5a0279ec9d07a4a5bf4180c3e63f191e`.

Library `prepare_materialize` returned a signed transfer URL and
`workspace_path:null`. Download attempts using default, additional-network and
escalated execution all failed with `Tunnel connection failed: 403 Forbidden`.
No bytes were downloaded, no hash was verified and no archive was extracted.
The TypeScript adapter has not been recreated. The round-trip/rejection matrix
above remains pending until a supported byte-preserving transfer succeeds.

No `AGENTS.md` was found in `/`, `/workspace`, the repository or its candidate
tree; the applicable instructions were requested from the parent. No remote
publication, CI run, merge, deployment, payment call or database migration was
performed by this continuation.
