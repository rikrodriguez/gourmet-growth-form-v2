# Review timestamp correction — 1 November 2026

## Reproduced defect

On PR 19's exact head `924b34a69638942d0766bd940e62880d73add807`, the manual review brief accepted `2026-02-30T02:00:00Z` as an explicitly confirmed review time. The permissive `Date.parse` check normalizes impossible dates. It also accepted a missing timezone and offset timestamps, although capture and reviewed generation already require the canonical UTC contract.

The new regression failed before the fix (`Missing expected exception: 2026-02-30T02:00:00Z`). Reusing the existing `realTimestamp` helper rejects impossible dates, timezone-less timestamps, noncanonical offsets and excessive fractional precision. Valid leap-day UTC and one-to-three fractional digits are preserved without normalization.

## Scope and evidence

- No change to pricing, deposits, authorization meaning, capture, GHL, PayPal or commercial execution flags.
- Local Node 24: 33 context tests and 13 evidence tests PASS; two new test cases cover six invalid and four valid values. Module syntax and Vite build PASS.
- Existing exact dependency versions were reused from the local Gourmet source workspace; no package versions or lockfile changed. An offline install attempt failed with ENOTCACHED before this reuse.
- The complete `test:prototype` command reaches the browser suite but cannot start Chromium here: `socket() failed: Operation not permitted`. The 10 browser checks are NOT claimed as passed on this revision. No flags or security policy were weakened to work around that failure.
- External private generator not present; its integration was not rerun. These changes do not touch its adapter.
- A separate read-only CI workflow runs the 46 dependency-free contract tests and syntax checks only, on this exact draft branch. It has no secrets, deployments, uploads, installs, browser access or payment operations, and does not invoke the Hostinger publication workflow. Hosted result remains to be verified on the final commit.

PR remains draft. No merge, deploy, client messages, credential/permission changes or paid services.
