# Synthetic office API

This API reuses local draft, pilot and payment arithmetic modules with synthetic
fixtures. It has no LLM, staff account system, real client data, provider connector,
message sender or payment executor. A DEMO approval records a decision while
external execution remains blocked.

## Local development

```sh
npm run office:db -- start
npm run office:api
# In another terminal:
npm run office:dev
```

`npm run office:up` starts all three in sequence. The API binds only
`127.0.0.1:4180`; Vite serves `127.0.0.1:4175` and proxies `/office-api`.
PostgreSQL 16 is isolated at loopback port 55433 with user `office_candidate`,
database `gourmet_office_candidate_dev` and state
`gourmet-office-candidate-development`. The development script operates only
its labelled candidate container and `.office-dev` data directory. Stop/restart
preserves data and the script provides no remove/reset command.

Development PostgreSQL uses local trust authentication. `OFFICE_DATABASE_URL`,
if supplied, must match the allowed loopback host, port, user and database without
a password or URL options. Remote or production connections are rejected.
Startup verifies migration checksums and seeds fixtures only when the named
state is absent. Add a new numbered migration instead of changing an applied one.

## Sessions and authentication

A local development session is a selected DEMO scope, not authenticated staff
identity. Requests require an allowed Host and loopback peer. Mutations require
the exact allowed local Origin and JSON content. No CORS access is granted.

`POST /office-api/session` with JSON `{}` starts a four-hour DEMO session.
Optional `role` (`operator|viewer`), `caseIds` and `functionIds` can narrow the
scope. Arrays must contain unique recognized values and be nonempty; unknown
fields fail. Example metadata:

```json
{
  "mode": "demo",
  "actorId": "OFFICE_DEMO_OPERATOR",
  "role": "viewer",
  "caseIds": ["demo-aurora", "demo-cedar", "demo-harbor"],
  "functionIds": ["sales", "proposals", "coordination", "logistics", "suppliers", "finance", "quality", "marketing", "talent"],
  "expiresAt": "2099-01-01T04:00:00.000Z",
  "storage": {"kind": "postgres", "durable": true},
  "outboundEffects": 0
}
```

The random 256-bit cookie is HttpOnly, SameSite=Strict and scoped to
`/office-api`; only hashes are kept in memory, never logged. Staging also marks
the cookie Secure. `GET /office-api/session` returns metadata or 401; `DELETE`
revokes the cookie and returns 204. API restart invalidates sessions while
PostgreSQL domain data, history and idempotency records persist.

Private staging uses a separate entrypoint and runtime configuration. The server
authenticates a shared staging credential before serving UI, assets or API, and
caps every session to the configured role (`viewer` by default). Selecting
`operator` in the UI cannot prove identity or exceed that cap. Exact HTTPS Host,
origin, proxy peer and forwarded protocol checks remain required. See
[staging configuration](../../../docs/staging.md).

## Commands and storage

`GET /office-api/health` reads PostgreSQL and returns
`{status:'ok',mode:'demo',storage:'postgres',outboundEffects:0}`. Staging health
also requires authentication. Storage failure returns 503 with no memory or
browser fallback.

`GET /office-api/snapshot` returns the current contract filtered by session
case/function grants. Each collection is bounded to its 1000 most recent records;
pending approvals are prioritized. `hasMore` and a coverage note disclose
truncation, while storage retains all records. Full historical reporting and
pagination are not implemented. The dashboard aggregates current records;
the Historial view reads persisted synthetic events for the selected case.

`POST /office-api/commands` (alias `/office-api/command`) accepts an
`OfficeCommand` and returns `{snapshot,replayed}`. `draft|chat` prepares a local
synthetic artifact or scripted response. `approve|reject|cancel|revise` requires
`approvalId`, exact `revision` and `digest`; revision additionally requires text.
The digest binds account, channel, recipient, content, attachments, revision and
domain review. Revisions invalidate prior approvals. Preparing suppliers before
the synthetic human sale closes returns 403.

Operator role, case and function grants are checked before execution and replay.
Reusing an idempotency key with different content returns 409. A replay returns
the current authoritative state and never restores an earlier approval.

Each command locks one synthetic aggregate with `SELECT ... FOR UPDATE` in a
four-client pool. State, jobs, approvals, revisions, commands and history commit
together; errors roll back the transaction. Command metadata and full history
also live in SQL tables. Application checks and database triggers reject prior
event deletion/alteration. These consistency controls do not resist a database
administrator. The aggregate intentionally serializes a small demonstration;
it is not a production scaling design.

## Verification scope

```sh
npm run office:db -- start
npm run test:office
npm run test:office:e2e
```

Domain/HTTP tests use transaction doubles. PostgreSQL tests require the real
candidate development database and fail if it is absent. They check concurrent
idempotency, rollback, append-only enforcement, decision races and API/pool
replacement. Pool replacement is narrower evidence than restarting a database
container or restoring its volume. Staging preflight must separately verify
authenticated UI/API, real restart persistence and backup restoration.

Browser tests exercise desktop and 320-pixel mobile with the real local API;
external requests are blocked. Aurora demonstrates a synthetic verified deposit
of USD 37.45 against USD 74.90, with outstanding balance and pending supplier.
Cedar has a supplier accepted while payment is pending. Harbor has an open
synthetic sale. A verified deposit does not establish full settlement.
