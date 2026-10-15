<?php

declare(strict_types=1);

namespace Gourmet\Payments\Security;

/** Service-to-service bearer authentication for disabled-by-default internal routes. */
final class InternalApiAuthenticator
{
    public static function validBearer(?string $authorization, string $sharedSecret): bool
    {
        if ($sharedSecret === '' || !is_string($authorization)) {
            return false;
        }
        if (preg_match('/\ABearer[ \t]+(.+)\z/i', trim($authorization), $matches) !== 1) {
            return false;
        }
        return hash_equals($sharedSecret, trim($matches[1]));
    }
}
