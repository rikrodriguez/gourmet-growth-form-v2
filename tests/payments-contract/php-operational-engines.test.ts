import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import { decodePaymentAgreementReceiptV2, paymentAgreementIdempotencyKeyV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import { operationFixture, authorization, envelope, request, response, assertNoFinancialSideEffects, assertPersisted } from './operational-cases';
import { createOperationalPaymentFixtureV2, startOperationalPaymentReceiverV2,
  type OperationalDatabaseBindingV2, type OperationalFixtureOptionsV2, type OperationalFixtureV2 } from './php-operational-receiver';

const engines = ['mariadb', 'mysql'] as const;
const selected = process.env.GOURMET_CONTRACT_TEST_ENGINES ?? (process.env.CI === 'true' ? 'mariadb,mysql' : '');
const requested = new Set(selected.split(',').filter(Boolean));
for (const value of requested) if (!(engines as readonly string[]).includes(value)) throw new Error('INVALID_REQUESTED_PAYMENT_ENGINE');
const php = process.env.GOURMET_CONTRACT_MYSQL_PHP_BIN || process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const evidenceDirectory = fileURLToPath(new URL('../../test-results/gourmet-payments-contract/engines/', import.meta.url));
async function evidence(engine: string, value: Record<string, unknown>) {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(`${evidenceDirectory}${engine}.json`, JSON.stringify({ suite: 'original-payments-runtime-engine-v2', engine, atMs: Date.now(), ...value }, null, 2) + '\n');
}
function missingCapability(): string | null {
  const driver = spawnSync(php, ['-d', 'xdebug.mode=off', '-r', "echo json_encode(PDO::getAvailableDrivers());"], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
  });
  if (driver.error || driver.status !== 0 || driver.stderr) return 'PHP PDO MySQL capability is unavailable';
  if (!(JSON.parse(driver.stdout) as unknown[]).includes('mysql')) return 'Selected PHP has no PDO MySQL driver';
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  return docker.error || docker.status !== 0 ? 'Disposable Docker database capability is unavailable' : null;
}

for (const engine of engines) test(`original Payments Application/Connection on ephemeral ${engine}`, async t => {
  if (!requested.has(engine)) {
    await evidence(engine, { status: 'NOT_VALIDATED', reason: 'Engine is not selected for this local run' });
    t.skip(`NOT_VALIDATED: engine ${engine} is not selected`); return;
  }
  const missing = missingCapability();
  if (missing) { await evidence(engine, { status: 'FAILED', reason: missing }); assert.fail(`${engine}: ${missing}; selected engines cannot skip or fall back`); }
  const { startEphemeralPaymentDatabaseV2 } = await import(new URL('./ephemeral-mysql.ts', import.meta.url).href);
  const database: { binding: OperationalDatabaseBindingV2; close(): Promise<void>; restart(): Promise<void> } = await startEphemeralPaymentDatabaseV2(engine);
  const options: OperationalFixtureOptionsV2 = { phpBinary: php, database: { engine, binding: database.binding } };
  const ledger = await createOperationalPaymentFixtureV2({ ...options, seedLegacy: true }).catch(async error => { await database.close(); throw error; });
  let receiver: Awaited<ReturnType<typeof startOperationalPaymentReceiverV2>> | undefined;
  const checks: string[] = [];
  let queryEvidence: ReturnType<OperationalFixtureV2['invoke']>['queryProbes'];
  let migrationEvidence: ReturnType<OperationalFixtureV2['invoke']>['migrationGates'];
  const runCase = async (name: string, run: () => unknown | Promise<unknown>) => {
    let failed = false, failure: unknown;
    await t.test(name, async () => {
      try { await run(); } catch (error) { failed = true; failure = error; throw error; }
    });
    if (failed) throw failure; // Never write VALIDATED after a failed subtest.
  };
  try {
    await runCase('actual Connection selects native PDO MySQL; original root migrations upgrade a preexisting v1 agreement', () => {
      assert.deepEqual(ledger.initial.applied, ['0004_current_payment_ledger.sql', '0005_versioned_payment_agreement_drafts.sql']);
      const state = ledger.initial.snapshot, storage = state.storage!;
      assert.equal(storage.driver, 'mysql'); assert.equal(storage.engine, engine);
      assert.equal(storage.database, database.binding.database); assert.equal(storage.nativePrepares, true);
      assert.equal(storage.foreignKeysEnabled, true); assert.equal(storage.collation, 'utf8mb4_bin'); assert.equal(storage.timeZone, '+00:00');
      assert.match(storage.version, engine === 'mariadb' ? /^11\.4\..*MariaDB/i : /^8\.4\./);
      assert.ok(storage.sqlMode?.includes('STRICT_ALL_TABLES') || storage.sqlMode?.includes('STRICT_TRANS_TABLES'));
      const before = ledger.initial.legacyBeforeMigration![0], row = state.agreements[0];
      assert.equal(row.public_uuid, before.public_uuid); assert.equal(row.contract_version, 1);
      assert.equal(row.total_cents, 10001); assert.equal(row.reservation_cents, 4900); assert.equal(row.balance_cents, 5101);
      assert.equal(row.recipient_name, 'Synthetic legacy recipient'); assert.equal(row.recipient_email, 'legacy@example.test');
      assert.equal(row.recipient_phone, '+1 202 555 0101'); assert.equal(row.token_is_null, 0);
      assert.equal(row.created_at, before.created_at); assert.equal(row.updated_at, before.updated_at);
      const long = state.agreements.find(row => row.public_uuid === '00000000-0000-4000-8000-000000000021')!;
      assert.equal(long.recipient_name, 'N'.repeat(100) + ' ' + 'L'.repeat(100));
      const longBefore = ledger.initial.legacyBeforeMigration!.find(row => row.public_uuid === long.public_uuid)!;
      assert.equal(long.updated_at, longBefore.updated_at); assert.equal(long.created_at, longBefore.created_at);
      assert.equal(state.counts.customers, 2); assert.equal(state.migrations.length, 5);
      assert.deepEqual(state.schedules.map(row => [row.kind, row.amount_cents]), [['RESERVATION', 4900], ['BALANCE', 5101]]);
      assertNoFinancialSideEffects(state); checks.push('original_migrations_v1_upgrade_native_pdo');
    });
    receiver = await startOperationalPaymentReceiverV2(options);
    for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) await runCase(`${mode}: real HTTP -> original Application -> actual ${engine} rows, process restart and replay`, async () => {
      const { operation } = await operationFixture(mode, `${engine}-${mode}`);
      const headers = { authorization: `Bearer ${receiver!.sharedSecret}`, 'content-type': 'application/json',
        'idempotency-key': paymentAgreementIdempotencyKeyV2(operation.operationId) };
      const first = await fetch(`${receiver!.baseUrl}/internal/v2/payment-agreements`, { method: 'POST', headers, body: envelope(operation), signal: AbortSignal.timeout(5000) });
      const body = await first.text(); assert.equal(first.status, 201, body);
      const state = await receiver!.inspect();
      const receipt = assertPersisted({ snapshot: state, providerCalls: state.providerCalls }, operation, body);
      await receiver!.restart();
      const replay = await fetch(`${receiver!.baseUrl}/internal/v2/payment-agreements`, { method: 'POST', headers, body: envelope(operation), signal: AbortSignal.timeout(5000) });
      assert.equal(replay.status, 200); assert.deepEqual(decodePaymentAgreementReceiptV2(await replay.text(), operation), receipt);
      const recovery = await fetch(`${receiver!.baseUrl}/internal/v2/payment-agreements/reconcile`, { method: 'POST', headers,
        body: canonical({ operationId: operation.operationId, operationDigest: digest(operation) }), signal: AbortSignal.timeout(5000) });
      assert.equal(recovery.status, 200); assert.deepEqual(decodePaymentAgreementReceiptV2(await recovery.text(), operation), receipt);
      const changed = structuredClone(operation); changed.service.name += ' modified';
      const conflict = ledger.invoke(request(changed)); assert.deepEqual(response(conflict, 409), { status: 'idempotency_conflict' });
      assert.deepEqual(await receiver!.inspect(), state); checks.push(`http_${mode}_restart_replay_reconciliation_conflict`);
    });
    await runCase('bearer/assertion/default-off gates remain effective with native PDO and leave every row unchanged', async () => {
      const { operation } = await operationFixture('retainer_50', `${engine}-auth`), baseline = ledger.invoke({ action: 'snapshot' }).snapshot;
      const normal = request(operation), expired = authorization(operation, Date.now() - 120_000);
      const cases: [Record<string, unknown>, NodeJS.ProcessEnv, number, string][] = [
        [{ ...normal, headers: { ...normal.headers, authorization: 'Bearer synthetic-invalid' } }, {}, 404, 'not_found'],
        [normal, { INTERNAL_V2_ENABLED: 'false' }, 404, 'not_found'],
        [{ ...normal, path: '/internal/v1/payment-agreements' }, {}, 404, 'not_found'],
        [{ ...normal, body: envelope(operation, expired) }, {}, 422, 'invalid_request'],
        [{ ...normal, production: true }, {}, 503, 'draft_execution_disabled'],
      ];
      for (const [input, env, code, status] of cases) {
        const result = ledger.invoke(input, env); assert.deepEqual(response(result, code), { status }); assert.deepEqual(result.snapshot, baseline);
      }
      checks.push('auth_assertion_v1_commercial_default_off');
    });
    await runCase('real final-audit SIGNAL failure rolls back agreement, schedules and idempotency; identical retry commits once', async () => {
      const { operation } = await operationFixture('retainer_50', `${engine}-rollback`);
      const before = ledger.invoke({ action: 'install_audit_failure' }).snapshot;
      try {
        const failed = ledger.invoke(request(operation)); assert.deepEqual(response(failed, 503), { status: 'request_unavailable' });
        assert.deepEqual(failed.snapshot, before);
      } finally { ledger.invoke({ action: 'remove_audit_failure' }); }
      const committed = ledger.invoke(request(operation)); response(committed, 201); assertPersisted(committed, operation, committed.response!.body);
      assert.equal(committed.snapshot.counts.payment_agreements, before.counts.payment_agreements + 1);
      assert.equal(committed.snapshot.counts.idempotency_keys, before.counts.idempotency_keys + 1);
      const replay = ledger.invoke(request(operation)); response(replay, 200); assert.deepEqual(replay.snapshot, committed.snapshot);
      const rollbackOperation = (await operationFixture('full_upfront', `${engine}-callback-rollback`)).operation;
      const callback = ledger.invoke({ action: 'rollback', body: envelope(rollbackOperation) });
      assert.equal(callback.callbackCalls, 1); assert.equal(callback.transactionOpen, false); assert.deepEqual(callback.snapshot, callback.before);
      checks.push('application_guard_receipt_audit_atomic_rollback_retry');
    });
    await runCase('actual repository/outbox queries use native prepares and preserve target facts on replay; all probe rows roll back', () => {
      const before = ledger.invoke({ action: 'snapshot' }).snapshot;
      const probes = ledger.invoke({ action: 'query_probes' });
      assert.equal(probes.queryProbes?.driver, 'mysql'); assert.ok(probes.queryProbes.assertions >= 20);
      assert.ok(Object.values(probes.queryProbes.facts).every(value => value === true));
      queryEvidence = probes.queryProbes;
      assert.deepEqual(probes.snapshot, before); checks.push('native_search_consents_attempts_outbox_replay_and_rollback');
    });
    await runCase('two original AdminBootstrap attempts initiated in parallel with different tokens/emails create only one first administrator', async () => {
      ledger.invoke({ action: 'bootstrap_seed' });
      const attempts = await Promise.all(['a', 'b'].map(index => ledger.invokeAsync({ action: 'bootstrap_attempt', index })));
      assert.equal(attempts.filter(result => result.bootstrapCreated === true).length, 1);
      const final = ledger.invoke({ action: 'snapshot' }).snapshot;
      assert.equal(final.counts.admin_users, 1);
      assert.equal(Math.max(...attempts.map(result => result.consumedBootstrapTokens!)), 1);
      checks.push('parallel_original_bootstrap_distinct_tokens_single_admin');
    });
    await runCase('actual migration journal readiness, checksum/lock/partial-DDL gates operate on an owned scratch schema and preserve the application ledger', () => {
      const before = ledger.invoke({ action: 'snapshot' }).snapshot;
      const result = ledger.invoke({ action: 'mysql_migration_gates' });
      assert.ok(result.migrationGates); assert.equal(result.migrationGates.driver, 'mysql');
      assert.ok(result.migrationGates.assertions >= 44); assert.ok(Object.values(result.migrationGates.facts).every(value => value === true));
      assert.equal(result.migrationGates.facts.readiness_executes_zero_ddl, true);
      assert.equal(result.migrationGates.facts.retry_rejects_partial_ddl_even_without_fault_sql, true);
      migrationEvidence = result.migrationGates;
      assert.deepEqual(result.snapshot, before); checks.push('real_migrator_readiness_drift_lock_partial_ddl_scratch_isolation');
    });
    await runCase('container restart preserves committed rows and no provider/financial effects were produced', async () => {
      const before = await receiver!.inspect(); assert.equal(before.providerCalls, 0); assertNoFinancialSideEffects(before);
      await database.restart(); await receiver!.restart();
      assert.deepEqual(await receiver!.inspect(), before); checks.push('database_and_php_restart_durable_rows_provider_zero');
    });
    const final = await receiver.inspect();
    await evidence(engine, { status: 'VALIDATED', storage: final.storage, checks, queryEvidence, migrationEvidence,
      counts: final.counts, providerCalls: final.providerCalls,
      agreements: final.agreements.map(row => ({ agreementId: row.public_uuid, contractVersion: row.contract_version,
        mode: row.payment_mode, totalCents: row.total_cents, initialCents: row.initial_cents, reservationCents: row.reservation_cents, balanceCents: row.balance_cents })) });
    t.diagnostic(JSON.stringify({ engine, version: final.storage?.version, nativePrepares: final.storage?.nativePrepares,
      timeZone: final.storage?.timeZone, checkedCases: checks.length, queryAssertions: queryEvidence?.assertions,
      migrationAssertions: migrationEvidence?.assertions, counts: final.counts, providerCalls: final.providerCalls }));
  } catch (error) {
    await evidence(engine, { status: 'FAILED', checks, message: error instanceof Error ? error.message : String(error) }); throw error;
  } finally { await receiver?.close(); await ledger.close(); await database.close(); }
});
