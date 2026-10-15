<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Logging\Redactor;
use Gourmet\Payments\Support\Uuid;
use PDO;
use PDOException;

/**
 * Durable, provider-free intent queue. No Monday API calls belong here.
 */
final readonly class MondaySyncOutbox
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @param array<string,mixed> $payload */
    public function enqueue(string $mondayItemId, string $eventType, string $dedupeKey, array $payload): bool
    {
        try {
            $statement = $this->pdo->prepare(
                'INSERT INTO monday_sync_outbox (public_uuid, monday_item_id, event_type, payload_json, dedupe_key, available_at) ' .
                'VALUES (:uuid, :monday_item_id, :event_type, :payload_json, :dedupe_key, :available_at)'
            );
            $statement->execute([
                'uuid' => Uuid::v4(),
                'monday_item_id' => $mondayItemId,
                'event_type' => $eventType,
                'payload_json' => json_encode(Redactor::context($payload), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
                'dedupe_key' => $dedupeKey,
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
}
