<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

/** Immutable wire evidence derived from a persisted, disabled v2 draft.
 * No customer consent, issuance authority or provider activation is inferred.
 */
final readonly class CheckoutConditionsV1
{
    private function __construct(
        public \stdClass $conditions,
        public string $digest,
        private string $canonical,
    ) {
    }

    /** @param array<string,mixed> $draft */
    public static function fromDraft(array $draft, int $nowMs): self
    {
        self::check(self::integer($draft, 'contract_version') === 2
            && self::field($draft, 'status') === 'DRAFT_INTERNAL'
            && self::field($draft, 'provider') === null
            && self::field($draft, 'public_token_hash') === null);
        $agreementId = self::field($draft, 'public_uuid');
        self::check(is_string($agreementId)
            && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $agreementId) === 1);
        $raw = self::field($draft, 'operation_json');
        self::check(is_string($raw) && $raw !== '' && strlen($raw) <= 196608);
        try {
            $value = json_decode($raw, false, 40, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \DomainException('INVALID_CHECKOUT_CONDITIONS_V1');
        }
        self::check($value instanceof \stdClass && InternalPaymentPlanV2::encodeCanonical($value) === $raw);
        $operation = OperationalPaymentAgreementV2::validateOperation($value, $nowMs);
        $operationDigest = hash('sha256', $raw);
        self::check(self::field($draft, 'operation_id') === $operation->operationId
            && self::field($draft, 'operation_digest') === $operationDigest);
        $plan = $operation->prepared->plan;
        $quote = $plan->sourceQuote;
        $schedule = $plan->paymentSchedule;
        $expected = [
            'configuration_id' => $operation->configurationId,
            'configuration_digest' => $operation->configurationDigest,
            'payment_mode' => $plan->paymentMode,
            'currency' => $quote->currency,
            'source_lead_id' => $plan->canonicalLeadId,
            'source_quote_id' => $quote->digest,
            'source_quote_version' => (string) $quote->version,
            'recipient_name' => $operation->recipient->name,
            'recipient_email' => $operation->recipient->email,
            'recipient_phone' => $operation->recipient->phone,
            'service_name' => $operation->service->name,
            'event_location' => $operation->service->eventLocation,
            'event_at_utc' => self::databaseTime($schedule?->eventInstant),
            'balance_due_at_utc' => self::databaseTime($schedule?->balanceInstant),
            'balance_timezone' => $schedule?->configured->timezone,
            'link_expires_at' => self::databaseTime($plan->linkExpiration->instant),
            'link_revoked_at' => null,
            'link_expired_event_at' => null,
            'monday_item_id' => null,
            'internal_notes' => null,
            'terms_version' => 'v2-draft',
            'reservation_policy_version' => 'v2-draft',
        ];
        foreach ($expected as $field => $value) {
            self::check(self::field($draft, $field) === $value);
        }
        foreach ([
            'total_cents' => $quote->totalCents,
            'initial_cents' => $plan->initialPaymentCents,
            'balance_cents' => $plan->paymentBalanceCents,
        ] as $field => $amount) {
            self::check(self::integer($draft, $field) === $amount);
        }
        self::check($plan->paymentMode === 'fixed_49_reservation'
            ? self::integer($draft, 'reservation_cents') === 4900
            : self::field($draft, 'reservation_cents') === null);
        // A MySQL customer FK or joined provider resources must not silently
        // add customer/provider authority to this disabled draft evidence.
        foreach (['customer_id', 'paypal_subscription_id', 'paypal_status', 'paypal_start_at_utc'] as $field) {
            if (array_key_exists($field, $draft)) {
                self::check($draft[$field] === null);
            }
        }
        $created = self::field($draft, 'created_at');
        self::check(is_string($created));
        $createdAt = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $created, new \DateTimeZone('UTC'));
        $errors = \DateTimeImmutable::getLastErrors();
        self::check($createdAt !== false && ($errors === false || $errors['warning_count'] + $errors['error_count'] === 0)
            && $createdAt->format('Y-m-d H:i:s.u') === $created);
        $createdMs = $createdAt->getTimestamp() * 1000 + intdiv((int) $createdAt->format('u'), 1000);
        self::check($createdMs >= $operation->prepared->internalApproval->atMs && $createdMs <= $nowMs);
        if (array_key_exists('updated_at', $draft)) {
            self::check($draft['updated_at'] === $created);
        }
        $conditions = (object) [
            'contractVersion' => 1,
            'purpose' => 'gourmet_payment_checkout',
            'sourceDraft' => (object) [
                'agreementId' => $agreementId,
                'operationId' => $operation->operationId,
                'operationDigest' => $operationDigest,
            ],
            'operation' => $operation,
        ];
        $canonical = InternalPaymentPlanV2::encodeCanonical($conditions);
        return new self($conditions, hash('sha256', $canonical), $canonical);
    }

    public function canonicalJson(): string
    {
        // readonly does not recursively freeze stdClass. Refuse a changed
        // public view instead of signing or projecting a mutated object.
        self::check(InternalPaymentPlanV2::encodeCanonical($this->conditions) === $this->canonical
            && hash_equals($this->digest, hash('sha256', $this->canonical)));
        return $this->canonical;
    }

    public function assertCurrent(int $nowMs): void
    {
        $this->canonicalJson();
        OperationalPaymentAgreementV2::validateOperation($this->conditions->operation, $nowMs);
    }

    /** Validate stored checkout wire; callers must bind it to their child row. */
    public static function fromCanonical(string $raw, int $nowMs): self
    {
        self::check($raw !== '' && strlen($raw) <= 196608);
        try { $value = json_decode($raw, false, 40, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \DomainException('INVALID_CHECKOUT_CONDITIONS_V1'); }
        self::check($value instanceof \stdClass && InternalPaymentPlanV2::encodeCanonical($value) === $raw);
        self::keys($value, ['contractVersion', 'purpose', 'sourceDraft', 'operation']);
        self::check($value->contractVersion === 1 && $value->purpose === 'gourmet_payment_checkout'
            && $value->sourceDraft instanceof \stdClass);
        self::keys($value->sourceDraft, ['agreementId', 'operationId', 'operationDigest']);
        self::check(is_string($value->sourceDraft->agreementId)
            && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $value->sourceDraft->agreementId) === 1);
        $operation = OperationalPaymentAgreementV2::validateOperation($value->operation, $nowMs);
        self::check($value->sourceDraft->operationId === $operation->operationId
            && $value->sourceDraft->operationDigest === hash('sha256', InternalPaymentPlanV2::encodeCanonical($operation)));
        return new self($value, hash('sha256', $raw), $raw);
    }

    /** @return array{representation:?string,blockers:list<string>} */
    public function providerAssessment(): array
    {
        $this->canonicalJson();
        $split = $this->conditions->operation->prepared->plan->paymentMode !== 'full_upfront';
        return [
            'representation' => $split ? 'subscriptions_setup_and_one_balance' : 'orders_capture',
            'blockers' => ['PROVIDER_DISABLED'],
        ];
    }

    /** @param list<string> $keys */
    private static function keys(\stdClass $value, array $keys): void
    {
        $actual = array_keys(get_object_vars($value)); sort($actual, SORT_STRING); sort($keys, SORT_STRING);
        self::check($actual === $keys);
    }

    /** @param array<string,mixed> $draft */
    private static function field(array $draft, string $name): mixed
    {
        self::check(array_key_exists($name, $draft));
        return $draft[$name];
    }

    /** Canonical PDO integer strings are accepted without lossy coercion.
     * @param array<string,mixed> $draft
     */
    private static function integer(array $draft, string $name): int
    {
        $value = self::field($draft, $name);
        if (is_string($value)) {
            self::check(preg_match('/^(?:0|[1-9][0-9]{0,9})$/D', $value) === 1);
            $value = (int) $value;
        }
        self::check(is_int($value) && $value >= 0 && $value <= 1000000000);
        return $value;
    }

    private static function databaseTime(?string $instant): ?string
    {
        return $instant === null ? null : (new \DateTimeImmutable($instant))
            ->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
    }

    private static function check(bool $condition): void
    {
        if (!$condition) {
            throw new \DomainException('INVALID_CHECKOUT_CONDITIONS_V1');
        }
    }
}
