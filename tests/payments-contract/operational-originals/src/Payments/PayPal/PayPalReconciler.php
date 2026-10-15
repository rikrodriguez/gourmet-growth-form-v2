<?php

declare(strict_types=1);

namespace Gourmet\Payments\Payments\PayPal;

use Gourmet\Payments\Database\AuditLog;
use Gourmet\Payments\Database\EmailOutbox;
use Gourmet\Payments\Database\ProviderResourceRepository;
use Gourmet\Payments\Database\SalesOsEventOutbox;
use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class PayPalReconciler
{
    public function __construct(
        private PDO $pdo,
        private PayPalGateway $gateway,
        private ProviderResourceRepository $resources,
    ) {
    }

    public function reconcile(string $agreementUuid, string $subscriptionId): PayPalReconciliationResult
    {
        $agreement = $this->loadAgreement($agreementUuid);
        $resource = $this->resources->findSubscriptionForAgreement((int) $agreement['id']);
        if ($resource === null || !hash_equals((string) $resource['external_id'], $subscriptionId)) {
            throw new \DomainException('PayPal subscription is not mapped to this agreement.');
        }

        $subscription = $this->gateway->getSubscription($subscriptionId);
        if (($subscription['id'] ?? null) !== $subscriptionId || ($subscription['custom_id'] ?? null) !== $agreementUuid) {
            throw new \DomainException('PayPal subscription identity does not match the local agreement.');
        }
        $status = is_string($subscription['status'] ?? null) ? $subscription['status'] : 'UNKNOWN';
        $startAt = is_string($subscription['start_time'] ?? null)
            ? (new \DateTimeImmutable($subscription['start_time']))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u')
            : null;
        $approvedAt = in_array($status, ['APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'], true)
            ? (is_string($subscription['status_update_time'] ?? null)
                ? (new \DateTimeImmutable($subscription['status_update_time']))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u')
                : null)
            : null;

        $createdAt = new \DateTimeImmutable((string) $agreement['created_at'], new \DateTimeZone('UTC'));
        $transactions = $this->gateway->listTransactions(
            $subscriptionId,
            $createdAt->modify('-1 day'),
            new \DateTimeImmutable('+1 day', new \DateTimeZone('UTC')),
        );

        $paid = [];
        $this->pdo->beginTransaction();
        try {
            $this->resources->updateSubscriptionState($subscriptionId, $status, $startAt, $approvedAt);
            $schedules = [
                'RESERVATION' => $this->loadSchedule((int) $agreement['id'], 'RESERVATION'),
                'BALANCE' => $this->loadSchedule((int) $agreement['id'], 'BALANCE'),
            ];
            $reservationFailed = false;
            $reservationFailureProviderPaymentId = null;
            foreach ($transactions as $transaction) {
                $kind = $this->matchScheduleKind($transaction, $schedules);
                if ($kind === null) {
                    continue;
                }
                $transactionStatus = is_string($transaction['status'] ?? null) ? $transaction['status'] : 'UNKNOWN';
                $providerPaymentId = is_string($transaction['id'] ?? null) ? $transaction['id'] : '';
                if ($providerPaymentId === '') {
                    continue;
                }
                $schedule = $schedules[$kind];
                $this->recordAttempt($schedule, $providerPaymentId, $transactionStatus);
                if ($kind === 'RESERVATION' && in_array($transactionStatus, ['FAILED', 'DECLINED'], true)) {
                    $reservationFailed = true;
                    $reservationFailureProviderPaymentId = $providerPaymentId;
                }
                if ($transactionStatus === 'COMPLETED') {
                    $paidAt = is_string($transaction['time'] ?? null)
                        ? (new \DateTimeImmutable($transaction['time']))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u')
                        : gmdate('Y-m-d H:i:s.000000');
                    $statement = $this->pdo->prepare(
                        "UPDATE payment_schedules SET status = 'PAID', paid_at = COALESCE(paid_at, :paid_at) WHERE id = :id AND status <> 'PAID'"
                    );
                    $statement->execute(['paid_at' => $paidAt, 'id' => $schedule['id']]);
                    if ($statement->rowCount() === 1) {
                        (new AuditLog($this->pdo))->record(
                            'PROVIDER',
                            'PAYMENT_SCHEDULE_PAID',
                            'PAYMENT_SCHEDULE',
                            null,
                            (string) $schedule['public_uuid'],
                            'paypal:transaction:' . $providerPaymentId,
                            [
                                'provider' => 'PAYPAL',
                                'provider_payment_id' => $providerPaymentId,
                                'payment_kind' => $kind,
                                'amount_cents' => (int) $schedule['amount_cents'],
                                'currency' => 'USD',
                                'paid_at' => $paidAt,
                            ],
                        );
                        (new SalesOsEventOutbox($this->pdo))->enqueueAgreementEvent(
                            $agreement,
                            $kind === 'RESERVATION' ? 'reservation.paid' : 'balance.paid',
                            ($kind === 'RESERVATION' ? 'reservation.paid:' : 'balance.paid:') . (string) $schedule['public_uuid'] . ':' . $providerPaymentId,
                            (int) $schedule['amount_cents'],
                            $providerPaymentId,
                            new \DateTimeImmutable($paidAt, new \DateTimeZone('UTC')),
                        );
                        $paid[] = $kind;
                        $this->queueFinancialEmail($agreement, $kind, $schedule, $paidAt);
                    }
                }
            }

            $states = $this->pdo->prepare('SELECT kind, status FROM payment_schedules WHERE agreement_id = :agreement_id');
            $states->execute(['agreement_id' => $agreement['id']]);
            $scheduleStates = $states->fetchAll(PDO::FETCH_KEY_PAIR);
            if (($scheduleStates['RESERVATION'] ?? null) === 'PAID' && ($scheduleStates['BALANCE'] ?? null) === 'PENDING') {
                $statement = $this->pdo->prepare("UPDATE payment_schedules SET status = 'SCHEDULED' WHERE agreement_id = :id AND kind = 'BALANCE'");
                $statement->execute(['id' => $agreement['id']]);
                $scheduleStates['BALANCE'] = 'SCHEDULED';
                if ($statement->rowCount() === 1) {
                    (new SalesOsEventOutbox($this->pdo))->enqueueAgreementEvent(
                        $agreement,
                        'balance.scheduled',
                        'balance.scheduled:' . (string) $schedules['BALANCE']['public_uuid'],
                        (int) $schedules['BALANCE']['amount_cents'],
                    );
                }
            }
            $agreementStatus = ($scheduleStates['RESERVATION'] ?? null) === 'PAID' && ($scheduleStates['BALANCE'] ?? null) === 'PAID'
                ? 'FULLY_PAID'
                : (($scheduleStates['RESERVATION'] ?? null) === 'PAID'
                    ? 'RESERVATION_PAID'
                    : ($reservationFailed ? 'PAYMENT_FAILED' : 'PENDING_RESERVATION'));
            $statement = $this->pdo->prepare('UPDATE payment_agreements SET status = :status WHERE id = :id AND status <> :next_status');
            $statement->execute(['status' => $agreementStatus, 'next_status' => $agreementStatus, 'id' => $agreement['id']]);
            if ($agreementStatus === 'PAYMENT_FAILED' && $statement->rowCount() === 1) {
                (new SalesOsEventOutbox($this->pdo))->enqueueAgreementEvent(
                    $agreement,
                    'payment.failed',
                    'payment.failed:' . (string) $schedules['RESERVATION']['public_uuid'] . ':' . ($reservationFailureProviderPaymentId ?? 'unknown'),
                    (int) $schedules['RESERVATION']['amount_cents'],
                    $reservationFailureProviderPaymentId,
                );
            }
            $this->pdo->commit();
        } catch (\Throwable $exception) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $exception;
        }

        return new PayPalReconciliationResult($status, array_values(array_unique($paid)), $agreementStatus);
    }

    /** @return array<string, mixed> */
    private function loadAgreement(string $uuid): array
    {
        $statement = $this->pdo->prepare('SELECT payment_agreements.*, recipient_email AS customer_email, recipient_name AS customer_first_name FROM payment_agreements WHERE public_uuid = :uuid AND provider = \'PAYPAL\' LIMIT 1');
        $statement->execute(['uuid' => $uuid]);
        $row = $statement->fetch();
        if (!is_array($row)) {
            throw new \DomainException('PayPal agreement was not found.');
        }

        return $row;
    }

    /** @return array<string, mixed> */
    private function loadSchedule(int $agreementId, string $kind): array
    {
        $statement = $this->pdo->prepare('SELECT * FROM payment_schedules WHERE agreement_id = :agreement_id AND kind = :kind LIMIT 1');
        $statement->execute(['agreement_id' => $agreementId, 'kind' => $kind]);
        $row = $statement->fetch();
        if (!is_array($row)) {
            throw new \DomainException('Required payment schedule was not found.');
        }

        return $row;
    }

    /**
     * Match provider financial evidence to the two locally-authoritative schedules.
     *
     * @param array<string, mixed> $transaction
     * @param array{RESERVATION:array<string,mixed>,BALANCE:array<string,mixed>} $schedules
     */
    private function matchScheduleKind(array $transaction, array $schedules): ?string
    {
        $gross = $transaction['amount_with_breakdown']['gross_amount'] ?? null;
        if (!is_array($gross) || ($gross['currency_code'] ?? null) !== 'USD' || !is_string($gross['value'] ?? null)) {
            return null;
        }

        $cents = PayPalMoney::toCents($gross['value']);

        $matches = [];
        foreach ($schedules as $kind => $schedule) {
            if ((int) $schedule['amount_cents'] === $cents) {
                $matches[] = $kind;
            }
        }
        if (count($matches) === 1) {
            return $matches[0];
        }

        // A $49 balance is valid. When both schedules have the same amount,
        // never guess: use the local schedule state and the agreed balance date.
        if ($matches === ['RESERVATION', 'BALANCE'] && is_string($transaction['time'] ?? null)) {
            $transactionAt = new \DateTimeImmutable($transaction['time']);
            $balanceDueAt = new \DateTimeImmutable((string) $schedules['BALANCE']['due_at_utc'], new \DateTimeZone('UTC'));
            if ($schedules['RESERVATION']['status'] !== 'PAID' && $transactionAt < $balanceDueAt) {
                return 'RESERVATION';
            }
            if ($schedules['RESERVATION']['status'] === 'PAID' && $transactionAt >= $balanceDueAt) {
                return 'BALANCE';
            }
        }

        return null;
    }

    /** @param array<string, mixed> $schedule */
    private function recordAttempt(array $schedule, string $providerPaymentId, string $status): void
    {
        $mapped = $status === 'COMPLETED' ? 'SUCCEEDED' : (in_array($status, ['FAILED', 'DECLINED'], true) ? 'FAILED' : 'PENDING');
        $statement = $this->pdo->prepare(
            'INSERT INTO payment_attempts (' .
            'public_uuid, schedule_id, provider, provider_payment_id, idempotency_key, amount_cents, currency, status, failure_code' .
            ') VALUES (' .
            ":uuid, :schedule_id, 'PAYPAL', :provider_payment_id, :idempotency_key, :amount_cents, 'USD', :status, :failure_code" .
            ') ON CONFLICT(provider, provider_payment_id) DO UPDATE SET status = excluded.status, failure_code = excluded.failure_code, updated_at = CURRENT_TIMESTAMP'
        );
        $statement->execute([
            'uuid' => Uuid::v4(),
            'schedule_id' => $schedule['id'],
            'provider_payment_id' => $providerPaymentId,
            'idempotency_key' => 'paypal:transaction:' . $providerPaymentId,
            'amount_cents' => $schedule['amount_cents'],
            'status' => $mapped,
            'failure_code' => $mapped === 'FAILED' ? $status : null,
        ]);
    }

    /** @param array<string,mixed> $agreement @param array<string,mixed> $schedule */
    private function queueFinancialEmail(array $agreement, string $kind, array $schedule, string $paidAt): void
    {
        $recipient = $agreement['customer_email'] ?? null;
        if (!is_string($recipient) || $recipient === '') {
            return;
        }
        $event = $kind === 'RESERVATION' ? 'RESERVATION_CONFIRMED' : 'BALANCE_PAID';
        (new EmailOutbox($this->pdo))->enqueue(
            'paypal:' . $event . ':' . (string) $schedule['public_uuid'],
            $event,
            $recipient,
            mb_strtolower($event),
            [
                'customer_first_name' => (string) ($agreement['customer_first_name'] ?? ''),
                'amount_cents' => (int) $schedule['amount_cents'],
                'currency' => 'USD',
                'paid_at' => $paidAt,
            ],
            new \DateTimeImmutable('now', new \DateTimeZone('UTC')),
        );
    }
}
