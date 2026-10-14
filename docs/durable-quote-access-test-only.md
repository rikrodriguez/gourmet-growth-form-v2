# Durable quote access: isolated test-only composition

Adds an opt-in composition around existing-session proof, persisted membership/version checks, per-event grants and quote operations using one PostgreSQL transaction. It does not start a server, install an authentication adapter or provision accounts, sessions, permissions, catalogs or credentials. The prepared migration is not registered with existing startup paths and permits only `test` mode.

The session adapter must be server-owned. Do not resolve an actor, tenant or permission from a request body or untrusted identity header. The database stores hashes rather than raw proof tokens. Quote data remains sealed through the existing vault. Authority rows remain share-locked until the quote transaction commits. Revocation serializes after a transaction that already holds the lock; subsequent requests are rejected. Expiry during the operation causes rollback. This does not promise cancellation of a transaction that already acquired valid authority.

Creation requires an existing, explicitly assigned event and grant. This slice does not allocate event IDs or create assignments. Status reports role-level capability only; every event operation additionally requires the event grant. FINANCE is not allowed to access this quote module. These are test policies, not configured permissions for real Gourmet staff.

Verification on 2026-10-14:
- 15 new real PostgreSQL tests: proof/CSRF, session and membership versions, disabled user, role, assignment, read-only grants, expiration/rollback, tenant isolation, observed concurrent revocation lock and HTTP create/recreate API/read/revoke.
- 873 Office tests passed locally with PostgreSQL 18.4; four Docker Compose tests could not run because Docker is absent.
- TypeScript, separate new-test typecheck and both builds passed. Existing 99 operations tests passed before this composition; no operations code changed.
- Synthetic rows only. The HTTP test uses Fastify injection, not a browser, real user session or public server. Existing CI uses its configured PostgreSQL version and must validate the exact published commit.

Pending: independent review, full CI including Docker and browser regression, a real approved identity adapter and authorized commercial catalog, operational migration review, and explicit deployment. No changes to Monday, payments, messages, provider credentials, security settings or live data. Existing runtime and Dashboard default behavior are unchanged.
