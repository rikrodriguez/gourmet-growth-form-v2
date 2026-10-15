# Persisted synthetic Payments v2 drafts

This opt-in extends the existing event quote commands and encrypted aggregate.
It does not create an original Payments agreement. The recovered original
`PaymentAgreementService::create` generates a payment token before its database
transaction, persists reservation/balance schedules and emits
`payment_link.created`. It has no safe draft operation. The original repository's
link replacement also generates a token. Neither method is called here.

The canonical source is Dropbox `Gourmet Corporation/gourmet-payments`, including
the [original API contract](https://www.dropbox.com/scl/fi/ar6lugcu7uq7mbtdmjvrg).
The original PHP migrations were not recovered; this change makes no claim about
their column defaults or constraints. It uses the existing Office SQL 005
encrypted aggregate and authorization transaction without a new SQL migration.

## One flow with two explicit commands

The existing preparation remains an immutable `pending_configuration` snapshot.
Its null fields and blockers are never rewritten. Two commands use the same
`POST /api/office/event-quotes/:eventId/commands` route:

1. `configure_payment_v2` requires the exact preparation ID/digest and explicit
   `paymentTerms`, `termsChangeReason`, `paymentSchedule` and `linkExpiration`.
   The server derives the mode, quote and amount references, and resolves a
   synthetic canonical lead from its own scope/event fixture mapping. It stores
   a `draft_configuration` with the exact plan review digest.
2. `register_payment_draft_v2` requires that configuration ID/digest and the
   `expectedReviewDigest` returned for review. A current authorized actor
   separately approves this exact internal plan. The server emits the canonical
   v2 wire, invokes the isolated PHP validator, checks the echoed receipt against
   that live wire, and stores a `draft_internal` registration.

Each command also requires its existing `key` and `expectedRevision`, current
write and approval permissions, same-origin JSON, CSRF and, for the Dashboard
composition, the current access revision. A matching durable command receipt
returns the saved result without another PHP invocation. A conflicting command
under the same key is rejected. Each preparation has one immutable configuration;
each configuration has one registration. Revised facts require a fresh reviewed
quote and preparation, preserving the original evidence.

Both commands require `scope.mode === 'test'`, a `test_only` catalogue and the
explicit server dependency `testPaymentDrafts`. Omission disables them. This
dependency supplies only a synthetic fixture lead resolver and a bounded,
abortable contract validator. There is no default PHP subprocess, network
transport, environment activation flag or registration in the product servers.
The actual PHP process adapter belongs exclusively to the test harness. The
existing payment card exposes a conditions form only when the server advertises
this test capability. It starts unconfigured, offers an explicit copy of the
quoted conditions, and requires separate calendar/expiration choices. A saved
configuration becomes a read-only review with a separate confirmation checkbox
and draft-registration button.

## Evidence and restart behavior

The first configuration promotes the aggregate to schema 4 and adds
`paymentConfigurationsV2` and `paymentDraftRegistrationsV2`. Schemas 1/2/3 retain
their exact shapes and validation. All prior and new ledgers are append-only;
the store rejects downgrades and changes to historical prefixes. Existing size,
revision and ledger limits still apply. Older application readers reject schema
4, which must be considered before rolling back an application that has written
these documents.

Each configuration or registration append commits with its audit and idempotency
receipt in the same authorized PostgreSQL transaction. The two commands remain
separate review steps. The server rechecks its actor, catalogue,
fixture binding and future calendar constraints after asynchronous validation.
A timeout, invalid echo or expired authority rolls the operation back. No draft
row, audit or command receipt survives a rejected transaction.

Stored evidence is verified deterministically against the source and audit
sequence at its recorded time. Reads after restart do not call PHP, recreate an
issued wire object or treat an expired historical date as corruption. Later
quote/brief/catalogue changes make a previous draft obsolete for further work;
they do not rewrite its history. The existing payment card displays the current
synthetic draft state and its conditions without another panel.

The PHP receipt always has `authorizationVerified:false`, `executable:false`,
`providerEnabled:false` and `publicPaymentUrl:null`. Its validation proves
structural agreement with the internal plan; it does not authenticate a real
Payments service request or authorize collection. The registration retains these
same disabled flags.

## Sources of explicit facts

| Fact | Source in this test flow | Source required for real use |
| --- | --- | --- |
| Actor, scope, event and rights | Existing durable session and event ACL | Authorized operational session and event assignment |
| Quote version, artifact, recipient, total, quoted deposit and conditions | Exact approved immutable quote | Same approved source, with recipient/service confirmed |
| Collection mode | Explicit immutable v2 preparation | Explicit commercial decision and its separate approval |
| Canonical lead | Server-owned fixture mapped to exact scope/event | Authorized CRM/source relationship; never inferred from email |
| New conditions and change reason | Explicit synthetic command facts | Authorized conditions and reason for any change from the quote |
| Event/balance date, hour and IANA timezone | Explicit structured fixture facts | Confirmed event and agreed collection schedule |
| Link expiration or explicit `never` | Explicit synthetic choice | Authorized expiration decision; never catalogue validity |
| Customer agreement and dispatch authority | Absent | Separate consent and operational authorization evidence |

No business choice is needed to exercise this synthetic flow. In particular, a
free-text brief is not a source for calendar/timezone facts and a quoted
percentage equal to USD 49 does not authorize the fixed exception.

## Remaining path to a real payment link

1. Supply the authorized real lead relationship, confirmed structured schedule,
   conditions, expiration, customer agreement and dispatch authority from the
   sources above. Synthetic evidence cannot be promoted into that authority.
2. Implement and review an operational v2 receiver command with durable
   authentication, current quote/configuration binding, replay and concurrency
   checks, and persistence appropriate to all three modes. The original v1
   creation method enforces its fixed policy and cannot safely receive the v2
   plans unchanged.
3. Deliberately configure and authorize provider/link creation, service
   credentials and delivery, then validate that integration in its approved
   environment. None is enabled by this draft workflow.

The test flow closes configuration, separate internal review, PHP structural
validation and durable recording in one existing route. Payment execution,
remote migration, credentials, merge and deployment remain outside this change.

## Verification of this continuation

On 2026-10-15, `npm run test:office` passed 1194 cases; the isolated contract
runner retained 114 original/v1 and 100 v2 passing cases in separate guarded
processes. The 99 operations cases, application/contract types and both builds
also passed. No dependencies or workflow permissions changed.

`GOURMET_CONTRACT_PHP_BIN=/tmp/gourmet-php/bin/php npm run test:event-quotes:e2e`
exercised the actual conditions form and separate confirmation in Chromium,
through durable HTTP authorization, PostgreSQL and isolated PHP. It saved three
drafts with six actual PHP validation starts, including altered-echo, timeout
and in-flight-expiry rejection cases. Restart/replay skipped PHP; a final browser
reload preserved the complete conditions, calendars, timezones, expiration and
reasons for all three saved drafts. Two identical request flows initiated in
parallel validated once; that check does not assert forced SQL contention.

The harness writes `test-results/gourmet-payments-contract/http-durable-v2.json`
only after the complete proof passes, and records review/registered screenshots
at 1280×900 and 360×780 under `test-results/dashboard-visual`. Local validation
uses Node 24.19.0 and isolated PHP 8.4.26. Exact published-SHA CI evidence is
reported in draft PR 3; results from an earlier SHA do not validate this change.
