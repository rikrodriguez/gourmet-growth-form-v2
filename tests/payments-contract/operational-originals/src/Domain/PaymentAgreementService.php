<?php

declare(strict_types=1);

namespace Gourmet\Payments\Domain;

use Gourmet\Payments\Database\AuditLog;
use Gourmet\Payments\Database\MondaySyncOutbox;
use Gourmet\Payments\Database\SalesOsEventOutbox;
use Gourmet\Payments\Support\MondayItemReference;
use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class PaymentAgreementService
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @return array{agreement_uuid:string,token:string} */
    public function create(
        ?string $mondayItemReference,
        string $recipientName,
        string $email,
        int $totalCents,
        \DateTimeImmutable $balanceDueAt,
        string $balanceTimezone,
        ?\DateTimeImmutable $linkExpiresAt,
        ?string $provider = 'PAYPAL',
        ?string $phone = null,
        string $serviceName = 'Gourmet service',
        ?\DateTimeImmutable $eventAt = null,
        ?string $eventLocation = null,
        ?string $internalNotes = null,
        ?string $sourceLeadId = null,
        ?string $sourceQuoteId = null,
        ?string $sourceQuoteVersion = null,
        ?callable $afterPersisted = null,
    ): array {
        $mondayItemId = $this->normalizeMondayItemId($mondayItemReference);
        if (trim($recipientName) === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new \DomainException('Valid recipient snapshot fields are required.');
        }
        new \DateTimeZone($balanceTimezone);
        if ($provider !== 'PAYPAL') {
            throw new \DomainException('Unsupported payment provider.');
        }
        if (trim($serviceName) === '') {
            throw new \DomainException('A service or event name is required.');
        }

        $money = Money::agreement($totalCents);
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        if ($balanceDueAt <= $now) {
            throw new \DomainException('The balance date must be in the future.');
        }
        if ($linkExpiresAt !== null && $linkExpiresAt <= $now) {
            throw new \DomainException('The payment link expiration must be in the future.');
        }

        $agreementUuid = Uuid::v4();
        $rawToken = PaymentLink::generateToken();
        $sourceLeadId = $this->sourceReference($sourceLeadId);
        $sourceQuoteId = $this->sourceReference($sourceQuoteId);
        $sourceQuoteVersion = $this->sourceReference($sourceQuoteVersion);

        $this->pdo->beginTransaction();
        try {
            $agreement = $this->pdo->prepare(
                'INSERT INTO payment_agreements (' .
                'public_uuid, monday_item_id, source_lead_id, source_quote_id, source_quote_version, recipient_name, recipient_email, recipient_phone, service_name, event_at_utc, event_location, internal_notes, currency, total_cents, reservation_cents, balance_cents, balance_due_at_utc, balance_timezone, ' .
                'status, provider, public_token_hash, link_expires_at, terms_version, reservation_policy_version' .
                ') VALUES (' .
                ':uuid, :monday_item_id, :source_lead_id, :source_quote_id, :source_quote_version, :recipient_name, :recipient_email, :recipient_phone, :service_name, :event_at, :event_location, :internal_notes, :currency, :total, :reservation, :balance, :balance_due, :timezone, ' .
                "'PENDING_RESERVATION', :provider, :token_hash, :link_expires, 'v1-local', 'v1-local'" .
                ')'
            );
            $agreement->bindValue('uuid', $agreementUuid);
            $agreement->bindValue('monday_item_id', $mondayItemId);
            $agreement->bindValue('source_lead_id', $sourceLeadId);
            $agreement->bindValue('source_quote_id', $sourceQuoteId);
            $agreement->bindValue('source_quote_version', $sourceQuoteVersion);
            $agreement->bindValue('recipient_name', mb_substr(trim($recipientName), 0, 200));
            $agreement->bindValue('recipient_email', mb_strtolower(trim($email)));
            $agreement->bindValue('recipient_phone', $phone === null || trim($phone) === '' ? null : mb_substr(trim($phone), 0, 32));
            $agreement->bindValue('service_name', mb_substr(trim($serviceName), 0, 180));
            $agreement->bindValue('event_at', $eventAt?->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
            $agreement->bindValue('event_location', $eventLocation === null || trim($eventLocation) === '' ? null : mb_substr(trim($eventLocation), 0, 255));
            $agreement->bindValue('internal_notes', $internalNotes === null || trim($internalNotes) === '' ? null : mb_substr(trim($internalNotes), 0, 4000));
            $agreement->bindValue('currency', $money->currency);
            $agreement->bindValue('total', $money->totalCents, PDO::PARAM_INT);
            $agreement->bindValue('reservation', $money->reservationCents, PDO::PARAM_INT);
            $agreement->bindValue('balance', $money->balanceCents, PDO::PARAM_INT);
            $agreement->bindValue('balance_due', $balanceDueAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
            $agreement->bindValue('timezone', $balanceTimezone);
            $agreement->bindValue('provider', $provider);
            $agreement->bindValue('token_hash', PaymentLink::hash($rawToken), PDO::PARAM_LOB);
            $agreement->bindValue('link_expires', $linkExpiresAt?->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
            $agreement->execute();
            $agreementId = (int) $this->pdo->lastInsertId();

            $schedule = $this->pdo->prepare(
                'INSERT INTO payment_schedules (public_uuid, agreement_id, kind, amount_cents, due_at_utc) ' .
                'VALUES (:uuid, :agreement_id, :kind, :amount, :due_at)'
            );
            foreach ([
                ['RESERVATION', $money->reservationCents, $now],
                ['BALANCE', $money->balanceCents, $balanceDueAt],
            ] as [$kind, $amount, $dueAt]) {
                $schedule->execute([
                    'uuid' => Uuid::v4(),
                    'agreement_id' => $agreementId,
                    'kind' => $kind,
                    'amount' => $amount,
                    'due_at' => $dueAt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'),
                ]);
            }

            (new AuditLog($this->pdo))->record(
                'SYSTEM',
                'PAYMENT_AGREEMENT_CREATED',
                'PAYMENT_AGREEMENT',
                null,
                $agreementUuid,
                null,
                ['currency' => $money->currency, 'total_cents' => $money->totalCents],
            );
            if ($mondayItemId !== null) {
                (new MondaySyncOutbox($this->pdo))->enqueue(
                    $mondayItemId,
                    'PAYMENT_AGREEMENT_CREATED',
                    'agreement-created:' . $agreementUuid,
                    ['agreement_uuid' => $agreementUuid, 'status' => 'PENDING_RESERVATION', 'total_cents' => $money->totalCents, 'balance_cents' => $money->balanceCents, 'currency' => 'USD'],
                );
            }
            (new SalesOsEventOutbox($this->pdo))->enqueueAgreementEvent(
                [
                    'public_uuid' => $agreementUuid,
                    'source_lead_id' => $sourceLeadId,
                    'monday_item_id' => $mondayItemId,
                    'source_quote_id' => $sourceQuoteId,
                    'source_quote_version' => $sourceQuoteVersion,
                ],
                'payment_link.created',
                'payment_link.created:' . $agreementUuid,
                null,
                null,
                $now,
            );
            if ($afterPersisted !== null) {
                $afterPersisted($agreementUuid, $rawToken);
            }

            $this->pdo->commit();
        } catch (\Throwable $exception) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $exception;
        }

        return [
            'agreement_uuid' => $agreementUuid,
            'token' => $rawToken,
        ];
    }

    private function normalizeMondayItemId(?string $reference): ?string
    {
        $reference = $reference === null ? '' : trim($reference);
        if ($reference === '') {
            return null;
        }
        if (preg_match('/^[0-9]{1,20}$/', $reference) === 1) {
            return $reference;
        }
        return MondayItemReference::itemId($reference);
    }

    private function sourceReference(?string $value): ?string
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        return mb_substr(trim($value), 0, 180);
    }
}
