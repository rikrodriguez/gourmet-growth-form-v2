<?php

declare(strict_types=1);

// New synthetic harness, never the original destructive E2E. The Node test
// supplies a verified, patched runtime and a disposable directory explicitly.
use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Domain\Money;
use Gourmet\Payments\Domain\PaymentAgreementService;
use Gourmet\Payments\Http\Application;
use Gourmet\Payments\Http\OperationalPaymentAgreementV2;
use Gourmet\Payments\Http\Request;
use Gourmet\Payments\Http\Response;
use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Payments\PayPal\PayPalHttpResponse;
use Gourmet\Payments\Payments\PayPal\PayPalHttpTransport;
use Gourmet\Payments\Support\Config;

ini_set('display_errors', 'stderr');
error_reporting(E_ALL);
$root = $argv[1] ?? '';
$directory = $argv[2] ?? '';
if (!is_dir($root . '/src') || !is_dir($directory) || !is_file($directory . '/synthetic-fixture-only')) {
    throw new RuntimeException('Explicit disposable runtime and fixture directory required.');
}
require $root . '/bootstrap/autoload.php';
$input = json_decode((string) stream_get_contents(STDIN), true, 40, JSON_THROW_ON_ERROR);
if (!is_array($input)) {
    throw new RuntimeException('Synthetic fixture input required.');
}
$config = new Config(
    root: $root,
    environment: ($input['production'] ?? false) ? 'production' : 'test',
    appUrl: 'https://synthetic.invalid',
    appKey: str_repeat('ab', 32),
    sqlitePath: $directory . '/storage/ledger.sqlite',
    sqliteBusyTimeoutMs: 1000,
    sessionTtl: 3600,
    loginMaxAttempts: 5,
    loginWindowSeconds: 900,
);
$pdo = Connection::open($config);
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
$snapshot = static function () use ($pdo): array {
    $tables = ['payment_agreements', 'payment_schedules', 'payment_attempts', 'payment_consents',
        'provider_resources', 'provider_webhook_events', 'email_outbox', 'monday_sync_outbox',
        'sales_os_event_outbox', 'audit_events', 'idempotency_keys'];
    $counts = [];
    foreach ($tables as $table) {
        $counts[$table] = (int) $pdo->query('SELECT COUNT(*) FROM ' . $table)->fetchColumn();
    }
    return [
        'counts' => $counts,
        'agreements' => $pdo->query("SELECT public_uuid, contract_version, payment_mode, initial_cents, operation_id, operation_digest, operation_json, configuration_id, configuration_digest, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, recipient_phone, service_name, event_at_utc, event_location, currency, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, status, provider, public_token_hash IS NULL AS token_is_null, CASE WHEN public_token_hash IS NULL THEN NULL ELSE 'synthetic-present' END AS public_token_hash, link_expires_at, terms_version, reservation_policy_version FROM payment_agreements ORDER BY id")->fetchAll(),
        'schedules' => $pdo->query('SELECT a.public_uuid AS agreement_uuid, s.kind, s.amount_cents, s.due_at_utc, s.status, s.paid_at FROM payment_schedules s JOIN payment_agreements a ON a.id = s.agreement_id ORDER BY s.id')->fetchAll(),
        'idempotency' => $pdo->query('SELECT scope, idempotency_key, lower(hex(request_hash)) AS request_hash, response_status, completed_at, locked_until, response_ciphertext IS NOT NULL AS encrypted_response FROM idempotency_keys ORDER BY id')->fetchAll(),
        'audit' => $pdo->query('SELECT event_type, aggregate_public_uuid, metadata_json FROM audit_events ORDER BY id')->fetchAll(),
        'migrations' => $pdo->query('SELECT version FROM schema_migrations ORDER BY version')->fetchAll(PDO::FETCH_COLUMN),
        'foreignKeyViolations' => $pdo->query('PRAGMA foreign_key_check')->fetchAll(),
    ];
};

$action = $input['action'] ?? '';
$result = [];
if ($action === 'initialize') {
    // Run byte-identical original migrations first and seed a historical v1
    // fixture with a synthetic hash. Never call v1 create/token generation.
    if ($input['seedLegacy'] ?? false) {
        (new Migrator($pdo, $directory . '/legacy-migrations/sqlite'))->migrate();
        $statement = $pdo->prepare('INSERT INTO payment_agreements (public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, service_name, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, public_token_hash, terms_version, reservation_policy_version) VALUES (:uuid, NULL, :lead, :quote, :version, :name, :email, :service, 10001, 4900, 5101, :due, :timezone, :hash, :terms, :policy)');
        $statement->bindValue('uuid', '00000000-0000-4000-8000-000000000001');
        $statement->bindValue('lead', 'synthetic-legacy-lead');
        $statement->bindValue('quote', 'synthetic-legacy-quote');
        $statement->bindValue('version', '1');
        $statement->bindValue('name', 'Synthetic legacy recipient');
        $statement->bindValue('email', 'legacy@example.test');
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
        $result['legacyBeforeMigration'] = $pdo->query('SELECT public_uuid, total_cents, reservation_cents, balance_cents, public_token_hash IS NOT NULL AS token_present FROM payment_agreements')->fetchAll();
        $result['legacyMoney'] = Money::agreement(10001);
    }
    $result['applied'] = (new Migrator($pdo, $root . '/migrations/sqlite'))->migrate();
} elseif ($action === 'install_audit_failure') {
    $pdo->exec("CREATE TRIGGER synthetic_abort_final_v2_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'INTERNAL_PAYMENT_DRAFT_V2_REQUESTED' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_FINAL_AUDIT_FAILURE'); END");
} elseif ($action === 'remove_audit_failure') {
    $pdo->exec('DROP TRIGGER synthetic_abort_final_v2_audit');
} elseif ($action === 'migration_fault') {
    require __DIR__ . '/operational-migration-fault.php';
    $result['migrationFault'] = runOperationalMigrationFaultV2($root, $directory);
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
