<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final readonly class PayPalHttpResponse
{
    public function __construct(public int $status, public string $body)
    {
    }
}
