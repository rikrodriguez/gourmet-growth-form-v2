<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

use Gourmet\Payments\Domain\Money;

/**
 * Authenticated Office command for an operational, non-executable agreement.
 * The HTTP service bearer authenticates the caller. These pins bind that
 * service's assertion to one immutable operation; they do not prove customer
 * consent or authorize a provider charge.
 */
final readonly class OperationalPaymentAgreementV2
{
    public const IDEMPOTENCY_SCOPE = 'internal.payment_agreements.draft.v2';

    private function __construct(
        public \stdClass $operation,
        public \stdClass $authorization,
        public string $operationDigest,
    ) {
    }

    public static function fromJson(string $rawBody, int $nowMs): self
    {
        $envelope = self::decode($rawBody);
        self::object($envelope, ['operation', 'authorization']);
        $operation = self::operation($envelope->operation);
        // Application composition loads the canonical domain class; the pure
        // validator intentionally does not boot or autoload domain code.
        self::check(Money::CURRENCY === 'USD');
        // Pure contract validation is repeated using the receiver's clock,
        // before the service can persist a new agreement.
        InternalPaymentPlanV2::validate(InternalPaymentPlanV2::encodeCanonical($operation->prepared), $nowMs);
        $digest = hash('sha256', InternalPaymentPlanV2::encodeCanonical($operation));
        $authorization = self::object($envelope->authorization, [
            'issuer', 'purpose', 'actorId', 'scope', 'operationId',
            'operationDigest', 'issuedAtMs', 'expiresAtMs',
        ]);
        self::check($authorization->issuer === 'gourmet_office'
            && $authorization->purpose === 'create_disabled_payment_agreement_v2');
        self::identifier($authorization->actorId);
        self::check(InternalPaymentPlanV2::encodeCanonical($authorization->scope)
            === InternalPaymentPlanV2::encodeCanonical($operation->prepared->plan->scope));
        self::check($authorization->operationId === $operation->operationId
            && $authorization->operationDigest === $digest);
        self::check(is_int($authorization->issuedAtMs) && is_int($authorization->expiresAtMs)
            && $authorization->issuedAtMs >= 0 && $authorization->issuedAtMs <= $nowMs
            && $authorization->expiresAtMs > $nowMs
            && $authorization->expiresAtMs - $authorization->issuedAtMs <= 300000);
        // A retry may be authorized by another currently permitted operator;
        // prepared.internalApproval remains the original plan approval.
        return new self($operation, $authorization, $digest);
    }

    /** @return array{operationId:string,operationDigest:string} */
    public static function reconciliationFromJson(string $rawBody): array
    {
        $value = self::decode($rawBody);
        self::object($value, ['operationId', 'operationDigest']);
        self::hashValue($value->operationId);
        self::hashValue($value->operationDigest);
        return ['operationId' => $value->operationId, 'operationDigest' => $value->operationDigest];
    }

    public static function idempotencyKey(string $operationId): string
    {
        self::hashValue($operationId);
        return 'gourmet-v2-' . $operationId;
    }

    public function requestHash(): string
    {
        return hex2bin($this->operationDigest);
    }

    /** @return array<string,mixed> */
    public function operationArray(): array
    {
        return json_decode(InternalPaymentPlanV2::encodeCanonical($this->operation), true, 32, JSON_THROW_ON_ERROR);
    }

    /** @return array<string,mixed> */
    public function receipt(string $agreementId): array
    {
        self::check(preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $agreementId) === 1);
        return [
            'contractVersion' => 2,
            'status' => 'draft_persisted',
            'agreementId' => $agreementId,
            'operationId' => $this->operation->operationId,
            'operationDigest' => $this->operationDigest,
            'operation' => $this->operation,
            'executable' => false,
            'providerEnabled' => false,
            'publicPaymentUrl' => null,
            'authorizationVerified' => false,
            'serviceAuthenticated' => true,
        ];
    }

    /**
     * Read-only recovery validates immutable stored evidence, without applying
     * today's calendar to an agreement already committed in the ledger.
     * @return array<string,mixed>
     */
    public static function recoveredReceipt(string $json, string $operationId, string $operationDigest): array
    {
        $receipt = self::decode($json);
        self::object($receipt, [
            'contractVersion', 'status', 'agreementId', 'operationId', 'operationDigest',
            'operation', 'executable', 'providerEnabled', 'publicPaymentUrl',
            'authorizationVerified', 'serviceAuthenticated',
        ]);
        self::check($receipt->contractVersion === 2 && $receipt->status === 'draft_persisted'
            && $receipt->operationId === $operationId && $receipt->operationDigest === $operationDigest
            && $receipt->executable === false && $receipt->providerEnabled === false
            && $receipt->publicPaymentUrl === null && $receipt->authorizationVerified === false
            && $receipt->serviceAuthenticated === true);
        self::check(is_string($receipt->agreementId)
            && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $receipt->agreementId) === 1);
        $operation = self::operation($receipt->operation);
        self::check($operation->operationId === $operationId
            && hash_equals($operationDigest, hash('sha256', InternalPaymentPlanV2::encodeCanonical($operation))));
        return get_object_vars($receipt);
    }

    private static function operation(mixed $value): \stdClass
    {
        $operation = self::object($value, [
            'contractVersion', 'operationId', 'configurationId', 'configurationDigest',
            'prepared', 'recipient', 'service',
        ]);
        self::check($operation->contractVersion === 2);
        self::hashValue($operation->operationId);
        self::identifier($operation->configurationId);
        self::hashValue($operation->configurationDigest);
        self::check($operation->prepared instanceof \stdClass
            && ($operation->prepared->plan ?? null) instanceof \stdClass);
        $plan = $operation->prepared->plan;
        self::check(($plan->scope ?? null) instanceof \stdClass);
        $scope = self::object($plan->scope, ['organizationId', 'workspaceId', 'mode']);
        self::identifier($scope->organizationId);
        self::identifier($scope->workspaceId);
        self::check(in_array($scope->mode, ['test', 'commercial'], true));
        self::identifier($plan->eventId ?? null);
        self::hashValue($plan->preparationDigest ?? null);
        $id = hash('sha256', InternalPaymentPlanV2::encodeCanonical((object) [
            'scope' => $scope,
            'eventId' => $plan->eventId,
            'configurationId' => $operation->configurationId,
            'configurationDigest' => $operation->configurationDigest,
            'preparationDigest' => $plan->preparationDigest,
        ]));
        self::check(hash_equals($id, $operation->operationId));
        $recipient = self::object($operation->recipient, ['name', 'email', 'phone']);
        self::text($recipient->name, 160);
        self::text($recipient->email, 254);
        self::check($recipient->email === ($plan->sourceQuote->intendedRecipient ?? null));
        if ($recipient->phone !== null) {
            self::text($recipient->phone, 32);
        }
        $service = self::object($operation->service, ['name', 'eventLocation']);
        self::text($service->name, 180);
        if ($service->eventLocation !== null) {
            self::text($service->eventLocation, 500);
        }
        return $operation;
    }

    private static function decode(string $raw): \stdClass
    {
        self::check($raw !== '' && strlen($raw) <= 196608);
        try {
            $value = json_decode($raw, false, 40, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \DomainException('INVALID_OPERATIONAL_PAYMENT_V2');
        }
        self::check($value instanceof \stdClass
            && InternalPaymentPlanV2::encodeCanonical($value) === $raw);
        return $value;
    }

    /** @param list<string> $keys */
    private static function object(mixed $value, array $keys): \stdClass
    {
        self::check($value instanceof \stdClass);
        $actual = array_keys(get_object_vars($value));
        sort($actual, SORT_STRING);
        sort($keys, SORT_STRING);
        self::check($actual === $keys);
        return $value;
    }

    private static function identifier(mixed $value): void
    {
        self::text($value, 96);
        self::check(preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $value) === 1
            && !in_array($value, ['constructor', 'prototype', '__proto__'], true));
    }

    private static function hashValue(mixed $value): void
    {
        self::check(is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) === 1);
    }

    private static function text(mixed $value, int $max): void
    {
        self::check(is_string($value) && trim($value) !== ''
            && intdiv(strlen(mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2) <= $max
            && preg_match('/[\x00-\x1f\x7f]/u', $value) !== 1);
    }

    private static function check(bool $condition): void
    {
        if (!$condition) {
            throw new \DomainException('INVALID_OPERATIONAL_PAYMENT_V2');
        }
    }
}
