<?php

declare(strict_types=1);

namespace Gourmet\Payments\Domain;

final class PaymentLink
{
    public static function generateToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token, true);
    }

    public static function hashHex(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function isUsable(?string $expiresAt, ?string $revokedAt, \DateTimeImmutable $now): bool
    {
        if ($revokedAt !== null) {
            return false;
        }
        if ($expiresAt === null) {
            return true;
        }

        return new \DateTimeImmutable($expiresAt, new \DateTimeZone('UTC')) > $now;
    }
}
