<?php

declare(strict_types=1);

namespace Gourmet\Payments\Support;

/**
 * Converts a customer-facing Monday item link into its durable item identifier.
 *
 * V1 deliberately does not call the Monday API; the link is only an operator
 * convenience input. The payment ledger retains the extracted item ID.
 */
final class MondayItemReference
{
    public static function itemId(string $reference): string
    {
        $reference = trim($reference);
        if ($reference === '' || mb_strlen($reference) > 2048) {
            throw new \DomainException('Paste a valid Monday client reference URL.');
        }

        $parts = parse_url($reference);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || mb_strtolower((string) $parts['scheme']) !== 'https') {
            throw new \DomainException('Paste a valid Monday client reference URL.');
        }

        $host = mb_strtolower((string) $parts['host']);
        if ($host !== 'monday.com' && !str_ends_with($host, '.monday.com')) {
            throw new \DomainException('Paste a valid Monday client reference URL.');
        }

        $path = (string) ($parts['path'] ?? '');
        if (preg_match('#/(?:pulses|items)/([0-9]{1,20})(?:/|$)#i', $path, $matches) === 1) {
            return $matches[1];
        }

        parse_str((string) ($parts['query'] ?? ''), $query);
        foreach (['pulse', 'pulse_id', 'pulseId', 'item', 'item_id', 'itemId', 'selectedItems'] as $key) {
            $candidate = $query[$key] ?? null;
            if (is_string($candidate) && preg_match('/^[0-9]{1,20}$/', $candidate) === 1) {
                return $candidate;
            }
        }

        throw new \DomainException('Paste a valid Monday client reference URL.');
    }
}
