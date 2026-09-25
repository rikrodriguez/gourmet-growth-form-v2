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
- `MEASUREMENT_ENVIRONMENT`: keep `staging` on the current API. A future production API must explicitly set `production`.
- `GOOGLE_ADS_CUSTOMER_ID`: numeric conversion customer ID without hyphens (`1112667809`).
- `GOOGLE_ADS_CONVERSION_ACTION_ID`: numeric existing website conversion action ID (`7476344812`).
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

## M3B Enhanced Conversions readiness

The selected architecture supplements the existing `WEBPAGE` conversion through Google Data Manager API multi-source conversion ingestion. The browser sends only the normal conversion plus an opaque `transaction_id`; phone normalization, SHA-256 hashing, consent checks, and delivery stay server-side.

The isolated production destinations provisioned for the future cutover are GTM `GTM-PJ4NSD4K`, GA4 `G-K1QGPQ1X06`, and Clarity `ynyby0wh14`. Their public build variables are stored only in the GitHub `production` environment. The repository-level variables used by staging remain unchanged. None of these resources is installed, published, or connected to customer traffic by M3B.

`growth_v2.measurement_outbox` is written in the same transaction as lead capture only when the backend is explicitly configured for production, both `ad_storage` and `ad_user_data` were explicitly granted, the request is not QA, and the verified Ads IDs exist. The unique lead/event constraint and stable transaction ID prevent double counting across retries.

The `measurement-worker` Compose service is profile-gated and defaults to `GOOGLE_ADS_DELIVERY_MODE=disabled`. Do not start it until all of the following are separately approved:

1. Production cutover and the production GTM container are published with the same transaction ID on the existing Ads conversion tag.
2. Google Cloud Data Manager API access and Application Default Credentials are provisioned outside the repository.
3. `GOOGLE_ADS_DELIVERY_MODE=validate-only` has passed without submitting a conversion.
4. A separate authorization changes the mode to `live`.

`npm run ads:dry-run` is local-only, uses synthetic data, makes no network request, and prints no plaintext phone or name.
