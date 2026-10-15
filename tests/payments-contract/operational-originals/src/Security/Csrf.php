<?php

declare(strict_types=1);

namespace Gourmet\Payments\Security;

final class Csrf
{
    public static function issue(): string
    {
        return Secrets::randomToken();
    }

    public static function validate(string $submitted, string $cookie): bool
    {
        return $submitted !== '' && $cookie !== '' && hash_equals($cookie, $submitted);
    }
}
