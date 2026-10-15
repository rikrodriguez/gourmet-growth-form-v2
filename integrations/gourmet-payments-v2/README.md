# Additive Gourmet Payments v2 contract receiver

This directory contains an isolated PHP contract validator intended as an
additive `src/Http/InternalPaymentPlanV2.php` file in the canonical Dropbox
`Gourmet Corporation/gourmet-payments` application. It is not a replacement
Payments application, registered route or agreement-creation service. It is not
copied into the current Dashboard runtime. No original v1 file is modified.

The receiver accepts the exact canonical JSON produced by
`prepareGourmetPaymentsV2Wire`, which calls the existing separately reviewed
internal-plan helper. It validates and echoes that complete preparation:
original quote percentage, cents, recipient, conditions and source pins remain
separate from the new mode, amounts, conditions, reasons, schedule and expiration.
It rejects incompatible modes, unknown/missing fields, ambiguous serialization,
lossy integer amounts, invalid fingerprints and incompatible calendar facts.

A successful result is only:

```text
status: contract_validated_internal
prepared: the complete unchanged internal preparation
executable: false
providerEnabled: false
publicPaymentUrl: null
authorizationVerified: false
```

The preparation retains its provider/operational-receiver blockers. No agreement
ID, payment token, public URL, outbox intent or financial event is created.
The TS receipt decoder compares every returned fact with its own immutable
server-prepared snapshot. It does not accept an independently supplied snapshot
as evidence that the local review helper issued it.

## Original source reuse and compatibility

The canonical PHP request parser, Application, agreement service and Money policy
were inspected from Dropbox with revision, byte count, SHA-256 and Dropbox content
hash recorded in `tests/payments-contract/v2-originals/SOURCES.json`. Nineteen
pertinent original files were recovered separately in the workspace; they are
not presented as a complete application checkout. Only the original 985-byte
`Money.php` is copied into the isolated test references and executed here.

The fixed-reservation branch calls the original `Money::agreement`; retainer and
full payment use their explicit v2 invariants. The v1 fixed-reservation rule is
not generalized or applied to a percentage quote. Existing v1 and its 17 historical
transfer references remain byte-for-byte unchanged. Canonical Dropbox copies of
five common files differ from the older transfer by two terminal line feeds;
their distinct hashes and provenance are retained rather than silently replaced.

Original future-local-date validation resides in private Application methods.
The v2 validator uses native PHP date/time primitives with equivalent exact
local-date checks plus explicit unique-instant/DST checks and the v2 calendar
rules. It does not reflect private methods in production, construct Application
or call `PaymentAgreementService::create`. The caller supplies the trusted clock
as a method argument, never from the JSON body.

The CLI harness loads only the verified original Money class and the new v2
validator. Tests run with a minimal environment, PHP URL/network/process
functions disabled and the existing instrumented Node network guard. They do
not connect to a database, initialize a provider, start the PHP application or
run the legacy database E2E. The 114 original checks and additional v2 checks
retain separate subprocesses, logs and counts under `npm run test:payments-contract`.

The current isolated suite passes 114 original/v1 checks and 100 additional v2
checks. NUL in a timezone first reproduced a native `ValueError` in all five
expiration/schedule entry points. The validator now rejects ASCII controls before
the native constructor and converts its value errors to a contract rejection;
30 control-character cases verify that behavior. Apia's omitted 2011-12-30 is
tested with an earlier trusted clock, while both adjacent dates must validate
and retain their exact instants, isolating the missing day from past-date checks.

## Operational work still required

This validator proves structural interoperability, not trust in a sender. A
self-consistent review fingerprint cannot authenticate its actor, authorize a
lead relationship or prove a source quote/catalogue is current. The payload lacks
the actor's current rights, durable identity, expiry and revocation state.
`internalApproval` is declared review evidence; it is not customer consent.
Tests include self-consistent altered source pins that remain structurally valid
but fail comparison with the expected server snapshot.

Before an operational endpoint can use this contract, the existing server must
resolve and recheck authenticated actor, scope, lead, source quote, catalogue,
configuration and exact approval; persist the reviewed plan with idempotency,
revocation and stale-review checks; and register a separately versioned receiver
with appropriate authenticated replay protection. The subsequent
[synthetic draft workflow](../../docs/payment-draft-v2.md) exercises the existing
durable authorization and encrypted aggregate with an explicit fixture lead
resolver and an isolated PHP callback. It records the receipt as a disabled
internal draft; it is not a commercial composition or endpoint registration.
The existing card's condition form and review apply only to that test capability.
Keep the original creation service and payment
transport unreachable. Never pass the new envelope to the original v1 endpoint.

Commercial mode definitions are already specified. Individual quotes still need
authorized lead linkage, explicit conditions/change reason and new approval,
explicit expiration and their applicable event/balance calendar facts. Missing
facts remain blocked; the validator supplies no defaults for them.
