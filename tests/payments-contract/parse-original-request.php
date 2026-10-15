<?php

declare(strict_types=1);

// Test-only: parse stdin through the byte-verified original request parser and
// the original private date methods. Do not boot or dispatch the application.
$referenceRoot = __DIR__ . '/references/producer-reference';
$sourceHashes = [
    'InternalPaymentAgreementRequest.php' => 'c775be893d1796e1d4fb03cb1e2120ca78b39e042b115254aa6d121328d44e6f',
    'Application.php' => 'e31cf08152feedfb33120d9c141f8883586820ca32e88992397d7725b2e1c240',
];
foreach ($sourceHashes as $file => $expected) {
    $path = $referenceRoot . '/' . $file;
    if (!is_file($path) || hash_file('sha256', $path) !== $expected) {
        fwrite(STDERR, 'Original PHP reference missing or changed: ' . $file . "\n");
        exit(2);
    }
}
if (!extension_loaded('mbstring')) {
    fwrite(STDERR, "The isolated PHP runtime requires mbstring.\n");
    exit(2);
}

require $referenceRoot . '/InternalPaymentAgreementRequest.php';
require $referenceRoot . '/Application.php';

try {
    $raw = stream_get_contents(STDIN, 131073);
    if ($raw === false || strlen($raw) > 131072) {
        throw new DomainException('Synthetic request exceeds the test input limit.');
    }
    $command = Gourmet\Payments\Http\InternalPaymentAgreementRequest::fromJson($raw);
    $reflection = new ReflectionClass(Gourmet\Payments\Http\Application::class);
    $application = $reflection->newInstanceWithoutConstructor();
    $timezone = $reflection->getMethod('internalTimezone')->invoke($application, $command->timezone);
    $parseDate = $reflection->getMethod('localDate');
    $balanceDue = $parseDate->invoke($application, $command->balanceDueDate, $timezone);
    $eventAt = $command->eventAt === null ? null : $parseDate->invoke($application, $command->eventAt, $timezone);
    $expiration = $reflection->getMethod('internalExpiration')->invoke($application, $command->linkExpiration, $timezone);
    $utc = static fn (?DateTimeImmutable $value): ?string => $value?->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');

    echo json_encode([
        'status' => 'parsed',
        'php_version' => PHP_VERSION,
        'source_hashes' => $sourceHashes,
        'request_hash' => bin2hex($command->requestHash()),
        'request' => [
            'lead_id' => $command->leadId,
            'monday_item_id' => $command->mondayItemId,
            'quote_id' => $command->quoteId,
            'quote_version' => $command->quoteVersion,
            'recipient' => [
                'name' => $command->recipientName,
                'email' => $command->recipientEmail,
                'phone' => $command->recipientPhone,
            ],
            'event' => [
                'service_name' => $command->serviceName,
                'event_at' => $command->eventAt,
                'location' => $command->eventLocation,
            ],
            'total_cents' => $command->totalCents,
            'balance_due_date' => $command->balanceDueDate,
            'timezone' => $command->timezone,
            'link_expiration' => $command->linkExpiration,
        ],
        'instants' => [
            'balance_due_date' => $utc($balanceDue),
            'event_at' => $utc($eventAt),
            'link_expiration' => $utc($expiration),
        ],
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), "\n";
} catch (DomainException $exception) {
    echo json_encode(['status' => 'blocked', 'exception' => $exception::class], JSON_THROW_ON_ERROR), "\n";
}
