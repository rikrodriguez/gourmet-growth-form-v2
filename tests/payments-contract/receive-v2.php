<?php

declare(strict_types=1);

// Isolated CLI harness only. No Application, service, database, token or provider.
// The clock is a harness argument, never an assertion taken from request JSON.
$money = __DIR__ . '/v2-originals/Money.php';
if (PHP_INT_SIZE < 8 || !extension_loaded('mbstring') || !is_file($money)
    || filesize($money) !== 985
    || hash_file('sha256', $money) !== 'd84e7bfb9c5b92357141e91bb9d1738099abce5ae95aa36abe2ccaebacad2cc1') {
    fwrite(STDERR, "Verified canonical Money source and 64-bit PHP with mbstring are required.\n");
    exit(2);
}
require $money;
require dirname(__DIR__, 2) . '/integrations/gourmet-payments-v2/src/Http/InternalPaymentPlanV2.php';

try {
    if ($argc !== 2 || preg_match('/\A(?:0|[1-9][0-9]{0,15})\z/', $argv[1]) !== 1
        || (int) $argv[1] > 8640000000000000) {
        throw new DomainException('INVALID_PAYMENT_PLAN_V2_CLOCK');
    }
    $raw = stream_get_contents(STDIN, 131073);
    if ($raw === false || strlen($raw) > 131072) {
        throw new DomainException('INVALID_PAYMENT_PLAN_V2');
    }
    $receipt = Gourmet\Payments\Http\InternalPaymentPlanV2::validate($raw, (int) $argv[1]);
    echo json_encode($receipt, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS), "\n";
} catch (DomainException $exception) {
    $code = preg_match('/\A[A-Z][A-Z0-9_]{0,95}\z/', $exception->getMessage()) === 1
        ? $exception->getMessage() : 'INVALID_PAYMENT_PLAN_V2';
    echo json_encode(['status' => 'blocked', 'code' => $code], JSON_THROW_ON_ERROR), "\n";
}
