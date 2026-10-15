<?php

declare(strict_types=1);

namespace Gourmet\Payments\Security;

/** Prepares a signed callback; dispatch remains disabled until a worker is approved. */
final class SalesOsCallbackSigner
{
    /** @return array<string,string> */
    public static function headers(string $payload, string $sharedSecret, \DateTimeImmutable $now): array
    {
        if ($sharedSecret === '') {
            throw new \RuntimeException('Sales OS callback authentication is not configured.');
        }
        $timestamp = $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z');
        return [
            'Content-Type' => 'application/json',
            'X-Gourmet-Event-Version' => 'v1',
            'X-Gourmet-Timestamp' => $timestamp,
            'X-Gourmet-Signature' => 'v1=' . hash_hmac('sha256', $timestamp . '.' . $payload, $sharedSecret),
        ];
    }
}
