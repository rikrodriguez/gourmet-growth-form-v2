<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final class PayPalMoney
{
    public static function fromCents(int $cents): string
    {
        if ($cents <= 0) {
            throw new \DomainException('PayPal USD amount must be positive.');
        }

        return sprintf('%d.%02d', intdiv($cents, 100), $cents % 100);
    }

    public static function toCents(string $value): int
    {
        if (preg_match('/\A([0-9]+)(?:\.([0-9]{1,2}))?\z/', $value, $matches) !== 1) {
            throw new \DomainException('PayPal USD amount has an unsupported decimal representation.');
        }
        $fraction = str_pad($matches[2] ?? '', 2, '0');

        return ((int) $matches[1] * 100) + (int) $fraction;
    }
}
