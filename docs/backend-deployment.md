# Gourmet Growth Form V2 backend deployment contract

The API is an independent Node.js/Fastify service. It must not be deployed under `public_html` or `public_html/form2`, and it does not read or write any legacy Gourmet storage.

## Required infrastructure

1. Provision a PostgreSQL 16+ database dedicated to Growth Form V2.
2. Create separate migration and application roles. The migration role owns `growth_v2`; the application role receives only `USAGE` on the schema and `SELECT`, `INSERT`, and `UPDATE` on its tables.
3. Provision an always-on Node.js 22 service from `Dockerfile.api` with persistent HTTPS ingress.
4. Point `api.gourmet-corporation.com` to that service only after `/health` succeeds and TLS is active.
5. Configure the static frontend build with `VITE_GOURMET_API_BASE_URL=https://api.gourmet-corporation.com` only after the API and database are verified.

## Required backend environment

- `DATABASE_URL`: application-role PostgreSQL connection string.
- `LEAD_ENCRYPTION_KEY_BASE64`: exactly 32 random bytes encoded as base64, stored only in the platform secret manager.
- `LEAD_ENCRYPTION_KEY_ID`: non-secret key version such as `v1`.
- `CORS_ALLOWED_ORIGINS`: `https://gourmet-corporation.com` in staging/production.
- `NODE_ENV`: `production` on the hosted service.
- `API_HOST`: normally `0.0.0.0` in the container.
- `API_PORT`: platform-assigned port or `3001`.
- `GIT_SHA`: deployed source SHA.
- `TRUST_PROXY`: set to `true` only when the service is behind a trusted proxy that overwrites forwarded client-IP headers.
- `QA_MARKER_SECRET`: staging-only secret for marking disposable QA data.
- GitHub secret `E2E_QA_SECRET`: the same staging QA marker, injected only into Playwright requests and never into the frontend bundle.
- GitHub variable `VITE_GOURMET_API_BASE_URL`: enabled only after the hosted API passes health and integration checks.

Migration and cleanup credentials are never used by the runtime service:

- `MIGRATION_DATABASE_URL`: migration-owner connection string for `npm run db:migrate`.
- `APP_DATABASE_ROLE`: validated PostgreSQL application-role identifier used when granting least privilege.
- `CLEANUP_DATABASE_URL`: staging cleanup role with deletion rights, used only by `npm run db:cleanup:qa`.

## Safe rollout order

1. Provision database and roles.
2. Run `MIGRATION_DATABASE_URL=... APP_DATABASE_ROLE=... npm run db:migrate` as an explicit release step.
3. Deploy the API container with runtime secrets.
4. Verify `GET /health` reports `database: connected` and the intended `GIT_SHA`.
5. Run API integration and QA traffic using the protected QA headers.
6. Configure `VITE_GOURMET_API_BASE_URL` and deploy the static frontend through the existing `develop` pipeline.
7. Verify exact frontend SHA and a complete staging lead flow.
8. Remove QA records with `CLEANUP_DATABASE_URL=... npm run db:cleanup:qa`.

Down migrations are explicit and never run at application startup. Use `npm run db:migrate:down` only with an approved backup and maintenance window.
