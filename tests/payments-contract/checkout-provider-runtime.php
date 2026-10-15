<?php

declare(strict_types=1);

// Synthetic CLI composition only: original Config/Connection/service/coordinator,
// an explicitly injected fake transport, and the caller's disposable ledger.
// There is no original E2E, ambient provider configuration, or network fallback.
use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Domain\PaymentAgreementService;
use Gourmet\Payments\Payments\PayPal\PayPalConfig;
use Gourmet\Payments\Payments\PayPal\PayPalHttpResponse;
use Gourmet\Payments\Payments\PayPal\PayPalHttpTransport;
use Gourmet\Payments\Payments\PayPal\PayPalTransportException;
use Gourmet\Payments\Payments\PayPal\VersionedCheckoutProviderV1;

ini_set('display_errors', 'stderr');
error_reporting(E_ALL);
$root = $argv[1] ?? '';
$directory = $argv[2] ?? '';
if ($argc !== 3 || !is_dir($root . '/src') || !is_file($root . '/bootstrap/autoload.php')
    || !is_dir($directory) || (!is_file($directory . '/synthetic-fixture-only')
        && !is_file($directory . '/.synthetic-contract-fixture'))) {
    throw new RuntimeException('Explicit materialized runtime and disposable synthetic fixture required.');
}
$directory = realpath($directory);
if (!is_string($directory) || is_link($directory . '/provider-fake-state.json')) {
    throw new RuntimeException('Owned synthetic fixture state required.');
}
require $root . '/bootstrap/autoload.php';
require __DIR__ . '/operational-config.php';
$raw = stream_get_contents(STDIN, 262145);
if (!is_string($raw) || strlen($raw) > 262144) { throw new RuntimeException('Bounded synthetic action required.'); }
$input = json_decode($raw, true, 40, JSON_THROW_ON_ERROR);
if (!is_array($input) || !is_string($input['action'] ?? null)) { throw new RuntimeException('Explicit synthetic action required.'); }
$nowMs = $input['nowMs'] ?? (int) floor(microtime(true) * 1000);
if (!is_int($nowMs) || $nowMs < 0 || $nowMs > 8640000000000000) { throw new RuntimeException('Explicit valid fixture clock required.'); }
$config = operationalFixtureConfigV2($root, $directory);
$pdo = Connection::open($config);
$mysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';

final class SyntheticCheckoutTransport implements PayPalHttpTransport
{
    public const MERCHANT = 'SYNTHETICMERCHANT';
    private const CLIENT = 'synthetic-checkout-client';
    private const SECRET = 'synthetic-checkout-secret';

    public function __construct(private string $file, private int $nowMs, private PDO $pdo) {}

    public static function config(): PayPalConfig
    {
        return new PayPalConfig('sandbox', self::CLIENT, self::SECRET, 'synthetic-checkout-webhook');
    }

    /** @return array<string,mixed> */
    private function initial(): array
    {
        return ['synthetic' => 'owned-checkout-provider-v1', 'counter' => 0, 'calls' => [],
            'products' => [], 'plans' => [], 'subscriptions' => [], 'orders' => [], 'requests' => [], 'controls' => []];
    }

    private function state(callable $change): mixed
    {
        if (is_link($this->file)) { throw new RuntimeException('Synthetic state must not be a symlink.'); }
        $handle = fopen($this->file, 'c+');
        if ($handle === false || !flock($handle, LOCK_EX)) { throw new RuntimeException('Synthetic state lock unavailable.'); }
        try {
            $raw = stream_get_contents($handle);
            $state = $raw === '' ? $this->initial() : json_decode($raw, true, 40, JSON_THROW_ON_ERROR);
            if (!is_array($state) || ($state['synthetic'] ?? null) !== 'owned-checkout-provider-v1') {
                throw new RuntimeException('Explicit owned synthetic provider state required.');
            }
            $result = $change($state);
            rewind($handle);
            if (!ftruncate($handle, 0) || fwrite($handle, json_encode($state, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)) === false || !fflush($handle)) {
                throw new RuntimeException('Synthetic state persistence failed.');
            }
            return $result;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @return array<string,mixed> */
    public function inspect(): array { return $this->state(static fn (array &$state): array => $state); }

    /** @param array<string,mixed> $controls */
    public function control(array $controls): void
    {
        $allowed = ['resetControls', 'approveOrder', 'loseOrderCreateResponse', 'loseCaptureResponse',
            'completeInitial', 'completeBalance', 'wrongPlanBalance', 'wrongInitialAmount', 'wrongMerchant',
            'wrongCurrency', 'wrongCustomId', 'wrongStartTime', 'transactionsObject', 'paymentTime', 'providerReference',
            'revokeChildDuringOrderGet', 'delayOAuthMs', 'delayOrderGetMs',
            'planCyclesObject', 'orderUnitsObject', 'orderCapturesObject'];
        foreach ($controls as $key => $value) {
            if (!in_array($key, $allowed, true) || (!is_bool($value) && !is_string($value) && !is_int($value) && $value !== null)
                || (in_array($key, ['delayOAuthMs', 'delayOrderGetMs'], true)
                    ? !is_int($value) || $value < 0 || $value > 100 : is_int($value))) {
                throw new RuntimeException('Unsupported synthetic provider control.');
            }
        }
        $this->state(static function (array &$state) use ($controls): void {
            if (($controls['resetControls'] ?? false) === true) { $state['controls'] = []; }
            unset($controls['resetControls']);
            $state['controls'] = array_replace($state['controls'], $controls);
        });
    }

    private function time(): string
    {
        return (new DateTimeImmutable('@' . intdiv($this->nowMs, 1000)))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    private static function bump(string $amount): string
    {
        if (preg_match('/^([0-9]+)\.([0-9]{2})$/D', $amount, $parts) !== 1) { throw new RuntimeException('Synthetic decimal required.'); }
        $cents = (int) $parts[1] * 100 + (int) $parts[2] + 1;
        return intdiv($cents, 100) . '.' . str_pad((string) ($cents % 100), 2, '0', STR_PAD_LEFT);
    }

    /** @param array<string,string> $headers */
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutSeconds): PayPalHttpResponse
    {
        $parts = parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? null) !== 'https' || ($parts['host'] ?? null) !== 'api-m.sandbox.paypal.com'
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['port']) || isset($parts['fragment'])) {
            throw new RuntimeException('Unallowlisted synthetic provider destination.');
        }
        $path = $parts['path'] ?? '';
        $result = $this->state(function (array &$state) use ($method, $path, $parts, $headers, $body): array {
            $state['calls'][] = ['method' => $method, 'path' => $path, 'query' => $parts['query'] ?? null,
                'requestId' => $headers['PayPal-Request-Id'] ?? null,
                'payload' => $body === null ? null : (str_starts_with($path, '/v1/oauth2/') ? 'synthetic-oauth' : json_decode($body, true, 40, JSON_THROW_ON_ERROR))];
            if ($method === 'POST' && $path === '/v1/oauth2/token') {
                if (($headers['Authorization'] ?? '') !== 'Basic ' . base64_encode(self::CLIENT . ':' . self::SECRET)
                    || $body !== 'grant_type=client_credentials') { throw new RuntimeException('Unexpected synthetic OAuth binding.'); }
                if (($state['controls']['delayOAuthMs'] ?? 0) > 0) { usleep($state['controls']['delayOAuthMs'] * 1000); }
                return ['status' => 200, 'body' => ['access_token' => 'synthetic-checkout-access-token', 'expires_in' => 3600]];
            }
            if (($headers['Authorization'] ?? null) !== 'Bearer synthetic-checkout-access-token') {
                throw new RuntimeException('Unexpected synthetic provider bearer.');
            }
            $payload = $body === null ? null : json_decode($body, true, 40, JSON_THROW_ON_ERROR);
            $key = $headers['PayPal-Request-Id'] ?? null;
            $controls = $state['controls'];
            $target = $controls['providerReference'] ?? null;
            $active = static fn (string $id): bool => $target === null || $target === $id;
            if ($method === 'POST' && in_array($path, ['/v1/catalogs/products', '/v1/billing/plans', '/v1/billing/subscriptions', '/v2/checkout/orders'], true)) {
                if (!is_array($payload) || !is_string($key) || $key === '') { throw new RuntimeException('Synthetic create payload and request ID required.'); }
                $requestKey = $path . ':' . $key;
                if (isset($state['requests'][$requestKey])) {
                    $saved = $state['requests'][$requestKey];
                    if ($saved['payload'] !== $payload) { throw new RuntimeException('Synthetic provider idempotency conflict.'); }
                    return ['status' => 201, 'body' => $state[$saved['collection']][$saved['id']]];
                }
                $number = ++$state['counter'];
                if ($path === '/v1/catalogs/products') {
                    $collection = 'products'; $id = 'PROD-' . str_pad((string) $number, 17, '0', STR_PAD_LEFT);
                    $response = ['id' => $id] + $payload;
                } elseif ($path === '/v1/billing/plans') {
                    $collection = 'plans'; $id = 'P-' . str_pad((string) $number, 24, '0', STR_PAD_LEFT);
                    $response = ['id' => $id] + $payload;
                } elseif ($path === '/v1/billing/subscriptions') {
                    $collection = 'subscriptions'; $id = 'I-' . str_pad((string) $number, 17, '0', STR_PAD_LEFT);
                    $response = ['id' => $id, 'status' => 'APPROVAL_PENDING', 'plan_overridden' => false, 'quantity' => '1',
                        'transactions' => [], 'links' => [['rel' => 'approve', 'href' => 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=' . $id]]] + $payload;
                } else {
                    $collection = 'orders'; $id = 'O' . str_pad((string) $number, 16, '0', STR_PAD_LEFT);
                    $response = ['id' => $id, 'status' => 'CREATED', 'links' => [['rel' => 'payer-action', 'href' => 'https://www.sandbox.paypal.com/checkoutnow?token=' . $id]]] + $payload;
                }
                $state[$collection][$id] = $response;
                $state['requests'][$requestKey] = ['collection' => $collection, 'id' => $id, 'payload' => $payload];
                if ($collection === 'orders' && ($controls['loseOrderCreateResponse'] ?? false) === true) {
                    $state['controls']['loseOrderCreateResponse'] = false;
                    return ['transportLost' => true];
                }
                return ['status' => 201, 'body' => $response];
            }
            if ($method === 'POST' && preg_match('#^/v2/checkout/orders/([A-Z0-9]{1,64})/capture$#D', $path, $match) === 1) {
                $id = $match[1];
                if (!isset($state['orders'][$id]) || !is_string($key)) { throw new RuntimeException('Known synthetic capture target required.'); }
                $order = &$state['orders'][$id];
                if ($order['status'] !== 'COMPLETED') {
                    if ($order['status'] !== 'APPROVED') { return ['status' => 422, 'body' => ['name' => 'ORDER_NOT_APPROVED']]; }
                    $captureId = 'C' . str_pad((string) ++$state['counter'], 16, '0', STR_PAD_LEFT);
                    $order['status'] = 'COMPLETED';
                    $order['purchase_units'][0]['payments']['captures'] = [['id' => $captureId, 'status' => 'COMPLETED',
                        'final_capture' => true, 'amount' => $order['purchase_units'][0]['amount'],
                        'create_time' => $controls['paymentTime'] ?? $this->time(), 'update_time' => $controls['paymentTime'] ?? $this->time()]];
                }
                if (($controls['loseCaptureResponse'] ?? false) === true) {
                    $state['controls']['loseCaptureResponse'] = false;
                    return ['transportLost' => true];
                }
                $response = $order;
                if (($controls['orderCapturesObject'] ?? false) === true) {
                    $response['purchase_units'][0]['payments']['captures'] = (object) ['0' => $order['purchase_units'][0]['payments']['captures'][0]];
                }
                return ['status' => 201, 'body' => $response];
            }
            if ($method === 'GET' && preg_match('#^/v1/catalogs/products/(PROD-[A-Z0-9]+)$#D', $path, $match) === 1) {
                if (!isset($state['products'][$match[1]])) { throw new RuntimeException('Unknown synthetic product.'); }
                return ['status' => 200, 'body' => $state['products'][$match[1]]];
            }
            if ($method === 'GET' && preg_match('#^/v1/billing/plans/(P-[A-Z0-9]+)$#D', $path, $match) === 1) {
                if (!isset($state['plans'][$match[1]])) { throw new RuntimeException('Unknown synthetic plan.'); }
                $plan = $state['plans'][$match[1]];
                if (($controls['wrongPlanBalance'] ?? false) === true) { $plan['billing_cycles'][0]['pricing_scheme']['fixed_price']['value'] = self::bump($plan['billing_cycles'][0]['pricing_scheme']['fixed_price']['value']); }
                if (($controls['wrongInitialAmount'] ?? false) === true) { $plan['payment_preferences']['setup_fee']['value'] = self::bump($plan['payment_preferences']['setup_fee']['value']); }
                if (($controls['planCyclesObject'] ?? false) === true) { $plan['billing_cycles'] = (object) ['0' => $plan['billing_cycles'][0]]; }
                return ['status' => 200, 'body' => $plan];
            }
            if ($method === 'GET' && preg_match('#^/v1/billing/subscriptions/(I-[A-Z0-9]+)(/transactions)?$#D', $path, $match) === 1) {
                $id = $match[1];
                if (!isset($state['subscriptions'][$id])) { throw new RuntimeException('Unknown synthetic subscription.'); }
                $subscription = &$state['subscriptions'][$id];
                $plan = $state['plans'][$subscription['plan_id']];
                foreach (['completeInitial' => ['INITIAL', $plan['payment_preferences']['setup_fee'], $controls['paymentTime'] ?? $this->time()],
                    'completeBalance' => ['BALANCE', $plan['billing_cycles'][0]['pricing_scheme']['fixed_price'], $controls['paymentTime'] ?? $subscription['start_time']]] as $control => [$kind, $amount, $time]) {
                    if ($active($id) && ($controls[$control] ?? false) === true) {
                        $transactionId = 'T' . strtoupper(substr(hash('sha256', $id . ':' . $kind), 0, 16));
                        if (!in_array($transactionId, array_column($subscription['transactions'], 'id'), true)) {
                            $subscription['transactions'][] = ['id' => $transactionId, 'status' => 'COMPLETED', 'time' => $time,
                                'amount_with_breakdown' => ['gross_amount' => $amount]];
                        }
                        $subscription['status'] = 'ACTIVE';
                        $subscription['links'] = [];
                    }
                }
                if (($match[2] ?? '') === '/transactions') {
                    $transactions = $subscription['transactions'];
                    if (($controls['wrongCurrency'] ?? false) === true) { foreach ($transactions as &$transaction) { $transaction['amount_with_breakdown']['gross_amount']['currency_code'] = 'EUR'; } unset($transaction); }
                    if (($controls['transactionsObject'] ?? false) === true) { $transactions = (object) ['synthetic' => $transactions[0] ?? ['status' => 'PENDING']]; }
                    return ['status' => 200, 'body' => ['transactions' => $transactions]];
                }
                $response = $subscription;
                unset($response['transactions']);
                if (($controls['wrongCustomId'] ?? false) === true) { $response['custom_id'] = '00000000-0000-4000-8000-999999999999'; }
                if (($controls['wrongStartTime'] ?? false) === true) { $response['start_time'] = (new DateTimeImmutable($response['start_time']))->modify('+1 second')->format('Y-m-d\TH:i:s\Z'); }
                return ['status' => 200, 'body' => $response];
            }
            if ($method === 'GET' && preg_match('#^/v2/checkout/orders/([A-Z0-9]{1,64})$#D', $path, $match) === 1) {
                $id = $match[1];
                if (!isset($state['orders'][$id])) { throw new RuntimeException('Unknown synthetic order.'); }
                if (($controls['delayOrderGetMs'] ?? 0) > 0) { usleep($controls['delayOrderGetMs'] * 1000); }
                if ($active($id) && ($controls['revokeChildDuringOrderGet'] ?? false) === true) {
                    $uuid = $state['orders'][$id]['purchase_units'][0]['custom_id'];
                    $at = (new DateTimeImmutable('@' . intdiv($this->nowMs, 1000)))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
                    $revoke = $this->pdo->prepare('UPDATE payment_agreements SET link_revoked_at = :at WHERE public_uuid = :uuid AND contract_version = 3');
                    $revoke->execute(['at' => $at, 'uuid' => $uuid]);
                    if ($revoke->rowCount() !== 1) { throw new RuntimeException('Synthetic child revocation failed.'); }
                    $state['controls']['revokeChildDuringOrderGet'] = false;
                }
                if ($active($id) && ($controls['approveOrder'] ?? false) === true && $state['orders'][$id]['status'] !== 'COMPLETED') { $state['orders'][$id]['status'] = 'APPROVED'; }
                $order = $state['orders'][$id];
                if (($controls['wrongMerchant'] ?? false) === true) { $order['purchase_units'][0]['payee']['merchant_id'] = 'OTHER_SYNTHETIC_MERCHANT'; }
                if (($controls['wrongCustomId'] ?? false) === true) { $order['purchase_units'][0]['custom_id'] = '00000000-0000-4000-8000-999999999999'; }
                if (($controls['wrongCurrency'] ?? false) === true) { $order['purchase_units'][0]['amount']['currency_code'] = 'EUR'; }
                if (($controls['orderCapturesObject'] ?? false) === true && isset($order['purchase_units'][0]['payments']['captures'][0])) {
                    $order['purchase_units'][0]['payments']['captures'] = (object) ['0' => $order['purchase_units'][0]['payments']['captures'][0]];
                }
                if (($controls['orderUnitsObject'] ?? false) === true) { $order['purchase_units'] = (object) ['0' => $order['purchase_units'][0]]; }
                return ['status' => 200, 'body' => $order];
            }
            throw new RuntimeException('Unallowlisted synthetic provider method or route.');
        });
        if (($result['transportLost'] ?? false) === true) { throw new PayPalTransportException(true); }
        return new PayPalHttpResponse($result['status'], json_encode($result['body'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
    }
}

$transport = new SyntheticCheckoutTransport($directory . '/provider-fake-state.json', $nowMs, $pdo);
$snapshot = static function () use ($pdo): array {
    $tables = ['payment_agreements', 'payment_checkout_issuances', 'payment_schedules', 'payment_attempts', 'provider_resources',
        'idempotency_keys', 'payment_consents', 'audit_events', 'email_outbox', 'monday_sync_outbox', 'sales_os_event_outbox'];
    $counts = []; $rows = []; $allRows = [];
    foreach ($tables as $table) {
        $data = $pdo->query('SELECT * FROM ' . $table . ' ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        $counts[$table] = count($data);
        $allRows[$table] = ['rows' => count($data), 'sha256' => hash('sha256', serialize($data))];
        foreach ($data as &$row) {
            foreach (['public_token_hash', 'request_hash', 'response_hash', 'configuration_hash', 'ip_hash', 'response_nonce', 'response_tag'] as $column) {
                if (is_string($row[$column] ?? null)) { $row[$column] = bin2hex($row[$column]); }
            }
            if (isset($row['response_ciphertext'])) { $row['response_ciphertext'] = 'synthetic-encrypted-response-present'; }
        }
        unset($row);
        $rows[$table] = $data;
    }
    return ['counts' => $counts, 'allRows' => $allRows, 'agreements' => $rows['payment_agreements'],
        'checkoutIssuances' => $rows['payment_checkout_issuances'], 'schedules' => $rows['payment_schedules'],
        'attempts' => $rows['payment_attempts'], 'resources' => $rows['provider_resources'], 'idempotency' => $rows['idempotency_keys'],
        'consents' => $rows['payment_consents'], 'audit' => $rows['audit_events'],
        'outboxes' => ['email' => $rows['email_outbox'], 'monday' => $rows['monday_sync_outbox'], 'salesOs' => $rows['sales_os_event_outbox']]];
};
$output = [];
try {
    $action = $input['action'];
    if ($action === 'fake_control') {
        if (!is_array($input['control'] ?? null)) { throw new RuntimeException('Explicit synthetic controls required.'); }
        $transport->control($input['control']);
        $output['result'] = ['controlled' => true];
    } elseif ($action === 'install_audit_failure') {
        $pdo->exec($mysql
            ? "CREATE TRIGGER synthetic_abort_provider_audit BEFORE INSERT ON audit_events FOR EACH ROW BEGIN IF NEW.event_type = 'PAYMENT_SCHEDULE_PAID' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SYNTHETIC_PROVIDER_AUDIT_FAILURE'; END IF; END"
            : "CREATE TRIGGER synthetic_abort_provider_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'PAYMENT_SCHEDULE_PAID' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PROVIDER_AUDIT_FAILURE'); END");
        $output['result'] = ['auditFailureInstalled' => true];
    } elseif ($action === 'remove_audit_failure') {
        $pdo->exec('DROP TRIGGER IF EXISTS synthetic_abort_provider_audit');
        $output['result'] = ['auditFailureInstalled' => false];
    } elseif ($action === 'inspect') {
        $output['result'] = ['inspected' => true];
    } elseif (in_array($action, ['start', 'resume', 'capture', 'status', 'consent_proof'], true)) {
        $uuid = $input['childAgreementId'] ?? null;
        if (!is_string($uuid) || preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $uuid) !== 1) {
            throw new RuntimeException('Explicit synthetic child agreement UUID required.');
        }
        $lookup = $pdo->prepare('SELECT * FROM payment_agreements WHERE public_uuid = :uuid AND contract_version = 3');
        $lookup->execute(['uuid' => $uuid]);
        $child = $lookup->fetch(PDO::FETCH_ASSOC);
        if (!is_array($child)) { throw new RuntimeException('Synthetic emitted child not found.'); }
        $conditions = (new PaymentAgreementService($pdo))->checkoutConditionsForAgreementV1((int) $child['id']);
        $wire = $conditions->conditions;
        if ($action === 'consent_proof') {
            $query = $pdo->prepare('SELECT * FROM payment_consents WHERE agreement_id = :id ORDER BY id');
            $read = static function () use ($query, $child): array { $query->execute(['id' => $child['id']]); return $query->fetchAll(PDO::FETCH_ASSOC); };
            if ($read() !== []) { throw new RuntimeException('Fresh synthetic child consent fixture required.'); }
            $full = $child['payment_mode'] === 'full_upfront';
            $valid = ['type' => $full ? 'ONE_TIME_PAYMENT' : 'INITIAL_PAYMENT', 'amount' => (int) $child['initial_cents'],
                'terms' => $conditions->digest, 'due' => null];
            $changedDigest = ($conditions->digest[0] === 'a' ? 'b' : 'a') . substr($conditions->digest, 1);
            $wrongDue = $full ? '2099-01-01 00:00:00.000000'
                : (new DateTimeImmutable($child['balance_due_at_utc'], new DateTimeZone('UTC')))->modify('+1 second')->format('Y-m-d H:i:s.u');
            $negatives = [
                'type' => array_replace($valid, ['type' => 'NON_REFUNDABLE_RESERVATION']),
                'amount' => array_replace($valid, ['amount' => $valid['amount'] + 1]),
                'digest' => array_replace($valid, ['terms' => $changedDigest]),
                'due' => array_replace($valid, ['type' => $full ? 'ONE_TIME_PAYMENT' : 'FUTURE_BALANCE_CHARGE',
                    'amount' => $full ? (int) $child['initial_cents'] : (int) $child['balance_cents'], 'due' => $wrongDue]),
            ];
            $rejected = [];
            foreach ($negatives as $name => $bad) {
                if ($read() !== []) { throw new RuntimeException('No prior consent may mask a SQL rejection.'); }
                $pdo->beginTransaction();
                try {
                    $insert = $pdo->prepare("INSERT INTO payment_consents (public_uuid,agreement_id,provider,consent_type,terms_version,amount_cents,scheduled_charge_at,accepted_at) VALUES (:uuid,:agreement,'PAYPAL',:type,:terms,:amount,:due,:accepted)");
                    $insert->execute(['uuid' => Gourmet\Payments\Support\Uuid::v4(), 'agreement' => $child['id'],
                        'type' => $bad['type'], 'terms' => $bad['terms'], 'amount' => $bad['amount'],
                        'due' => $bad['due'], 'accepted' => gmdate('Y-m-d H:i:s.000000')]);
                    throw new RuntimeException('Incompatible synthetic consent was accepted.');
                } catch (PDOException $exception) {
                    if (!str_contains($exception->getMessage(), 'PAYMENT_CONSENT_VERSION_MISMATCH')) { throw $exception; }
                    $rejected[] = $name;
                } finally {
                    if ($pdo->inTransaction()) { $pdo->rollBack(); }
                }
            }
            $service = new PaymentAgreementService($pdo);
            $service->recordCheckoutConsentsV1($child, hash('sha256', 'synthetic-consent-ip', true), 'Synthetic consent fixture');
            $first = $read();
            $service->recordCheckoutConsentsV1($child, hash('sha256', 'synthetic-consent-ip', true), 'Synthetic repeated consent fixture');
            $second = $read();
            if ($first !== $second || count($second) !== ($full ? 1 : 2)) { throw new RuntimeException('Synthetic consent repeat changed persisted facts.'); }
            $output['consentProof'] = ['negativeRejections' => $rejected, 'beforeValidRows' => 0,
                'afterFirstRows' => count($first), 'afterSecondRows' => count($second), 'repeatedRowsIdentical' => true];
            $output['result'] = ['consentRecorded' => true];
        } else {
        $provider = new VersionedCheckoutProviderV1($pdo, SyntheticCheckoutTransport::config(), $transport, SyntheticCheckoutTransport::MERCHANT);
        $reference = $input['providerReference'] ?? '';
        if (!is_string($reference)) { throw new RuntimeException('Synthetic provider reference must be a string.'); }
        $output['result'] = match ($action) {
            'start' => $provider->start($child, $wire, $input['returnUrl'] ?? 'https://synthetic.invalid/return', $input['cancelUrl'] ?? 'https://synthetic.invalid/cancel', $nowMs),
            'resume' => $provider->resume($child, $wire, $reference, $nowMs),
            'capture' => $provider->capture($child, $wire, $reference, $nowMs),
            'status' => $provider->status($child, $wire, $nowMs),
        };
        }
    } else { throw new RuntimeException('Unknown synthetic coordinator action.'); }
} catch (Throwable $exception) {
    if ($pdo->inTransaction()) { $pdo->rollBack(); }
    $message = $exception->getMessage();
    $output['error'] = ['class' => $exception::class, 'code' => preg_match('/^[A-Z][A-Z0-9_]{0,95}$/D', $message) === 1 ? $message : 'SYNTHETIC_PROVIDER_ACTION_REJECTED'];
}
$state = $transport->inspect();
$output['snapshot'] = $snapshot();
$output['providerCalls'] = count($state['calls']);
$output['liveCalls'] = 0;
$output['transport'] = 'explicit_fake_no_fallback';
$output['calls'] = $state['calls'];
$output['providerState'] = $state;
echo json_encode($output, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
