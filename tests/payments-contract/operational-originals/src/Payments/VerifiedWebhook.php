<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments;

final readonly class VerifiedWebhook
{
    public function __construct(
        public string $providerEventId,
        public string $eventType,
        public string $payloadHash,
    ) {
    }
}
