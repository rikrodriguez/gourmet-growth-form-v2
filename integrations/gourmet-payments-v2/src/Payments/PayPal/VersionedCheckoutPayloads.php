<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Http\CheckoutConditionsV1;

/** Pure provider field projection, never a provisioner or checkout command.
 * Product/plan IDs, approval URLs and provider authority are deliberately absent.
 */
final class VersionedCheckoutPayloads
{
    /** @return array<string,mixed> */
    public static function project(CheckoutConditionsV1 $conditions, int $nowMs, ?string $childAgreementUuid = null): array
    {
        $conditions->assertCurrent($nowMs);
        // Detach every returned object from the public read-only evidence view.
        $wire = json_decode($conditions->canonicalJson(), false, 40, JSON_THROW_ON_ERROR);
        $assessment = $conditions->providerAssessment();
        $plan = $wire->operation->prepared->plan;
        $result = [
            'status' => $childAgreementUuid === null ? 'provider_binding_required' : 'projected_provider_fields',
            'conditionsDigest' => $conditions->digest,
            'sourceDraft' => $wire->sourceDraft,
            'representation' => $assessment['representation'],
            'providerEnabled' => false,
            'executable' => false,
            'publicPaymentUrl' => null,
            'blockers' => $assessment['blockers'],
            'consentPolicy' => [
                'termsAcceptanceRequired' => true,
                'balanceAutocollectionConsentRequired' => $plan->paymentMode !== 'full_upfront',
                'customerConsentVerified' => false,
            ],
            'planFields' => null,
            'subscriptionFields' => null,
            'ordersFields' => null,
        ];
        if ($childAgreementUuid === null) { return $result; }
        self::assertChildUuid($childAgreementUuid, $wire->sourceDraft->agreementId);
        if ($plan->paymentMode === 'full_upfront') {
            $result['ordersFields'] = [
                'intent' => 'CAPTURE',
                'purchase_units' => [[
                    'custom_id' => $childAgreementUuid,
                    'invoice_id' => $childAgreementUuid,
                    'amount' => ['currency_code' => 'USD', 'value' => PayPalMoney::fromCents($plan->sourceQuote->totalCents)],
                ]],
            ];
            return $result;
        }
        $result['planFields'] = [
            'billing_cycles' => [[
                'frequency' => ['interval_unit' => 'DAY', 'interval_count' => 1],
                'tenure_type' => 'REGULAR',
                'sequence' => 1,
                'total_cycles' => 1,
                'pricing_scheme' => ['fixed_price' => [
                    'value' => PayPalMoney::fromCents($plan->paymentBalanceCents),
                    'currency_code' => 'USD',
                ]],
            ]],
            'payment_preferences' => [
                'auto_bill_outstanding' => true,
                'setup_fee' => [
                    'value' => PayPalMoney::fromCents($plan->initialPaymentCents),
                    'currency_code' => 'USD',
                ],
                'setup_fee_failure_action' => 'CANCEL',
                'payment_failure_threshold' => 0,
            ],
        ];
        $result['subscriptionFields'] = [
            'start_time' => $plan->paymentSchedule->balanceInstant,
            'custom_id' => $childAgreementUuid,
        ];
        return $result;
    }

    public static function assertChildUuid(string $childUuid, string $parentUuid): void
    {
        if ($childUuid === $parentUuid || preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $childUuid) !== 1) {
            throw new \DomainException('INVALID_CHECKOUT_CHILD_BINDING');
        }
    }
}
