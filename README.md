# Gourmet Growth Form V2

Independent CRO / Growth Form V2 for Gourmet Corporation.

## Staging target

- Public URL: `https://gourmet-corporation.com/form2/`
- Source branch: `develop`
- Generated deployment branch: `hostinger-staging`
- Hostinger deployment path: `public_html/form2`

The existing production funnel is legacy control and must not be modified by this project.

## Growth Dashboard V2

- Authenticated URL: `https://dashboard.gourmet-corporation.com`
- Data source: PostgreSQL schema `growth_v2` only
- Service: isolated Fastify + React container behind Traefik
- Deployment overlay: `deploy/dashboard.compose.yaml`
- Reporting timezone: `America/Los_Angeles`
- QA rows: excluded by default and opt-in in the UI
- Session status: dynamically derived from durable activity using `ABANDONMENT_GRACE_MINUTES`

The dashboard never reads legacy flat files, Monday, or the legacy PHP dashboards. Business endpoints are read-only. Phone ciphertext, IVs, authentication tags, and key identifiers are not returned by dashboard APIs; lists show only whether a phone was captured.

## Monday CRM delivery (M2A)

PostgreSQL remains authoritative. Phone capture writes the lead and one coalescing `growth_v2.crm_outbox` row in the same transaction. The internal `crm-worker` container validates the live board schema before processing, decrypts phone data only in memory, and sends it to Monday with a persisted `Idempotency-Key`. Progressive committed answers update the same `monday_item_id`.

Required worker-only environment:

```text
MONDAY_API_TOKEN=<server secret>
MONDAY_BOARD_ID=18403945258
MONDAY_GROUP_ID=group_mm1etwgc
CRM_WORKER_BATCH_SIZE=10
CRM_WORKER_CONCURRENCY=2
CRM_WORKER_POLL_MS=10000
CRM_WORKER_MAX_ATTEMPTS=8
CRM_WORKER_LEASE_MS=120000
CRM_AMBIGUOUS_CREATE_WINDOW_MS=1500000
```

The worker has no public route. Authenticated staff can inspect safe queue/heartbeat counts at `/v1/admin/crm/health`. Flexible date windows remain in PostgreSQL; only an exact date is mapped to Monday's `Event Date` column. Geo remains empty until a trusted source matching the board's legacy meaning is available.

If a create response is ambiguous, the worker reuses the persisted idempotency key only inside a 25-minute safety window (shorter than Monday's documented 30-minute cache). After that it dead-letters the job instead of risking a duplicate.

### Required dashboard environment

```text
NODE_ENV=production
DATABASE_URL=postgres://<runtime-role>@<postgres>/gourmet_growth_v2_staging
DASHBOARD_ORIGIN=https://dashboard.gourmet-corporation.com
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=3002
ABANDONMENT_GRACE_MINUTES=10
STAFF_SESSION_TTL_HOURS=12
TRUST_PROXY=true
GIT_SHA=<exact-deployed-sha>
```

`ABANDONMENT_GRACE_MINUTES` is mandatory in production. The runtime role receives only the staff-table permissions required for login and session rotation; migrations and staff provisioning use the separate migration/admin database role.

### First staff user

Provision from a trusted server TTY. The password is read with hidden input and must never be supplied as a command-line argument, committed, or pasted into chat:

```bash
STAFF_ADMIN_DATABASE_URL='postgres://<migration-role>@<postgres>/gourmet_growth_v2_staging' \
  npm run staff:create -- --email staff@example.com --role admin
```

### Dashboard verification

```bash
npm run typecheck
npm run test:unit
npm run test:db
npm run dashboard:build
npm run test:dashboard:e2e
docker build -f Dockerfile.dashboard .
```

The first-party dashboard does not replace the known backup policy: weekly provider backup plus daily logical backup retained for 14 days on the same VPS. An off-VPS database backup remains required before production readiness.

On the VPS, combine the existing PostgreSQL/API manifest with the tracked dashboard overlay:

```bash
docker compose -f compose.yaml -f dashboard.compose.yaml up -d dashboard
docker compose -f compose.yaml -f dashboard.compose.yaml --profile staff-admin run --rm staff-admin \
  --email staff@example.com --role admin
```
