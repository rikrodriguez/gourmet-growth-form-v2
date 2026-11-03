# Private input errors — 3 November 2026

## Reproduced defect

Both context CLIs forwarded `JSON.parse` and file-read error messages directly to stderr. A malformed synthetic input printed a fragment of its content; a missing input printed its full local path. These diagnostics can be copied into logs or support reports even though the input is a private conversation, review or snapshot.

## Change

The two CLIs use a shared file reader with fixed input roles: `CONTEXT`, `REVIEW`, `MONDAY` and `CONFIRMED`. Read failures return `<ROLE>_READ_FAILED`; malformed JSON returns `<ROLE>_JSON_INVALID`. The manual-text entry also uses the safe reader. Messages explain how to correct the input locally without including its path, content or the underlying exception. No fallback input, implicit retry or generation is performed.

Context provenance, capture authorization, reviewed evidence, identity, prior-payment and fixture-only generation checks are unchanged. This is deliberately limited to input read/parse diagnostics, not a claim that every CLI error or successful report is free of private information. Successful reports intentionally include the authorized context. Adapter/output errors and other validation errors are outside this patch.

## Evidence

- Two regression tests failed before the fix: malformed content leaked to stderr, and a missing input exposed its local path.
- The passing malformed-input test covers all six JSON entry points across both CLIs, including the Vault fixture, Monday snapshot, human review and confirmed fields. Failed operations emit no stdout and create no output directory.
- The passing missing-file test covers the context input of both CLIs and manual-text input. The manual-text path leak was also reproduced before extending the fix to that entry point.
- Full offline Node suite: 66 passed, 0 failed. Modified modules pass syntax checks. Vite production build passes.
- Fixtures and temporary filenames are synthetic. No client data, external adapter, browser, GHL operation, payment call or message was used.

This remains a draft code change. It does not reopen or diagnose the real GHL survey, verify native browser capture, merge or deploy the application.
