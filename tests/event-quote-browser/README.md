# Persisted quote browser integration (explicit tests only)

This harness mounts the actual approved DashboardPage and composes React → same-origin HTTP → `PostgresEventQuoteStore` with
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

Cases: no quote reads on navigation/mount/reload, explicit existing-access verification and event-ID selection, then manual intake, server catalogue selection, generated quote, exact internal
approval, browser reload, changed brief and obsolete approval, a second quote,
exact historical artifact retrieval, desktop/mobile overflow, logout/identity
replacement without automatic reopen, late response after changing event, Back navigation withdrawing access, unknown financial metrics after saving a quote, a projected-access expiry timer and a separate server-deadline mismatch withdrawal. The only injected access source is a test-only projection; it does not create production identity or commercial catalogue authority.
Requests outside loopback fail the run. Screenshots, if reached, go to ignored
`test-results/dashboard-visual/persisted-quote-*.png` (the existing short-retention synthetic artifact).

Verification limit for the 2026-10-13 executor: Chromium was attempted once and
failed before any page interaction with `socket() failed: Operation not permitted`
(`process_singleton_posix.cc`, SIGABRT). The standalone component was verified in CI at cc846f7a; this changed Dashboard-mounted flow and its screenshots have not
been verified here. Unit/HTTP/server-render/transport tests are separate from
real browser evidence. Do not bypass the executor restriction to run this test.
