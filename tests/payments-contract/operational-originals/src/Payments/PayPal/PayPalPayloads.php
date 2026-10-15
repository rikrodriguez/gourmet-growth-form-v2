<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

final class PayPalPayloads
{
    /** @return array<string, mixed> */
    public static function product(): array
    {
        return [
            'name' => 'Gourmet Catering Reservation',
            'description' => 'Sandbox product for the two-payment Gourmet catering proof of concept.',
            'type' => 'SERVICE',
        ];
    }

    /** @return array<string, mixed> */
    public static function plan(string $productId, string $currency = 'USD', int $balanceCents = 100): array
    {
        self::requireUsd($currency);
        if (preg_match('/\APROD-[A-Z0-9]{17}\z/', $productId) !== 1) {
            throw new \DomainException('A valid PayPal product ID is required.');
        }

        return [
            'product_id' => $productId,
            'name' => 'Gourmet reservation and scheduled balance',
            'description' => 'USD 49 setup fee and one finite future balance payment.',
            'status' => 'ACTIVE',
            'billing_cycles' => [[
                'frequency' => [
                    'interval_unit' => 'DAY',
                    'interval_count' => 1,
                ],
                'tenure_type' => 'REGULAR',
                'sequence' => 1,
                'total_cycles' => 1,
                'pricing_scheme' => [
                    'fixed_price' => [
                        'value' => PayPalMoney::fromCents($balanceCents),
                        'currency_code' => 'USD',
                    ],
                ],
            ]],
            'payment_preferences' => [
                'auto_bill_outstanding' => true,
                'setup_fee' => [
                    'value' => '49.00',
                    'currency_code' => 'USD',
                ],
                'setup_fee_failure_action' => 'CANCEL',
                'payment_failure_threshold' => 0,
            ],
        ];
    }

    /** @return array<string, mixed> */
    public static function subscription(
        string $planId,
        string $agreementUuid,
        \DateTimeImmutable $startTime,
        ?\DateTimeImmutable $now = null,
    ): array {
        if (preg_match('/\AP-[A-Z0-9]{24}\z/', $planId) !== 1 || preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i', $agreementUuid) !== 1) {
            throw new \DomainException('A plan ID and opaque agreement UUID are required.');
        }
        $utc = new \DateTimeZone('UTC');
        $current = ($now ?? new \DateTimeImmutable('now', $utc))->setTimezone($utc);
        $start = $startTime->setTimezone($utc);
        if ($start <= $current) {
            throw new \DomainException('The PayPal subscription start time must be in the future.');
        }

        return [
            'plan_id' => $planId,
            'start_time' => $start->format('Y-m-d\TH:i:s\Z'),
            'custom_id' => $agreementUuid,
        ];
    }

    /** @param array<string, mixed> $plan */
    public static function assertFinitePlan(array $plan, ?int $expectedBalanceCents = null): void
    {
        $cycles = $plan['billing_cycles'] ?? null;
        $preferences = $plan['payment_preferences'] ?? null;
        if (!is_array($cycles) || count($cycles) !== 1 || !is_array($cycles[0] ?? null) || !is_array($preferences)) {
            throw new \DomainException('PayPal plan must contain exactly one regular billing cycle.');
        }
        $cycle = $cycles[0];
        $regular = $cycle['pricing_scheme']['fixed_price'] ?? null;
        $setup = $preferences['setup_fee'] ?? null;
        $valid = is_array($regular)
            && is_array($setup)
            && ($cycle['tenure_type'] ?? null) === 'REGULAR'
            && (int) ($cycle['sequence'] ?? 0) === 1
            && (int) ($cycle['total_cycles'] ?? 0) === 1
            && ($regular['currency_code'] ?? null) === 'USD'
            && is_string($regular['value'] ?? null)
            && ($expectedBalanceCents === null || PayPalMoney::toCents($regular['value']) === $expectedBalanceCents)
            && PayPalMoney::toCents($regular['value']) > 0
            && ($setup['currency_code'] ?? null) === 'USD'
            && is_string($setup['value'] ?? null)
            && PayPalMoney::toCents($setup['value']) === 4900
            && ($preferences['setup_fee_failure_action'] ?? null) === 'CANCEL'
            && ($preferences['auto_bill_outstanding'] ?? null) === true;
        if (!$valid) {
            throw new \DomainException('PayPal plan does not satisfy the Phase 3 finite USD invariants.');
        }
    }

    private static function requireUsd(string $currency): void
    {
        if ($currency !== 'USD') {
            throw new \DomainException('PayPal Phase 3 supports USD only.');
        }
    }
}
