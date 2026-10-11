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
| `OFFICE_STAGING_PASSWORD` | 24–256 printable ASCII characters from `!` to `~`, without spaces; runtime only. |
| `OFFICE_STAGING_ROLE` | `viewer` initially. `operator` is an explicit server-side opt-in. |
| `OFFICE_STAGING_TRUSTED_PROXY_CIDRS` | Actual private proxy addresses/CIDRs, bounded to the trusted proxy. Compose also adds `127.0.0.1/32` for its health probe. |
| `OFFICE_STAGING_DB_HOST` | `office-db`, reachable only by service name on the internal network. |
| `OFFICE_STAGING_DB_PORT` | `5432`. |
| `OFFICE_STAGING_DB_USER` | `office_stage`. |
| `OFFICE_STAGING_DB_NAME` | `gourmet_office_stage_demo`. |
| `OFFICE_STAGING_DB_PASSWORD` | 24–256 characters without U+0000–001F or U+007F controls; runtime only, shared by the app and PostgreSQL service. |

Use `.env.staging.example` as a blank variable inventory. Enter real credentials
only in the staging resource's runtime secret settings. Do not make them build
arguments, Vite variables, labels, source files, screenshots or log content.
Do not inherit development `OFFICE_DATABASE_URL` or `PG*` overrides into staging.
Missing/invalid settings prevent staging startup. Empty placeholder values are
not usable credentials. Compose permits empty runtime settings during the image
build because Coolify loads runtime-only secrets after that phase. The staging
entrypoint still validates every required setting before serving or connecting
to PostgreSQL; permitting build interpolation does not permit an empty runtime.

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
response, and prints no credentials. It uses `node:http.request` to preserve the
configured Host: Node 24 `fetch` replaces that header with the loopback host and
the application correctly rejects the request. The target remains fixed to
loopback and the probe follows no redirects. `pg_isready` alone does not validate the
application's database password; the authenticated API health check does.

Startup failures emit one JSON diagnostic with `event`, `stage` and a fixed
allowlisted `code`. Invalid runtime settings also include only the variable
name and its fixed `requirement`. Stages distinguish configuration, database
construction, compiled UI, application readiness, database initialization and
listening. Recognized database error codes identify authentication, permissions,
missing database or connectivity without copying messages, stacks, detail or
DSNs. Resource cleanup failures also stay inside this diagnostic boundary.
Keep secret validation strict; correct an invalid setting through the runtime
secret controls without copying its value into troubleshooting evidence.

## Coolify preflight

After code publication and deployment have separate authorization, choose the
reviewed branch/commit as the Git source, the Docker Compose build strategy,
base directory `/` and Compose location `/compose.staging.yml`. Enable **Raw
Compose Deployment** for this resource on Coolify v4.4.6. Its managed parser 5
adds every declared network to every service, which would attach PostgreSQL to
the frontend and resource networks even with `connect_to_docker_network=false`.
Raw mode preserves the source's DB-only internal network.

The frontend uses the existing external `coolify` network, inspected on the
staging VPS with Traefik attached. Only `office-web` joins it; PostgreSQL stays
on the internal database network. Coolify supplies `COOLIFY_RESOURCE_UUID` to
the standard Compose commands for unique router/service identifiers. The source
includes resource-scoped Traefik labels
for `office-staging.gourmet-corporation.com`: HTTP redirects to HTTPS, TLS uses
Coolify's `https` entrypoint and `letsencrypt` resolver, and the backend is port
4180 with the original Host preserved. The application's authentication remains
mandatory. PostgreSQL explicitly disables Traefik and publishes no ports. No
manual global proxy configuration change is required. Coolify v4.4.6 still
attempts to create its UUID network and attach the proxy automatically before
Compose startup, even in raw mode; neither application service uses that extra
network. Inspect actual attachments after deployment. Keep custom Compose build/start commands empty
so Coolify's resource variable remains in effect.

The runtime origin is `https://office-staging.gourmet-corporation.com` without
the internal port. Raw routing uses the source labels, not the application's
managed domain-port override. A different domain requires reviewing those
labels and the runtime origin together. This integration follows Coolify's
[deployment job](https://github.com/coollabsio/coolify/blob/v4.4.6/app/Jobs/ApplicationDeploymentJob.php#L938)
and [proxy defaults](https://github.com/coollabsio/coolify/blob/v4.4.6/bootstrap/helpers/proxy.php#L767),
with network preservation by the
[raw parser](https://github.com/coollabsio/coolify/blob/v4.4.6/app/Models/Application.php#L2102).

Run the Compose contract checks before deployment; they resolve the effective
services, networks and labels without inheriting credentials or loading an env
file. Confirm raw mode on the resource: the database must remain solely internal
and have no domain or host port. Avoid attaching all services to a shared
predefined network. The VPS inspection on 2026-10-11 found Traefik at
`172.16.1.2` on `coolify`, so `172.16.1.2/32` is the expected runtime proxy
allowlist for this Compose. This is a topology-based expectation, not an
observation from a running staging container. Verify the actual peer and
network attachments after the first deployment, and recheck the allowlist if
the proxy address changes. An existing staging container is not a preflight
requirement. No permissive catch-all CIDR is acceptable. The
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
