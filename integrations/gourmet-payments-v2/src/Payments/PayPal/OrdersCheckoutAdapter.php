<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Http\CheckoutConditionsV1;

/** Orders CAPTURE over the original authenticated client/transport, with no
 * credential lookup or default transport. Construction never makes a request.
 */
final readonly class OrdersCheckoutAdapter
{
    public function __construct(private PayPalClient $client, private string $expectedMerchantId)
    {
        if (preg_match('/^[A-Za-z0-9]{1,127}$/D', $expectedMerchantId) !== 1) {
            throw new \DomainException('EXPECTED_PAYPAL_MERCHANT_REQUIRED');
        }
    }

    /** @return array<string,mixed> */
    public function create(CheckoutConditionsV1 $conditions, string $childUuid, int $nowMs, string $returnUrl, string $cancelUrl): array
    {
        $this->guardClock($conditions, $nowMs);
        $projection = VersionedCheckoutPayloads::project($conditions, $nowMs, $childUuid);
        $payload = $projection['ordersFields'];
        self::check(is_array($payload));
        $payload['purchase_units'][0]['payee'] = ['merchant_id' => $this->expectedMerchantId];
        $payload['payment_source'] = ['paypal' => ['experience_context' => [
            'return_url' => $returnUrl, 'cancel_url' => $cancelUrl,
            'user_action' => 'PAY_NOW', 'shipping_preference' => 'NO_SHIPPING',
        ]]];
        $result = $this->client->createOrder($payload, self::requestId('create', $conditions, $childUuid));
        return $this->validated($result, null, $conditions, $childUuid);
    }

    /** Read-only recovery does not reinterpret historical evidence as a new sale.
     * @return array<string,mixed>
     */
    public function get(string $orderId, CheckoutConditionsV1 $conditions, string $childUuid): array
    {
        self::providerId($orderId);
        return $this->validated($this->client->getOrder($orderId), $orderId, $conditions, $childUuid);
    }

    /** Capture requires a current checkout and an approved, locally bound order.
     * A completed authoritative GET is recovery, never another capture.
     * @return array<string,mixed>
     */
    public function capture(string $orderId, CheckoutConditionsV1 $conditions, string $childUuid, int $nowMs): array
    {
        $this->guardClock($conditions, $nowMs);
        $current = $this->get($orderId, $conditions, $childUuid);
        if ($current['paid']) { return $current; }
        $conditions->assertCurrent($nowMs);
        self::check($current['status'] === 'APPROVED');
        try {
            $response = $this->client->captureOrder($orderId, self::requestId('capture', $conditions, $childUuid, $orderId));
        } catch (PayPalTransportException | PayPalApiException $exception) {
            // A capture response can be lost, or another identical attempt can
            // have completed. Only authoritative, bound financial evidence
            // resolves it. No second POST or newly generated request ID occurs.
            try { $recovered = $this->get($orderId, $conditions, $childUuid); }
            catch (\Throwable) { throw $exception; }
            if ($recovered['paid']) { return $recovered; }
            throw $exception;
        }
        return $this->validated($response, $orderId, $conditions, $childUuid);
    }

    public static function requestId(string $action, CheckoutConditionsV1 $conditions, string $childUuid, ?string $orderId = null): string
    {
        self::check(in_array($action, ['create', 'capture'], true));
        $conditions->canonicalJson();
        VersionedCheckoutPayloads::assertChildUuid($childUuid, $conditions->conditions->sourceDraft->agreementId);
        if ($orderId !== null) { self::providerId($orderId); }
        return ($action === 'create' ? 'gco-' : 'gcc-') . substr(hash('sha256',
            $action . ':' . $childUuid . ':' . $conditions->digest . ':' . ($orderId ?? '')), 0, 32);
    }

    /** @param array<string,mixed> $order @return array<string,mixed> */
    private function validated(array $order, ?string $orderId, CheckoutConditionsV1 $conditions, string $childUuid): array
    {
        $conditions->canonicalJson();
        VersionedCheckoutPayloads::assertChildUuid($childUuid, $conditions->conditions->sourceDraft->agreementId);
        $plan = $conditions->conditions->operation->prepared->plan;
        self::check($plan->paymentMode === 'full_upfront');
        $id = $order['id'] ?? null;
        self::check(is_string($id)); self::providerId($id);
        self::check($orderId === null || $id === $orderId);
        self::check(($order['intent'] ?? null) === 'CAPTURE'
            && in_array($order['status'] ?? null, ['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'COMPLETED', 'VOIDED'], true));
        $units = $order['purchase_units'] ?? null;
        self::check(is_array($units) && array_is_list($units) && count($units) === 1 && is_array($units[0]));
        $unit = $units[0];
        self::check(($unit['custom_id'] ?? null) === $childUuid && ($unit['invoice_id'] ?? null) === $childUuid
            && ($unit['payee']['merchant_id'] ?? null) === $this->expectedMerchantId);
        self::amount($unit['amount'] ?? null, $plan->sourceQuote->totalCents);
        $captures = $unit['payments']['captures'] ?? [];
        self::check(is_array($captures) && array_is_list($captures) && count($captures) <= 1);
        $captureId = null; $paid = false; $paidAt = null;
        if ($captures !== []) {
            $capture = $captures[0];
            self::check(is_array($capture) && is_string($capture['id'] ?? null));
            self::providerId($capture['id']);
            self::amount($capture['amount'] ?? null, $plan->sourceQuote->totalCents);
            self::check(in_array($capture['status'] ?? null, ['COMPLETED', 'PENDING', 'DECLINED', 'FAILED'], true));
            if (($capture['status'] ?? null) === 'COMPLETED') {
                self::check($order['status'] === 'COMPLETED' && ($capture['final_capture'] ?? null) === true);
                $paid = true; $captureId = $capture['id'];
                $paidAt = $capture['update_time'] ?? $capture['create_time'] ?? null;
                self::check(is_string($paidAt) && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/D', $paidAt) === 1);
                $date = new \DateTimeImmutable($paidAt);
                self::check($date->format('Y-m-d\TH:i:s') === substr($paidAt, 0, 19));
                if (isset($capture['seller_receivable_breakdown']['gross_amount'])) {
                    self::amount($capture['seller_receivable_breakdown']['gross_amount'], $plan->sourceQuote->totalCents);
                }
            }
        }
        self::check($order['status'] !== 'COMPLETED' || $paid);
        $approval = null;
        foreach ($order['links'] ?? [] as $link) {
            if (is_array($link) && in_array($link['rel'] ?? null, ['approve', 'payer-action'], true) && is_string($link['href'] ?? null)) {
                self::check(parse_url($link['href'], PHP_URL_SCHEME) === 'https'
                    && in_array(parse_url($link['href'], PHP_URL_HOST), ['www.sandbox.paypal.com', 'sandbox.paypal.com', 'www.paypal.com', 'paypal.com'], true)
                    && parse_url($link['href'], PHP_URL_USER) === null && parse_url($link['href'], PHP_URL_PASS) === null);
                $approval = $link['href'];
            }
        }
        return ['externalId' => $id, 'status' => $order['status'], 'approvalUrl' => $approval,
            'paid' => $paid, 'captureId' => $captureId, 'paidAt' => $paidAt, 'raw' => $order];
    }

    private static function amount(mixed $amount, int $expected): void
    {
        self::check(is_array($amount) && ($amount['currency_code'] ?? null) === 'USD' && is_string($amount['value'] ?? null)
            && strlen($amount['value']) <= 16);
        self::check(PayPalMoney::toCents($amount['value']) === $expected);
    }

    private function guardClock(CheckoutConditionsV1 $conditions, int $nowMs): void
    {
        $started = hrtime(true);
        $this->client->addBeforeVersionedRequest(static function () use ($conditions, $nowMs, $started): void {
            $conditions->assertCurrent($nowMs + intdiv(hrtime(true) - $started, 1000000));
        });
    }

    private static function providerId(string $id): void
    {
        self::check(preg_match('/^[A-Z0-9]{1,64}$/D', $id) === 1);
    }

    private static function check(bool $value): void
    {
        if (!$value) { throw new \DomainException('PAYPAL_ORDER_CHECKOUT_MISMATCH'); }
    }
}
