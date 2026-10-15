<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final class PayPalApiException extends \RuntimeException
{
    public function __construct(
        public readonly int $httpStatus,
        public readonly string $category,
        public readonly ?string $providerName,
        public readonly ?string $debugId,
    ) {
        parent::__construct(sprintf('PayPal request failed (%s, HTTP %d).', $category, $httpStatus));
    }
}
