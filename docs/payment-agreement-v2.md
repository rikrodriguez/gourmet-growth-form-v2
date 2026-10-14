# Internal Payments v2 preparation

The product decision received on 2026-10-14 defines three explicitly selected
collection modes. USD 49 is an occasional sales exception, never a default.
An existing quote and its internal approval remain unchanged when preparing a
new collection plan. Selecting a different mode does not approve the difference.

| Selected mode | Initial amount | Remaining amount | Balance schedule |
| --- | --- | --- | --- |
| `retainer_50` | 50%, rounded half up to integer cents | Exact total minus initial amount | Proposed local calendar date seven days before the event; separate approved hour required |
| `full_upfront` | Exact total | Zero | None; a balance schedule is rejected |
| `fixed_49_reservation` | 4900 cents | Exact total minus 4900 | Explicitly agreed balance amount, date, hour and timezone; no automatic seven-day rule |

The selector starts empty, including for existing quotes. The command requires
the discriminator. A 50% quote with a 4900-cent deposit remains a percentage
quote: arithmetic does not select the fixed exception. For odd totals, the
retainer uses the existing half-up rule and the balance is the subtraction, so
the two amounts always sum to the exact total. No equivalent percentage is
manufactured for USD 49.

The existing quote schema contains `depositBps` and the exact `depositCents`;
both are preserved, along with the exact quoted conditions and artifact. No new
fixed-amount quote schema or catalogue policy is inferred. A selected mode can
differ from that source only as a pending proposal requiring explicit review and
new approval. The source quote is never recalculated or overwritten by the mode.

## Persisted boundary

`prepare_payment_v2` uses the existing exact quote, internal approval and artifact
pins, expected revision and idempotency key, plus a required `paymentMode`.
Identity and amounts come from the server; dates, new conditions, lead IDs,
approval flags and extra fields are rejected in that command body.

Both write and approval permission are required in the service, HTTP durable
authorization target and Dashboard grant. Existing same-origin, CSRF, scope,
catalogue freshness, expiry, bounded transaction, receipt and audit checks apply.
The selection is one immutable pending preparation per quote version. A mode
change needs a newly reviewed quote version and preparation rather than rewriting
the selection or retrying a different mode under the old idempotency key.

| Aggregate schema | Contents |
| --- | --- |
| 1 | Existing briefs, quotes and decisions, without preparations |
| 2 | Existing immutable legacy `paymentPreparations` |
| 3 | Both the legacy ledger, possibly empty, and nonempty `paymentContractPreparationsV2` |

Schemas 1/2 keep their exact old validation and replay rules. Only a new v2 write
promotes the encrypted aggregate to schema 3. Both ledgers are append-only;
schema downgrade is rejected. A legacy and a v2 preparation may coexist for one
quote, with distinct identifiers, without converting either record. The original
PHP agreements and all 17 recovered references stay unchanged. Existing SQL 005
can store the new encrypted document; no SQL migration was added or applied.
Old application readers reject schema 3, so an eventual rollback must account
for documents already written by the new application.

Every new saved preparation remains `pending_configuration` with new payment
conditions, schedule, approval and canonical lead set to null. Link expiration
has an explicit unresolved blocker for all three modes, including full payment.
`quotedDepositMatchesMode` describes only the initial arithmetic and percentage;
it never approves conditions. Provider and receiver remain blocked, with
`providerEnabled:false` and `publicPaymentUrl:null`.

## Calendar proposals and exact internal review

`proposeRetainerBalanceDateV2` accepts structured event date, event hour, IANA
timezone and an explicit server clock. It subtracts seven Gregorian calendar
labels in that zone, not 168 elapsed UTC hours. The output is a proposed date,
never an approved charge time. It does not parse the free-text brief, copy the
event hour into a balance hour, choose a timezone or shift a past date forward.
Missing or invalid facts, skipped days and ambiguous/nonexistent local minutes
stay pending. `resolveApprovedLocalMinuteV2` requires a unique exact instant.

Events fewer than seven local calendar days away and past proposed balance
dates require an explicit timing-review reason and a separately provided future
balance date/hour, all included in the subsequent review digest. A balance must
remain in the future and precede the event; approving a past charge is never
allowed. A proposed date of today remains a warning until an explicitly supplied
hour resolves to a future instant. Full upfront payment rejects all future
balance fields. The USD 49 exception requires its own exact agreed balance and
future due date, without inferring an event schedule.

The separate `gourmet-payments-agreement-v2.ts` helper validates a complete
configuration and computes a fingerprint over scope, event, preparation,
original quote/approval/artifact, recipient, mode, exact amounts, original and
new terms, reasons, lead and all calendar/expiration facts. Changing any of
those facts invalidates the previous review. A mode or conditions differing
from the quote require an explicit change-review reason. Link expiration must
be explicitly configured with date/hour/timezone, or the explicit `never`
choice inherited from the original contract; it is never taken from catalogue
validity. Zero initial amounts and a zero remaining retainer stay blocked for
review without altering the source quote.

`prepareGourmetPaymentsAgreementV2` additionally requires a current server-owned
actor with write/approval rights, durable identity for commercial scope, and the
exact reviewed fingerprint. Actor data, source records, current catalogue, clock
and canonical lead must come from authorized server composition. A fingerprint
is integrity evidence, not authentication; this helper cannot establish a real
lead relationship or consent. It creates only `prepared_internal` review
evidence, with `executable:false`, null URL and provider/receiver blockers.

No configuration editor, configuration approval API, storage for completed plan
reviews or runtime caller is registered. The visible/persisted flow therefore
stays pending until those sources and approvals are deliberately configured.
The isolated helper and tests exercise that future contract without claiming
that operational composition exists. An additive, unregistered PHP v2 contract
validator now validates and echoes that exact internal plan through isolated
TS → PHP → TS checks; see [the receiver boundary](../integrations/gourmet-payments-v2/README.md).
It reuses original canonical Money only for the explicit USD 49 mode, does not
call the original agreement creation service, and always returns
`authorizationVerified:false`, disabled execution and a null URL. Its successful
self-consistency check cannot authenticate a sender or attest current source
records. Never pass v2 facts to v1: that adapter/parser can ignore added fields
and retain its fixed policy.

## Verification

The new suites cover workflow/replay and all three modes, PostgreSQL encrypted
durability/restarts/races/revocation/rollback, UI explicit selection, calendar
and DST arithmetic, complete fact-preserving JSON round trips, missing facts,
separate approval and stale-review rejection. They run in `npm run test:office`.
The existing React–HTTP–PostgreSQL browser flow now selects 50% explicitly, saves
separate 100% and exceptional USD 49 drafts for new quotes, and checks recovery
and revoked access. It captures all three modes and exact source quote reviews
at desktop/mobile sizes, and checks actual monetary text geometry. The manual
[visual review](payments-v2-visual-review.md) records the corrected mobile decimal
wrapping defect, captured states and next implementation/data boundaries.
`npm run test:payments-contract` still runs the 114 original/v1 checks against
byte-verified original TypeScript and PHP sources in isolated memory. A separate
guarded subprocess tests the additive PHP v2 contract, original Money reuse,
exact source/new fact round trips and incompatibility rejections. Its test count
and log remain distinct from those original 114 checks.

No receiver/provider registration, payment transport, credential, account, real
client, link, charge, remote migration, merge or deployment is introduced. The
legacy PHP E2E that truncates its target database is never used. CI evidence for
the exact published revision is recorded in draft PR 3, not inferred from the
successful CI of an earlier commit.
