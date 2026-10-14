<?php

declare(strict_types=1);

namespace Gourmet\Payments\Logging;

final class Redactor
{
    public static function path(string $path): string
    {
        return preg_replace('#\A/pay/[^/]+#', '/pay/[REDACTED]', $path) ?? '/pay/[REDACTED]';
    }

    /** @param array<string, mixed> $context @return array<string, mixed> */
    public static function context(array $context): array
    {
        $redacted = [];
        foreach ($context as $key => $value) {
            if (preg_match('/password|secret|authorization|api[_-]?key|token|cookie|card|cvv|cvc|payload/i', (string) $key)) {
                $redacted[$key] = '[REDACTED]';
                continue;
            }
            $redacted[$key] = is_array($value) ? self::context($value) : $value;
        }

        return $redacted;
    }
}


