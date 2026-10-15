<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class ProviderResourceRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @return array<string, mixed>|null */
    public function findByConfiguration(string $provider, string $resourceType, string $configurationHash): ?array
    {
        $statement = $this->pdo->prepare(
            'SELECT * FROM provider_resources WHERE provider = :provider AND resource_type = :resource_type AND configuration_hash = :configuration_hash LIMIT 1'
        );
        $statement->bindValue('provider', $provider);
        $statement->bindValue('resource_type', $resourceType);
        $statement->bindValue('configuration_hash', $configurationHash, PDO::PARAM_LOB);
        $statement->execute();
        $row = $statement->fetch();

        return is_array($row) ? $row : null;
    }

    /** @return array<string, mixed>|null */
    public function findSubscriptionForAgreement(int $agreementId): ?array
    {
        $statement = $this->pdo->prepare(
            "SELECT * FROM provider_resources WHERE provider = 'PAYPAL' AND resource_type = 'SUBSCRIPTION' AND agreement_id = :agreement_id LIMIT 1"
        );
        $statement->execute(['agreement_id' => $agreementId]);
        $row = $statement->fetch();

        return is_array($row) ? $row : null;
    }

    /**
     * @param array{provider:string,resource_type:string,external_id:string,parent_external_id:?string,agreement_id:?int,status:string,idempotency_key:string,configuration_hash:string,start_at_utc:?string,approved_at_utc:?string} $resource
     */
    public function insert(array $resource): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO provider_resources (' .
            'public_uuid, provider, resource_type, external_id, parent_external_id, agreement_id, status, idempotency_key, configuration_hash, start_at_utc, approved_at_utc' .
            ') VALUES (' .
            ':uuid, :provider, :resource_type, :external_id, :parent_external_id, :agreement_id, :status, :idempotency_key, :configuration_hash, :start_at_utc, :approved_at_utc' .
            ')'
        );
        $statement->bindValue('uuid', Uuid::v4());
        $statement->bindValue('provider', $resource['provider']);
        $statement->bindValue('resource_type', $resource['resource_type']);
        $statement->bindValue('external_id', $resource['external_id']);
        $statement->bindValue('parent_external_id', $resource['parent_external_id']);
        $statement->bindValue('agreement_id', $resource['agreement_id'], $resource['agreement_id'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
        $statement->bindValue('status', $resource['status']);
        $statement->bindValue('idempotency_key', $resource['idempotency_key']);
        $statement->bindValue('configuration_hash', $resource['configuration_hash'], PDO::PARAM_LOB);
        $statement->bindValue('start_at_utc', $resource['start_at_utc']);
        $statement->bindValue('approved_at_utc', $resource['approved_at_utc']);
        $statement->execute();
    }

    public function updateSubscriptionState(
        string $externalId,
        string $status,
        ?string $startAtUtc,
        ?string $approvedAtUtc,
    ): void {
        $statement = $this->pdo->prepare(
            "UPDATE provider_resources SET status = :status, start_at_utc = :start_at, approved_at_utc = COALESCE(approved_at_utc, :approved_at) " .
            "WHERE provider = 'PAYPAL' AND resource_type = 'SUBSCRIPTION' AND external_id = :external_id"
        );
        $statement->execute([
            'status' => $status,
            'start_at' => $startAtUtc,
            'approved_at' => $approvedAtUtc,
            'external_id' => $externalId,
        ]);
    }
}
