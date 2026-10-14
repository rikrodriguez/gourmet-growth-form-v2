<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

/**
 * Immutable adapter for the future Gourmet Sales OS payment_link.requested event.
 * It deliberately carries only the payment snapshot and source references required
 * to create a payment agreement; it is not a CRM projection.
 */
final readonly class InternalPaymentAgreementRequest
{
    public function __construct(
        public string $leadId,
        public ?string $mondayItemId,
        public string $quoteId,
        public string $quoteVersion,
        public string $recipientName,
        public string $recipientEmail,
        public ?string $recipientPhone,
        public string $serviceName,
        public ?string $eventAt,
        public ?string $eventLocation,
        public int $totalCents,
        public string $balanceDueDate,
        public string $timezone,
        public string $linkExpiration,
        private array $canonicalPayload,
    ) {
    }

    public static function fromJson(string $rawBody): self
    {
        try {
            $payload = json_decode($rawBody, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \DomainException('Request body must be valid JSON.');
        }
        if (!is_array($payload) || array_is_list($payload)) {
            throw new \DomainException('Request body must be a JSON object.');
        }

        $recipient = self::object($payload, 'recipient');
        $event = self::object($payload, 'event');
        $mondayItemId = self::nullableIdentifier($payload['monday_item_id'] ?? null, 'monday_item_id');
        $total = $payload['total_cents'] ?? null;
        if (!is_int($total) || $total < 1) {
            throw new \DomainException('total_cents must be an integer.');
        }

        return new self(
            leadId: self::requiredIdentifier($payload, 'lead_id'),
            mondayItemId: $mondayItemId,
            quoteId: self::requiredIdentifier($payload, 'quote_id'),
            quoteVersion: self::requiredIdentifier($payload, 'quote_version'),
            recipientName: self::requiredString($recipient, 'name', 200),
            recipientEmail: self::requiredString($recipient, 'email', 320),
            recipientPhone: self::nullableString($recipient['phone'] ?? null, 32, 'recipient.phone'),
            serviceName: self::requiredString($event, 'service_name', 180),
            eventAt: self::nullableString($event['event_at'] ?? null, 64, 'event.event_at'),
            eventLocation: self::nullableString($event['location'] ?? null, 255, 'event.location'),
            totalCents: $total,
            balanceDueDate: self::requiredString($payload, 'balance_due_date', 64),
            timezone: self::requiredString($payload, 'timezone', 64),
            linkExpiration: self::requiredString($payload, 'link_expiration', 64),
            canonicalPayload: self::canonicalize($payload),
        );
    }

    public function requestHash(): string
    {
        return hash('sha256', json_encode($this->canonicalPayload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), true);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    private static function object(array $payload, string $key): array
    {
        $value = $payload[$key] ?? null;
        if (!is_array($value) || array_is_list($value)) {
            throw new \DomainException($key . ' must be a JSON object.');
        }
        return $value;
    }

    /** @param array<string,mixed> $payload */
    private static function requiredIdentifier(array $payload, string $key): string
    {
        return self::requiredString($payload, $key, 180);
    }

    /** @param array<string,mixed> $payload */
    private static function requiredString(array $payload, string $key, int $maxLength): string
    {
        $value = $payload[$key] ?? null;
        if (!is_string($value) || trim($value) === '' || mb_strlen(trim($value)) > $maxLength) {
            throw new \DomainException($key . ' is required.');
        }
        return trim($value);
    }

    private static function nullableIdentifier(mixed $value, string $key): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_int($value)) {
            $value = (string) $value;
        }
        $identifier = self::nullableString($value, 20, $key);
        if ($identifier !== null && preg_match('/^[0-9]{1,20}$/', $identifier) !== 1) {
            throw new \DomainException($key . ' is invalid.');
        }
        return $identifier;
    }

    private static function nullableString(mixed $value, int $maxLength, string $key): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || mb_strlen(trim($value)) > $maxLength) {
            throw new \DomainException($key . ' is invalid.');
        }
        return trim($value);
    }

    /** @param array<string,mixed> $value @return array<string,mixed> */
    private static function canonicalize(array $value): array
    {
        ksort($value, SORT_STRING);
        foreach ($value as $key => $item) {
            if (is_array($item) && !array_is_list($item)) {
                $value[$key] = self::canonicalize($item);
            }
        }
        return $value;
    }
}


