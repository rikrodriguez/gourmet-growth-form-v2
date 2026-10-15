<?php

declare(strict_types=1);

namespace Gourmet\Payments\Domain;

final readonly class Money
{
    public const CURRENCY = 'USD';
    public const RESERVATION_CENTS = 4900;

    private function __construct(
        public int $totalCents,
        public int $reservationCents,
        public int $balanceCents,
        public string $currency,
    ) {
    }

    public static function agreement(int $totalCents, string $currency = self::CURRENCY): self
    {
        if ($currency !== self::CURRENCY) {
            throw new \DomainException('Only USD is supported in V1.');
        }
        if ($totalCents <= self::RESERVATION_CENTS) {
            throw new \DomainException('Total must be greater than the reservation fee.');
        }

        return new self(
            totalCents: $totalCents,
            reservationCents: self::RESERVATION_CENTS,
            balanceCents: $totalCents - self::RESERVATION_CENTS,
            currency: self::CURRENCY,
        );
    }
}
