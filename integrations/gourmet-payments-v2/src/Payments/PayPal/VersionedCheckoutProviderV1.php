<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Database\AuditLog;
use Gourmet\Payments\Database\IdempotencyGuard;
use Gourmet\Payments\Database\ProviderResourceRepository;
use Gourmet\Payments\Http\CheckoutConditionsV1;
use Gourmet\Payments\Http\InternalPaymentPlanV2;
use Gourmet\Payments\Support\Uuid;
use PDO;

/** Explicit server composition of the original client, provisioning registry
 * and idempotency ledger. The HTTP caller owns activation, token, CSRF and
 * customer consent. No transport or credentials are discovered here.
 */
final readonly class VersionedCheckoutProviderV1
{
    private PayPalClient $client;
    private ProviderResourceRepository $resources;
    private IdempotencyGuard $guard;
    private PayPalProvisioningService $provisioner;

    public function __construct(private PDO $pdo, PayPalConfig $config, PayPalHttpTransport $transport, private ?string $expectedMerchantId = null)
    {
        $this->client = new PayPalClient($config, $transport);
        $this->resources = new ProviderResourceRepository($pdo);
        $this->guard = new IdempotencyGuard($pdo);
        $this->provisioner = new PayPalProvisioningService($pdo, $this->client, $this->resources, $this->guard);
    }

    /** @param array<string,mixed> $child @return array<string,mixed> */
    public function start(array $child, \stdClass $conditions, string $returnUrl, string $cancelUrl, int $nowMs): array
    {
        $clock = $this->clock($nowMs);
        $evidence = $this->bind($child, $conditions, $nowMs, true);
        $this->client->setBeforeVersionedRequest(fn () => $this->guardBeforeMutation($child, $evidence, $clock));
        $this->urls($returnUrl, $cancelUrl, $evidence);
        $resource = $this->resource($child);
        if ($resource !== null) { return $this->read($child, $evidence, $resource, $nowMs); }
        if ($child['payment_mode'] === 'full_upfront') {
            $adapter = $this->orders();
            $key = OrdersCheckoutAdapter::requestId('create', $evidence, $child['public_uuid']);
            $hash = $this->orderHash($child, $evidence);
            $this->guard->begin('PAYPAL_CHECKOUT_ORDER_CREATE_V1', $key, $hash);
            try {
                $order = $adapter->create($evidence, $child['public_uuid'], $clock(), $returnUrl, $cancelUrl);
                $this->pdo->beginTransaction();
                try {
                    $this->resources->insert(['provider' => 'PAYPAL', 'resource_type' => 'ORDER',
                        'external_id' => $order['externalId'], 'parent_external_id' => null,
                        'agreement_id' => (int) $child['id'], 'status' => $order['status'],
                        'idempotency_key' => $key, 'configuration_hash' => $hash,
                        'start_at_utc' => null, 'approved_at_utc' => null]);
                    $this->guard->complete('PAYPAL_CHECKOUT_ORDER_CREATE_V1', $key, 201, hash('sha256', json_encode($order, JSON_THROW_ON_ERROR), true));
                    $update = $this->pdo->prepare("UPDATE payment_agreements SET provider = 'PAYPAL' WHERE id = :id AND contract_version = 3");
                    $update->execute(['id' => $child['id']]);
                    $this->pdo->commit();
                } catch (\Throwable $exception) {
                    if ($this->pdo->inTransaction()) { $this->pdo->rollBack(); }
                    throw $exception;
                }
            } catch (\Throwable $exception) {
                $this->guard->markAmbiguous('PAYPAL_CHECKOUT_ORDER_CREATE_V1', $key);
                throw $exception;
            }
            $resource = $this->resource($child);
            self::check($resource !== null);
            return $this->orderResult($child, $evidence, $resource, $order, $clock());
        }
        $product = $this->provisioner->createOrReuseVersionedProduct();
        $plan = $this->provisioner->createOrReuseVersionedPlan($product->externalId, $evidence, $child['public_uuid'], $clock());
        $this->provisioner->createOrReuseVersionedSubscription((int) $child['id'], $child['public_uuid'], $product->externalId,
            $plan->externalId, $evidence, $clock(), $returnUrl, $cancelUrl);
        $resource = $this->resource($child);
        self::check($resource !== null);
        return $this->read($child, $evidence, $resource, $clock());
    }

    /** Return/lookup never sends a capture, even when PayPal says APPROVED.
     * @param array<string,mixed> $child @return array<string,mixed>
     */
    public function resume(array $child, \stdClass $conditions, string $providerReference, int $nowMs): array
    {
        $evidence = $this->bind($child, $conditions, $nowMs, false);
        $resource = $this->resource($child);
        self::check($resource !== null && $resource['external_id'] === $providerReference);
        return $this->read($child, $evidence, $resource, $nowMs);
    }

    /** Explicit buyer POST, called only after the HTTP CSRF/consent gates.
     * @param array<string,mixed> $child @return array<string,mixed>
     */
    public function capture(array $child, \stdClass $conditions, string $providerReference, int $nowMs): array
    {
        $clock = $this->clock($nowMs);
        $evidence = $this->bind($child, $conditions, $nowMs, false);
        $this->client->setBeforeVersionedRequest(fn () => $this->guardBeforeMutation($child, $evidence, $clock));
        self::check($child['payment_mode'] === 'full_upfront');
        $resource = $this->resource($child);
        self::check($resource !== null && $resource['external_id'] === $providerReference);
        $this->assertOrderResource($child, $evidence, $resource);
        $adapter = $this->orders();
        $current = $adapter->get($providerReference, $evidence, $child['public_uuid']);
        if ($current['paid']) { return $this->orderResult($child, $evidence, $resource, $current, $clock()); }
        $evidence->assertCurrent($clock());
        self::check($current['status'] === 'APPROVED');
        $key = OrdersCheckoutAdapter::requestId('capture', $evidence, $child['public_uuid'], $providerReference);
        $scope = 'PAYPAL_CHECKOUT_ORDER_CAPTURE_V1';
        $this->guard->begin($scope, $key, $this->orderHash($child, $evidence));
        try {
            $order = $adapter->capture($providerReference, $evidence, $child['public_uuid'], $clock());
            $result = $this->orderResult($child, $evidence, $resource, $order, $clock(), [$scope, $key]);
            if (!$order['paid']) { $this->guard->markAmbiguous($scope, $key); }
            return $result;
        } catch (\Throwable $exception) {
            $this->guard->markAmbiguous($scope, $key);
            throw $exception;
        }
    }

    /** @param array<string,mixed> $child @return array<string,mixed> */
    public function status(array $child, \stdClass $conditions, int $nowMs): array
    {
        $evidence = $this->bind($child, $conditions, $nowMs, false);
        $resource = $this->resource($child);
        if ($resource === null) { return ['status' => 'NOT_STARTED', 'paid' => false, 'approvalUrl' => null, 'providerReference' => null]; }
        return $this->read($child, $evidence, $resource, $nowMs);
    }

    /** @param array<string,mixed> $child */
    private function bind(array $child, \stdClass $wire, int $nowMs, bool $current): CheckoutConditionsV1
    {
        self::check(!$this->pdo->inTransaction()); // Never hold ledger locks across provider I/O.
        self::check(($child['contract_version'] ?? null) === 3 || ($child['contract_version'] ?? null) === '3');
        self::check(isset($child['public_uuid'], $child['id'], $child['created_at'], $child['terms_version']));
        $created = self::timestamp((string) $child['created_at']);
        $createdMs = $created->getTimestamp() * 1000 + intdiv((int) $created->format('u'), 1000);
        self::check($createdMs <= $nowMs);
        $evidence = CheckoutConditionsV1::fromCanonical(InternalPaymentPlanV2::encodeCanonical($wire), $current ? $nowMs : $createdMs);
        VersionedCheckoutPayloads::assertChildUuid($child['public_uuid'], $wire->sourceDraft->agreementId);
        self::check($child['terms_version'] === $evidence->digest);
        $plan = $wire->operation->prepared->plan;
        $expected = ['payment_mode' => $plan->paymentMode, 'currency' => 'USD',
            'source_lead_id' => $plan->canonicalLeadId, 'source_quote_id' => $plan->sourceQuote->digest,
            'source_quote_version' => (string) $plan->sourceQuote->version,
            'recipient_name' => $wire->operation->recipient->name, 'recipient_email' => $wire->operation->recipient->email,
            'recipient_phone' => $wire->operation->recipient->phone, 'service_name' => $wire->operation->service->name,
            'event_location' => $wire->operation->service->eventLocation,
            'event_at_utc' => self::databaseInstant($plan->paymentSchedule?->eventInstant),
            'balance_due_at_utc' => self::databaseInstant($plan->paymentSchedule?->balanceInstant),
            'balance_timezone' => $plan->paymentSchedule?->configured->timezone,
            'link_expires_at' => self::databaseInstant($plan->linkExpiration->instant),
            'reservation_policy_version' => 'checkout-v1-' . $plan->paymentMode];
        foreach ($expected as $field => $value) { self::check(array_key_exists($field, $child) && $child[$field] === $value); }
        foreach (['total_cents' => $plan->sourceQuote->totalCents, 'initial_cents' => $plan->initialPaymentCents, 'balance_cents' => $plan->paymentBalanceCents] as $field => $value) {
            self::check(isset($child[$field]) && (is_int($child[$field]) || ctype_digit((string) $child[$field])) && (string) $child[$field] === (string) $value);
        }
        self::check(array_key_exists('reservation_cents', $child)
            && ($plan->paymentMode === 'fixed_49_reservation' ? (string) $child['reservation_cents'] === '4900' : $child['reservation_cents'] === null));
        return $evidence;
    }

    /** @param array<string,mixed> $child @return array<string,mixed>|null */
    private function resource(array $child): ?array
    {
        $query = $this->pdo->prepare("SELECT * FROM provider_resources WHERE agreement_id = :id AND provider = 'PAYPAL' AND resource_type IN ('ORDER','SUBSCRIPTION')");
        $query->execute(['id' => $child['id']]); $rows = $query->fetchAll();
        self::check(count($rows) <= 1);
        if ($rows === []) { return null; }
        self::check($rows[0]['resource_type'] === ($child['payment_mode'] === 'full_upfront' ? 'ORDER' : 'SUBSCRIPTION'));
        return $rows[0];
    }

    /** @param array<string,mixed> $child @param array<string,mixed> $resource @return array<string,mixed> */
    private function read(array $child, CheckoutConditionsV1 $evidence, array $resource, int $nowMs): array
    {
        $clock = $this->clock($nowMs);
        if ($child['payment_mode'] === 'full_upfront') {
            $this->assertOrderResource($child, $evidence, $resource);
            return $this->orderResult($child, $evidence, $resource, $this->orders()->get($resource['external_id'], $evidence, $child['public_uuid']), $clock());
        }
        $planId = $resource['parent_external_id'];
        self::check(is_string($planId));
        $lookup = $this->pdo->prepare("SELECT * FROM provider_resources WHERE provider = 'PAYPAL' AND resource_type = 'PLAN' AND external_id = :id LIMIT 1");
        $lookup->execute(['id' => $planId]); $planResource = $lookup->fetch();
        self::check(is_array($planResource) && is_string($planResource['parent_external_id']));
        $created = self::timestamp($child['created_at']);
        $createdMs = $created->getTimestamp() * 1000 + intdiv((int) $created->format('u'), 1000);
        $expectedPlan = PayPalPayloads::versionedPlan($planResource['parent_external_id'], $evidence, $child['public_uuid'], $createdMs);
        self::check(hash_equals((string) $planResource['configuration_hash'], hash('sha256', json_encode($expectedPlan, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), true)));
        PayPalPayloads::assertVersionedPlan($this->client->getVersionedPlan($planId), $expectedPlan);
        $subscription = $this->client->getVersionedSubscription($resource['external_id']);
        PayPalPayloads::assertVersionedSubscription($subscription, $resource['external_id'], $planId, $child['public_uuid'],
            $evidence->conditions->operation->prepared->plan->paymentSchedule->balanceInstant, $expectedPlan);
        $transactions = $this->client->listVersionedTransactions($resource['external_id'], self::timestamp($child['created_at'])->modify('-1 day'),
            (new \DateTimeImmutable('@' . intdiv($nowMs, 1000)))->modify('+1 day'));
        $financial = [];
        foreach ($transactions as $transaction) {
            if (($transaction['status'] ?? null) !== 'COMPLETED') { continue; }
            $gross = $transaction['amount_with_breakdown']['gross_amount'] ?? null;
            self::check(is_array($gross) && ($gross['currency_code'] ?? null) === 'USD' && is_string($gross['value'] ?? null) && strlen($gross['value']) <= 16);
            $id = $transaction['id'] ?? null; $time = $transaction['time'] ?? null;
            self::check(is_string($id) && preg_match('/^[A-Z0-9]{1,64}$/D', $id) === 1 && is_string($time));
            $financial[] = ['id' => $id, 'amount' => PayPalMoney::toCents($gross['value']), 'time' => self::timestamp($time)];
        }
        usort($financial, static fn (array $a, array $b): int => $a['time'] <=> $b['time']);
        $result = $this->apply($child, $evidence, $resource, (string) $subscription['status'], $financial, $clock(), null, null);
        foreach ($subscription['links'] ?? [] as $link) {
            if (is_array($link) && ($link['rel'] ?? null) === 'approve' && is_string($link['href'] ?? null)) {
                self::check(parse_url($link['href'], PHP_URL_SCHEME) === 'https'
                    && in_array(parse_url($link['href'], PHP_URL_HOST), ['www.sandbox.paypal.com', 'sandbox.paypal.com', 'www.paypal.com', 'paypal.com'], true)
                    && parse_url($link['href'], PHP_URL_USER) === null && parse_url($link['href'], PHP_URL_PASS) === null);
                $result['approvalUrl'] = $link['href'];
            }
        }
        return $result;
    }

    /** @param array<string,mixed> $child @param array<string,mixed> $resource @param array<string,mixed> $order @param list<string>|null $captureGuard @return array<string,mixed> */
    private function orderResult(array $child, CheckoutConditionsV1 $evidence, array $resource, array $order, int $nowMs, ?array $captureGuard = null): array
    {
        $financial = $order['paid'] ? [['id' => $order['captureId'], 'amount' => (int) $child['total_cents'], 'time' => self::timestamp($order['paidAt'])]] : [];
        if ($order['paid'] && $captureGuard === null) {
            $scope = 'PAYPAL_CHECKOUT_ORDER_CAPTURE_V1';
            $key = OrdersCheckoutAdapter::requestId('capture', $evidence, $child['public_uuid'], $resource['external_id']);
            $query = $this->pdo->prepare('SELECT request_hash,completed_at FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key');
            $query->execute(['scope' => $scope, 'key' => $key]); $pending = $query->fetch();
            if (is_array($pending)) {
                self::check(hash_equals((string) $pending['request_hash'], $this->orderHash($child, $evidence)));
                if ($pending['completed_at'] === null) { $captureGuard = [$scope, $key]; }
            }
        }
        $result = $this->apply($child, $evidence, $resource, $order['status'], $financial, $nowMs, $captureGuard, $order['raw']);
        $result['approvalUrl'] = $order['approvalUrl'];
        return $result;
    }

    /** Only verified COMPLETED evidence reaches here; approval is not payment.
     * @param array<string,mixed> $child @param array<string,mixed> $resource @param list<array{id:string,amount:int,time:\DateTimeImmutable}> $financial
     * @param list<string>|null $captureGuard @param array<string,mixed>|null $raw @return array<string,mixed>
     */
    private function apply(array $child, CheckoutConditionsV1 $evidence, array $resource, string $providerStatus, array $financial, int $nowMs, ?array $captureGuard, ?array $raw): array
    {
        $this->pdo->beginTransaction();
        try {
            $lock = $this->pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
            $query = $this->pdo->prepare('SELECT * FROM payment_schedules WHERE agreement_id = :id ORDER BY id' . $lock);
            $query->execute(['id' => $child['id']]); $schedules = [];
            foreach ($query->fetchAll() as $schedule) { self::check(!isset($schedules[$schedule['kind']])); $schedules[$schedule['kind']] = $schedule; }
            $initialKind = $child['payment_mode'] === 'fixed_49_reservation' ? 'RESERVATION' : 'INITIAL';
            self::check(isset($schedules[$initialKind]) && count($schedules) === ((int) $child['balance_cents'] > 0 ? 2 : 1));
            self::check((int) $schedules[$initialKind]['amount_cents'] === (int) $child['initial_cents']
                && $schedules[$initialKind]['due_at_utc'] === $child['created_at']);
            if ((int) $child['balance_cents'] > 0) {
                self::check(isset($schedules['BALANCE']) && (int) $schedules['BALANCE']['amount_cents'] === (int) $child['balance_cents']
                    && $schedules['BALANCE']['due_at_utc'] === $child['balance_due_at_utc']);
            }
            foreach ($financial as $payment) {
                $paidMs = $payment['time']->getTimestamp() * 1000 + intdiv((int) $payment['time']->format('u'), 1000);
                self::check($paidMs >= self::timestamp($child['created_at'])->getTimestamp() * 1000 && $paidMs <= $nowMs);
                $kind = null;
                $initialMatches = $payment['amount'] === (int) $child['initial_cents'];
                $balanceMatches = isset($schedules['BALANCE']) && $payment['amount'] === (int) $child['balance_cents'];
                if ($initialMatches && $balanceMatches) {
                    $due = self::timestamp($child['balance_due_at_utc']);
                    if ($payment['time'] < $due) { $kind = $initialKind; }
                    elseif ($schedules[$initialKind]['status'] === 'PAID') { $kind = 'BALANCE'; }
                } elseif ($initialMatches) { $kind = $initialKind; }
                elseif ($balanceMatches && $schedules[$initialKind]['status'] === 'PAID' && $payment['time'] >= self::timestamp($child['balance_due_at_utc'])) { $kind = 'BALANCE'; }
                self::check($kind !== null);
                $schedule = $schedules[$kind];
                $existing = $this->pdo->prepare("SELECT schedule_id,amount_cents,currency,status FROM payment_attempts WHERE provider = 'PAYPAL' AND provider_payment_id = :id LIMIT 1" . $lock);
                $existing->execute(['id' => $payment['id']]); $attempt = $existing->fetch();
                if (is_array($attempt)) {
                    self::check((string) $attempt['schedule_id'] === (string) $schedule['id'] && (int) $attempt['amount_cents'] === $payment['amount']
                        && $attempt['currency'] === 'USD' && $attempt['status'] === 'SUCCEEDED');
                } else {
                    $insert = $this->pdo->prepare("INSERT INTO payment_attempts (public_uuid,schedule_id,provider,provider_payment_id,idempotency_key,amount_cents,currency,status) VALUES (:uuid,:schedule,'PAYPAL',:payment,:key,:amount,'USD','SUCCEEDED')");
                    $insert->execute(['uuid' => Uuid::v4(), 'schedule' => $schedule['id'], 'payment' => $payment['id'],
                        'key' => 'paypal:checkout:' . $payment['id'], 'amount' => $payment['amount']]);
                }
                $paidAt = $payment['time']->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
                $update = $this->pdo->prepare("UPDATE payment_schedules SET status = 'PAID', paid_at = :at WHERE id = :id AND status <> 'PAID'");
                $update->execute(['at' => $paidAt, 'id' => $schedule['id']]);
                if ($update->rowCount() === 1) {
                    (new AuditLog($this->pdo))->record('PROVIDER', 'PAYMENT_SCHEDULE_PAID', 'PAYMENT_SCHEDULE', null, $schedule['public_uuid'],
                        'paypal:checkout:' . $payment['id'], ['contract_version' => 3, 'payment_kind' => $kind, 'amount_cents' => $payment['amount'],
                            'currency' => 'USD', 'provider_payment_id' => $payment['id'], 'conditions_digest' => $evidence->digest]);
                }
                $schedules[$kind]['status'] = 'PAID';
            }
            $initialPaid = $schedules[$initialKind]['status'] === 'PAID';
            $fullyPaid = $initialPaid && (!isset($schedules['BALANCE']) || $schedules['BALANCE']['status'] === 'PAID');
            if ($initialPaid && isset($schedules['BALANCE']) && $schedules['BALANCE']['status'] === 'PENDING') {
                $update = $this->pdo->prepare("UPDATE payment_schedules SET status = 'SCHEDULED' WHERE id = :id AND status = 'PENDING'");
                $update->execute(['id' => $schedules['BALANCE']['id']]);
            }
            $agreementStatus = $fullyPaid ? 'FULLY_PAID' : ($initialPaid ? ($initialKind === 'RESERVATION' ? 'RESERVATION_PAID' : 'INITIAL_PAID') : 'PENDING_CHECKOUT');
            $update = $this->pdo->prepare("UPDATE payment_agreements SET status = :status, provider = 'PAYPAL' WHERE id = :id AND contract_version = 3");
            $update->execute(['status' => $agreementStatus, 'id' => $child['id']]);
            $update = $this->pdo->prepare('UPDATE provider_resources SET status = :status WHERE id = :id');
            $update->execute(['status' => $providerStatus, 'id' => $resource['id']]);
            if ($captureGuard !== null && $fullyPaid && $raw !== null) {
                $this->guard->complete($captureGuard[0], $captureGuard[1], 200, hash('sha256', json_encode($raw, JSON_THROW_ON_ERROR), true));
            }
            $this->pdo->commit();
            return ['status' => $providerStatus, 'paid' => $fullyPaid, 'agreementStatus' => $agreementStatus,
                'approvalUrl' => null, 'providerReference' => $resource['external_id'],
                'paidSchedules' => array_keys(array_filter($schedules, static fn (array $schedule): bool => $schedule['status'] === 'PAID'))];
        } catch (\Throwable $exception) {
            if ($this->pdo->inTransaction()) { $this->pdo->rollBack(); }
            throw $exception;
        }
    }

    private function orders(): OrdersCheckoutAdapter
    {
        self::check($this->expectedMerchantId !== null);
        return new OrdersCheckoutAdapter($this->client, $this->expectedMerchantId);
    }

    /** Last local check after OAuth/GET I/O and immediately before a provider
     * mutation. No ledger lock is held across that network operation.
     * @param array<string,mixed> $child
     */
    private function guardBeforeMutation(array $child, CheckoutConditionsV1 $evidence, \Closure $clock): void
    {
        $query = $this->pdo->prepare('SELECT public_uuid,contract_version,status,terms_version,payment_mode,public_token_hash,link_revoked_at,link_expires_at FROM payment_agreements WHERE id = :id LIMIT 1');
        $query->execute(['id' => $child['id']]); $current = $query->fetch();
        $nowMs = $clock();
        $evidence->assertCurrent($nowMs);
        self::check(is_array($current) && (string) $current['contract_version'] === '3'
            && $current['public_uuid'] === $child['public_uuid'] && $current['terms_version'] === $evidence->digest
            && $current['payment_mode'] === $child['payment_mode']
            && in_array($current['status'], ['PENDING_CHECKOUT', 'INITIAL_PAID', 'RESERVATION_PAID', 'PAYMENT_FAILED'], true)
            && $current['public_token_hash'] !== null && $current['link_revoked_at'] === null);
        if ($current['link_expires_at'] !== null) {
            $expires = self::timestamp($current['link_expires_at']);
            self::check($expires->getTimestamp() * 1000 + intdiv((int) $expires->format('u'), 1000) > $clock());
        }
        if (isset($child['public_token_hash'])) {
            self::check(is_string($child['public_token_hash']) && hash_equals($child['public_token_hash'], (string) $current['public_token_hash']));
        }
        $evidence->assertCurrent($clock());
    }

    /** The explicit server clock advances with elapsed I/O; fixtures can use a
     * trusted synthetic epoch without freezing expiration during network calls.
     * @return \Closure():int
     */
    private function clock(int $nowMs): \Closure
    {
        $started = hrtime(true);
        return static fn (): int => $nowMs + intdiv(hrtime(true) - $started, 1000000);
    }

    /** @param array<string,mixed> $child */
    private function orderHash(array $child, CheckoutConditionsV1 $evidence): string
    {
        return hash('sha256', InternalPaymentPlanV2::encodeCanonical((object) [
            'childAgreementId' => $child['public_uuid'], 'conditionsDigest' => $evidence->digest,
            'expectedMerchantId' => $this->expectedMerchantId, 'representation' => 'orders_capture',
        ]), true);
    }

    /** @param array<string,mixed> $child @param array<string,mixed> $resource */
    private function assertOrderResource(array $child, CheckoutConditionsV1 $evidence, array $resource): void
    {
        self::check($resource['resource_type'] === 'ORDER' && (string) $resource['agreement_id'] === (string) $child['id']
            && hash_equals((string) $resource['configuration_hash'], $this->orderHash($child, $evidence)));
    }

    private function urls(string $returnUrl, string $cancelUrl, CheckoutConditionsV1 $evidence): void
    {
        foreach ([$returnUrl, $cancelUrl] as $url) {
            $scheme = parse_url($url, PHP_URL_SCHEME); $host = parse_url($url, PHP_URL_HOST);
            self::check(is_string($host) && ($scheme === 'https' || ($scheme === 'http'
                && $evidence->conditions->operation->prepared->plan->scope->mode === 'test'
                && in_array($host, ['127.0.0.1', '::1'], true)))
                && parse_url($url, PHP_URL_USER) === null && parse_url($url, PHP_URL_PASS) === null
                && parse_url($url, PHP_URL_FRAGMENT) === null);
        }
        self::check(parse_url($returnUrl, PHP_URL_SCHEME) === parse_url($cancelUrl, PHP_URL_SCHEME)
            && parse_url($returnUrl, PHP_URL_HOST) === parse_url($cancelUrl, PHP_URL_HOST)
            && parse_url($returnUrl, PHP_URL_PORT) === parse_url($cancelUrl, PHP_URL_PORT));
    }

    private static function databaseInstant(?string $instant): ?string
    {
        return $instant === null ? null : self::timestamp($instant)->format('Y-m-d H:i:s.u');
    }

    private static function timestamp(string $value): \DateTimeImmutable
    {
        self::check(preg_match('/^\d{4}-\d{2}-\d{2}(?:T| )\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/D', $value) === 1);
        try { $date = new \DateTimeImmutable($value, new \DateTimeZone('UTC')); }
        catch (\Exception) { throw new \DomainException('PAYPAL_CHECKOUT_BINDING_MISMATCH'); }
        self::check($date->format('Y-m-d H:i:s') === str_replace('T', ' ', substr($value, 0, 19)));
        return $date->setTimezone(new \DateTimeZone('UTC'));
    }

    private static function check(bool $condition): void
    {
        if (!$condition) { throw new \DomainException('PAYPAL_CHECKOUT_BINDING_MISMATCH'); }
    }
}
