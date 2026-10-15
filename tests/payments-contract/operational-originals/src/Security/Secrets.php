<?php

declare(strict_types=1);

namespace Gourmet\Payments\Security;

final class Secrets
{
    public static function randomToken(int $bytes = 32): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token, true);
    }

    public static function passwordHash(string $password): string
    {
        $hash = password_hash($password, PASSWORD_ARGON2ID);
        if ($hash === false) {
            throw new \RuntimeException('Password hashing failed.');
        }

        return $hash;
    }

    public static function passwordVerify(string $password, string $hash): bool
    {
        return password_verify($password, $hash);
    }

    public static function privacyHash(string $value, string $appKey): string
    {
        return hash_hmac('sha256', $value, $appKey, true);
    }
}
