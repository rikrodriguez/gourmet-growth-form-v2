<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Logging\Redactor;
use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class AuditLog
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @param array<string, mixed> $metadata */
    public function record(
        string $actorType,
        string $eventType,
        string $aggregateType,
        ?string $actorUuid,
        ?string $aggregateUuid,
        ?string $requestId,
        array $metadata = [],
    ): void {
        $statement = $this->pdo->prepare(
            'INSERT INTO audit_events (public_uuid, actor_type, actor_public_uuid, event_type, aggregate_type, aggregate_public_uuid, request_id, metadata_json) ' .
            'VALUES (:uuid, :actor_type, :actor_uuid, :event_type, :aggregate_type, :aggregate_uuid, :request_id, :metadata)'
        );
        $statement->execute([
            'uuid' => Uuid::v4(),
            'actor_type' => $actorType,
            'actor_uuid' => $actorUuid,
            'event_type' => $eventType,
            'aggregate_type' => $aggregateType,
            'aggregate_uuid' => $aggregateUuid,
            'request_id' => $requestId,
            'metadata' => json_encode(Redactor::context($metadata), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
        ]);
    }
}
