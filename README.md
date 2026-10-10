# Gourmet Office synthetic demo

Gourmet Office is a local demonstration of an office, review queue and dashboard
using three synthetic cases. Chat replies are scripted fixtures. Approval records
a synthetic decision; it never sends messages, executes payments or connects a
provider. All domain data is simulated and outbound effects remain zero.

Use Node 24; supported versions are `>=22 <25`. The lockfile pins dependencies.

```sh
npm ci --no-audit --no-fund
npm run office:up
```

Open `http://127.0.0.1:4175/office/`. This command starts the isolated local
PostgreSQL database, API on loopback port 4180 and Vite on loopback port 4175.
Select a DEMO scope to explore synthetic records. The chooser is a scope selector,
not proof of personal identity. Stopping the UI/API preserves the local database.

The local database uses port 55433, user `office_candidate`, database
`gourmet_office_candidate_dev` and state `gourmet-office-candidate-development`.
Development trust authentication is restricted to that loopback database; staging
requires the separate authenticated database described in [docs/staging.md](docs/staging.md).

History stores synthetic command events durably in PostgreSQL. The dashboard
aggregates the current snapshot; it does not store historical metric series.

## Checks

```sh
npm run typecheck
npm run build
npm run office:build
npm run test:operations
npm run test:office
npm run test:e2e
npm run test:office:e2e
```

The PostgreSQL tests require the isolated development database. Run
`npm run office:db -- start` first. Browser suites start their own servers and
require those ports to be free; stop `office:up` before running them. Browser
requests are restricted to local test origins and reserved synthetic mocks.
External requests fail the suites. If Chromium is already installed, its executable
can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; otherwise install
Playwright Chromium with `npx playwright install chromium`.

The baseline `build` and `start` commands build/serve the separate original app
from `dist`, with `/health` on default port 3000. Office builds go to `dist-office`.
Screenshots, logs and traces remain ignored local evidence.

## Private staging candidate

`Dockerfile` and `compose.staging.yml` describe a separate synthetic staging
candidate. The Node 24 container serves compiled office UI and API under one
HTTPS origin behind an explicitly trusted proxy. Both UI and API require valid
runtime credentials. Sessions are capped at `viewer` by default; `operator`
requires explicit server configuration and still cannot authorize live effects.

[docs/staging.md](docs/staging.md) records the runtime contract, secret handling,
deployment preflight and acceptance checks. The repository contains no real
credentials. Building or configuring this candidate does not establish that a
Coolify deployment, real container restart or restore has been verified.
