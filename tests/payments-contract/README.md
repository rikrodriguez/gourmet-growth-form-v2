# Original Gourmet Payments contract checks

Run from the repository root with Node 22–24 and PHP 8 with mbstring and
pdo_sqlite available:

```sh
npm run test:payments-contract
```

`GOURMET_CONTRACT_PHP_BIN` may select an isolated PHP executable. This continuation
used `/tmp/gourmet-php/bin/php`, PHP 8.4.26, Node 24.19.0, tsx 4.23.15 and
TypeScript 7.0.2. No dependency versions were changed to match the historical
snapshot. Type-check the pure adapter and the new round-trip tests separately:

```sh
./node_modules/.bin/tsc --noEmit -p tests/payments-contract/tsconfig.json
```

The runner verifies all 17 original source/fixture files against
`references/TRANSFER-SHA256SUMS.json` before loading them. They were transferred
byte for byte from the October 5 reviewed bundle through the parent task. The
bundle ZIP itself was not downloaded or hash-verified here: its Library transfer
failed with proxy 403. Per-file hashes, rather than an inferred ZIP hash, establish
the identity of this recovered subset. No original source was reconstructed or
reformatted. The reference-local Git attribute preserves the original PHP EOF
blank lines during whitespace checking.

The PHP producer uses only `sqlite::memory:`. The new parser helper loads the
original request parser and reflects the original application's date methods
without constructing or dispatching the application. Neither calls the agreement
creation service or generates a payment token or URL. The Node tests use the
original in-memory event consumer; its intents are retained only in test memory.
No dispatcher is started. Child processes inherit a minimal test environment;
PHP URL access/network/shell functions are disabled and Node's fetch, HTTP,
socket and DNS entry points fail the run, including caught attempts. Four probes
verify those rejections before loading the references. Optional tsx parent-pipe
IPC is also denied without being counted as an external network attempt.
Both PHP subprocesses set `xdebug.mode=off` at startup, which disables optional
[Xdebug features](https://xdebug.org/docs/all_settings#mode). The runner's
PHP 8.3.6 with Xdebug 3.2.0 otherwise fails while annotating an invalid-timezone
exception, before the original application can convert it into its expected
domain rejection. The original sources and rejection assertions stay unchanged.

`test-results/gourmet-payments-contract/` contains the freshly generated PHP
output, Node test log and current runtime/count summary. Historical evidence from
the bundle is not used as an execution result. The producer's `external_calls:0`
field is a declaration from its source, not an instrumented call counter. The
five original request/date
fixtures contain 2027 dates and the original PHP code checks the current time;
they must fail when those dates become past rather than silently shifting dates.

The existing historical request test imports `gourmet-payments.ts`, including its
inactive client definition. No test enables or instantiates a network adapter.
Its original type-only `FetchLike` dependency from `integrations/src/index.ts`
is outside this subset and is erased by tsx. The command above type-checks the
pure contract adapter and new tests; it does not claim a complete historical
integrations-package type-check. No type stub was added.

These fixtures represent standalone fixed-reservation agreements. Percentage
quotes from the current application never enter this structural adapter. The
separate `tests/office/gourmet-payments-boundary.test.ts` verifies preserved
quote terms, dates and percentage amounts and rejects attempts to create an
agreement or inject a calendar/consent through the current command API.

No payment transport, provider configuration, credentials, runtime registration,
migration or duplicate Dashboard panel is added. The runtime Docker stages do
not copy this test reference directory.

## Additive v2 receiver checks

The same command also runs `v2-roundtrip.test.ts` in a separate guarded Node
process. `receive-v2.php` loads only the hash-verified canonical `Money.php` from
`v2-originals` and the new isolated PHP v2 validator. The 114 original checks keep
their own count; additional v2 counts appear under `summary.json` → `v2`, and
their log is `v2-node-tests.log`. The trusted synthetic clock is an explicit CLI
argument, not part of the request. No application or agreement service starts.

See [the additive receiver](../../integrations/gourmet-payments-v2/README.md) for
the exact structural-validation boundary, canonical source provenance and the
authentication/configuration work still missing. A successful echo always has
`authorizationVerified:false`, execution disabled and a null public URL.
