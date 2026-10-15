<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Logging\Redactor;
use Gourmet\Payments\Support\Uuid;
use PDO;
use PDOException;

final readonly class EmailOutbox
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @param array<string, mixed> $payload */
    public function enqueue(
        string $deduplicationKey,
        string $eventType,
        string $recipientEmail,
        string $templateKey,
        array $payload,
        \DateTimeImmutable $availableAt,
    ): bool {
        $statement = $this->pdo->prepare(
            'INSERT INTO email_outbox (public_uuid, deduplication_key, event_type, recipient_email, template_key, payload_json, available_at) ' .
            'VALUES (:uuid, :deduplication_key, :event_type, :recipient, :template_key, :payload, :available_at)'
        );
        try {
            $statement->execute([
                'uuid' => Uuid::v4(),
                'deduplication_key' => $deduplicationKey,
                'event_type' => $eventType,
                'recipient' => mb_strtolower(trim($recipientEmail)),
                'template_key' => $templateKey,
                'payload' => json_encode(Redactor::context($payload), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
                'available_at' => $availableAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
            ]);
            return true;
        } catch (PDOException $exception) {
            if ((int) ($exception->errorInfo[1] ?? 0) === 1062 || str_contains($exception->getMessage(), 'UNIQUE constraint failed')) {
                return false;
            }
            throw $exception;
        }
    }

    public function claim(int $id, \DateTimeImmutable $now, int $leaseSeconds): bool
    {
        $statement = $this->pdo->prepare(
            "UPDATE email_outbox SET status = 'PROCESSING', attempt_count = attempt_count + 1, last_attempt_at = :attempted_at, locked_until = :locked_until " .
            "WHERE id = :id AND status = 'PENDING' AND available_at <= :available_cutoff AND (locked_until IS NULL OR locked_until <= :lease_cutoff)"
        );
        $nowUtc = $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
        $statement->execute([
            'id' => $id,
            'attempted_at' => $nowUtc,
            'available_cutoff' => $nowUtc,
            'lease_cutoff' => $nowUtc,
            'locked_until' => $now->modify('+' . $leaseSeconds . ' seconds')->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
        ]);
        return $statement->rowCount() === 1;
    }

    public function markRetry(int $id, string $failureSafe, \DateTimeImmutable $availableAt): void
    {
        $statement = $this->pdo->prepare(
            "UPDATE email_outbox SET status = 'PENDING', failure_safe = :failure, available_at = :available_at, locked_until = NULL WHERE id = :id AND status = 'PROCESSING'"
        );
        $statement->execute([
            'id' => $id,
            'failure' => mb_substr($failureSafe, 0, 500),
            'available_at' => $availableAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
        ]);
    }

    public function markSent(int $id, \DateTimeImmutable $sentAt): void
    {
        $statement = $this->pdo->prepare(
            "UPDATE email_outbox SET status = 'SENT', sent_at = :sent_at, locked_until = NULL, failure_safe = NULL WHERE id = :id AND status = 'PROCESSING'"
        );
        $statement->execute([
            'id' => $id,
            'sent_at' => $sentAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
        ]);
    }

    /** @return list<array<string,mixed>> */
    public function due(\DateTimeImmutable $now, int $limit = 25): array
    {
        $statement = $this->pdo->prepare(
            "SELECT * FROM email_outbox WHERE status = 'PENDING' AND available_at <= :now AND (locked_until IS NULL OR locked_until <= :now) ORDER BY id ASC LIMIT " . max(1, min(100, $limit))
        );
        $statement->execute(['now' => $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u')]);
        return $statement->fetchAll();
    }
}
