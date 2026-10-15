<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

/**
 * A separately authorized attempt to issue checkout from a persisted draft.
 * Service authentication and issuance capability are not customer consent.
 * Issuance creates a linked checkout; activating its provider is a separate gate.
 */
final readonly class InternalCheckoutEmissionV1
{
    private function __construct(
        public string $issuanceId,
        public string $sourceDraftId,
        public string $operationId,
        public string $operationDigest,
        public string $conditionsDigest,
        public \stdClass $authorization,
    ) {
    }

    public static function fromJson(string $rawBody, int $nowMs): self
    {
        self::check($rawBody !== '' && strlen($rawBody) <= 16384);
        try { $value = json_decode($rawBody, false, 16, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \DomainException('INVALID_CHECKOUT_EMISSION_V1'); }
        self::object($value, ['contractVersion', 'issuanceId', 'sourceDraftId', 'operationId', 'operationDigest', 'conditionsDigest', 'authorization']);
        self::check(InternalPaymentPlanV2::encodeCanonical($value) === $rawBody && $value->contractVersion === 1);
        self::check(is_string($value->sourceDraftId)
            && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $value->sourceDraftId) === 1);
        foreach (['issuanceId', 'operationId', 'operationDigest', 'conditionsDigest'] as $field) { self::hashValue($value->{$field}); }
        $expected = hash('sha256', InternalPaymentPlanV2::encodeCanonical((object) [
            'contractVersion' => 1,
            'purpose' => 'issue_payment_checkout_v1',
            'sourceDraftId' => $value->sourceDraftId,
            'operationId' => $value->operationId,
            'operationDigest' => $value->operationDigest,
            'conditionsDigest' => $value->conditionsDigest,
        ]));
        self::check(hash_equals($expected, $value->issuanceId));
        $authorization = self::object($value->authorization, [
            'issuer', 'purpose', 'capability', 'actorId', 'scope', 'issuanceId', 'sourceDraftId',
            'operationDigest', 'conditionsDigest', 'issuedAtMs', 'expiresAtMs',
        ]);
        self::check($authorization->issuer === 'gourmet_office'
            && $authorization->purpose === 'issue_payment_checkout_v1'
            && $authorization->capability === 'issue_payment_checkout_v1');
        self::identifier($authorization->actorId);
        $scope = self::object($authorization->scope, ['organizationId', 'workspaceId', 'mode']);
        self::identifier($scope->organizationId);
        self::identifier($scope->workspaceId);
        self::check(in_array($scope->mode, ['test', 'commercial'], true));
        foreach (['issuanceId', 'sourceDraftId', 'operationDigest', 'conditionsDigest'] as $field) {
            self::check($authorization->{$field} === $value->{$field});
        }
        $command = new self($value->issuanceId, $value->sourceDraftId, $value->operationId,
            $value->operationDigest, $value->conditionsDigest, $authorization);
        $command->assertFresh($nowMs);
        return $command;
    }

    public function idempotencyKey(): string
    {
        return 'gourmet-checkout-v1-' . $this->issuanceId;
    }

    public function assertFresh(int $nowMs): void
    {
        $a = $this->authorization;
        self::check($nowMs >= 0 && $nowMs <= 8640000000000000
            && is_int($a->issuedAtMs) && is_int($a->expiresAtMs)
            && $a->issuedAtMs >= 0 && $a->issuedAtMs <= $nowMs && $a->expiresAtMs > $nowMs
            && $a->expiresAtMs <= 8640000000000000
            && $a->expiresAtMs - $a->issuedAtMs <= 300000);
    }

    public function requestHash(): string
    {
        return hash('sha256', InternalPaymentPlanV2::encodeCanonical((object) [
            'contractVersion' => 1, 'issuanceId' => $this->issuanceId, 'sourceDraftId' => $this->sourceDraftId,
            'operationId' => $this->operationId, 'operationDigest' => $this->operationDigest,
            'conditionsDigest' => $this->conditionsDigest,
        ]), true);
    }

    public function assertMatches(CheckoutConditionsV1 $derived, int $nowMs, bool $requireCurrent = true): void
    {
        $this->assertFresh($nowMs);
        if ($requireCurrent) { $derived->assertCurrent($nowMs); }
        $conditions = $derived->conditions;
        $source = $conditions->sourceDraft;
        $scope = $conditions->operation->prepared->plan->scope;
        if ($source->agreementId !== $this->sourceDraftId || $source->operationId !== $this->operationId
            || $source->operationDigest !== $this->operationDigest || $derived->digest !== $this->conditionsDigest
            || InternalPaymentPlanV2::encodeCanonical($scope) !== InternalPaymentPlanV2::encodeCanonical($this->authorization->scope)) {
            throw new \DomainException('CHECKOUT_SOURCE_CHANGED');
        }
    }

    /** @return array<string,mixed> */
    public function issuedReceipt(CheckoutConditionsV1 $derived, string $checkoutId, string $publicPaymentUrl): array
    {
        self::check(preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $checkoutId) === 1);
        self::check(preg_match('~\Ahttps?://[^\s?#]+/pay/[A-Za-z0-9_-]{43}\z~D', $publicPaymentUrl) === 1);
        return [
            'contractVersion' => 1,
            'status' => 'checkout_issued',
            'issuanceId' => $this->issuanceId,
            'sourceDraftId' => $this->sourceDraftId,
            'checkoutId' => $checkoutId,
            'conditionsDigest' => $derived->digest,
            'conditions' => $derived->conditions,
            'providerAssessment' => (object) [
                'representation' => $derived->conditions->operation->prepared->plan->paymentMode === 'full_upfront'
                    ? 'orders_capture' : 'subscriptions_setup_and_one_balance',
                'blockers' => ['PROVIDER_DISABLED'],
            ],
            'executable' => false,
            'providerEnabled' => false,
            'publicPaymentUrl' => $publicPaymentUrl,
            'authorizationVerified' => false,
            'serviceAuthenticated' => true,
        ];
    }

    /** @return array<string,mixed> */
    public function recoveredReceipt(string $json, CheckoutConditionsV1 $derived, string $checkoutId): array
    {
        try { $value = json_decode($json, false, 48, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \DomainException('INVALID_CHECKOUT_RECEIPT_V1'); }
        self::object($value, ['contractVersion', 'status', 'issuanceId', 'sourceDraftId', 'checkoutId',
            'conditionsDigest', 'conditions', 'providerAssessment', 'publicPaymentUrl', 'executable',
            'providerEnabled', 'authorizationVerified', 'serviceAuthenticated']);
        self::check(InternalPaymentPlanV2::encodeCanonical($value) === $json && is_string($value->publicPaymentUrl));
        $expected = $this->issuedReceipt($derived, $checkoutId, $value->publicPaymentUrl);
        self::check(InternalPaymentPlanV2::encodeCanonical((object) $expected) === $json);
        return get_object_vars($value);
    }

    /** @param list<string> $keys */
    private static function object(mixed $value, array $keys): \stdClass
    {
        self::check($value instanceof \stdClass);
        $actual = array_keys(get_object_vars($value));
        sort($actual, SORT_STRING); sort($keys, SORT_STRING);
        self::check($actual === $keys);
        return $value;
    }

    private static function identifier(mixed $value): void
    {
        self::check(is_string($value) && strlen($value) <= 96
            && preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $value) === 1
            && !in_array($value, ['constructor', 'prototype', '__proto__'], true));
    }

    private static function hashValue(mixed $value): void
    {
        self::check(is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) === 1);
    }

    private static function check(bool $condition): void
    {
        if (!$condition) { throw new \DomainException('INVALID_CHECKOUT_EMISSION_V1'); }
    }
}
