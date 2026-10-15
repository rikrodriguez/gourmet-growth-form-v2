<?php

declare(strict_types=1);

/**
 * Runs actual repository queries against an already migrated, isolated ledger.
 * Every synthetic row is rolled back. No DDL, application configuration,
 * network call, token generation or real provider is involved.
 *
 * @return array{assertions:int,facts:array<string,bool>,driver:string}
 */
function runOperationalQueryProbesV2(PDO $pdo): array
{
    if ($pdo->inTransaction()) { throw new RuntimeException('Query probes require their own isolated transaction.'); }
    $facts = [];
    $assert = static function (bool $condition, string $name) use (&$facts): void {
        if (!$condition) { throw new RuntimeException('Operational query probe failed: ' . $name); }
        $facts[$name] = true;
    };
    $tables = ['payment_agreements', 'payment_schedules', 'payment_attempts', 'payment_consents', 'email_outbox', 'sales_os_event_outbox', 'monday_sync_outbox', 'idempotency_keys'];
    $counts = static function () use ($pdo, $tables): array {
        $result = [];
        foreach ($tables as $table) { $result[$table] = (int) $pdo->query('SELECT COUNT(*) FROM ' . $table)->fetchColumn(); }
        return $result;
    };
    $before = $counts();
    $driver = (string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        // PDO MySQL reports int 0 on PHP 8.3 and bool false on PHP 8.4.
        $emulatePrepares = $pdo->getAttribute(PDO::ATTR_EMULATE_PREPARES);
        $assert($emulatePrepares === false || $emulatePrepares === 0, 'native_prepares');
    }
    $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $uuid = Gourmet\Payments\Support\Uuid::v4();
    $marker = 'synthetic-query-' . $uuid;
    $pdo->beginTransaction();
    try {
        // Legacy row exists only to exercise unchanged v1 repository queries.
        // A synthetic digest is not a raw payment token and yields no URL.
        $insert = $pdo->prepare("INSERT INTO payment_agreements (public_uuid,monday_item_id,recipient_name,recipient_email,service_name,currency,total_cents,reservation_cents,balance_cents,balance_due_at_utc,balance_timezone,status,provider,public_token_hash,terms_version,reservation_policy_version) VALUES (:uuid,NULL,:name,'synthetic-query@example.invalid','Synthetic query probe','USD',10001,4900,5101,'2099-12-08 12:00:00.000000','UTC','PENDING_RESERVATION','PAYPAL',:hash,'v1-local','v1-local')");
        $insert->bindValue('uuid', $uuid);
        $insert->bindValue('name', $marker);
        $insert->bindValue('hash', hash('sha256', $marker, true), PDO::PARAM_LOB);
        $insert->execute();
        $agreementId = (int) $pdo->lastInsertId();
        $repository = new Gourmet\Payments\Database\PaymentAgreementRepository($pdo);
        $matches = $repository->agreements($marker, 'ALL', 'ALL');
        $assert(count($matches) === 1 && $matches[0]['public_uuid'] === $uuid, 'nonempty_search');
        $agreement = $repository->findByPublicUuid($uuid);
        $assert(is_array($agreement), 'agreement_read');

        $repository->recordCheckoutConsents($agreement, hash('sha256', $marker . ':ip', true), 'Synthetic local query probe');
        $repository->recordCheckoutConsents($agreement, hash('sha256', $marker . ':ip', true), 'Synthetic local query probe');
        $consents = $pdo->prepare('SELECT COUNT(*) FROM payment_consents WHERE agreement_id = :id');
        $consents->execute(['id' => $agreementId]);
        $assert((int) $consents->fetchColumn() === 2, 'consent_target_replay');
        $invalidAgreement = $agreement;
        $invalidAgreement['id'] = PHP_INT_MAX;
        $rejected = false;
        try { $repository->recordCheckoutConsents($invalidAgreement, hash('sha256', $marker . ':ip', true), 'Synthetic local query probe'); }
        catch (PDOException) { $rejected = true; }
        $assert($rejected, 'consent_other_constraint_rejected');

        $email = new Gourmet\Payments\Database\EmailOutbox($pdo);
        $assert($email->enqueue($marker, 'SYNTHETIC_QUERY', 'synthetic-query@example.invalid', 'synthetic', ['synthetic' => true], $now->modify('-1 minute')), 'email_insert');
        $due = array_filter($email->due($now, 100), static fn (array $row): bool => $row['deduplication_key'] === $marker);
        $assert(count($due) === 1, 'email_due_cutoffs');
        $emailRow = array_values($due)[0];
        $assert($email->claim((int) $emailRow['id'], $now, 60), 'email_claim');
        $assert(!$email->claim((int) $emailRow['id'], $now, 60), 'email_claim_once');

        $sales = new Gourmet\Payments\Database\SalesOsEventOutbox($pdo);
        $assert($sales->enqueue('payment.failed', $marker, ['synthetic' => true]), 'sales_insert');
        $assert(!$sales->enqueue('payment.failed', $marker, ['synthetic' => true]), 'sales_target_replay');
        $claimed = array_filter($sales->claim(100, $now->modify('+1 minute')), static fn (array $row): bool => $row['dedupe_key'] === $marker);
        $assert(count($claimed) === 1, 'sales_claim_cutoffs');
        $monday = new Gourmet\Payments\Database\MondaySyncOutbox($pdo);
        $assert($monday->enqueue('123', 'PAYMENT_AGREEMENT_CREATED', $marker, ['synthetic' => true]), 'monday_insert');
        $assert(!$monday->enqueue('123', 'PAYMENT_AGREEMENT_CREATED', $marker, ['synthetic' => true]), 'monday_target_replay');

        $scheduleUuid = Gourmet\Payments\Support\Uuid::v4();
        $schedule = $pdo->prepare("INSERT INTO payment_schedules (public_uuid,agreement_id,kind,amount_cents,due_at_utc,status) VALUES (:uuid,:id,'RESERVATION',4900,:due,'PENDING')");
        $schedule->execute(['uuid' => $scheduleUuid, 'id' => $agreementId, 'due' => $now->format('Y-m-d H:i:s.u')]);
        $scheduleId = (int) $pdo->lastInsertId();
        $scheduleRow = ['id' => $scheduleId, 'amount_cents' => 4900];
        $gateway = new class implements Gourmet\Payments\Payments\PayPal\PayPalGateway {
            public int $calls = 0;
            private function unexpected(): never { $this->calls++; throw new RuntimeException('Provider calls are forbidden in query probes.'); }
            public function createProduct(array $payload, string $requestId): array { return $this->unexpected(); }
            public function getProduct(string $productId): array { return $this->unexpected(); }
            public function createPlan(array $payload, string $requestId): array { return $this->unexpected(); }
            public function getPlan(string $planId): array { return $this->unexpected(); }
            public function createSubscription(array $payload, string $requestId): array { return $this->unexpected(); }
            public function getSubscription(string $subscriptionId): array { return $this->unexpected(); }
            public function cancelSubscription(string $subscriptionId, string $reason): void { $this->unexpected(); }
            public function listTransactions(string $subscriptionId, DateTimeImmutable $start, DateTimeImmutable $end): array { return $this->unexpected(); }
        };
        $reconciler = new Gourmet\Payments\Payments\PayPal\PayPalReconciler($pdo, $gateway, new Gourmet\Payments\Database\ProviderResourceRepository($pdo));
        // This calls the real private SQL method; no provider method or domain
        // replacement is used to reach the upsert boundary.
        $attempt = new ReflectionMethod($reconciler, 'recordAttempt');
        $attempt->invoke($reconciler, $scheduleRow, $marker, 'COMPLETED');
        $read = $pdo->prepare("SELECT public_uuid,amount_cents,currency,schedule_id,idempotency_key,status,failure_code FROM payment_attempts WHERE provider = 'PAYPAL' AND provider_payment_id = :payment_id");
        $read->execute(['payment_id' => $marker]);
        $original = $read->fetch();
        $attempt->invoke($reconciler, $scheduleRow, $marker, 'FAILED');
        $read->execute(['payment_id' => $marker]);
        $updated = $read->fetch();
        $assert(is_array($original) && is_array($updated)
            && $updated['status'] === 'FAILED' && $updated['failure_code'] === 'FAILED'
            && array_diff_assoc($original, $updated) === ['status' => 'SUCCEEDED', 'failure_code' => null], 'attempt_target_update_preserves_facts');

        $collisionId = $marker . ':collision';
        $seed = $pdo->prepare("INSERT INTO payment_attempts (public_uuid,schedule_id,provider,provider_payment_id,idempotency_key,amount_cents,currency,status) VALUES (:uuid,:schedule,'PAYPAL',:payment,:key,4900,'USD','PENDING')");
        $seed->execute(['uuid' => Gourmet\Payments\Support\Uuid::v4(), 'schedule' => $scheduleId, 'payment' => $marker . ':held', 'key' => 'paypal:transaction:' . $collisionId]);
        $rejected = false;
        try { $attempt->invoke($reconciler, $scheduleRow, $collisionId, 'FAILED'); }
        catch (PDOException) { $rejected = true; }
        $assert($rejected, 'attempt_unrelated_unique_rejected');
        $read->execute(['payment_id' => $collisionId]);
        $assert($read->fetch() === false, 'attempt_conflict_did_not_create');
        $assert($gateway->calls === 0, 'provider_calls_zero');

        // Explicit binary edge bytes are stronger evidence than random AES
        // output, which might never exercise NUL, FF or trailing-zero storage.
        $binaryScope = 'synthetic.query.probes.v2';
        $requestHash = "\x00\xff" . str_repeat("\x81", 29) . "\x00";
        $responseHash = "\x00\xff" . str_repeat("\x84", 29) . "\x00";
        $ciphertext = "\x00\xff" . str_repeat("SYNTHETIC\x00", 9000) . "\x00";
        $nonce = "\x00\xff" . str_repeat("\x82", 9) . "\x00";
        $tag = "\x00\xff" . str_repeat("\x83", 13) . "\x00";
        $guard = new Gourmet\Payments\Database\IdempotencyGuard($pdo);
        $guard->begin($binaryScope, $marker, $requestHash);
        $guard->completeEncrypted($binaryScope, $marker, 201, $responseHash, $ciphertext, $nonce, $tag);
        $replayed = $guard->replay($binaryScope, $marker, $requestHash);
        $assert(is_array($replayed) && $replayed['status'] === 201
            && $replayed['ciphertext'] === $ciphertext && $replayed['nonce'] === $nonce
            && $replayed['tag'] === $tag, 'binary_encrypted_replay_exact');
        $binaryRead = $pdo->prepare('SELECT request_hash,response_hash,HEX(request_hash) AS request_hex,LENGTH(request_hash) AS request_length,HEX(response_hash) AS response_hex,LENGTH(response_hash) AS response_length,HEX(response_ciphertext) AS ciphertext_hex,LENGTH(response_ciphertext) AS ciphertext_length,HEX(response_nonce) AS nonce_hex,LENGTH(response_nonce) AS nonce_length,HEX(response_tag) AS tag_hex,LENGTH(response_tag) AS tag_length FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key');
        $binaryRead->execute(['scope' => $binaryScope, 'key' => $marker]);
        $stored = $binaryRead->fetch();
        $assert(is_array($stored) && $stored['request_hash'] === $requestHash
            && $stored['response_hash'] === $responseHash, 'binary_hashes_exact');
        $assert($stored['request_hex'] === strtoupper(bin2hex($requestHash)) && (int) $stored['request_length'] === 32
            && $stored['response_hex'] === strtoupper(bin2hex($responseHash)) && (int) $stored['response_length'] === 32, 'binary_hash_hex_lengths');
        $assert($stored['ciphertext_hex'] === strtoupper(bin2hex($ciphertext))
            && (int) $stored['ciphertext_length'] === strlen($ciphertext)
            && strlen($ciphertext) > 65535, 'binary_large_ciphertext_hex_length');
        $assert($stored['nonce_hex'] === strtoupper(bin2hex($nonce)) && (int) $stored['nonce_length'] === 12
            && $stored['tag_hex'] === strtoupper(bin2hex($tag)) && (int) $stored['tag_length'] === 16, 'binary_nonce_tag_hex_lengths');

        if ($driver === 'mysql') {
            $versioned = $pdo->query('SELECT * FROM payment_agreements WHERE contract_version = 2 ORDER BY id')->fetchAll();
            $sources = [];
            foreach ($versioned as $row) { $sources[(string) $row['payment_mode']] ??= $row; }
            foreach (['retainer_50', 'full_upfront', 'fixed_49_reservation'] as $mode) {
                $assert(isset($sources[$mode]), 'versioned_source_' . $mode);
            }
            $rejectVersioned = static function (array $source, string $field, string $value, string $name) use ($pdo, $assert, $marker): void {
                unset($source['id']);
                $source['public_uuid'] = Gourmet\Payments\Support\Uuid::v4();
                $source['operation_id'] = hash('sha256', $marker . ':' . $name);
                $source[$field] = $value;
                $columns = array_keys($source);
                foreach ($columns as $column) {
                    if (preg_match('/^[a-z][a-z0-9_]*$/D', $column) !== 1) { throw new RuntimeException('Unexpected query probe column.'); }
                }
                $sql = 'INSERT INTO payment_agreements (`' . implode('`,`', $columns) . '`) VALUES (:' . implode(',:', $columns) . ')';
                $rejected = false;
                try { $pdo->prepare($sql)->execute($source); }
                catch (PDOException $exception) {
                    // A collision or incidental column error must not count
                    // as evidence that the versioned policy CHECK worked.
                    $message = (string) ($exception->errorInfo[2] ?? $exception->getMessage());
                    $rejected = in_array((int) ($exception->errorInfo[1] ?? 0), [4025, 3819], true)
                        && str_contains($message, 'chk_payment_agreements_versioned');
                }
                $assert($rejected, $name);
            };
            foreach (['retainer_50', 'full_upfront', 'fixed_49_reservation'] as $mode) {
                $rejectVersioned($sources[$mode], 'payment_mode', $mode . ' ', 'sql_trailing_mode_' . $mode);
            }
            foreach (['operation_id', 'operation_digest', 'configuration_digest'] as $field) {
                $rejectVersioned($sources['retainer_50'], $field, str_repeat('A', 64), 'sql_uppercase_' . $field);
            }
        }
    } finally {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
    }
    $assert($counts() === $before, 'all_probe_rows_rolled_back');
    $assert(!$pdo->inTransaction(), 'transaction_closed');
    return ['assertions' => count($facts), 'facts' => $facts, 'driver' => $driver];
}
