<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

interface PayPalGateway
{
    /** @param array<string, mixed> $payload @return array<string, mixed> */
    public function createProduct(array $payload, string $requestId): array;

    /** @return array<string, mixed> */
    public function getProduct(string $productId): array;

    /** @param array<string, mixed> $payload @return array<string, mixed> */
    public function createPlan(array $payload, string $requestId): array;

    /** @return array<string, mixed> */
    public function getPlan(string $planId): array;

    /** @param array<string, mixed> $payload @return array<string, mixed> */
    public function createSubscription(array $payload, string $requestId): array;

    /** @return array<string, mixed> */
    public function getSubscription(string $subscriptionId): array;

    public function cancelSubscription(string $subscriptionId, string $reason): void;

    /** @return list<array<string, mixed>> */
    public function listTransactions(string $subscriptionId, \DateTimeImmutable $start, \DateTimeImmutable $end): array;
}
