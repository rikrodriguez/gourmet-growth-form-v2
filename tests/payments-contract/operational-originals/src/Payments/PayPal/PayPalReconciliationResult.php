<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final readonly class PayPalReconciliationResult
{
    /** @param list<string> $paidSchedules */
    public function __construct(
        public string $subscriptionStatus,
        public array $paidSchedules,
        public string $agreementStatus,
    ) {
    }
}
