<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final readonly class PayPalProvisioningResult
{
    public function __construct(
        public string $externalId,
        public string $status,
        public bool $reused,
        public ?string $approvalUrl = null,
    ) {
    }
}
