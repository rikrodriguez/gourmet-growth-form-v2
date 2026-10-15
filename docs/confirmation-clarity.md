# Clarity on the Form 2 confirmation

`/form2/request-received/` is a new document after submission. The funnel's
measurement manager does not survive that navigation. The confirmation now
connects the existing consent manager directly to the existing Clarity loader.
Analytics consent is required; advertising consent alone does not load Clarity.
The shared Privacy choices control allows changes and revocation on this page.

This connection deliberately does not initialize the acquisition measurement
manager, load GTM, flush pending events or produce another conversion. It keeps
the configured project ID, the confirmation's `data-clarity-mask`, the clean URL
and the retired-route redirect. Cleanup removes only its consent listener, so a
StrictMode remount does not revoke consent or replace the vendor script.

No query or fragment belongs to the confirmation URL contract. The connection
removes both with `history.replaceState` before initializing Clarity, including
parameters preserved by the Apache redirect from the retired route. If that
operation throws or leaves parameters present, the connection fails closed:
the confirmation remains usable, but it does not load or subscribe Clarity.
The server redirect configuration is unchanged.
Apache documents query preservation and the separate discard flag in its
[RewriteRule flags reference](https://httpd.apache.org/docs/current/en/rewrite/flags.html#flag_qsd).

## Local verification

The unit contracts exercise both the consent lifecycle and the real existing
vendor/consent modules with in-memory document and storage fixtures. They do not
start a browser, make requests or simulate actual SDK recording.

```sh
node --import tsx --test tests/unit/*.test.ts
npm run typecheck
```

The browser suite is explicitly opt-in, requires a loopback target and
intercepts vendors and the API. Other external origins are blocked. Build a
synthetic artifact, then run the representative mobile/desktop profiles:

```sh
VITE_GOURMET_API_BASE_URL=http://127.0.0.1:4173 \
VITE_MEASUREMENT_ENVIRONMENT=staging \
VITE_GTM_CONTAINER_ID=GTM-QATEST \
VITE_GA4_MEASUREMENT_ID=G-QATEST123 \
VITE_GOOGLE_ADS_CONVERSION_ID=AW-123456789 \
VITE_GOOGLE_ADS_CONVERSION_LABEL=qa-label \
VITE_CLARITY_PROJECT_ID=clarityqa npm run build

E2E_MEASUREMENT_MODE=mock E2E_API_MODE=mock \
node node_modules/@playwright/test/cli.js test \
  tests/e2e/confirmation-clarity.spec.ts \
  --project=mobile-chromium-390x844 \
  --project=desktop-chromium-1440x900
```

The same suite supports a production-mode local build using an explicit
`E2E_EXPECTED_CLARITY_ID`. The interception remains mandatory; the production
build mode is not permission to contact real vendors or submit real leads.
The visual contract produces confirmation and expanded-preferences screenshots
in the test output. Inspect those screenshots before declaring visual approval.

Coverage includes absent/rejected/ads-only/invalid consent, unavailable storage,
acceptance/revocation/reacceptance, a delayed SDK, reload, untouched acquisition
queues, masking, the retired route and a complete synthetic submission followed
by a new document and another reload.

## Release boundary

Do not push this change directly to `develop` or `hostinger-staging` for testing.
The source-line `build-hostinger-staging.yml` workflow publishes to the public
Form 2 deployment branch. Its name does not make it a validation-only workflow.
Keep this fix on its own branch and draft PR, separate from Office and Payments.
The fix does not modify or dispatch any workflow.

The implementation environment could run unit tests, type checks and builds,
but Chromium could not start because local socket creation was denied by the
runtime (`EPERM`), including an approved escalated attempt. Browser execution,
screenshots and live SDK recording are therefore not claimed by those results.
Refer to the draft PR for the exact tested commit and final validation counts.

The existing consent manager does not synchronize preference changes between
tabs. Script presence and queued consent commands are integration evidence;
they do not prove that the real SDK recorded or continued a session.

The URL safeguard covers the current document location only; `replaceState`
cannot rewrite `document.referrer`. The [official Clarity metadata source](https://github.com/microsoft/clarity/blob/master/packages/clarity-js/src/data/metadata.ts)
reads both `location.href` and `document.referrer`. The mock suite does not
validate the real SDK's treatment of referrers. Evaluate same-origin legacy
navigation with a query-bearing referrer before live release; this fix is not
a claim that all historical URL metadata is sanitized.
