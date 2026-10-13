# Persisted quote browser integration (explicit tests only)

This harness composes React → same-origin HTTP → `PostgresEventQuoteStore` with
synthetic values from `tests/office/event-quote-fixtures.ts`. It never registers
routes in the existing app, starts a real identity/login flow, reads providers,
sends a message, publishes, charges, or deploys anything.

Run with the isolated local test database available and ports 4197/4198 free:

```sh
npm run office:db -- start
node --import tsx tests/event-quote-browser/check.ts
npm run office:db -- stop
```

The harness initializes one randomly named `quote_test_*` schema, with a random
in-memory encryption key, and drops only that namespace on exit, including a
browser launch failure. It never migrates the deployed/default schema. Chromium
comes from `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or `/usr/bin/chromium`.

Cases: manual intake, server catalogue selection, generated quote, exact internal
approval, browser reload, changed brief and obsolete approval, a second quote,
exact historical artifact retrieval, desktop/mobile overflow, logout/identity
replacement, late response after changing event, and session-expiry clearing.
Requests outside loopback fail the run. Screenshots, if reached, go to ignored
`test-results/dashboard-visual/persisted-quote-*.png` (the existing short-retention synthetic artifact).

Verification limit for the 2026-10-13 executor: Chromium was attempted once and
failed before any page interaction with `socket() failed: Operation not permitted`
(`process_singleton_posix.cc`, SIGABRT). The browser flow and screenshots have not
been verified here. Unit/HTTP/server-render/transport tests are separate from
real browser evidence. Do not bypass the executor restriction to run this test.
