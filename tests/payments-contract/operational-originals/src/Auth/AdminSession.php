<?php

declare(strict_types=1);

namespace Gourmet\Payments\Auth;

use Gourmet\Payments\Security\Secrets;

final class AdminSession
{
    /** @return array{raw_token:string,token_hash:string,csrf_token:string,csrf_hash:string,expires_at:string} */
    public static function issue(\DateTimeImmutable $now, int $ttlSeconds): array
    {
        $raw = Secrets::randomToken();
        $csrf = Secrets::randomToken();

        return [
            'raw_token' => $raw,
            'token_hash' => Secrets::hashToken($raw),
            'csrf_token' => $csrf,
            'csrf_hash' => Secrets::hashToken($csrf),
            'expires_at' => $now->modify('+' . $ttlSeconds . ' seconds')->format('Y-m-d H:i:s.u'),
        ];
    }

    public static function isExpired(string $expiresAt, \DateTimeImmutable $now): bool
    {
        return new \DateTimeImmutable($expiresAt, new \DateTimeZone('UTC')) <= $now;
    }
}
