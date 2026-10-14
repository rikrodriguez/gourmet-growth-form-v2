<?php
declare(strict_types=1);

// Runs only in an isolated test runtime. No credentials, network, app boot,
// worker, persistent database or production configuration is loaded.
foreach (['pdo_sqlite', 'mbstring'] as $extension) {
    if (!extension_loaded($extension)) {
        fwrite(STDERR, "Missing test-runtime extension: {$extension}\n");
        exit(2);
    }
}
require __DIR__ . '/Uuid.php';
require __DIR__ . '/Redactor.php';
require __DIR__ . '/SalesOsEventOutbox.php';
require __DIR__ . '/InternalPaymentAgreementRequest.php';
require __DIR__ . '/Application.php';

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE sales_os_event_outbox (
    public_uuid TEXT PRIMARY KEY, event_type TEXT NOT NULL,
    dedupe_key TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL,
    available_at TEXT NOT NULL
)');
$outbox = new Gourmet\Payments\Database\SalesOsEventOutbox($pdo);
$agreement = [
    'public_uuid' => 'agreement-php-synthetic',
    'source_lead_id' => 'lead-php-synthetic',
    'monday_item_id' => '123456789',
    'source_quote_id' => 'quote-php-synthetic',
    'source_quote_version' => 'v1',
];
$types = ['payment_link.created', 'reservation.paid', 'balance.scheduled',
    'balance.paid', 'payment.failed', 'payment_link.expired', 'payment_link.revoked'];
$date = new DateTimeImmutable('2026-10-01T12:00:00Z');
foreach ($types as $type) {
    $amount = match ($type) {
        'reservation.paid' => 4900,
        'balance.scheduled', 'balance.paid' => 120100,
        default => null,
    };
    $transaction = in_array($type, ['reservation.paid', 'balance.paid'], true)
        ? 'synthetic-' . $type : null;
    $outbox->enqueueAgreementEvent($agreement, $type, 'fixture:' . $type, $amount, $transaction, $date);
}
$rows = $pdo->query('SELECT public_uuid, event_type, payload_json FROM sales_os_event_outbox ORDER BY rowid')->fetchAll(PDO::FETCH_ASSOC);
if (count($rows) !== 7) { throw new RuntimeException('Expected seven genuine producer fixtures.'); }

$inputPath = $argv[1] ?? __DIR__ . '/prepared-requests.json';
$inputs = json_decode((string) file_get_contents($inputPath), true, 32, JSON_THROW_ON_ERROR);
$reflection = new ReflectionClass(Gourmet\Payments\Http\Application::class);
$app = $reflection->newInstanceWithoutConstructor();
$parseDate = $reflection->getMethod('localDate');
$parseExpiration = $reflection->getMethod('internalExpiration');
$requestChecks = [];
foreach ($inputs as $input) {
    $command = Gourmet\Payments\Http\InternalPaymentAgreementRequest::fromJson(json_encode($input['request'], JSON_THROW_ON_ERROR));
    $due = $parseDate->invoke($app, $command->balanceDueDate, $command->timezone);
    $expiry = $parseExpiration->invoke($app, $command->linkExpiration, $command->timezone);
    $actual = $due->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    if ($actual !== $input['expected_due_utc']) { throw new RuntimeException('Cross-language datetime changed the instant.'); }
    $requestChecks[] = ['name' => $input['name'], 'status' => 'PASS', 'due_utc' => $actual,
        'service_name' => $command->serviceName, 'expiration_parsed' => $expiry === null ? 'never' : 'date'];
}
echo json_encode(['php_version' => PHP_VERSION, 'producer_executed' => true,
    'storage' => 'sqlite::memory:', 'external_calls' => 0, 'rows' => $rows,
    'request_checks' => $requestChecks], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
