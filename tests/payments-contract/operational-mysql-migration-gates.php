<?php

declare(strict_types=1);

use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Support\Config;

/** Real MySQL-family DDL has implicit commits. These probes use only the owned
 * disposable fixture, and remove only their explicitly named synthetic table
 * and receipt. They never attempt to repair or adopt a production migration. */
function runOperationalMysqlMigrationGatesV2(PDO $pdo, Config $config, string $root, string $directory): array
{
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql' || $config->environment !== 'test'
        || $config->mysqlHost !== '127.0.0.1' || $config->mysqlUser !== 'root' || $config->mysqlPassword !== ''
        || preg_match('/^gourmet_payment_test_[a-f0-9]{32}$/D', $config->mysqlDatabase) !== 1
        || !is_file($directory . '/synthetic-fixture-only') || !is_file($directory . '/database-binding.json')
        || realpath($root) !== realpath($config->root)) {
        throw new RuntimeException('Explicit owned disposable MySQL fixture required.');
    }
    if ($pdo->inTransaction()) { throw new RuntimeException('Fixture schema creation requires no open transaction.'); }
    $mainSnapshot = static function () use ($pdo): array {
        $result = [];
        $tables = $pdo->query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($tables as $table) {
            if (preg_match('/^[A-Za-z0-9_]+$/D', $table) !== 1) { throw new RuntimeException('Unexpected fixture table name.'); }
            $rows = [];
            foreach ($pdo->query('SELECT * FROM `' . $table . '`')->fetchAll(PDO::FETCH_ASSOC) as $row) { $rows[] = serialize($row); }
            sort($rows, SORT_STRING);
            $result[$table] = ['rows' => count($rows), 'sha256' => hash('sha256', serialize($rows))];
        }
        return $result;
    };
    $mainBefore = $mainSnapshot();
    $database = 'gourmet_payment_migration_test_' . bin2hex(random_bytes(12));
    $created = false;
    try {
        // Only this fresh randomly named schema inside the already owned
        // disposable container is mutable. The application's fixture is read.
        $pdo->exec('CREATE DATABASE `' . $database . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
        $created = true;
        $scratchConfig = new Config(root: $root, environment: 'test', appUrl: 'https://synthetic.invalid',
            appKey: str_repeat('ab', 32), sqlitePath: $directory . '/unused-migration-gates.sqlite',
            sqliteBusyTimeoutMs: 1000, sessionTtl: 3600, loginMaxAttempts: 5, loginWindowSeconds: 900,
            ledgerDriver: 'mysql', mysqlHost: $config->mysqlHost, mysqlPort: $config->mysqlPort,
            mysqlDatabase: $database, mysqlUser: $config->mysqlUser, mysqlPassword: $config->mysqlPassword);
        $scratchPdo = Connection::open($scratchConfig);
        (new Migrator($scratchPdo, $scratchConfig->migrationDirectory()))->migrate();
        $scratchPdo->exec("INSERT INTO customers (public_uuid, first_name, last_name, email) VALUES ('00000000-0000-4000-8000-000000000021', 'Synthetic migration', 'recipient', 'migration@example.test')");
        $customerId = (int) $scratchPdo->lastInsertId();
        $seed = $scratchPdo->prepare("INSERT INTO payment_agreements (public_uuid, customer_id, recipient_name, recipient_email, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version, status, provider) VALUES ('00000000-0000-4000-8000-000000000022', :customer, 'Synthetic migration recipient', 'migration@example.test', 'Synthetic migration service', 10001, 4900, 5101, '2099-12-01 14:00:00.000000', 'America/New_York', :hash, 'v1-local', 'v1-local', 'PENDING_RESERVATION', 'PAYPAL')");
        $seed->bindValue('customer', $customerId, PDO::PARAM_INT);
        $seed->bindValue('hash', str_repeat('x', 32), PDO::PARAM_LOB);
        $seed->execute();
        $agreementId = (int) $scratchPdo->lastInsertId();
        $schedule = $scratchPdo->prepare('INSERT INTO payment_schedules (public_uuid, agreement_id, kind, amount_cents, due_at_utc) VALUES (:uuid, :agreement, :kind, :amount, :due)');
        foreach ([['00000000-0000-4000-8000-000000000023', 'RESERVATION', 4900, '2026-10-01 12:00:00.000000'],
            ['00000000-0000-4000-8000-000000000024', 'BALANCE', 5101, '2099-12-01 14:00:00.000000']] as [$uuid, $kind, $amount, $due]) {
            $schedule->execute(['uuid' => $uuid, 'agreement' => $agreementId, 'kind' => $kind, 'amount' => $amount, 'due' => $due]);
        }
        $result = runOperationalMysqlMigrationGateProbesV2($scratchPdo, $scratchConfig, $root, $directory);
    } finally {
        if ($created) { $pdo->exec('DROP DATABASE `' . $database . '`'); }
    }
    $mainAfter = $mainSnapshot();
    if ($mainBefore !== $mainAfter) { throw new RuntimeException('Migration probes changed the main application fixture.'); }
    ++$result['assertions'];
    $result['facts']['main_application_fixture_every_row_preserved'] = true;
    $result['mainBefore'] = $mainBefore;
    $result['mainAfter'] = $mainAfter;
    $result['scratchSchemaDropped'] = true;
    return $result;
}

/** Internal probes operate only on the freshly allocated scratch schema. */
function runOperationalMysqlMigrationGateProbesV2(PDO $pdo, Config $config, string $root, string $directory): array
{
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql' || $config->environment !== 'test'
        || preg_match('/^gourmet_payment_migration_test_[a-f0-9]{24}$/D', $config->mysqlDatabase) !== 1
        || !is_file($directory . '/synthetic-fixture-only')) {
        throw new RuntimeException('Explicit fresh synthetic migration schema required.');
    }
    $assertions = 0;
    $facts = [];
    $check = static function (bool $condition, string $name) use (&$assertions, &$facts): void {
        ++$assertions;
        if (!$condition) { throw new RuntimeException('Synthetic migration gate failed: ' . $name); }
        $facts[$name] = true;
    };
    $blocked = static function (callable $run, string $expected, string $name) use ($check): string {
        try { $unexpected = $run(); } catch (RuntimeException $exception) {
            $check($exception->getMessage() === $expected, $name);
            return $exception->getMessage();
        }
        throw new RuntimeException('Synthetic migration gate unexpectedly accepted: ' . $name
            . '; returned ' . json_encode($unexpected, JSON_THROW_ON_ERROR));
    };
    $tableNames = static fn (PDO $connection): array => $connection->query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    )->fetchAll(PDO::FETCH_COLUMN);
    $businessSnapshot = static function (PDO $connection) use ($tableNames): array {
        $tables = [];
        foreach ($tableNames($connection) as $table) {
            if (in_array($table, ['schema_migrations', 'schema_migration_attempts',
                'synthetic_migration_fault_probe', 'synthetic_migration_engine_probe'], true)) { continue; }
            if (preg_match('/^[A-Za-z0-9_]+$/D', $table) !== 1) { throw new RuntimeException('Unexpected fixture table name.'); }
            $rows = [];
            foreach ($connection->query('SELECT * FROM `' . $table . '`')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                ksort($row, SORT_STRING);
                // Binary hashes/ciphertexts are encoded losslessly; rows are
                // sorted independently of the engine's physical scan order.
                foreach ($row as &$value) {
                    $value = is_string($value) ? ['string', base64_encode($value)] : [get_debug_type($value), $value];
                }
                unset($value);
                $rows[] = json_encode($row, JSON_THROW_ON_ERROR);
            }
            sort($rows, SORT_STRING);
            $tables[$table] = ['rows' => count($rows), 'sha256' => hash('sha256', json_encode($rows, JSON_THROW_ON_ERROR))];
        }
        return ['tables' => $tables, 'sha256' => hash('sha256', json_encode($tables, JSON_THROW_ON_ERROR))];
    };
    $ddlCounters = static function (PDO $connection): array {
        $rows = $connection->query("SHOW SESSION STATUS WHERE Variable_name IN ('Com_create_table','Com_alter_table','Com_drop_table','Com_rename_table','Com_truncate','Com_create_index','Com_drop_index','Com_create_trigger','Com_drop_trigger')")->fetchAll(PDO::FETCH_KEY_PAIR);
        ksort($rows, SORT_STRING);
        return array_map('intval', $rows);
    };
    $versions = static fn (PDO $connection): array => $connection->query('SELECT version FROM schema_migrations ORDER BY version')->fetchAll(PDO::FETCH_COLUMN);
    $migrationDirectory = $config->migrationDirectory();
    $migrator = new Migrator($pdo, $migrationDirectory);
    $businessBefore = $businessSnapshot($pdo);
    $versionsBefore = $versions($pdo);
    $check($versionsBefore === ['0001_payment_foundation.sql', '0002_paypal_sandbox_poc.sql', '0003_checkout_experience.sql',
        '0004_current_payment_ledger.sql', '0005_versioned_payment_agreement_drafts.sql', '0006_versioned_payment_checkouts.sql'],
        'six_attested_fixture_migrations_required');
    $check(!$pdo->inTransaction(), 'fixture_starts_outside_transaction');

    $tablesBefore = $tableNames($pdo);
    $ddlBefore = $ddlCounters($pdo);
    $migrator->assertCurrent();
    $ddlAfter = $ddlCounters($pdo);
    $tablesAfter = $tableNames($pdo);
    $check($ddlBefore === $ddlAfter, 'readiness_executes_zero_ddl');
    $check($tablesBefore === $tablesAfter, 'readiness_changes_zero_tables');
    $check($businessBefore === $businessSnapshot($pdo), 'readiness_preserves_business_rows');
    $readiness = ['ddlBefore' => $ddlBefore, 'ddlAfter' => $ddlAfter,
        'tableCountBefore' => count($tablesBefore), 'tableCountAfter' => count($tablesAfter), 'tableCountDelta' => count($tablesAfter) - count($tablesBefore)];

    $scratch = $directory . '/mysql-migration-gates';
    if (!mkdir($scratch, 0700)) { throw new RuntimeException('Fresh synthetic migration directory required.'); }
    foreach ($versionsBefore as $version) {
        if (!copy($migrationDirectory . '/' . $version, $scratch . '/' . $version)) {
            throw new RuntimeException('Unable to copy attested fixture migration.');
        }
    }
    $driftVersion = $versionsBefore[0];
    $driftFile = $scratch . '/' . $driftVersion;
    $originalSql = file_get_contents($driftFile);
    if (!is_string($originalSql)) { throw new RuntimeException('Unable to read fixture SQL.'); }
    file_put_contents($driftFile, $originalSql . "\n-- synthetic checksum drift only\n");
    try {
        $checksumDrift = $blocked(static fn () => (new Migrator($pdo, $scratch))->assertCurrent(),
            'MYSQL_MIGRATION_CHECKSUM_MISMATCH', 'readiness_rejects_changed_sql_checksum');
        $blocked(static fn () => (new Migrator($pdo, $scratch))->migrate(),
            'MYSQL_MIGRATION_CHECKSUM_MISMATCH', 'migration_rejects_changed_sql_checksum');
    } finally { file_put_contents($driftFile, $originalSql); }

    // Only these DML probes roll back. No DDL occurs inside either transaction.
    $pdo->beginTransaction();
    try {
        $remove = $pdo->prepare('DELETE FROM schema_migrations WHERE version = :version');
        $remove->execute(['version' => $driftVersion]);
        $check($remove->rowCount() === 1, 'missing_version_fixture_removed_one_receipt');
        $missingVersion = $blocked(static fn () => $migrator->assertCurrent(),
            'MYSQL_SCHEMA_MIGRATION_REQUIRED', 'readiness_rejects_missing_version');
    } finally { if ($pdo->inTransaction()) { $pdo->rollBack(); } }
    $migrator->assertCurrent();
    $check($versionsBefore === $versions($pdo), 'missing_version_probe_rolls_back');
    $pdo->beginTransaction();
    try {
        $remove = $pdo->prepare('DELETE FROM schema_migration_attempts WHERE version = :version');
        $remove->execute(['version' => $driftVersion]);
        $check($remove->rowCount() === 1, 'legacy_attestation_fixture_removed_one_receipt');
        $legacyAttestation = $blocked(static fn () => $migrator->assertCurrent(),
            'MYSQL_LEGACY_MIGRATION_ATTESTATION_REQUIRED', 'readiness_rejects_unattested_legacy_version');
    } finally { if ($pdo->inTransaction()) { $pdo->rollBack(); } }
    $migrator->assertCurrent();
    $check($businessBefore === $businessSnapshot($pdo), 'transactional_receipt_probes_preserve_business_rows');

    // CLI migrations require no open transaction. Unknown receipts therefore
    // use explicit autocommit inserts and exact synthetic-receipt cleanup in
    // this scratch schema, never a transaction around MySQL DDL.
    $unknownAttemptGates = [];
    foreach (['APPLIED' => 'MYSQL_SCHEMA_VERSION_DRIFT', 'STARTED' => 'MYSQL_PARTIAL_MIGRATION_REQUIRES_RECOVERY'] as $state => $expected) {
        $version = '9001_synthetic_unknown_' . strtolower($state) . '_' . bin2hex(random_bytes(8)) . '.sql';
        $checksum = hash('sha256', 'Synthetic unknown migration receipt: ' . $version, true);
        $insert = $pdo->prepare('INSERT INTO schema_migration_attempts (version, checksum, state, started_at, completed_at) VALUES (:version, :checksum, :state, :started, :completed)');
        $insert->bindValue('version', $version);
        $insert->bindValue('checksum', $checksum, PDO::PARAM_LOB);
        $insert->bindValue('state', $state);
        $insert->bindValue('started', '2026-10-01 12:00:00.000000');
        $insert->bindValue('completed', $state === 'APPLIED' ? '2026-10-01 12:00:01.000000' : null,
            $state === 'APPLIED' ? PDO::PARAM_STR : PDO::PARAM_NULL);
        $insert->execute();
        $check($insert->rowCount() === 1 && !$pdo->inTransaction(), 'unknown_' . strtolower($state) . '_receipt_is_autocommitted');
        try {
            $unknownAttemptGates[$state] = [
                'readiness' => $blocked(static fn () => $migrator->assertCurrent(), $expected,
                    'readiness_rejects_unknown_' . strtolower($state) . '_receipt'),
                'migration' => $blocked(static fn () => $migrator->migrate(), $expected,
                    'migration_rejects_unknown_' . strtolower($state) . '_receipt'),
            ];
        } finally {
            $remove = $pdo->prepare('DELETE FROM schema_migration_attempts WHERE version = :version AND checksum = :checksum AND state = :state');
            $remove->bindValue('version', $version);
            $remove->bindValue('checksum', $checksum, PDO::PARAM_LOB);
            $remove->bindValue('state', $state);
            $remove->execute();
            $check($remove->rowCount() === 1, 'unknown_' . strtolower($state) . '_synthetic_receipt_explicitly_removed');
        }
        $migrator->assertCurrent();
    }
    $check($businessBefore === $businessSnapshot($pdo), 'unknown_receipt_gates_preserve_business_rows');

    $other = Connection::open($config);
    $lockName = 'gourmet:migrate:' . substr(hash('sha256', $config->mysqlDatabase), 0, 47);
    $lock = $other->prepare('SELECT GET_LOCK(:name, 0)');
    $lock->execute(['name' => $lockName]);
    $check((int) $lock->fetchColumn() === 1, 'independent_connection_owns_migration_lock');
    try {
        $migrationLock = $blocked(static fn () => $migrator->assertCurrent(),
            'MYSQL_MIGRATION_IN_PROGRESS', 'readiness_rejects_independent_migration_lock');
    } finally {
        $release = $other->prepare('SELECT RELEASE_LOCK(:name)');
        $release->execute(['name' => $lockName]);
        $check((int) $release->fetchColumn() === 1, 'independent_migration_lock_released');
    }
    $migrator->assertCurrent();

    $check(!in_array('synthetic_migration_engine_probe', $tableNames($pdo), true), 'engine_probe_name_unused');
    $pdo->exec('CREATE TABLE synthetic_migration_engine_probe (id INT PRIMARY KEY) ENGINE=MyISAM');
    try {
        $nonInnoDb = $blocked(static fn () => $migrator->assertCurrent(),
            'MYSQL_INNODB_REQUIRED', 'readiness_rejects_non_innodb_table');
    } finally { $pdo->exec('DROP TABLE synthetic_migration_engine_probe'); }
    $migrator->assertCurrent();

    $faultVersion = '0007_synthetic_migration_fault.sql';
    $faultSql = "CREATE TABLE synthetic_migration_fault_probe (id INT PRIMARY KEY, fixture VARCHAR(32) NOT NULL) ENGINE=InnoDB;\n"
        . "THIS IS DELIBERATELY INVALID SYNTHETIC SQL;\n";
    $check(!in_array('synthetic_migration_fault_probe', $tableNames($pdo), true), 'partial_ddl_probe_name_unused');
    $findAttempt = $pdo->prepare('SELECT checksum, state FROM schema_migration_attempts WHERE version = :version');
    $findAttempt->execute(['version' => $faultVersion]);
    $check($findAttempt->fetch() === false, 'partial_ddl_attempt_name_unused');
    file_put_contents($scratch . '/' . $faultVersion, $faultSql);
    $faultMigrator = new Migrator($pdo, $scratch);
    try {
        $failed = false;
        try { $faultMigrator->migrate(); } catch (PDOException $exception) {
            $failed = true;
            $sqlState = (string) $exception->getCode();
        }
        $check($failed, 'invalid_sql_fails_after_real_create_table');
        $check(!$pdo->inTransaction(), 'mysql_ddl_failure_is_not_claimed_transactional');
        // Observe durable state through a different real connection, not only
        // the connection that executed the implicitly committed DDL.
        $durable = Connection::open($config);
        $check(in_array('synthetic_migration_fault_probe', $tableNames($durable), true), 'partial_ddl_table_is_durable');
        $durableAttempt = $durable->prepare('SELECT checksum, state FROM schema_migration_attempts WHERE version = :version');
        $durableAttempt->execute(['version' => $faultVersion]);
        $attempt = $durableAttempt->fetch();
        $check(is_array($attempt) && $attempt['state'] === 'STARTED'
            && hash_equals(hash('sha256', $faultSql, true), $attempt['checksum']), 'partial_ddl_started_receipt_is_durable');
        $check($versions($durable) === $versionsBefore, 'partial_ddl_never_records_applied_version');
        $check($businessSnapshot($durable) === $businessBefore, 'partial_ddl_preserves_every_business_row');
        $withFaultDirectory = $blocked(static fn () => $faultMigrator->migrate(),
            'MYSQL_PARTIAL_MIGRATION_REQUIRES_RECOVERY', 'retry_rejects_partial_ddl');
        $withCurrentDirectory = $blocked(static fn () => $migrator->migrate(),
            'MYSQL_PARTIAL_MIGRATION_REQUIRES_RECOVERY', 'retry_rejects_partial_ddl_even_without_fault_sql');
        $readinessWithFault = $blocked(static fn () => $faultMigrator->assertCurrent(),
            'MYSQL_PARTIAL_MIGRATION_REQUIRES_RECOVERY', 'readiness_rejects_partial_ddl');
        $readinessWithoutFault = $blocked(static fn () => $migrator->assertCurrent(),
            'MYSQL_PARTIAL_MIGRATION_REQUIRES_RECOVERY', 'readiness_rejects_partial_ddl_even_without_fault_sql');
        $partialDdl = ['sqlState' => $sqlState, 'durableTable' => true, 'durableAttemptState' => $attempt['state'],
            'appliedBefore' => $versionsBefore, 'appliedAfterFailure' => $versions($durable),
            'retryWithFaultDirectory' => $withFaultDirectory, 'retryWithCurrentDirectory' => $withCurrentDirectory,
            'readinessWithFaultDirectory' => $readinessWithFault, 'readinessWithCurrentDirectory' => $readinessWithoutFault,
            'cleanup' => 'explicit_synthetic_fixture_only'];
    } finally {
        // This is explicit test cleanup of this named synthetic probe, never
        // an automatic recovery mechanism in Migrator or Application.
        $pdo->exec('DROP TABLE IF EXISTS synthetic_migration_fault_probe');
        $cleanup = $pdo->prepare("DELETE FROM schema_migration_attempts WHERE version = :version AND checksum = :checksum AND state = 'STARTED'");
        $cleanup->bindValue('version', $faultVersion);
        $cleanup->bindValue('checksum', hash('sha256', $faultSql, true), PDO::PARAM_LOB);
        $cleanup->execute();
        unlink($scratch . '/' . $faultVersion);
    }
    $migrator->assertCurrent();
    $check($migrator->migrate() === [], 'explicit_fixture_cleanup_restores_current_schema');
    $check($versions($pdo) === $versionsBefore, 'all_applied_versions_preserved');
    $check($tablesBefore === $tableNames($pdo), 'all_original_tables_preserved_after_probe_cleanup');
    $businessAfter = $businessSnapshot($pdo);
    $check($businessBefore === $businessAfter, 'every_business_row_and_binary_hash_preserved');
    return ['assertions' => $assertions, 'facts' => $facts, 'driver' => 'mysql',
        'engineVersion' => $pdo->query('SELECT VERSION()')->fetchColumn(), 'businessBefore' => $businessBefore, 'businessAfter' => $businessAfter,
        'readiness' => $readiness, 'checksumDrift' => $checksumDrift, 'missingVersion' => $missingVersion,
        'legacyAttestation' => $legacyAttestation, 'unknownAttemptGates' => $unknownAttemptGates,
        'migrationLock' => $migrationLock, 'nonInnoDb' => $nonInnoDb, 'partialDdl' => $partialDdl];
}
