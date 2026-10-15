<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments;

final readonly class ProviderResult
{
    public function __construct(
        public string $provider,
        public string $providerPaymentId,
        public string $status,
        public ?string $safeFailureCode = null,
    ) {
    }
}
