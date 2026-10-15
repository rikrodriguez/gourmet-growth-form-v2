<?php

declare(strict_types=1);

// New synthetic harness, never the original destructive E2E. The Node test
// supplies a verified, patched runtime and a disposable directory explicitly.
use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Auth\AdminBootstrap;
use Gourmet\Payments\Domain\Money;
use Gourmet\Payments\Domain\PaymentAgreementService;
use Gourmet\Payments\Http\Application;
use Gourmet\Payments\Http\OperationalPaymentAgreementV2;
use Gourmet\Payments\Http\InternalCheckoutEmissionV1;
use Gourmet\Payments\Http\Request;
use Gourmet\Payments\Http\Response;
use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Payments\PayPal\PayPalHttpResponse;
use Gourmet\Payments\Payments\PayPal\PayPalHttpTransport;
use Gourmet\Payments\Support\Config;
use Gourmet\Payments\Security\Secrets;
use Gourmet\Payments\Security\PaymentLinkReplayCipher;

ini_set('display_errors', 'stderr');
error_reporting(E_ALL);
$root = $argv[1] ?? '';
$directory = $argv[2] ?? '';
if (!is_dir($root . '/src') || !is_dir($directory) || !is_file($directory . '/synthetic-fixture-only')) {
    throw new RuntimeException('Explicit disposable runtime and fixture directory required.');
}
require $root . '/bootstrap/autoload.php';
require __DIR__ . '/operational-config.php';
$input = json_decode((string) stream_get_contents(STDIN), true, 40, JSON_THROW_ON_ERROR);
if (!is_array($input)) {
    throw new RuntimeException('Synthetic fixture input required.');
}
$config = operationalFixtureConfigV2($root, $directory, $input['production'] ?? false);
$pdo = Connection::open($config);
$mysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
$transport = new class implements PayPalHttpTransport {
    public int $calls = 0;
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutSeconds): PayPalHttpResponse
    {
        ++$this->calls;
        throw new RuntimeException('Synthetic draft attempted provider transport.');
    }
};
$application = new Application($config, new JsonLogger($directory . '/logs.jsonl'), $transport);
$readResponse = static function (Response $response): array {
    return (function (): array { return ['status' => $this->status, 'body' => $this->body]; })->call($response);
};
$snapshot = static function () use ($pdo, $mysql): array {
    $tables = ['payment_agreements', 'payment_schedules', 'payment_attempts', 'payment_consents',
        'provider_resources', 'provider_webhook_events', 'email_outbox', 'monday_sync_outbox',
        'sales_os_event_outbox', 'audit_events', 'idempotency_keys', 'admin_users', 'admin_bootstrap_tokens'];
    $counts = [];
    foreach ($tables as $table) {
        $counts[$table] = (int) $pdo->query('SELECT COUNT(*) FROM ' . $table)->fetchColumn();
    }
    $violations = [];
    if ($mysql) {
        $counts['customers'] = (int) $pdo->query('SELECT COUNT(*) FROM customers')->fetchColumn();
        foreach ([['payment_agreements', 'customer_id', 'customers'], ['payment_schedules', 'agreement_id', 'payment_agreements'], ['payment_attempts', 'schedule_id', 'payment_schedules'],
            ['payment_consents', 'agreement_id', 'payment_agreements'], ['provider_resources', 'agreement_id', 'payment_agreements']] as [$child, $foreignKey, $parent]) {
            foreach ($pdo->query("SELECT c.id FROM $child c LEFT JOIN $parent p ON c.$foreignKey = p.id WHERE c.$foreignKey IS NOT NULL AND p.id IS NULL")->fetchAll(PDO::FETCH_COLUMN) as $id) {
                $violations[] = ['table' => $child, 'id' => $id];
            }
        }
        $version = (string) $pdo->query('SELECT VERSION()')->fetchColumn();
        $storage = ['driver' => 'mysql', 'engine' => stripos($version, 'MariaDB') === false ? 'mysql' : 'mariadb', 'version' => $version,
            'database' => $pdo->query('SELECT DATABASE()')->fetchColumn(), 'nativePrepares' => !$pdo->getAttribute(PDO::ATTR_EMULATE_PREPARES),
            'foreignKeysEnabled' => (int) $pdo->query('SELECT @@FOREIGN_KEY_CHECKS')->fetchColumn() === 1,
            'collation' => $pdo->query('SELECT @@collation_connection')->fetchColumn(),
            'timeZone' => $pdo->query('SELECT @@session.time_zone')->fetchColumn(), 'sqlMode' => $pdo->query('SELECT @@session.sql_mode')->fetchColumn()];
    } else {
        $violations = $pdo->query('PRAGMA foreign_key_check')->fetchAll();
        $storage = ['driver' => 'sqlite', 'engine' => 'sqlite', 'version' => $pdo->query('SELECT sqlite_version()')->fetchColumn(),
            'foreignKeysEnabled' => (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn() === 1];
    }
    $tableNames = $pdo->query($mysql
        ? "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
    $allRows = [];
    $rowHashes = [];
    foreach ($tableNames as $table) {
        if (preg_match('/^[A-Za-z0-9_]+$/D', $table) !== 1) { throw new RuntimeException('Unexpected synthetic table name.'); }
        $rows = [];
        foreach ($pdo->query('SELECT * FROM `' . $table . '`')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            ksort($row, SORT_STRING);
            $rows[] = serialize($row);
        }
        sort($rows, SORT_STRING);
        $allRows[$table] = ['rows' => count($rows), 'sha256' => hash('sha256', serialize($rows))];
        $rowHashes[$table] = array_map(static fn (string $row): string => hash('sha256', $row), $rows);
        $counts[$table] = count($rows);
    }
    $checkoutIssuances = in_array('payment_checkout_issuances', $tableNames, true)
        ? $pdo->query('SELECT i.*, p.public_uuid AS source_draft_uuid, c.public_uuid AS checkout_uuid FROM payment_checkout_issuances i JOIN payment_agreements p ON p.id = i.parent_draft_id JOIN payment_agreements c ON c.id = i.checkout_agreement_id ORDER BY i.id')->fetchAll()
        : [];
    foreach ($checkoutIssuances as &$issuance) {
        foreach (['source_operation_digest', 'conditions_digest'] as $field) {
            if (is_string($issuance[$field] ?? null) && strlen($issuance[$field]) === 32) { $issuance[$field] = bin2hex($issuance[$field]); }
        }
    }
    unset($issuance);
    return [
        'counts' => $counts,
        'tableNames' => $tableNames,
        'allRows' => $allRows,
        'rowHashes' => $rowHashes,
        'checkoutIssuances' => $checkoutIssuances,
        'agreements' => $pdo->query("SELECT public_uuid, contract_version, payment_mode, initial_cents, operation_id, operation_digest, operation_json, configuration_id, configuration_digest, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, recipient_phone, service_name, event_at_utc, event_location, currency, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status, provider, public_token_hash IS NULL AS token_is_null, CASE WHEN public_token_hash IS NULL THEN NULL ELSE 'synthetic-present' END AS public_token_hash, link_expires_at, terms_version, reservation_policy_version, created_at, updated_at FROM payment_agreements ORDER BY id")->fetchAll(),
        'schedules' => $pdo->query('SELECT a.public_uuid AS agreement_uuid, s.kind, s.amount_cents, s.due_at_utc, s.status, s.paid_at FROM payment_schedules s JOIN payment_agreements a ON a.id = s.agreement_id ORDER BY s.id')->fetchAll(),
        'idempotency' => $pdo->query('SELECT scope, idempotency_key, lower(hex(request_hash)) AS request_hash, response_status, completed_at, locked_until, response_ciphertext IS NOT NULL AS encrypted_response FROM idempotency_keys ORDER BY id')->fetchAll(),
        'audit' => $pdo->query('SELECT event_type, aggregate_public_uuid, metadata_json FROM audit_events ORDER BY id')->fetchAll(),
        'migrations' => $pdo->query('SELECT version FROM schema_migrations ORDER BY version')->fetchAll(PDO::FETCH_COLUMN),
        'foreignKeyViolations' => $violations,
        'storage' => $storage,
    ];
};

$action = $input['action'] ?? '';
$result = [];
if ($action === 'initialize') {
    // Run byte-identical original migrations first and seed a historical v1
    // fixture with a synthetic hash. Never call v1 create/token generation.
    if ($input['seedLegacy'] ?? false) {
        (new Migrator($pdo, $directory . '/legacy-migrations/' . ($mysql ? 'mysql' : 'sqlite')))->migrate();
        if ($mysql) {
            $pdo->exec("INSERT INTO customers (public_uuid, first_name, last_name, email, phone) VALUES ('00000000-0000-4000-8000-000000000010', 'Synthetic legacy', 'recipient', 'legacy@example.test', '+1 202 555 0101')");
            $customerId = (int) $pdo->lastInsertId();
            $statement = $pdo->prepare("INSERT INTO payment_agreements (public_uuid, customer_id, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version, status, provider) VALUES (:uuid, :customer, :service, 10001, 4900, 5101, :due, :timezone, :hash, :terms, :policy, 'PENDING_RESERVATION', 'PAYPAL')");
            $statement->bindValue('customer', $customerId, PDO::PARAM_INT);
        } else {
            $statement = $pdo->prepare('INSERT INTO payment_agreements (public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version) VALUES (:uuid, NULL, :lead, :quote, :version, :name, :email, :service, 10001, 4900, 5101, :due, :timezone, :hash, :terms, :policy)');
            $statement->bindValue('lead', 'synthetic-legacy-lead');
            $statement->bindValue('quote', 'synthetic-legacy-quote');
            $statement->bindValue('version', '1');
            $statement->bindValue('name', 'Synthetic legacy recipient');
            $statement->bindValue('email', 'legacy@example.test');
        }
        $statement->bindValue('uuid', '00000000-0000-4000-8000-000000000001');
        $statement->bindValue('service', 'Synthetic legacy service');
        $statement->bindValue('due', '2099-12-01 14:00:00.000000');
        $statement->bindValue('timezone', 'America/New_York');
        $statement->bindValue('hash', hex2bin(str_repeat('ab', 32)), PDO::PARAM_LOB);
        $statement->bindValue('terms', 'v1-local');
        $statement->bindValue('policy', 'v1-local');
        $statement->execute();
        $id = (int) $pdo->lastInsertId();
        $schedule = $pdo->prepare('INSERT INTO payment_schedules (public_uuid, agreement_id, kind, amount_cents, due_at_utc) VALUES (:uuid, :agreement, :kind, :amount, :due)');
        foreach ([['00000000-0000-4000-8000-000000000002', 'RESERVATION', 4900, '2026-10-01 12:00:00.000000'], ['00000000-0000-4000-8000-000000000003', 'BALANCE', 5101, '2099-12-01 14:00:00.000000']] as [$uuid, $kind, $amount, $due]) {
            $schedule->execute(['uuid' => $uuid, 'agreement' => $id, 'kind' => $kind, 'amount' => $amount, 'due' => $due]);
        }
        if ($mysql) {
            $customer = $pdo->prepare('INSERT INTO customers (public_uuid, first_name, last_name, email) VALUES (:uuid, :first, :last, :email)');
            $customer->execute(['uuid' => '00000000-0000-4000-8000-000000000020', 'first' => str_repeat('N', 100), 'last' => str_repeat('L', 100), 'email' => 'legacy-boundary@example.test']);
            $customerId = (int) $pdo->lastInsertId();
            $long = $pdo->prepare("INSERT INTO payment_agreements (public_uuid, customer_id, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version, status) VALUES ('00000000-0000-4000-8000-000000000021', :customer, 10001, 4900, 5101, '2099-12-01 14:00:00.000000', 'UTC', :hash, 'v1-local', 'v1-local', 'PENDING_RESERVATION')");
            $long->bindValue('customer', $customerId, PDO::PARAM_INT);
            $long->bindValue('hash', hex2bin(str_repeat('cd', 32)), PDO::PARAM_LOB);
            $long->execute();
        }
        $result['legacyBeforeMigration'] = $pdo->query('SELECT public_uuid, total_cents, reservation_cents, balance_cents, public_token_hash IS NOT NULL AS token_present, created_at, updated_at FROM payment_agreements ORDER BY id')->fetchAll();
        $result['legacyMoney'] = Money::agreement(10001);
    }
    $result['applied'] = (new Migrator($pdo, $config->migrationDirectory()))->migrate();
} elseif ($action === 'install_audit_failure') {
    $pdo->exec($mysql
        ? "CREATE TRIGGER synthetic_abort_final_v2_audit BEFORE INSERT ON audit_events FOR EACH ROW BEGIN IF NEW.event_type = 'INTERNAL_PAYMENT_DRAFT_V2_REQUESTED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SYNTHETIC_FINAL_AUDIT_FAILURE'; END IF; END"
        : "CREATE TRIGGER synthetic_abort_final_v2_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'INTERNAL_PAYMENT_DRAFT_V2_REQUESTED' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_FINAL_AUDIT_FAILURE'); END");
} elseif ($action === 'remove_audit_failure') {
    $pdo->exec('DROP TRIGGER synthetic_abort_final_v2_audit');
} elseif ($action === 'install_checkout_audit_failure') {
    $pdo->exec($mysql
        ? "CREATE TRIGGER synthetic_abort_checkout_audit BEFORE INSERT ON audit_events FOR EACH ROW BEGIN IF NEW.event_type = 'PAYMENT_CHECKOUT_V1_ISSUED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SYNTHETIC_CHECKOUT_AUDIT_FAILURE'; END IF; END"
        : "CREATE TRIGGER synthetic_abort_checkout_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'PAYMENT_CHECKOUT_V1_ISSUED' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_CHECKOUT_AUDIT_FAILURE'); END");
} elseif ($action === 'remove_checkout_audit_failure') {
    $pdo->exec('DROP TRIGGER synthetic_abort_checkout_audit');
} elseif ($action === 'historical_draft') {
    // Seed a historical immutable draft using the real domain service and an
    // explicit past creation clock. The checkout route still uses its actual
    // current server clock; no application clock or stored row is rewritten.
    $at = $input['atMs'] ?? null;
    if (!is_int($at) || $at < 0 || $at >= (int) floor(microtime(true) * 1000)) {
        throw new RuntimeException('Explicit past synthetic draft time required.');
    }
    $command = OperationalPaymentAgreementV2::fromJson($input['body'] ?? '', $at);
    $now = DateTimeImmutable::createFromFormat('U.u', sprintf('%d.%06d', intdiv($at, 1000), ($at % 1000) * 1000));
    if ($now === false) { throw new RuntimeException('Invalid historical fixture time.'); }
    $created = (new PaymentAgreementService($pdo))->createDraftV2($command->operationArray(), $now);
    $result['historicalDraftId'] = $created['agreement_uuid'];
} elseif ($action === 'checkout_expired_route') {
    $token = $input['token'] ?? '';
    if (!is_string($token) || preg_match('/^[A-Za-z0-9_-]{43}$/D', $token) !== 1) {
        throw new RuntimeException('An actual synthetic checkout token is required.');
    }
    $lookup = $pdo->prepare('SELECT link_expires_at FROM payment_agreements WHERE contract_version = 3 AND public_token_hash = :hash');
    $lookup->bindValue('hash', hash('sha256', $token, true), PDO::PARAM_LOB); $lookup->execute();
    $expiry = $lookup->fetchColumn();
    $afterExpiration = new DateTimeImmutable('2100-01-01T00:00:00Z');
    if (!is_string($expiry) || new DateTimeImmutable($expiry, new DateTimeZone('UTC')) >= $afterExpiration) {
        throw new RuntimeException('Explicit expiring synthetic checkout before the fixture clock is required.');
    }
    // Only constructor DI changes this Application's clock. Neither its HTTP
    // input nor the immutable child/parent/receipt is modified to simulate age.
    $expiredApplication = new Application($config, new JsonLogger($directory . '/logs.jsonl'), $transport,
        static fn (): DateTimeImmutable => $afterExpiration);
    $result['response'] = $readResponse($expiredApplication->handle(new Request(
        'GET', '/pay/' . $token, [], [], [], '127.0.0.1', 'Synthetic expired checkout fixture', true, '', [])));
} elseif ($action === 'checkout_storage_proof') {
    $token = $input['token'] ?? '';
    $url = $input['url'] ?? '';
    $uuid = $input['agreementId'] ?? '';
    if (!is_string($token) || preg_match('/^[A-Za-z0-9_-]{43}$/D', $token) !== 1
        || !is_string($url) || !str_starts_with($url, 'https://synthetic.invalid/pay/')) {
        throw new RuntimeException('Explicit synthetic checkout token and URL required.');
    }
    $statement = $pdo->prepare('SELECT public_token_hash FROM payment_agreements WHERE public_uuid = :uuid');
    $statement->execute(['uuid' => $uuid]);
    $hash = $statement->fetchColumn();
    $plaintextToken = false;
    $plaintextUrl = false;
    foreach ($snapshot()['tableNames'] as $table) {
        foreach ($pdo->query('SELECT * FROM `' . $table . '`')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            foreach ($row as $value) {
                if (is_string($value)) {
                    $plaintextToken = $plaintextToken || str_contains($value, $token);
                    $plaintextUrl = $plaintextUrl || str_contains($value, $url);
                }
            }
        }
    }
    $result['checkoutStorageProof'] = ['tokenHashMatches' => is_string($hash) && hash_equals(hash('sha256', $token, true), $hash),
        'plaintextTokenPresent' => $plaintextToken, 'plaintextUrlPresent' => $plaintextUrl];
} elseif ($action === 'checkout_authority_expiry') {
    // A test-only domain callback observes the actual uncommitted writes, then
    // lets the short capability expire. Application has no injectable callback.
    $wire = json_decode($input['body'] ?? '', false, 16, JSON_THROW_ON_ERROR);
    $nowMs = (int) floor(microtime(true) * 1000);
    $wire->authorization->issuedAtMs = $nowMs;
    $wire->authorization->expiresAtMs = $nowMs + 150;
    $command = InternalCheckoutEmissionV1::fromJson(\Gourmet\Payments\Http\InternalPaymentPlanV2::encodeCanonical($wire), $nowMs);
    $proof = ['childPresentInside' => false, 'relationPresentInside' => false,
        'encryptedReceiptPresentInside' => false, 'auditPresentInside' => false, 'rejectedAtCommit' => false];
    $callbackCalls = 0;
    try {
        (new PaymentAgreementService($pdo))->issueCheckoutV1($command, new DateTimeImmutable('now', new DateTimeZone('UTC')),
            $config->appUrl, PaymentLinkReplayCipher::fromHexKey(str_repeat('cd', 32)), false,
            static function (string $childUuid) use ($pdo, $command, &$proof, &$callbackCalls): void {
                ++$callbackCalls;
                $child = $pdo->prepare("SELECT id FROM payment_agreements WHERE public_uuid = :uuid AND status = 'PENDING_CHECKOUT'");
                $child->execute(['uuid' => $childUuid]);
                $childId = $child->fetchColumn();
                $proof['childPresentInside'] = $childId !== false;
                $relation = $pdo->prepare('SELECT 1 FROM payment_checkout_issuances WHERE checkout_agreement_id = :id');
                $relation->execute(['id' => $childId]); $proof['relationPresentInside'] = $relation->fetchColumn() !== false;
                $receipt = $pdo->prepare('SELECT response_ciphertext IS NOT NULL FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key');
                $receipt->execute(['scope' => 'internal.payment_checkouts.issue.v1', 'key' => $command->idempotencyKey()]);
                $proof['encryptedReceiptPresentInside'] = (int) $receipt->fetchColumn() === 1;
                $audit = $pdo->prepare("SELECT 1 FROM audit_events WHERE event_type = 'PAYMENT_CHECKOUT_V1_ISSUED' AND aggregate_public_uuid = :uuid");
                $audit->execute(['uuid' => $childUuid]); $proof['auditPresentInside'] = $audit->fetchColumn() !== false;
                usleep(250000);
            });
        throw new RuntimeException('Expired checkout capability committed unexpectedly.');
    } catch (DomainException $exception) {
        if ($exception->getMessage() !== 'INVALID_CHECKOUT_EMISSION_V1') { throw $exception; }
        $proof['rejectedAtCommit'] = true;
    }
    $result['callbackCalls'] = $callbackCalls;
    $result['checkoutExpiryProof'] = $proof;
    $result['transactionOpen'] = $pdo->inTransaction();
} elseif ($action === 'checkout_sql_guards') {
    $lookup = $pdo->prepare('SELECT * FROM payment_checkout_issuances WHERE parent_draft_id = (SELECT id FROM payment_agreements WHERE public_uuid = :uuid)');
    $lookup->execute(['uuid' => $input['sourceDraftId'] ?? '']);
    $issuance = $lookup->fetch(PDO::FETCH_ASSOC);
    if (!is_array($issuance)) { throw new RuntimeException('An actual synthetic issued checkout is required.'); }
    $facts = [];
    $reject = static function (string $name, callable $operation) use ($pdo, &$facts): void {
        $pdo->beginTransaction();
        try {
            $operation();
            throw new RuntimeException('Synthetic checkout SQL mutation was accepted: ' . $name);
        } catch (PDOException $exception) {
            if (!in_array((string) $exception->getCode(), ['23000', '45000'], true)) { throw $exception; }
            $facts[$name] = true;
        } finally { if ($pdo->inTransaction()) { $pdo->rollBack(); } }
    };
    $update = static function (string $table, string $field, mixed $value, int $id) use ($pdo): void {
        $statement = $pdo->prepare('UPDATE ' . $table . ' SET ' . $field . ' = :value WHERE id = :id');
        $statement->execute(['value' => $value, 'id' => $id]);
    };
    $parentId = (int) $issuance['parent_draft_id'];
    $childId = (int) $issuance['checkout_agreement_id'];
    $reject('parent_draft_is_immutable', static fn () => $update('payment_agreements', 'status', 'PENDING_CHECKOUT', $parentId));
    foreach (['total_cents' => 1, 'initial_cents' => 1, 'recipient_name' => 'Synthetic changed recipient',
        'terms_version' => str_repeat('f', 64), 'balance_timezone' => 'UTC', 'contract_version' => 2,
        'link_expires_at' => '2099-11-21 18:00:00.000000', 'public_token_hash' => str_repeat('x', 32)] as $field => $value) {
        // UTC can already be the real value on full payment (which has NULL),
        // while the selected 50% fixture explicitly uses America/New_York.
        $reject('child_immutable_' . $field, static fn () => $update('payment_agreements', $field, $value, $childId));
    }
    $relationId = (int) $issuance['id'];
    $reject('relation_conditions_are_immutable', static fn () => $update('payment_checkout_issuances', 'conditions_json', '{}', $relationId));
    $reject('relation_cannot_be_deleted', static function () use ($pdo, $relationId): void {
        $statement = $pdo->prepare('DELETE FROM payment_checkout_issuances WHERE id = :id'); $statement->execute(['id' => $relationId]);
    });
    $schedule = $pdo->prepare('SELECT id FROM payment_schedules WHERE agreement_id = :id ORDER BY id LIMIT 1');
    $schedule->execute(['id' => $childId]); $scheduleId = (int) $schedule->fetchColumn();
    $reject('schedule_amount_is_immutable', static fn () => $update('payment_schedules', 'amount_cents', 1, $scheduleId));
    $reject('schedule_cannot_be_deleted', static function () use ($pdo, $scheduleId): void {
        $statement = $pdo->prepare('DELETE FROM payment_schedules WHERE id = :id'); $statement->execute(['id' => $scheduleId]);
    });
    $reject('one_parent_has_one_child_even_with_another_valid_child_and_issuance_key', static function () use ($pdo, $issuance, $childId): void {
        $lookup = $pdo->prepare('SELECT * FROM payment_agreements WHERE id = :id'); $lookup->execute(['id' => $childId]);
        $clone = $lookup->fetch(PDO::FETCH_ASSOC); unset($clone['id']);
        $clone['public_uuid'] = \Gourmet\Payments\Support\Uuid::v4();
        $clone['public_token_hash'] = random_bytes(32);
        $columns = array_keys($clone);
        foreach ($columns as $column) { if (preg_match('/^[a-z_]+$/D', $column) !== 1) { throw new RuntimeException('Unexpected fixture column.'); } }
        $insert = $pdo->prepare('INSERT INTO payment_agreements (' . implode(',', $columns) . ') VALUES (:' . implode(',:', $columns) . ')');
        foreach ($clone as $column => $value) {
            $insert->bindValue($column, $value, $column === 'public_token_hash' ? PDO::PARAM_LOB
                : ($value === null ? PDO::PARAM_NULL : (is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR)));
        }
        $insert->execute(); $cloneId = (int) $pdo->lastInsertId();
        $copy = $issuance; unset($copy['id']);
        $copy['issuance_id'] = hash('sha256', random_bytes(32)); $copy['checkout_agreement_id'] = $cloneId;
        $columns = array_keys($copy);
        $insert = $pdo->prepare('INSERT INTO payment_checkout_issuances (' . implode(',', $columns) . ') VALUES (:' . implode(',:', $columns) . ')');
        try { $insert->execute($copy); }
        catch (PDOException $exception) {
            if (!str_contains($exception->getMessage(), 'parent_draft')) { throw new RuntimeException('Expected actual parent UNIQUE constraint rejection.', 0, $exception); }
            throw $exception;
        }
    });
    $result['checkoutSqlGuards'] = ['assertions' => count($facts), 'facts' => $facts];
    $result['transactionOpen'] = $pdo->inTransaction();
} elseif ($action === 'migration_fault') {
    if ($mysql) { throw new RuntimeException('Atomic rebuild fault proof is SQLite-specific.'); }
    require __DIR__ . '/operational-migration-fault.php';
    $result['migrationFault'] = runOperationalMigrationFaultV2($root, $directory);
} elseif ($action === 'checkout_migration_fault') {
    if ($mysql) { throw new RuntimeException('Atomic rebuild fault proof is SQLite-specific.'); }
    require __DIR__ . '/operational-migration-fault.php';
    $result['migrationFault'] = runOperationalMigrationFaultV2($root, $directory, '0007_versioned_payment_checkouts.sql', $input['body'] ?? null);
} elseif ($action === 'query_probes') {
    require __DIR__ . '/operational-query-probes.php';
    $result['queryProbes'] = runOperationalQueryProbesV2($pdo);
} elseif ($action === 'mysql_migration_gates') {
    require __DIR__ . '/operational-mysql-migration-gates.php';
    $result['migrationGates'] = runOperationalMysqlMigrationGatesV2($pdo, $config, $root, $directory);
} elseif ($action === 'bootstrap_seed') {
    $seed = $pdo->prepare('INSERT INTO admin_bootstrap_tokens (public_id, token_hash, expires_at) VALUES (:id, :hash, :expires)');
    foreach (['a', 'b'] as $index) {
        $seed->bindValue('id', str_repeat($index, 32));
        $seed->bindValue('hash', Secrets::hashToken('synthetic-bootstrap-' . $index), PDO::PARAM_LOB);
        $seed->bindValue('expires', '2099-12-01 12:00:00.000000');
        $seed->execute();
    }
} elseif ($action === 'bootstrap_attempt') {
    $index = $input['index'] ?? '';
    if (!in_array($index, ['a', 'b'], true)) { throw new RuntimeException('Unknown synthetic administrator fixture.'); }
    $result['bootstrapCreated'] = (new AdminBootstrap($pdo))->createFirstAdmin(str_repeat($index, 32), 'synthetic-bootstrap-' . $index,
        'synthetic-bootstrap-' . $index . '@example.test', 'Synthetic administrator ' . $index, 'Synthetic fixture password only 2345');
    $result['consumedBootstrapTokens'] = (int) $pdo->query('SELECT COUNT(*) FROM admin_bootstrap_tokens WHERE consumed_at IS NOT NULL')->fetchColumn();
} elseif ($action === 'route') {
    $headers = $input['headers'] ?? [];
    if (!is_array($headers)) {
        throw new RuntimeException('Fixture headers required.');
    }
    $request = new Request(
        $input['method'] ?? 'POST', $input['path'] ?? '/internal/v2/payment-agreements',
        [], [], [], '127.0.0.1', 'Gourmet synthetic operational fixture', true,
        $input['body'] ?? '', $headers,
    );
    $result['response'] = $readResponse($application->handle($request));
} elseif ($action === 'rollback') {
    $command = OperationalPaymentAgreementV2::fromJson($input['body'], (int) floor(microtime(true) * 1000));
    $before = $snapshot();
    $callbackCalls = 0;
    $seenInside = [];
    try {
        (new PaymentAgreementService($pdo))->createDraftV2(
            $command->operationArray(), new DateTimeImmutable('now', new DateTimeZone('UTC')),
            static function (string $agreementUuid) use ($pdo, &$callbackCalls, &$seenInside): void {
                ++$callbackCalls;
                $query = $pdo->prepare('SELECT status, public_token_hash IS NULL AS token_is_null FROM payment_agreements WHERE public_uuid = :uuid');
                $query->execute(['uuid' => $agreementUuid]);
                $seenInside = $query->fetch();
                throw new RuntimeException('SYNTHETIC_AFTER_PERSISTED_FAILURE');
            },
        );
        throw new RuntimeException('Rollback callback unexpectedly returned.');
    } catch (RuntimeException $exception) {
        if ($exception->getMessage() !== 'SYNTHETIC_AFTER_PERSISTED_FAILURE') {
            throw $exception;
        }
    }
    $result = ['callbackCalls' => $callbackCalls, 'seenInside' => $seenInside, 'before' => $before,
        'transactionOpen' => $pdo->inTransaction()];
} elseif ($action === 'snapshot') {
    // Inspection uses the actual PDO ledger, never the request payload.
} else {
    throw new RuntimeException('Unknown synthetic fixture action.');
}
$result['snapshot'] = $snapshot();
$result['providerCalls'] = $transport->calls;
echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
