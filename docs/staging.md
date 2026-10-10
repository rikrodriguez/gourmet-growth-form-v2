# Private synthetic staging candidate

This configuration serves the compiled office UI and API from one Node 24
container. PostgreSQL 16 stores only synthetic fixtures and command history.
No LLM, CRM, email sender, payment execution or provider connection is added.
Approvals remain simulations and `outboundEffects` must stay zero.

The files are a deployment candidate. Source builds and browser tests do not
establish that the Docker image was built, or that any staging instance,
database-container restart, proxy configuration or restoration has been
exercised.

## Runtime contract

| Variable | Required value or rule |
| --- | --- |
| `OFFICE_RUNTIME_MODE` | `staging`; set by Compose and the image. |
| `OFFICE_STAGING_ORIGIN` | One exact HTTPS origin, without path, credentials, query or fragment. |
| `OFFICE_STAGING_USERNAME` | Runtime staging username; no committed value. |
| `OFFICE_STAGING_PASSWORD` | Runtime staging password; no committed value. |
| `OFFICE_STAGING_ROLE` | `viewer` initially. `operator` is an explicit server-side opt-in. |
| `OFFICE_STAGING_TRUSTED_PROXY_CIDRS` | Actual private proxy addresses/CIDRs, bounded to the trusted proxy. Compose also adds `127.0.0.1/32` for its health probe. |
| `OFFICE_STAGING_DB_HOST` | `office-db`, reachable only by service name on the internal network. |
| `OFFICE_STAGING_DB_PORT` | `5432`. |
| `OFFICE_STAGING_DB_USER` | `office_stage`. |
| `OFFICE_STAGING_DB_NAME` | `gourmet_office_stage_demo`. |
| `OFFICE_STAGING_DB_PASSWORD` | Runtime synthetic database password, shared only by the app and PostgreSQL service. |

Use `.env.staging.example` as a blank variable inventory. Enter real credentials
only in the staging resource's runtime secret settings. Do not make them build
arguments, Vite variables, labels, source files, screenshots or log content.
Do not inherit development `OFFICE_DATABASE_URL` or `PG*` overrides into staging.
Missing/invalid settings prevent staging startup. Empty placeholder values are
not usable credentials.

The staging entrypoint is `src/office/backend/staging-server.ts`. It binds port
4180 on the container interface and serves `/office/`, its compiled assets and
`/office-api` together. TLS terminates at the configured trusted proxy. The
application does not accept forwarded headers as identity: it first checks the
actual peer against the explicit proxy allowlist, then requires the configured
Host and `X-Forwarded-Proto: https`. Mutations require the exact HTTPS Origin.

Every UI, asset and API request requires the valid staging credential. The shared
credential permits controlled access to a demo; it is not an individual staff
account, MFA or SSO. The UI's DEMO chooser selects scope only. It cannot
authenticate a person or increase the configured role. DEMO cookies use Secure,
HttpOnly and SameSite=Strict; sessions expire and disappear on API restart.

## Container boundaries

The multistage Dockerfile installs from the lockfile and builds `dist-office`.
The runtime contains production dependencies, required source modules,
migrations and the health probe. It runs as the unprivileged `node` user with
a read-only root filesystem, a temporary writable directory, no added Linux
capabilities and no Docker socket or Docker client inside the application.
The Docker build context explicitly excludes private configuration and evidence.

Compose publishes no host ports. Only `office-web` has an HTTP entrypoint for
the domain proxy. PostgreSQL joins only the `internal: true` database network,
uses SCRAM password authentication and persists in the named
`office-stage-postgres` volume. The web container joins the frontend and database
networks. The frontend network enables proxy access; it is not an outbound
firewall, so the application invariant and acceptance checks still prohibit
external effects. [Docker network boundaries](https://docs.docker.com/compose/how-tos/networking/).

PostgreSQL readiness uses `pg_isready`. The application waits for that healthy
dependency and then verifies migrations, existing state and database access.
Its own health probe authenticates to loopback port 4180 with the configured
Host and forwarded HTTPS protocol, checks the demo/PostgreSQL/zero-effects
response, and prints no credentials. `pg_isready` alone does not validate the
application's database password; the authenticated API health check does.

## Coolify preflight

After code publication and deployment have separate authorization, choose the
reviewed branch/commit as the Git source, the Docker Compose build strategy,
base directory `/` and Compose location `/compose.staging.yml`. Use normal
managed Compose mode so Coolify supplies domain proxy integration. Route only
the `office-web` service's internal port 4180 from a dedicated HTTPS domain.
The origin configured in the app is the public HTTPS origin without the internal
port suffix used in Coolify's domain routing field.

Review the rendered services and networks before deployment: the database must
remain solely internal and must have no domain or host port. Avoid attaching all
services to a shared predefined network. Configure the exact proxy allowlist from
the reviewed staging topology; no permissive catch-all CIDR is acceptable. The
proxy must preserve the expected Host, supply its HTTPS protocol header and
forward the Authorization header. Prevent credentials from entering proxy
request logs. [Coolify Compose configuration](https://coolify.io/docs/applications/builds/docker-compose).

Set the runtime variables in Coolify and retain `viewer` unless synthetic writes
are explicitly intended. Confirm the database volume belongs to this staging
resource. Do not reuse a development volume or connect a business database.
Document backup retention and the staging owner before starting the resource.
Do not enable automatic publication from an unrelated application branch.

## Acceptance checks

1. Missing or wrong credentials return 401 for `/office/`, a compiled asset,
   `/office-api/health`, `/office-api/session` and `/office-api/snapshot`. A cookie
   alone never bypasses the staging credential. No HTML or sensitive JSON loads.
2. Valid credentials through the trusted HTTPS proxy load desktop and mobile UI,
   compiled assets and the authenticated health response. No page overflow or
   browser errors occur. Host/origin/protocol mismatches and untrusted peers fail.
3. The default viewer session cannot create drafts or decisions. A request for
   operator cannot raise its authority. With explicit operator configuration,
   drafts/revision/approval work only on synthetic cases; replay remains
   idempotent and external effects remain zero.
4. Verify PostgreSQL authentication with the application health check, migration
   checksums and fixture provenance. Database failure returns 503; there is no
   silent fallback or re-seeding of an existing office.
5. Record a synthetic command, restart the API and the actual database container,
   obtain a new session and verify the same state, history and replay behavior.
   API/pool replacement tests alone do not satisfy this restart check.
6. Create an authorized staging backup and restore it into a separate synthetic
   environment. Verify state/history counts and replay semantics. A named volume
   is persistence, not a verified backup; avoid destructive volume removal.
7. Confirm no host ports, raw secrets, real contacts or external calls are exposed.
   Record the reviewed commit, image versions, test results and remaining gaps.

The dashboard is a current aggregate. The Historial view reads durable synthetic
events; neither view claims to provide historical business metric series.
Deployment acceptance should record what was actually exercised without
inheriting results from a previous environment.
