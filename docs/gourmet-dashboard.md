# Gourmet Dashboard: commercial overview, separate from Office

This slice adds `/office/dashboard` beside the existing `/office/` scene and
`/office/communications` exact-review screen. The Office header's Dashboard
shortcut is a route link. Its previous internal dashboard tab is now called
**Operaciones**, with the same tab IDs, order and keyboard behavior. The approved
Office scene, images and original stylesheet are unchanged.

## Reference and implemented layout

Reference supplied by the owner: screenshots IMG_3959–IMG_3969 and
https://www.instagram.com/reel/Dd-XLmMzU4_/ . The reference demonstrates a CRM UX;
it does not establish a provider, architecture or real integration capability.

The layout follows the reference's grouped narrow sidebar, three KPI cards,
advertising strip, wide revenue area, review/activity sections, equal-width
opportunity columns, and channel-filtered inbox with list and response context.
The content and branding are adapted to Gourmet. The revenue area is an explicit
unknown state instead of an invented graph. There are no active-looking agent
switches, send buttons or fabricated automation results.

Pixel-level similarity and browser layout have **not** been verified locally.
Desktop/mobile browser cases are prepared; a successful build or SSR test does
not substitute for those checks.

## What the dashboard knows

- Its sole commercial data source is an in-memory fixture. `read(signal)` returns
  a fresh copy and has no network, credentials, session or write capability.
- Four invented opportunities and four invented conversations illustrate the
  layout. The cut is fixed at 2026-10-13 00:00 UTC. Reloading does not advance it.
- The fixture is explicitly partial. Its count is **records in the sample**, not
  all customers or new leads this month. Stage ages use the sample cut.
- Amounts and currencies are missing. Pipeline value remains unknown; missing
  amounts are not zero and mixed currencies are never added.
- Revenue, conversion and advertising remain unknown. Confirmed-stage examples
  are not evidence of payment or conversion. No estimated trend is drawn.
- Monday, Gmail, web form, Instagram, Messenger, payments, ads and catalog are
  **unconfigured in this dashboard**. Their current real-world connection state
  has not been read. No connector login, renewal or provider request occurs.
- Matching contact names do not merge accounts. Aurora's Info/Felipe messages
  remain separate. One deliberately unassociated example illustrates uncertainty.
- The sample inbox and the communications fixture are separate datasets. Opening
  Communications does not automatically associate an example with a draft.

## Existing exact-review workflow, reused without new authority

The review queue is unknown until the user explicitly requests a read. The
adapter accepts only a `read` dependency, issuing GET
`/office-api/communications` through the existing same-origin client. It does not
start a fixture session, save a draft, approve or dispatch. Cookies remain
HttpOnly and session scoped; CSRF protection on the existing mutation routes is
unchanged. GET cannot create review state and needs an existing allowed fixture
session. The regular server still has no communications routes by default.

The projection validates the response, fixture organization and actor, current
session expiry, the precise account/thread relationship, latest draft revision,
full draft digest and source/context digest. It checks cancellation and expiry
again after asynchronous verification. Current approvals are shown only as
**approved in the sample, unsent**. Inconsistent or unavailable data is blocked
or unknown, never treated as an empty or ready queue.

Links go to the existing `/office/communications` screen without identifiers,
auth tokens or approval state. The user must select the saved draft there and
complete the existing fresh verification and exact human approval. No approval
or sending action exists on the dashboard.

## Interaction, privacy and accessibility

- Source text is rendered as escaped React text, not HTML or external media.
- Selecting a conversation does not mark a message read on any service.
- No drag-to-change stage, payment link, scheduler or automated response exists.
- No browser storage, provider SDK or browser-owned identity is introduced.
- Failed reads withdraw the old queue. Abort/generation checks prevent late
  responses from restoring it. Hiding/leaving the page or a 15-minute display
  lifetime withdraws the view; reloading the sample and queue is explicit.
- The queue expires no later than its server session. A session cannot be
  extended from the dashboard.
- Mobile layouts use readable content and 44px control targets. Semantic
  headings, sections, links, selected states and a skip link support keyboard
  use; in-content navigation restores focus to the new heading.

## Run and verify

`npm run office:dev` serves the dashboard fixture without an API. To exercise the
optional review queue, use the existing explicitly local communications fixture
server and isolated PostgreSQL as described in `monday-gmail-preparation.md`.
Never enter real customer data or credentials in the fixture.

- `npm run typecheck`
- `npm run build` and `npm run office:build`
- `npm run test:office` (includes PostgreSQL and four Docker Compose checks)
- `npm run test:operations`
- `npm run test:dashboard:e2e` (20 desktop/mobile executions)
- Existing Office, staging and communications browser suites remain regression
  gates, including the renamed Operaciones tab.

The local constrained environment can run native isolated PostgreSQL, but Docker
is unavailable and Chromium exits before a page opens because `socket()` is not
permitted. The dot cloud browser cannot reach this workspace's localhost; its
URL policy also rejects `data:` navigation. These limits were respected. No
browser rendering, screenshot, Docker image build or new CI run is claimed for
this dashboard revision. The previously green communications PR verifies its
own commit, not this new dashboard code.

## Next operational slice (not activated)

Real metrics require an approved read-only source mapping, account/tenant scope,
field/currency definitions, complete pagination, date/cohort definitions and a
freshness/error policy. Catalog-backed proposals additionally require verified
menus/prices, provenance and availability rules. Existing exact approvals remain
required before every eventual send. No real account integration is configured
by this UI slice.
