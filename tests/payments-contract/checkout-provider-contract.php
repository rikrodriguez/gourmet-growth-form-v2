<?php

declare(strict_types=1);

// Pure synthetic contract checks. The caller supplies a materialized runtime
// and TS-produced operations; this script never boots Application, opens PDO,
// initializes configuration, generates a token, or calls a provider.
use Gourmet\Payments\Http\CheckoutConditionsV1;
use Gourmet\Payments\Http\InternalPaymentPlanV2;
use Gourmet\Payments\Payments\PayPal\VersionedCheckoutPayloads;
use Gourmet\Payments\Payments\PayPal\OrdersCheckoutAdapter;
use Gourmet\Payments\Payments\PayPal\PayPalClient;
use Gourmet\Payments\Payments\PayPal\PayPalConfig;
use Gourmet\Payments\Payments\PayPal\PayPalHttpTransport;
use Gourmet\Payments\Payments\PayPal\PayPalHttpResponse;
use Gourmet\Payments\Payments\PayPal\PayPalTransportException;

ini_set('display_errors', 'stderr');
error_reporting(E_ALL);
$runtime = $argv[1] ?? '';
if ($argc !== 2 || PHP_INT_SIZE < 8 || !extension_loaded('mbstring')
    || !is_dir($runtime . '/src') || !is_file($runtime . '/bootstrap/autoload.php')) {
    throw new RuntimeException('Explicit materialized runtime and 64-bit PHP with mbstring are required.');
}
require $runtime . '/bootstrap/autoload.php';
// The immutable original Money class is a pure prerequisite of the explicit
// fixed-reservation invariant. Its bytes were verified by the materializer;
// loading it does not boot Application, configuration or a provider.
require $runtime . '/src/Domain/Money.php';
$raw = stream_get_contents(STDIN, 2000001);
if (!is_string($raw) || strlen($raw) > 2000000) {
    throw new RuntimeException('Bounded synthetic fixture input required.');
}
$input = json_decode($raw, true, 40, JSON_THROW_ON_ERROR);
if (!is_array($input) || !is_int($input['nowMs'] ?? null) || !is_array($input['operations'] ?? null)
    || !array_is_list($input['operations']) || count($input['operations']) < 3 || count($input['operations']) > 64
    || !is_array($input['invalidOperations'] ?? null) || !array_is_list($input['invalidOperations'])
    || count($input['invalidOperations']) > 128) {
    throw new RuntimeException('Bounded TS-produced synthetic operations and an explicit clock are required.');
}
$assertions = 0;
$checks = [];
$check = static function (bool $condition, string $label) use (&$assertions, &$checks): void {
    if (!$condition) {
        throw new RuntimeException('CHECKOUT_PROVIDER_CONTRACT_FAILED: ' . $label);
    }
    ++$assertions;
    $checks[] = $label;
};
$reject = static function (string $label, callable $action) use ($check): void {
    try {
        $action();
    } catch (DomainException $exception) {
        $check(preg_match('/\A[A-Z][A-Z0-9_]{0,95}\z/', $exception->getMessage()) === 1,
            $label . ': bounded domain rejection');
        return;
    }
    throw new RuntimeException('CHECKOUT_PROVIDER_CONTRACT_ACCEPTED_INVALID: ' . $label);
};

// Independent canonical encoder for expected envelopes. It does not ask the
// implementation under test to construct its own expected wire or digest.
$canonical = static function (mixed $value) use (&$canonical): string {
    if ($value instanceof stdClass) {
        $properties = get_object_vars($value);
        ksort($properties, SORT_STRING);
        $parts = [];
        foreach ($properties as $key => $item) {
            $parts[] = $canonical((string) $key) . ':' . $canonical($item);
        }
        return '{' . implode(',', $parts) . '}';
    }
    if (is_array($value)) {
        if (!array_is_list($value)) {
            return $canonical((object) $value);
        }
        return '[' . implode(',', array_map($canonical, $value)) . ']';
    }
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES
        | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
};
$copy = static fn (mixed $value): mixed => unserialize(serialize($value), ['allowed_classes' => [stdClass::class]]);
$sqlInstant = static fn (?string $value): ?string => $value === null ? null
    : (new DateTimeImmutable($value))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
$decimal = static fn (int $cents): string => intdiv($cents, 100) . '.' . str_pad((string) ($cents % 100), 2, '0', STR_PAD_LEFT);

$nowMs = $input['nowMs'];
$created = (new DateTimeImmutable('@' . intdiv($nowMs, 1000)))->setTimezone(new DateTimeZone('UTC'))
    ->format('Y-m-d H:i:s') . '.' . str_pad((string) (($nowMs % 1000) * 1000), 6, '0', STR_PAD_LEFT);
$draftFor = static function (array $operation, string $uuid) use ($canonical, $created, $sqlInstant): array {
    $plan = $operation['prepared']['plan'];
    $schedule = $plan['paymentSchedule'];
    $operationJson = $canonical($operation);
    return [
        'public_uuid' => $uuid,
        'contract_version' => 2,
        'status' => 'DRAFT_INTERNAL',
        'provider' => null,
        'public_token_hash' => null,
        'operation_id' => $operation['operationId'],
        'operation_json' => $operationJson,
        'operation_digest' => hash('sha256', $operationJson),
        'configuration_id' => $operation['configurationId'],
        'configuration_digest' => $operation['configurationDigest'],
        'payment_mode' => $plan['paymentMode'],
        'currency' => 'USD',
        'total_cents' => $plan['sourceQuote']['totalCents'],
        'initial_cents' => $plan['initialPaymentCents'],
        'reservation_cents' => $plan['paymentMode'] === 'fixed_49_reservation' ? 4900 : null,
        'balance_cents' => $plan['paymentBalanceCents'],
        'balance_due_at_utc' => $sqlInstant($schedule['balanceInstant'] ?? null),
        'balance_timezone' => $schedule['configured']['timezone'] ?? null,
        'event_at_utc' => $sqlInstant($schedule['eventInstant'] ?? null),
        'link_expires_at' => $sqlInstant($plan['linkExpiration']['instant']),
        'link_revoked_at' => null,
        'link_expired_event_at' => null,
        'source_lead_id' => $plan['canonicalLeadId'],
        'source_quote_id' => $plan['sourceQuote']['digest'],
        'source_quote_version' => (string) $plan['sourceQuote']['version'],
        'recipient_name' => $operation['recipient']['name'],
        'recipient_email' => $operation['recipient']['email'],
        'recipient_phone' => $operation['recipient']['phone'],
        'service_name' => $operation['service']['name'],
        'event_location' => $operation['service']['eventLocation'],
        'monday_item_id' => null,
        'internal_notes' => null,
        'terms_version' => 'v2-draft',
        'reservation_policy_version' => 'v2-draft',
        'created_at' => $created,
        'updated_at' => $created,
        'customer_id' => null,
    ];
};
$modes = [];
$drafts = [];
$results = [];
foreach ($input['operations'] as $index => $operation) {
    $check(is_array($operation), 'fixture operation is an array');
    $mode = $operation['prepared']['plan']['paymentMode'] ?? null;
    $check(in_array($mode, ['retainer_50', 'full_upfront', 'fixed_49_reservation'], true), 'fixture mode is explicit');
    $modes[$mode] = true;
    $uuid = '00000000-0000-4000-8000-' . str_pad((string) ($index + 1), 12, '0', STR_PAD_LEFT);
    $draft = $draftFor($operation, $uuid);
    $drafts[$mode] ??= $draft;
    $before = $copy($draft);
    $conditions = CheckoutConditionsV1::fromDraft($draft, $nowMs);
    $expected = (object) [
        'contractVersion' => 1,
        'purpose' => 'gourmet_payment_checkout',
        'sourceDraft' => (object) [
            'agreementId' => $uuid,
            'operationId' => $operation['operationId'],
            'operationDigest' => $draft['operation_digest'],
        ],
        'operation' => json_decode($canonical($operation), false, 40, JSON_THROW_ON_ERROR),
    ];
    $expectedJson = $canonical($expected);
    $check($draft === $before, $mode . ': conversion never mutates the draft input');
    $check($conditions->conditions instanceof stdClass, $mode . ': checkout mirror is an object');
    $check($canonical($conditions->conditions) === $expectedJson, $mode . ': exact versioned source binding and operation');
    $check($conditions->canonicalJson() === $expectedJson, $mode . ': canonical JSON bytes round trip');
    $check($conditions->digest === hash('sha256', $expectedJson), $mode . ': digest binds the complete checkout mirror');
    $decoded = json_decode($conditions->canonicalJson(), false, 40, JSON_THROW_ON_ERROR);
    $check($canonical($decoded->operation) === $draft['operation_json'], $mode . ': all terms, dates, source facts and Unicode survive');
    $check($decoded->sourceDraft->operationDigest === hash('sha256', $canonical($decoded->operation)),
        $mode . ': independent operation hash survives JSON round trip');

    // Every required repository snapshot column must be present. Optional
    // projection metadata is tested separately rather than pretending it is
    // present in every PDO query.
    foreach (array_diff(array_keys($draft), ['updated_at', 'customer_id']) as $column) {
        $missing = $copy($draft);
        unset($missing[$column]);
        $reject($mode . ': missing snapshot column ' . $column,
            static fn () => CheckoutConditionsV1::fromDraft($missing, $nowMs));
    }
    $assessment = [
        'representation' => $mode === 'full_upfront' ? 'orders_capture' : 'subscriptions_setup_and_one_balance',
        'blockers' => ['PROVIDER_DISABLED'],
    ];
    $check($conditions->providerAssessment() === $assessment, $mode . ': approved provider representation has no outstanding business decision');
    $unbound = VersionedCheckoutPayloads::project($conditions, $nowMs);
    $check($unbound['status'] === 'provider_binding_required' && $unbound['planFields'] === null
        && $unbound['subscriptionFields'] === null && $unbound['ordersFields'] === null,
        $mode . ': provider projection never substitutes the parent UUID for a child binding');
    $childUuid = '00000000-0000-4000-8000-' . str_pad((string) ($index + 900001), 12, '0', STR_PAD_LEFT);
    $projection = VersionedCheckoutPayloads::project($conditions, $nowMs, $childUuid);
    $check($projection['status'] === 'projected_provider_fields' && $projection['executable'] === false
        && $projection['providerEnabled'] === false && $projection['publicPaymentUrl'] === null
        && $projection['blockers'] === ['PROVIDER_DISABLED'], $mode . ': pure projection remains disabled and issues nothing');
    $check($projection['representation'] === $assessment['representation']
        && $projection['conditionsDigest'] === $conditions->digest,
        $mode . ': projection binds exact representation and complete conditions');
    $plan = $operation['prepared']['plan'];
    if ($mode === 'full_upfront') {
        $check($projection['planFields'] === null && $projection['subscriptionFields'] === null,
            'full upfront: no subscription, setup fee, trial or future-balance fields');
        $check($projection['ordersFields'] === [
            'intent' => 'CAPTURE',
            'purchase_units' => [[
                'custom_id' => $childUuid,
                'invoice_id' => $childUuid,
                'amount' => ['currency_code' => 'USD', 'value' => $decimal($plan['sourceQuote']['totalCents'])],
            ]],
        ], 'full upfront: exactly one Orders CAPTURE purchase for the complete USD amount and child UUID');
    } else {
        $check($projection['ordersFields'] === null, $mode . ': split never uses an invented upfront order');
        $check($projection['planFields'] === [
            'billing_cycles' => [[
                'frequency' => ['interval_unit' => 'DAY', 'interval_count' => 1],
                'tenure_type' => 'REGULAR', 'sequence' => 1, 'total_cycles' => 1,
                'pricing_scheme' => ['fixed_price' => ['value' => $decimal($plan['paymentBalanceCents']), 'currency_code' => 'USD']],
            ]],
            'payment_preferences' => [
                'auto_bill_outstanding' => true,
                'setup_fee' => ['value' => $decimal($plan['initialPaymentCents']), 'currency_code' => 'USD'],
                'setup_fee_failure_action' => 'CANCEL', 'payment_failure_threshold' => 0,
            ],
        ], $mode . ': exact initial setup amount and one positive future balance cycle without rounding');
        $check($projection['subscriptionFields'] === ['start_time' => $plan['paymentSchedule']['balanceInstant'], 'custom_id' => $childUuid],
            $mode . ': exact approved future balance and the child UUID');
    }
    $check($conditions->canonicalJson() === $expectedJson && $draft === $before, $mode . ': projection never mutates source conditions or draft');
    foreach ([$uuid, 'not-a-uuid', '', strtoupper($childUuid)] as $badChild) {
        // Uppercasing an all-numeric fixture does not change it; use an
        // explicitly uppercase hexadecimal UUID for the case-sensitive check.
        if ($badChild === $childUuid) $badChild = 'AAAAAAAA-0000-4000-8000-000000900001';
        $reject($mode . ': incompatible child UUID rejected', static fn () => VersionedCheckoutPayloads::project($conditions, $nowMs, $badChild));
    }
    $results[] = ['conditions' => json_decode($conditions->canonicalJson(), false, 40, JSON_THROW_ON_ERROR),
        'canonical' => $conditions->canonicalJson(), 'conditionsDigest' => $conditions->digest,
        'providerAssessment' => $assessment, 'providerProjection' => $projection];
}
$modeNames = array_keys($modes);
sort($modeNames, SORT_STRING);
$check($modeNames === ['fixed_49_reservation', 'full_upfront', 'retainer_50'], 'fixture covers exactly all three payment modes');

$base = $drafts['retainer_50'];
$snapshotMutations = [
    'agreement UUID malformed' => ['public_uuid', 'not-a-uuid'],
    'agreement UUID has wrong version' => ['public_uuid', '00000000-0000-5000-8000-000000000001'],
    'contract version v1' => ['contract_version', 1],
    'contract version float' => ['contract_version', 2.0],
    'active status' => ['status', 'PENDING_RESERVATION'],
    'provider attached' => ['provider', 'PAYPAL'],
    'token attached' => ['public_token_hash', str_repeat('x', 32)],
    'operation ID mismatch' => ['operation_id', str_repeat('f', 64)],
    'operation digest mismatch' => ['operation_digest', str_repeat('f', 64)],
    'uppercase operation digest' => ['operation_digest', strtoupper($base['operation_digest'])],
    'configuration ID mismatch' => ['configuration_id', 'other-synthetic-configuration'],
    'configuration digest mismatch' => ['configuration_digest', str_repeat('f', 64)],
    'payment mode mismatch' => ['payment_mode', 'fixed_49_reservation'],
    'payment mode padded' => ['payment_mode', 'retainer_50 '],
    'payment mode case changed' => ['payment_mode', 'RETAINER_50'],
    'currency changed' => ['currency', 'EUR'],
    'currency case changed' => ['currency', 'usd'],
    'total changed' => ['total_cents', $base['total_cents'] + 1],
    'initial changed' => ['initial_cents', $base['initial_cents'] + 1],
    'initial float' => ['initial_cents', (float) $base['initial_cents']],
    'reservation invented for percentage' => ['reservation_cents', 4900],
    'balance changed' => ['balance_cents', $base['balance_cents'] + 1],
    'balance due changed' => ['balance_due_at_utc', '2099-12-15 00:00:01.000000'],
    'balance due offset text' => ['balance_due_at_utc', '2099-12-14T19:00:00-05:00'],
    'balance timezone changed' => ['balance_timezone', 'UTC'],
    'event timestamp changed' => ['event_at_utc', '2099-12-22 00:00:01.000000'],
    'expiration changed' => ['link_expires_at', '2099-12-01 15:30:01.000000'],
    'revocation attached' => ['link_revoked_at', $created],
    'expiry event attached' => ['link_expired_event_at', $created],
    'lead mismatch' => ['source_lead_id', 'other-synthetic-lead'],
    'quote mismatch' => ['source_quote_id', str_repeat('f', 64)],
    'quote version mismatch' => ['source_quote_version', '99'],
    'recipient name mismatch' => ['recipient_name', $base['recipient_name'] . ' changed'],
    'recipient email mismatch' => ['recipient_email', 'other@example.test'],
    'recipient phone mismatch' => ['recipient_phone', '+1 202 555 9999'],
    'service name mismatch' => ['service_name', $base['service_name'] . ' changed'],
    'event location mismatch' => ['event_location', 'Other synthetic location'],
    'Monday reference attached' => ['monday_item_id', '123456789'],
    'internal notes attached' => ['internal_notes', 'Synthetic extra notes'],
    'terms version v1' => ['terms_version', 'v1-local'],
    'reservation policy v1' => ['reservation_policy_version', 'v1-local'],
    'created timestamp malformed' => ['created_at', '2026-10-14T00:00:00Z'],
    'updated timestamp changed' => ['updated_at', '2099-01-01 00:00:00.000000'],
    'customer reference attached' => ['customer_id', 17],
];
foreach ($snapshotMutations as $label => [$column, $value]) {
    $changed = $copy($base);
    $changed[$column] = $value;
    $reject($label, static fn () => CheckoutConditionsV1::fromDraft($changed, $nowMs));
}

// Malformed or semantically incompatible operation evidence is rejected even
// when an attacker recomputes the untrusted row's operation hash.
foreach ([
    'trailing wire whitespace' => $base['operation_json'] . ' ',
    'array instead of operation' => '[]',
    'invalid JSON' => '{',
] as $label => $operationJson) {
    $changed = $copy($base);
    $changed['operation_json'] = $operationJson;
    $changed['operation_digest'] = hash('sha256', $operationJson);
    $reject($label, static fn () => CheckoutConditionsV1::fromDraft($changed, $nowMs));
}
foreach ([
    'source currency incompatible' => static function (array &$operation): void { $operation['prepared']['plan']['sourceQuote']['currency'] = 'EUR'; },
    'source amount incompatible' => static function (array &$operation): void { ++$operation['prepared']['plan']['initialPaymentCents']; },
    'invalid local balance date' => static function (array &$operation): void { $operation['prepared']['plan']['paymentSchedule']['configured']['balanceDate'] = '2099-02-30'; },
    'unknown IANA timezone' => static function (array &$operation): void { $operation['prepared']['plan']['paymentSchedule']['configured']['timezone'] = 'Synthetic/Nowhere'; },
    'unknown operation field' => static function (array &$operation): void { $operation['unexpected'] = true; },
    'executable prepared payload' => static function (array &$operation): void { $operation['prepared']['executable'] = true; },
    'enabled provider payload' => static function (array &$operation): void { $operation['prepared']['providerEnabled'] = true; },
] as $label => $mutate) {
    $operation = json_decode($base['operation_json'], true, 40, JSON_THROW_ON_ERROR);
    $mutate($operation);
    $changed = $draftFor($operation, $base['public_uuid']);
    $reject($label, static fn () => CheckoutConditionsV1::fromDraft($changed, $nowMs));
}

$invalidCount = 0;
foreach ($input['invalidOperations'] as $item) {
    $check(is_array($item) && is_string($item['label'] ?? null) && is_array($item['operation'] ?? null), 'invalid synthetic operation has explicit evidence');
    $operationJson = $canonical($item['operation']);
    $invalidDraft = $copy($base);
    $invalidDraft['operation_json'] = $operationJson;
    $invalidDraft['operation_digest'] = hash('sha256', $operationJson);
    $invalidDraft['operation_id'] = $item['operation']['operationId'] ?? '';
    $clock = $item['nowMs'] ?? $nowMs;
    $reject('TS/PHP incompatible operation: ' . $item['label'], static fn () => CheckoutConditionsV1::fromDraft($invalidDraft, $clock));
    ++$invalidCount;
}
$mutated = CheckoutConditionsV1::fromDraft($base, $nowMs);
$mutated->conditions->operation->prepared->plan->paymentTerms .= ' changed after binding';
$reject('public PHP object mutation is never signed or projected', static fn () => $mutated->canonicalJson());
$reject('mutated PHP evidence cannot project provider fields', static fn () => VersionedCheckoutPayloads::project($mutated, $nowMs, '00000000-0000-4000-8000-000000900001'));

// Exercise the original PayPalClient through its original HTTP interface. This
// queue has no network implementation or ambient credentials. Every expected
// method/path/response is explicit and unexpected requests fail immediately.
final class SyntheticCheckoutHttpTransport implements PayPalHttpTransport
{
    public array $calls = [];
    public function __construct(private array $queue) {}
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutSeconds): PayPalHttpResponse
    {
        if (parse_url($url, PHP_URL_SCHEME) !== 'https' || parse_url($url, PHP_URL_HOST) !== 'api-m.sandbox.paypal.com') {
            throw new RuntimeException('SYNTHETIC_TRANSPORT_UNEXPECTED_HOST');
        }
        $path = parse_url($url, PHP_URL_PATH);
        $this->calls[] = ['method' => $method, 'path' => $path, 'headers' => $headers, 'body' => $body, 'timeoutSeconds' => $timeoutSeconds];
        if ($path === '/v1/oauth2/token') {
            if ($method !== 'POST' || $body !== 'grant_type=client_credentials') throw new RuntimeException('SYNTHETIC_OAUTH_REQUEST_MISMATCH');
            return new PayPalHttpResponse(200, '{"access_token":"synthetic-no-authority","expires_in":3600}');
        }
        $expected = array_shift($this->queue);
        if (!is_array($expected) || $expected['method'] !== $method || $expected['path'] !== $path) {
            throw new RuntimeException('SYNTHETIC_TRANSPORT_UNEXPECTED_REQUEST');
        }
        if (($expected['lost'] ?? false) === true) throw new PayPalTransportException(true);
        return new PayPalHttpResponse($expected['status'] ?? 200, json_encode($expected['response'], JSON_THROW_ON_ERROR));
    }
    public function assertConsumed(): void
    {
        if ($this->queue !== []) throw new RuntimeException('SYNTHETIC_TRANSPORT_EXPECTED_REQUEST_MISSING');
    }
    public function financialCalls(): array
    {
        return array_values(array_filter($this->calls, static fn (array $call): bool => $call['path'] !== '/v1/oauth2/token'));
    }
}
$fullConditions = CheckoutConditionsV1::fromDraft($drafts['full_upfront'], $nowMs);
$fullPlan = $fullConditions->conditions->operation->prepared->plan;
$childUuid = '00000000-0000-4000-8000-000000990001';
$orderId = 'SYNTHETICORDER001';
$merchant = 'SYNTHETICMERCHANT1';
$approved = ['id' => $orderId, 'intent' => 'CAPTURE', 'status' => 'APPROVED',
    'purchase_units' => [['custom_id' => $childUuid, 'invoice_id' => $childUuid,
        'payee' => ['merchant_id' => $merchant],
        'amount' => ['currency_code' => 'USD', 'value' => $decimal($fullPlan->sourceQuote->totalCents)]]]];
$completed = $copy($approved);
$completed['status'] = 'COMPLETED';
$completed['purchase_units'][0]['payments']['captures'] = [['id' => 'SYNTHETICCAPTURE001', 'status' => 'COMPLETED',
    'final_capture' => true, 'amount' => $completed['purchase_units'][0]['amount'], 'update_time' => '2030-01-02T03:04:05.123Z',
    'seller_receivable_breakdown' => ['gross_amount' => $completed['purchase_units'][0]['amount']]]];
$getStep = static fn (array $response): array => ['method' => 'GET', 'path' => '/v2/checkout/orders/' . $orderId, 'response' => $response];
$captureStep = static fn (array $response): array => ['method' => 'POST', 'path' => '/v2/checkout/orders/' . $orderId . '/capture', 'response' => $response];
$fakeTransportCalls = 0;
$providerChecks = [];
$adapterFor = static function (array $queue) use ($merchant): array {
    $transport = new SyntheticCheckoutHttpTransport($queue);
    // Literal synthetic fixtures are passed directly to the original Config;
    // no application environment or real credential source is consulted.
    $client = new PayPalClient(new PayPalConfig('sandbox', 'synthetic-client', 'synthetic-secret', ''), $transport);
    return [new OrdersCheckoutAdapter($client, $merchant), $transport];
};
$finishTransport = static function (SyntheticCheckoutHttpTransport $transport) use (&$fakeTransportCalls): array {
    $transport->assertConsumed(); $fakeTransportCalls += count($transport->calls); return $transport->financialCalls();
};

[$adapter, $transport] = $adapterFor([
    ['method' => 'POST', 'path' => '/v2/checkout/orders', 'response' => $approved],
    ['method' => 'POST', 'path' => '/v2/checkout/orders', 'response' => $approved],
]);
$check($transport->calls === [], 'Orders adapter construction does not request authentication or a provider resource');
$createdOrder = $adapter->create($fullConditions, $childUuid, $nowMs, 'https://checkout.synthetic.invalid/return', 'https://checkout.synthetic.invalid/cancel');
$check($createdOrder['externalId'] === $orderId && $createdOrder['status'] === 'APPROVED' && $createdOrder['paid'] === false
    && $createdOrder['captureId'] === null && $createdOrder['paidAt'] === null,
    'Orders APPROVED response alone never attests a payment');
$adapter->create($fullConditions, $childUuid, $nowMs, 'https://checkout.synthetic.invalid/return', 'https://checkout.synthetic.invalid/cancel');
$calls = $finishTransport($transport);
$expectedRequestId = 'gco-' . substr(hash('sha256', 'create:' . $childUuid . ':' . $fullConditions->digest . ':'), 0, 32);
$check(count($calls) === 2 && $calls[0]['headers']['PayPal-Request-Id'] === $expectedRequestId
    && $calls[1]['headers']['PayPal-Request-Id'] === $expectedRequestId && $calls[0]['body'] === $calls[1]['body'],
    'identical Orders creates reuse the complete conditions-bound request ID and payload');
$check(json_decode($calls[0]['body'], true, 40, JSON_THROW_ON_ERROR) === [
    'intent' => 'CAPTURE', 'purchase_units' => [['custom_id' => $childUuid, 'invoice_id' => $childUuid,
        'amount' => ['currency_code' => 'USD', 'value' => $decimal($fullPlan->sourceQuote->totalCents)], 'payee' => ['merchant_id' => $merchant]]],
    'payment_source' => ['paypal' => ['experience_context' => ['return_url' => 'https://checkout.synthetic.invalid/return',
        'cancel_url' => 'https://checkout.synthetic.invalid/cancel', 'user_action' => 'PAY_NOW', 'shipping_preference' => 'NO_SHIPPING']]],
], 'original client sends exactly one complete USD CAPTURE purchase and the expected merchant/child binding');
$providerChecks['createRequestBoundAndApprovedUnpaid'] = true;

[$adapter, $transport] = $adapterFor([$getStep($approved), $captureStep($completed), $getStep($completed)]);
$paid = $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs);
$paidReplay = $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs);
$calls = $finishTransport($transport);
$check($paid['paid'] === true && $paid['captureId'] === 'SYNTHETICCAPTURE001' && $paid['paidAt'] === '2030-01-02T03:04:05.123Z'
    && $paidReplay === $paid, 'one authoritative COMPLETED capture produces the exact payment evidence on replay');
$captureCalls = array_values(array_filter($calls, static fn (array $call): bool => $call['method'] === 'POST'));
$check(count($captureCalls) === 1 && $captureCalls[0]['path'] === '/v2/checkout/orders/' . $orderId . '/capture'
    && $captureCalls[0]['headers']['PayPal-Request-Id'] === 'gcc-' . substr(hash('sha256', 'capture:' . $childUuid . ':' . $fullConditions->digest . ':' . $orderId), 0, 32),
    'completed duplicate capture replays a GET and never sends a second CAPTURE');
$providerChecks['completedReplaySkipsCapture'] = true;

foreach (['lost transport response' => ['lost' => true], 'duplicate provider response' => ['status' => 422,
    'response' => ['name' => 'UNPROCESSABLE_ENTITY', 'details' => [['issue' => 'ORDER_ALREADY_CAPTURED']]]]] as $label => $fault) {
    [$adapter, $transport] = $adapterFor([$getStep($approved), array_merge($captureStep([]), $fault), $getStep($completed), $getStep($completed)]);
    $recovered = $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs);
    $again = $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs);
    $calls = $finishTransport($transport);
    $check($recovered['paid'] === true && $again === $recovered
        && count(array_filter($calls, static fn (array $call): bool => $call['method'] === 'POST')) === 1
        && count(array_filter($calls, static fn (array $call): bool => $call['method'] === 'GET')) === 3,
        $label . ': authoritative bound GET recovers the known order without another CAPTURE or new request ID');
    $providerChecks[$label === 'lost transport response' ? 'lostCaptureRecoveredByGet' : 'duplicateCaptureRecoveredByGet'] = true;
}
[$adapter, $transport] = $adapterFor([$getStep($approved), array_merge($captureStep([]), ['lost' => true]), $getStep($approved)]);
$unresolved = false;
try { $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs); }
catch (PayPalTransportException $exception) { $unresolved = $exception->ambiguous; }
$calls = $finishTransport($transport);
$check($unresolved && count(array_filter($calls, static fn (array $call): bool => $call['method'] === 'POST')) === 1,
    'lost response followed by APPROVED stays unresolved and never creates a payment or another CAPTURE');
$pending = $copy($completed); $pending['status'] = 'APPROVED';
$pending['purchase_units'][0]['payments']['captures'][0]['status'] = 'PENDING';
[$adapter, $transport] = $adapterFor([$getStep($approved), $captureStep($pending)]);
$pendingResult = $adapter->capture($orderId, $fullConditions, $childUuid, $nowMs);
$finishTransport($transport);
$check($pendingResult['paid'] === false && $pendingResult['captureId'] === null && $pendingResult['paidAt'] === null,
    'a pending capture cannot attest paid status or a payment timestamp');
$providerChecks['unresolvedAndPendingNeverPaid'] = true;

$expiredNow = (new DateTimeImmutable($fullPlan->linkExpiration->instant))->getTimestamp() * 1000;
[$adapter, $transport] = $adapterFor([$getStep($approved)]);
$reject('an expired checkout cannot send a capture', static fn () => $adapter->capture($orderId, $fullConditions, $childUuid, $expiredNow));
$calls = $finishTransport($transport);
$check(count($calls) === 1 && $calls[0]['method'] === 'GET', 'expiry is rechecked before the financial POST after authoritative order lookup');
[$adapter, $transport] = $adapterFor([$getStep($completed)]);
$historicalPayment = $adapter->capture($orderId, $fullConditions, $childUuid, $expiredNow);
$calls = $finishTransport($transport);
$check($historicalPayment['paid'] === true && count($calls) === 1 && $calls[0]['method'] === 'GET',
    'an already completed historical order can reconcile read-only after expiry without a new charge');
$providerChecks['expiryBlocksNewCaptureButAllowsReadOnlyRecovery'] = true;

$responseMutations = [
    'wrong provider order ID' => static function (array &$v): void { $v['id'] = 'OTHERORDER'; },
    'AUTHORIZE is not CAPTURE' => static function (array &$v): void { $v['intent'] = 'AUTHORIZE'; },
    'source parent UUID is not the child custom ID' => static function (array &$v) use ($fullConditions): void { $v['purchase_units'][0]['custom_id'] = $fullConditions->conditions->sourceDraft->agreementId; },
    'invoice binding differs' => static function (array &$v): void { $v['purchase_units'][0]['invoice_id'] = 'other'; },
    'wrong merchant account' => static function (array &$v): void { $v['purchase_units'][0]['payee']['merchant_id'] = 'OTHERACCOUNT'; },
    'purchase currency differs' => static function (array &$v): void { $v['purchase_units'][0]['amount']['currency_code'] = 'EUR'; },
    'purchase amount differs' => static function (array &$v): void { $v['purchase_units'][0]['amount']['value'] = '100.00'; },
    'two purchase units' => static function (array &$v): void { $v['purchase_units'][] = $v['purchase_units'][0]; },
    'two captures' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][] = $v['purchase_units'][0]['payments']['captures'][0]; },
    'malformed nested capture list' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'] = ['id' => 'SYNTHETICCAPTURE001']; },
    'capture currency differs' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['amount']['currency_code'] = 'EUR'; },
    'capture amount differs' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['amount']['value'] = '100.00'; },
    'COMPLETED order without capture' => static function (array &$v): void { unset($v['purchase_units'][0]['payments']); },
    'COMPLETED order with pending capture' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['status'] = 'PENDING'; },
    'capture is not final' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['final_capture'] = false; },
    'completed capture with APPROVED order' => static function (array &$v): void { $v['status'] = 'APPROVED'; },
    'gross amount differs' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['seller_receivable_breakdown']['gross_amount']['value'] = '100.00'; },
    'impossible capture timestamp' => static function (array &$v): void { $v['purchase_units'][0]['payments']['captures'][0]['update_time'] = '2030-02-30T12:00:00Z'; },
];
foreach ($responseMutations as $label => $mutate) {
    $invalidOrder = $copy($completed); $mutate($invalidOrder);
    [$adapter, $transport] = $adapterFor([$getStep($invalidOrder)]);
    $reject('Orders authoritative evidence: ' . $label, static fn () => $adapter->get($orderId, $fullConditions, $childUuid));
    $calls = $finishTransport($transport);
    $check(count($calls) === 1 && $calls[0]['method'] === 'GET', $label . ': incompatible provider evidence cannot trigger any financial POST');
}
$providerChecks['incompatibleOrderEvidenceRejected'] = count($responseMutations);
foreach (['retainer_50', 'fixed_49_reservation'] as $mode) {
    [$adapter, $transport] = $adapterFor([]);
    $split = CheckoutConditionsV1::fromDraft($drafts[$mode], $nowMs);
    $reject('Orders cannot reinterpret the ' . $mode . ' contract', static fn () => $adapter->create($split, $childUuid, $nowMs,
        'https://checkout.synthetic.invalid/return', 'https://checkout.synthetic.invalid/cancel'));
    $check($finishTransport($transport) === [], 'wrong representation is rejected before OAuth or provider resource creation');
}
$providerChecks['splitModesNeverReinterpretedAsOrders'] = true;

echo json_encode(['results' => $results, 'invalidOperations' => $invalidCount, 'assertions' => $assertions,
    'checks' => $checks, 'providerCalls' => 0, 'databaseConnections' => 0,
    'fakeProvider' => ['transportCalls' => $fakeTransportCalls, 'checks' => $providerChecks]],
    JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
