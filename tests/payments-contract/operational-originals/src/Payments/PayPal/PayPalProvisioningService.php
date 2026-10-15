<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Database\IdempotencyGuard;
use Gourmet\Payments\Database\ProviderResourceRepository;
use PDO;

final readonly class PayPalProvisioningService
{
    private const PROVIDER = 'PAYPAL';

    public function __construct(
        private PDO $pdo,
        private PayPalGateway $gateway,
        private ProviderResourceRepository $resources,
        private IdempotencyGuard $idempotency,
    ) {
    }

    public function createOrReuseProduct(): PayPalProvisioningResult
    {
        $payload = PayPalPayloads::product();

        return $this->provision('PRODUCT', $payload, null, null, function (string $requestId) use ($payload): array {
            $created = $this->gateway->createProduct($payload, $requestId);
            $created['status'] = 'CREATED';

            return $created;
        });
    }

    public function createOrReusePlan(string $productId, int $balanceCents = 100): PayPalProvisioningResult
    {
        $payload = PayPalPayloads::plan($productId, 'USD', $balanceCents);

        return $this->provision('PLAN', $payload, $productId, null, function (string $requestId) use ($payload, $balanceCents): array {
            $created = $this->gateway->createPlan($payload, $requestId);
            $planId = is_string($created['id'] ?? null) ? $created['id'] : '';
            $authoritative = $planId === '' ? $created : $this->gateway->getPlan($planId);
            PayPalPayloads::assertFinitePlan($authoritative, $balanceCents);
            if (($authoritative['status'] ?? null) !== 'ACTIVE') {
                throw new \DomainException('Created PayPal plan is not ACTIVE.');
            }

            return $authoritative;
        });
    }

    public function createOrReuseSubscription(
        int $agreementId,
        string $agreementUuid,
        string $planId,
        \DateTimeImmutable $startTime,
    ): PayPalProvisioningResult {
        $payload = PayPalPayloads::subscription($planId, $agreementUuid, $startTime);

        return $this->provision('SUBSCRIPTION', $payload, $planId, $agreementId, function (string $requestId) use ($payload): array {
            return $this->gateway->createSubscription($payload, $requestId);
        });
    }

    /**
     * @param array<string, mixed> $payload
     * @param callable(string):array<string, mixed> $operation
     */
    private function provision(
        string $resourceType,
        array $payload,
        ?string $parentExternalId,
        ?int $agreementId,
        callable $operation,
    ): PayPalProvisioningResult {
        $canonical = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $configurationHash = hash('sha256', $canonical, true);
        $existing = $this->resources->findByConfiguration(self::PROVIDER, $resourceType, $configurationHash);
        if ($existing !== null) {
            return new PayPalProvisioningResult(
                (string) $existing['external_id'],
                (string) $existing['status'],
                true,
            );
        }

        $requestId = 'gpp-' . substr(hash('sha256', strtolower($resourceType) . ':' . $canonical), 0, 32);
        $scope = 'PAYPAL_' . $resourceType . '_CREATE';
        $this->idempotency->begin($scope, $requestId, $configurationHash);
        try {
            $response = $operation($requestId);
        } catch (PayPalTransportException $exception) {
            $this->idempotency->markAmbiguous($scope, $requestId);
            throw $exception;
        } catch (\Throwable $exception) {
            $this->idempotency->releaseDefinitiveFailure($scope, $requestId);
            throw $exception;
        }

        $externalId = $response['id'] ?? null;
        $status = $response['status'] ?? null;
        if (!is_string($externalId) || $externalId === '' || !is_string($status) || $status === '') {
            $this->idempotency->markAmbiguous($scope, $requestId);
            throw new \DomainException('PayPal create response omitted its resource identity or status.');
        }
        $approvalUrl = $resourceType === 'SUBSCRIPTION' ? $this->approvalUrl($response) : null;
        $startAt = is_string($response['start_time'] ?? null)
            ? $this->toDatabaseTime($response['start_time'])
            : (is_string($payload['start_time'] ?? null) ? $this->toDatabaseTime($payload['start_time']) : null);

        $this->pdo->beginTransaction();
        try {
            $this->resources->insert([
                'provider' => self::PROVIDER,
                'resource_type' => $resourceType,
                'external_id' => $externalId,
                'parent_external_id' => $parentExternalId,
                'agreement_id' => $agreementId,
                'status' => $status,
                'idempotency_key' => $requestId,
                'configuration_hash' => $configurationHash,
                'start_at_utc' => $startAt,
                'approved_at_utc' => null,
            ]);
            $responseHash = hash('sha256', json_encode($response, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), true);
            $this->idempotency->complete($scope, $requestId, 201, $responseHash);
            if ($resourceType === 'SUBSCRIPTION' && $agreementId !== null) {
                $statement = $this->pdo->prepare("UPDATE payment_agreements SET provider = 'PAYPAL' WHERE id = :id");
                $statement->execute(['id' => $agreementId]);
            }
            $this->pdo->commit();
        } catch (\Throwable $exception) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $exception;
        }

        return new PayPalProvisioningResult($externalId, $status, false, $approvalUrl);
    }

    /** @param array<string, mixed> $response */
    private function approvalUrl(array $response): ?string
    {
        foreach (($response['links'] ?? []) as $link) {
            if (!is_array($link) || ($link['rel'] ?? null) !== 'approve' || !is_string($link['href'] ?? null)) {
                continue;
            }
            $host = parse_url($link['href'], PHP_URL_HOST);
            if (in_array($host, ['www.sandbox.paypal.com', 'sandbox.paypal.com', 'www.paypal.com', 'paypal.com'], true)) {
                return $link['href'];
            }
        }

        return null;
    }

    private function toDatabaseTime(string $value): string
    {
        return (new \DateTimeImmutable($value))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
    }
}
