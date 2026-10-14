# Payments v2 visual review

The saved quote flow is reviewed at desktop 1280 × 900 and mobile 360 × 780,
using only the existing loopback React–HTTP–PostgreSQL test composition and
synthetic identities, quantities, catalogue and conditions. The screenshots are
real Chromium captures, with full-page and native element captures kept
separately; images are not reconstructed or edited.

Manual review date: 2026-10-14 UTC. Local browser: Chromium 154.0.8037.57 on
Debian 13. The correction starts from commit `8518aba`; the PR pins the published
corrective SHA and its own CI evidence.

The first manual pass found one defect: on the USD 108.07 quote, the mobile
review table split the last digit of subtotal USD 101.00 and total USD 108.07
onto another line. The saved quote amount table now sizes columns to their
contents and keeps monetary cells on one line. Long tables scroll within their
existing wrapper rather than expanding the page. The DEMO table keeps its
existing layout. The browser check measures actual text rectangles to reject
wrapped or overflowing monetary cells at both sizes.

## States and commercial facts

| Synthetic state | Source quote retained | Proposed payment draft | Required visible state |
| --- | --- | --- | --- |
| No selected mode | USD 25.94; quoted 50% deposit USD 12.97 | None | Empty selector, preparation disabled |
| 50/50, quote v1 | USD 25.94; deposit USD 12.97; remainder USD 12.97 | USD 12.97 initially + USD 12.97 later | Pending configuration/approval; seven calendar days is a date proposal only |
| 100%, quote v2 | USD 27.02; deposit USD 13.51; remainder USD 13.51 | One USD 27.02 payment, no future balance | Difference warning; no balance-calendar blocker |
| USD 49 exception, quote v3 | USD 108.07; deposit USD 54.04; remainder USD 54.03 | USD 49.00 initially + USD 59.07 later | Difference warning; agreed future balance date required |

All saved drafts explicitly show provider/receiver, lead, expiration and new
conditions/approval blockers. They contain no payment anchors or public URL.
Original quoted conditions and percentage deposits remain visible. A quote's
internal approval does not authorize its payment contract. Saving a new quote
marks previous drafts as obsolete history and resets the mode selector and
approval; it does not rewrite them. The USD 49 exception is never selected
automatically. These fixtures are arithmetic evidence, not Gourmet prices or
commercial authorization.

Manual inspection covers labels, status badges, warnings, table values,
conditions, enabled/disabled controls, long identifiers, layout and wrapping.
Desktop keeps the existing columns and sidebar; mobile uses the existing stacked
cards and menu. This is a review of two Chromium viewport sizes, not a claim of
all-browser, all-device or assistive-technology coverage. Persistence, restart,
duplicate click, expiry and revocation are checked by the same browser flow.

## Captures and reproduction

Run the isolated local database and `npm run test:event-quotes:e2e` with Chromium
available. Do not run the recovered legacy PHP database E2E.

The existing four saved-flow images remain. Additional files under
`test-results/dashboard-visual/` are:

- `payments-v2-selector-empty-{desktop,mobile}.png` and corresponding `-detail` files.
- `payments-v2-{50,100,49}-{desktop,mobile}.png` and corresponding `-detail` files.
- `quote-v{1,2,3}-{desktop,mobile}-detail.png` for the exact source quote review.

Full-page captures include brief, catalogue, exact review and draft history.
Payment detail captures keep every blocker readable at native scale; quote
detail captures preserve the source amounts and conditions beside that evidence.
The existing CI artifact step retains these files without workflow permission,
retention or secret changes. The PR records the exact tested SHA, terminal run
and artifact. Local manually reviewed reproductions and CI-retained images are
identified separately; no claim is made that their PNG bytes are identical.

## Minimum next implementation, still non-executing

1. Recover and inspect the relevant complete canonical PHP source and repository
   instructions first: the transferred references contain only partial PHP
   source. Extend the canonical `Gourmet Corporation/gourmet-payments` application with
   an explicit versioned v2 request/domain boundary for the three modes, source
   quote and new terms, exact integer amounts, approved schedule/expiration and
   review identity. Preserve v1 parsing, money rules and stored agreements. Reject
   v2 at v1 rather than relying on ignored extra fields. First add isolated TS ↔
   actual PHP v2 round trips and incompatibility checks, without calling a payment
   provider or running the legacy database E2E. The current v2 TS-only round trips
   do not establish PHP v2 interoperability.
2. Persist and review explicit configuration through the existing quote panel
   and authenticated server composition. Resolve source quote, catalogue,
   canonical lead and actor on the server; store the reviewed exact plan and
   authorization atomically with idempotency and stale-review checks. The pure
   v2 review helper exists, but no editor, approval API, completed-plan storage
   or operational caller is registered. Keep provider/receiver execution blocked.

Commercial facts still required per selected quote are the authorized canonical
lead relationship, chosen mode, exact new conditions, change-review reason when
the mode or conditions differ from the quote, authorized contract approval, and explicit link expiration
(date/hour/IANA timezone or approved `never`). For 50/50, supply verified event
date/hour/IANA timezone and a separate balance hour; review the seven-calendar-day
proposal and explicitly resolve near/past dates with a future alternative and
timing reason. The exception needs its exact agreed balance and future due date,
hour and timezone. Full upfront has no future balance fields. Neither a free-text
event date nor catalogue validity supplies these facts. The three mode definitions
are already decided; missing per-quote facts are not a request to change policy.
