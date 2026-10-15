<?php

declare(strict_types=1);

use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Support\Config;

/** Exercise the real patched Migrator with an error after every 0006 rebuild
 * statement. All SQL files and the file-backed ledger are disposable copies. */
function runOperationalMigrationFaultV2(string $root, string $directory): array
{
    $migrationDirectory = $directory . '/migration-fault/sqlite';
    if (!mkdir($migrationDirectory, 0700, true)) {
        throw new RuntimeException('Fresh migration fault fixture required.');
    }
    foreach (glob($root . '/migrations/sqlite/000[1245]_*.sql') ?: [] as $file) {
        if (!copy($file, $migrationDirectory . '/' . basename($file))) {
            throw new RuntimeException('Unable to copy verified legacy migration.');
        }
    }
    $config = new Config($root, 'test', 'https://synthetic.invalid', str_repeat('ab', 32),
        $directory . '/storage/migration-fault.sqlite', 1000, 3600, 5, 900);
    $pdo = Connection::open($config);
    (new Migrator($pdo, $migrationDirectory))->migrate();
    $seed = $pdo->prepare("INSERT INTO payment_agreements (public_uuid, monday_item_id, recipient_name, recipient_email, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version) VALUES ('00000000-0000-4000-8000-000000000011', NULL, 'Synthetic migration recipient', 'migration@example.test', 'Synthetic migration service', 10001, 4900, 5101, '2099-12-01 14:00:00.000000', 'America/New_York', :hash, 'v1-local', 'v1-local')");
    $seed->bindValue('hash', str_repeat('x', 32), PDO::PARAM_LOB);
    $seed->execute();
    $pdo->exec("INSERT INTO payment_schedules (public_uuid, agreement_id, kind, amount_cents, due_at_utc) VALUES ('00000000-0000-4000-8000-000000000012', 1, 'BALANCE', 5101, '2099-12-01 14:00:00.000000')");
    $read = static fn (PDO $connection): array => [
        'schema' => $connection->query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")->fetchAll(),
        'agreements' => $connection->query('SELECT * FROM payment_agreements ORDER BY id')->fetchAll(),
        'schedules' => $connection->query('SELECT * FROM payment_schedules ORDER BY id')->fetchAll(),
        'migrations' => $connection->query('SELECT * FROM schema_migrations ORDER BY version')->fetchAll(),
        'foreignKeys' => (int) $connection->query('PRAGMA foreign_keys')->fetchColumn(),
        'foreignKeyViolations' => $connection->query('PRAGMA foreign_key_check')->fetchAll(),
    ];
    $before = $read($pdo);
    $version = '0006_versioned_payment_agreement_drafts.sql';
    $sql = file_get_contents($root . '/migrations/sqlite/' . $version);
    if ($sql === false || !str_contains($sql, '-- migrate:atomic-rebuild')) {
        throw new RuntimeException('Real atomic rebuild migration required.');
    }
    file_put_contents($migrationDirectory . '/' . $version, $sql . "\nSELECT * FROM synthetic_missing_after_rebuild;\n");
    $failed = false;
    try {
        (new Migrator($pdo, $migrationDirectory))->migrate();
    } catch (PDOException) {
        $failed = true;
    }
    if (!$failed) {
        throw new RuntimeException('Injected migration fault did not fail.');
    }
    $transactionOpen = $pdo->inTransaction();
    // Reopen the actual file to verify durable rollback, not connection cache.
    $reopened = Connection::open($config);
    $afterFailure = $read($reopened);
    file_put_contents($migrationDirectory . '/' . $version, $sql);
    $applied = (new Migrator($reopened, $migrationDirectory))->migrate();
    $reapplied = (new Migrator($reopened, $migrationDirectory))->migrate();
    return ['failed' => $failed, 'transactionOpen' => $transactionOpen,
        'before' => $before, 'afterFailure' => $afterFailure,
        'applied' => $applied, 'reapplied' => $reapplied, 'afterSuccess' => $read($reopened)];
}
