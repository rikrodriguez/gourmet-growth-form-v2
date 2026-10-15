<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments;

interface PaymentProvider
{
    public function name(): string;

    public function createReservation(PaymentCommand $command): ProviderResult;

    public function chargeBalance(PaymentCommand $command): ProviderResult;

    public function reconcile(string $providerPaymentId): ProviderResult;

    /** @param array<string, string> $headers */
    public function verifyWebhook(string $rawPayload, array $headers): VerifiedWebhook;
}
