<?php

declare(strict_types=1);

use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Support\Config;

/** Exercise the real patched Migrator with an error after every target rebuild
 * statement. All SQL files and the file-backed ledger are disposable copies. */
function runOperationalMigrationFaultV2(string $root, string $directory,
    string $version = '0006_versioned_payment_agreement_drafts.sql', ?string $draftBody = null): array
{
    if (!in_array($version, ['0006_versioned_payment_agreement_drafts.sql', '0007_versioned_payment_checkouts.sql'], true)) {
        throw new RuntimeException('Explicit known synthetic rebuild target required.');
    }
    $fixtureName = substr($version, 0, 4);
    $migrationDirectory = $directory . '/migration-fault-' . $fixtureName . '/sqlite';
    if (!mkdir($migrationDirectory, 0700, true)) {
        throw new RuntimeException('Fresh migration fault fixture required.');
    }
    foreach (glob($root . '/migrations/sqlite/*.sql') ?: [] as $file) {
        if (strcmp(basename($file), $version) >= 0) { continue; }
        if (!copy($file, $migrationDirectory . '/' . basename($file))) {
            throw new RuntimeException('Unable to copy verified legacy migration.');
        }
    }
    $config = new Config($root, 'test', 'https://synthetic.invalid', str_repeat('ab', 32),
        $directory . '/storage/migration-fault-' . $fixtureName . '.sqlite', 1000, 3600, 5, 900);
    $pdo = Connection::open($config);
    (new Migrator($pdo, $migrationDirectory))->migrate();
    $seed = $pdo->prepare("INSERT INTO payment_agreements (public_uuid, monday_item_id, recipient_name, recipient_email, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version) VALUES ('00000000-0000-4000-8000-000000000011', NULL, 'Synthetic migration recipient', 'migration@example.test', 'Synthetic migration service', 10001, 4900, 5101, '2099-12-01 14:00:00.000000', 'America/New_York', :hash, 'v1-local', 'v1-local')");
    $seed->bindValue('hash', str_repeat('x', 32), PDO::PARAM_LOB);
    $seed->execute();
    $pdo->exec("INSERT INTO payment_schedules (public_uuid, agreement_id, kind, amount_cents, due_at_utc) VALUES ('00000000-0000-4000-8000-000000000012', 1, 'BALANCE', 5101, '2099-12-01 14:00:00.000000')");
    if ($draftBody !== null) {
        $command = \Gourmet\Payments\Http\OperationalPaymentAgreementV2::fromJson($draftBody, (int) floor(microtime(true) * 1000));
        (new \Gourmet\Payments\Domain\PaymentAgreementService($pdo))->createDraftV2($command->operationArray(), new DateTimeImmutable('now', new DateTimeZone('UTC')));
        $pdo->exec("INSERT INTO payment_consents (public_uuid,agreement_id,provider,consent_type,terms_version,amount_cents,accepted_at) VALUES ('00000000-0000-4000-8000-000000000013',1,'PAYPAL','NON_REFUNDABLE_RESERVATION','v1-local',4900,'2026-10-01 12:00:00.000000')");
        $pdo->exec("UPDATE sqlite_sequence SET seq = 90000 WHERE name = 'payment_agreements'");
        $pdo->exec("UPDATE sqlite_sequence SET seq = 80000 WHERE name = 'payment_consents'");
    }
    $read = static function (PDO $connection): array {
        $allRows = [];
        foreach ($connection->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN) as $table) {
            if (preg_match('/^[a-z_]+$/D', $table) !== 1) { throw new RuntimeException('Unexpected disposable fixture table.'); }
            $rows = [];
            foreach ($connection->query('SELECT * FROM ' . $table)->fetchAll(PDO::FETCH_ASSOC) as $row) { ksort($row); $rows[] = serialize($row); }
            sort($rows, SORT_STRING); $allRows[$table] = ['rows' => count($rows), 'sha256' => hash('sha256', serialize($rows))];
        }
        return [
        'schema' => $connection->query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")->fetchAll(),
        'allRows' => $allRows,
        'agreements' => $connection->query('SELECT * FROM payment_agreements ORDER BY id')->fetchAll(),
        'schedules' => $connection->query('SELECT * FROM payment_schedules ORDER BY id')->fetchAll(),
        'consents' => $connection->query('SELECT * FROM payment_consents ORDER BY id')->fetchAll(),
        'sequences' => $connection->query('SELECT name,seq FROM sqlite_sequence ORDER BY name')->fetchAll(),
        'migrations' => $connection->query('SELECT * FROM schema_migrations ORDER BY version')->fetchAll(),
        'foreignKeys' => (int) $connection->query('PRAGMA foreign_keys')->fetchColumn(),
        'foreignKeyViolations' => $connection->query('PRAGMA foreign_key_check')->fetchAll(),
    ]; };
    $before = $read($pdo);
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
