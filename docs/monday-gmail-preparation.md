# Monday/Gmail preparation — private and inactive

## Current local status (2026-10-13)

The private read adapters, encrypted CAS store and communications workflow are implemented and tested with synthetic data. The former `not_implemented` communications scaffold is gone. An explicit local-only fixture now composes the real workflow into HTTP and a separate review page. Ordinary development and staging entrypoints do not enable those endpoints. This work does not activate OAuth/scopes, import customer records, create Gmail drafts, send messages, schedule follow-ups, publish code or deploy anything.

The existing DEMO office remains separate. This external ledger never turns a DEMO approval into an operational permission.

## Identity and explicit associations

Monday Lead Management has a separate fixed-board, single-item read adapter. Names are display information; typed email/contact fields retain provenance. Both Monday and Gmail adapters default to disabled and use injected fetch for synthetic tests. Gmail identity must match the trusted grant's independently selected account before reading a selected thread. Felipe and Info retain distinct mailbox/account identities.

Exact normalized email produces review candidates, never automatic links. Normalization trims/lowercases while preserving dots and plus tags and rejecting malformed addresses. Phone-based correlation is not implemented in this workflow. An association pins the exact lead, event reference, verified account and account-scoped thread snapshots. Multiple candidates require explicit acknowledgement and evidence. Event references come from a trusted caller; names, dates in message bodies and similar labels do not establish event identity. An item ID duplicated across different boards cannot bind an unqualified event reference.

Provider identities use canonical tuples, so delimiters in account or thread IDs cannot collapse two sources. Current candidate sets and their relevant append-only evidence history are included in association digests. Newly discovered relevant correspondence invalidates old review; making that correspondence irrelevant later never resurrects the old approval. Candidate construction is indexed and fails closed above 1000 candidates before committing new state.

## Source coverage and exact review

A complete selected Gmail thread is not proof of complete correspondence across mailboxes and channels. The Gmail adapter marks selected-thread coverage accordingly. Incoming Voice notifications are partial inbound evidence with unknown outgoing coverage. Follow-up drafts require complete correspondence and remain blocked by relevant historical partial Voice evidence; an updated notification cannot erase that uncertainty. There is no live Voice integration or follow-up scheduler.

Drafts pin their association, evidence/coverage context and server-selected policy version. Exact To/CC/BCC recipients, subject, plain text, optional HTML and attachment metadata/content hashes are covered by the draft digest. Recipients must be in the reviewed correspondence, with the bound lead in To. HTML is stored for exact review only and is not rendered or transmitted by this module. Unknown attachment hashes block approval. Any source, review, policy or draft change makes the prior approval stale, including content that later returns to an older value.

Approval records `approved_unsent` only. The outbox is a deterministic internal view of those durable approvals: one entry per exact approved draft, disabled dispatch and explicit stale state. Repeating an identical approval cannot create a second outbox entry, and conflicting reuse of an approval ID is rejected. Mutations retain logical revision checks and physical CAS; callers refresh state after revision conflicts. There is no sender, provider draft API, delivery status, retry worker or inferred sending authority.

## Persistence and trust boundary

The ledger is isolated by organization, actor, external partition and fixture/live mode. It uses authenticated encryption and immutable-prefix CAS over the existing private-record store, without new migrations. Semantic replay validates every snapshot, association, draft and approval before returning state or appending. Corrupt or cross-scope history is rejected without fallback. Structured validation rejects accessors, executable serializers, sparse arrays, cycles, unexpected fields and oversized inputs without exposing raw private errors.

Constructor scope, clock, policy and observation provenance are trusted server injection points. This service does not authenticate a caller or prove that a claimed complete-correspondence observation came from an authorized reader. Production composition must supply that authority and independently verified source coverage; a browser must never choose them.

## Local review UI and HTTP fixture

With the project's isolated candidate PostgreSQL running on loopback port 55433:

```sh
npm run office:communications:fixture
# In another terminal:
npm run office:dev
# Open http://127.0.0.1:4175/office/communications
```

This separate route does not modify the approved central office scene. It presents source snapshots, distinct mailbox/account identities, explicit candidate linking, exact saved draft review and internal approval history/outbox. It uses the same workflow and encrypted PostgreSQL ledger as the backend tests, not predetermined response mocks. All source data and .test contacts are synthetic and server-owned. The page displays HTML as escaped source text only; it does not execute HTML, load its assets or upload attachments.

The HTTP fixture requires explicit dependencies, a raw loopback socket peer, an allowed Host and matching exact Origin. No CORS grants are emitted. Each session has a new server-chosen fixture scope, opaque HttpOnly SameSite=Strict cookie and separate CSRF token. Session setup accepts only an empty JSON object. Mutations accept only workflow command fields; no endpoint accepts observations, identity, coverage, provider credentials, approval authority or send actions. Staging composition explicitly refuses these fixture dependencies.

Sessions last 15 minutes and do not prove staff identity. Refresh retains an active session. Logout, expiry or API restart removes access; a new session starts a fresh scope. PostgreSQL records remain stored, but this fixture has no browser recovery route for an expired session. The launcher generates an ephemeral encryption key in memory; after process restart its previous fixture records cannot be decrypted by a new launcher. Never enter real customer data or secrets. Mutations are authorized at admission: a request accepted before expiry/logout may commit afterward and returns its committed result; expiry/logout does not undo an admitted operation. New requests require a valid session and CSRF token. The UI must treat interrupted writes as uncertain and refresh without automatic write retries.

`npm run test:communications:e2e` runs the dedicated browser scenarios against this real local fixture and the regular Vite app. It requires candidate PostgreSQL and usable Chromium; it never starts a production/staging server or contacts providers.

## Verification

Fresh local execution on exact base `1ab56fff5372851b566c2009e8597410b8c4cbdc`:

- 613 Office tests passed, using isolated real PostgreSQL 16.14. This includes the original eight workflow tests, sixteen regression tests, three full-workflow PostgreSQL tests, thirteen HTTP boundary tests, two HTTP/PostgreSQL integration tests and twelve client/static-render tests.
- 89 operations tests passed.
- TypeScript and both application builds passed.
- A real TCP smoke test passed through Vite, its proxy, the guarded fixture API and PostgreSQL: source review, draft, exact approval and reload.
- Independent review found no remaining blocker for the private workflow and explicit local approved-unsent-only fixture.
- Sixteen new Playwright cases (eight scenarios at desktop and mobile sizes) were discovered successfully but not executed. Chromium failed before opening a page with `socket() failed: Operation not permitted`. Browser lifecycle and visual checks remain unverified.
- Four Docker Compose tests and a runtime image build were not run because Docker is absent. Existing browser suites were not run. This is not a full CI or deployment approval.

Activation remains separate work: authenticated external service composition and durable user-session recovery, controlled read/import review, actual source and coverage verification, browser/CI checks and fresh deployment checks. New or expanded account access and every external message retain their required approvals. No production readiness or real commercial outcome is established by these synthetic tests.
