<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

interface PayPalHttpTransport
{
    /** @param array<string, string> $headers */
    public function send(
        string $method,
        string $url,
        array $headers,
        ?string $body,
        int $timeoutSeconds,
    ): PayPalHttpResponse;
}
