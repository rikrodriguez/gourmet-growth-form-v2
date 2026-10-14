<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Logging\Redactor;
use Gourmet\Payments\Support\Uuid;
use PDO;
use PDOException;

/** Durable outbound events for Gourmet Sales OS. This class never performs HTTP calls. */
final readonly class SalesOsEventOutbox
{
    private const EVENT_TYPES = [
        'payment_link.created',
        'reservation.paid',
        'balance.scheduled',
        'balance.paid',
        'payment.failed',
        'payment_link.expired',
        'payment_link.revoked',
    ];

    public function __construct(private PDO $pdo)
    {
    }

    /** @param array<string,mixed> $agreement */
    public function enqueueAgreementEvent(
        array $agreement,
        string $eventType,
        string $dedupeKey,
        ?int $amountCents = null,
        ?string $providerTransactionId = null,
        ?\DateTimeImmutable $occurredAt = null,
    ): bool {
        if (!in_array($eventType, self::EVENT_TYPES, true)) {
            throw new \DomainException('Unsupported Sales OS event type.');
        }
        $occurredAt ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $payload = [
            'payment_agreement_id' => (string) $agreement['public_uuid'],
            'lead_id' => $agreement['source_lead_id'] ?? null,
            'monday_item_id' => $agreement['monday_item_id'] ?? null,
            'quote_id' => $agreement['source_quote_id'] ?? null,
            'quote_version' => $agreement['source_quote_version'] ?? null,
            'event_type' => $eventType,
            'occurred_at' => $occurredAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z'),
        ];
        if ($amountCents !== null) {
            $payload['amount_cents'] = $amountCents;
            $payload['currency'] = 'USD';
        }
        if ($providerTransactionId !== null && $providerTransactionId !== '') {
            $payload['provider_transaction_id'] = $providerTransactionId;
        }
        return $this->enqueue($eventType, $dedupeKey, $payload);
    }

    /** @param array<string,mixed> $payload */
    public function enqueue(string $eventType, string $dedupeKey, array $payload): bool
    {
        try {
            $statement = $this->pdo->prepare(
                'INSERT INTO sales_os_event_outbox (public_uuid, event_type, dedupe_key, payload_json, available_at) ' .
                'VALUES (:uuid, :event_type, :dedupe_key, :payload, :available_at)'
            );
            $statement->execute([
                'uuid' => Uuid::v4(),
                'event_type' => $eventType,
                'dedupe_key' => $dedupeKey,
                'payload' => json_encode(Redactor::context($payload), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
                'available_at' => gmdate('Y-m-d H:i:s.u'),
            ]);
            return true;
        } catch (PDOException $exception) {
            if (str_contains($exception->getMessage(), 'UNIQUE constraint failed')) {
                return false;
            }
            throw $exception;
        }
    }

    /** @return list<array<string,mixed>> */
    public function claim(int $limit, \DateTimeImmutable $now, int $leaseSeconds = 60): array
    {
        $limit = min(max($limit, 1), 100);
        $at = $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
        $lease = $now->modify('+' . max($leaseSeconds, 10) . ' seconds')->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
        $select = $this->pdo->prepare(
            "SELECT public_uuid FROM sales_os_event_outbox WHERE status IN ('PENDING', 'RETRY') AND available_at <= :now " .
            'AND (locked_until IS NULL OR locked_until <= :now) ORDER BY available_at ASC LIMIT :limit'
        );
        $select->bindValue('now', $at);
        $select->bindValue('limit', $limit, PDO::PARAM_INT);
        $select->execute();
        $claimed = [];
        $lock = $this->pdo->prepare(
            "UPDATE sales_os_event_outbox SET status = 'PROCESSING', locked_until = :lease, updated_at = CURRENT_TIMESTAMP " .
            "WHERE public_uuid = :uuid AND status IN ('PENDING', 'RETRY') AND (locked_until IS NULL OR locked_until <= :now)"
        );
        foreach ($select->fetchAll(PDO::FETCH_COLUMN) as $uuid) {
            $lock->execute(['lease' => $lease, 'uuid' => $uuid, 'now' => $at]);
            if ($lock->rowCount() !== 1) {
                continue;
            }
            $row = $this->pdo->prepare('SELECT * FROM sales_os_event_outbox WHERE public_uuid = :uuid');
            $row->execute(['uuid' => $uuid]);
            $event = $row->fetch();
            if (is_array($event)) {
                $claimed[] = $event;
            }
        }
        return $claimed;
    }

    public function acknowledge(string $publicUuid): void
    {
        $statement = $this->pdo->prepare(
            "UPDATE sales_os_event_outbox SET status = 'SENT', processed_at = :now, locked_until = NULL, updated_at = CURRENT_TIMESTAMP " .
            "WHERE public_uuid = :uuid AND status = 'PROCESSING'"
        );
        $statement->execute(['uuid' => $publicUuid, 'now' => gmdate('Y-m-d H:i:s.u')]);
    }

    public function retry(string $publicUuid, \DateTimeImmutable $availableAt, string $safeError): void
    {
        $statement = $this->pdo->prepare(
            "UPDATE sales_os_event_outbox SET status = 'RETRY', attempt_count = attempt_count + 1, available_at = :available_at, locked_until = NULL, last_error_safe = :error, updated_at = CURRENT_TIMESTAMP " .
            "WHERE public_uuid = :uuid AND status = 'PROCESSING'"
        );
        $statement->execute([
            'uuid' => $publicUuid,
            'available_at' => $availableAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
            'error' => mb_substr($safeError, 0, 240),
        ]);
    }
}


