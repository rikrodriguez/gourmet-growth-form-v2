<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments;

final readonly class PaymentCommand
{
    public function __construct(
        public string $scheduleUuid,
        public string $idempotencyKey,
        public int $amountCents,
        public string $currency,
        public string $consentReference,
    ) {
    }
}
