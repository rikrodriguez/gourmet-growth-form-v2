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
- Reporting timezone: `America/Los_Angeles`
- QA rows: excluded by default and opt-in in the UI
- Session status: dynamically derived from durable activity using `ABANDONMENT_GRACE_MINUTES`

The dashboard never reads legacy flat files, Monday, or the legacy PHP dashboards. Business endpoints are read-only. Phone ciphertext, IVs, authentication tags, and key identifiers are not returned by dashboard APIs; lists show only whether a phone was captured.

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
