<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Domain\PaymentLink;
use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class PaymentAgreementRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /** @return array<string, mixed>|null */
    public function findUsableByRawToken(string $token, \DateTimeImmutable $now): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return null;
        }

        $statement = $this->pdo->prepare($this->detailSelect() . ' WHERE a.public_token_hash = :token_hash LIMIT 1');
        $statement->bindValue('token_hash', PaymentLink::hash($token), PDO::PARAM_LOB);
        $statement->execute();
        $agreement = $statement->fetch();

        if (!is_array($agreement) || !PaymentLink::isUsable(
            $agreement['link_expires_at'] !== null ? (string) $agreement['link_expires_at'] : null,
            $agreement['link_revoked_at'] !== null ? (string) $agreement['link_revoked_at'] : null,
            $now,
        )) {
            return null;
        }

        return $agreement;
    }

    /**
     * Records an expired-link event exactly once without revealing or persisting
     * its raw public token. Returns its agreement only for the private outbox.
     *
     * @return array<string,mixed>|null
     */
    public function recordExpirationByRawToken(string $token, \DateTimeImmutable $now): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            return null;
        }
        $statement = $this->pdo->prepare(
            $this->detailSelect() . " WHERE a.public_token_hash = :token_hash AND a.link_revoked_at IS NULL " .
            'AND a.link_expires_at IS NOT NULL AND a.link_expires_at <= :now LIMIT 1'
        );
        $statement->bindValue('token_hash', PaymentLink::hash($token), PDO::PARAM_LOB);
        $statement->bindValue('now', $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
        $statement->execute();
        $agreement = $statement->fetch();
        if (!is_array($agreement)) {
            return null;
        }

        $mark = $this->pdo->prepare(
            'UPDATE payment_agreements SET link_expired_event_at = :now WHERE id = :id AND link_expired_event_at IS NULL'
        );
        $mark->execute(['id' => $agreement['id'], 'now' => $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u')]);
        return $mark->rowCount() === 1 ? $agreement : null;
    }

    /** @return array<string, mixed>|null */
    public function findByPublicUuid(string $publicUuid): ?array
    {
        $statement = $this->pdo->prepare($this->detailSelect() . ' WHERE a.public_uuid = :uuid LIMIT 1');
        $statement->execute(['uuid' => $publicUuid]);
        $agreement = $statement->fetch();
        return is_array($agreement) ? $agreement : null;
    }

    /** @return array{counts:array<string,int>,recent_activity:list<array<string,mixed>>,upcoming_balances:list<array<string,mixed>>,attention:list<array<string,mixed>>} */
    public function dashboard(): array
    {
        $counts = ['total' => 0, 'awaiting_reservation' => 0, 'reservation_paid' => 0, 'balance_scheduled' => 0, 'fully_paid' => 0, 'attention_required' => 0];
        $rows = $this->pdo->query('SELECT status, COUNT(*) AS count FROM payment_agreements GROUP BY status')->fetchAll();
        foreach ($rows as $row) {
            $count = (int) $row['count'];
            $counts['total'] += $count;
            match ((string) $row['status']) {
                'PENDING_RESERVATION', 'AWAITING_RESERVATION', 'RESERVATION_PROCESSING' => $counts['awaiting_reservation'] += $count,
                'FULLY_PAID' => $counts['fully_paid'] += $count,
                'PAYMENT_FAILED', 'CANCELLED' => $counts['attention_required'] += $count,
                default => null,
            };
        }
        $scheduleCounts = $this->pdo->query("SELECT kind, status, COUNT(*) AS count FROM payment_schedules WHERE status IN ('PAID', 'SCHEDULED') GROUP BY kind, status")->fetchAll();
        foreach ($scheduleCounts as $row) {
            if ($row['kind'] === 'RESERVATION' && $row['status'] === 'PAID') {
                $counts['reservation_paid'] += (int) $row['count'];
            }
            if ($row['kind'] === 'BALANCE' && $row['status'] === 'SCHEDULED') {
                $counts['balance_scheduled'] += (int) $row['count'];
            }
        }

        $recentActivity = $this->pdo->query(
            'SELECT ae.event_type, ae.actor_type, ae.aggregate_type, ae.aggregate_public_uuid, ae.created_at, a.recipient_name, a.service_name ' .
            'FROM audit_events ae LEFT JOIN payment_agreements a ON a.public_uuid = ae.aggregate_public_uuid ' .
            'ORDER BY ae.created_at DESC LIMIT 8'
        )->fetchAll();

        $now = gmdate('Y-m-d H:i:s.u');
        $upcoming = $this->pdo->prepare(
            "SELECT a.public_uuid, a.recipient_name, a.service_name, a.balance_timezone, s.amount_cents, s.due_at_utc " .
            "FROM payment_schedules s JOIN payment_agreements a ON a.id = s.agreement_id " .
            "WHERE s.kind = 'BALANCE' AND s.status = 'SCHEDULED' AND s.due_at_utc >= :now " .
            'ORDER BY s.due_at_utc ASC LIMIT 8'
        );
        $upcoming->execute(['now' => $now]);

        $attention = $this->pdo->prepare(
            "SELECT public_uuid, recipient_name, service_name, status, balance_due_at_utc, balance_timezone " .
            "FROM payment_agreements WHERE status IN ('PAYMENT_FAILED', 'CANCELLED') " .
            "OR (link_revoked_at IS NULL AND link_expires_at IS NOT NULL AND link_expires_at <= :now " .
            "AND status NOT IN ('RESERVATION_PAID', 'FULLY_PAID')) " .
            'ORDER BY created_at DESC LIMIT 8'
        );
        $attention->execute(['now' => $now]);

        return [
            'counts' => $counts,
            'recent_activity' => $recentActivity,
            'upcoming_balances' => $upcoming->fetchAll(),
            'attention' => $attention->fetchAll(),
        ];
    }

    /** @return list<array<string,mixed>> */
    public function agreements(string $search, string $status, string $linkState): array
    {
        $search = mb_substr(trim($search), 0, 120);
        $allowedStatuses = ['ALL', 'PENDING_RESERVATION', 'AWAITING_RESERVATION', 'RESERVATION_PROCESSING', 'RESERVATION_PAID', 'FULLY_PAID', 'PAYMENT_FAILED', 'CANCELLED'];
        $allowedLinkStates = ['ALL', 'ACTIVE', 'EXPIRED', 'REVOKED'];
        if (!in_array($status, $allowedStatuses, true) || !in_array($linkState, $allowedLinkStates, true)) {
            throw new \DomainException('Invalid agreement filter.');
        }

        $clauses = ['1 = 1'];
        $parameters = [];
        if ($search !== '') {
            $clauses[] = '(a.recipient_name LIKE :search OR a.recipient_email LIKE :search OR a.service_name LIKE :search OR a.monday_item_id LIKE :search OR a.public_uuid LIKE :search)';
            $parameters['search'] = '%' . $search . '%';
        }
        if ($status !== 'ALL') {
            $clauses[] = 'a.status = :status';
            $parameters['status'] = $status;
        }

        $now = gmdate('Y-m-d H:i:s.u');
        if ($linkState === 'ACTIVE') {
            $clauses[] = '(a.link_revoked_at IS NULL AND (a.link_expires_at IS NULL OR a.link_expires_at > :now))';
            $parameters['now'] = $now;
        } elseif ($linkState === 'EXPIRED') {
            $clauses[] = '(a.link_revoked_at IS NULL AND a.link_expires_at IS NOT NULL AND a.link_expires_at <= :now)';
            $parameters['now'] = $now;
        } elseif ($linkState === 'REVOKED') {
            $clauses[] = 'a.link_revoked_at IS NOT NULL';
        }

        $statement = $this->pdo->prepare(
            'SELECT a.public_uuid, a.recipient_name, a.service_name, a.total_cents, a.balance_cents, a.balance_due_at_utc, a.balance_timezone, a.status, a.link_expires_at, a.link_revoked_at, a.created_at ' .
            'FROM payment_agreements a WHERE ' . implode(' AND ', $clauses) . ' ORDER BY a.created_at DESC LIMIT 200'
        );
        $statement->execute($parameters);
        return $statement->fetchAll();
    }

    /** @return list<array<string, mixed>> */
    public function schedules(int $agreementId): array
    {
        $statement = $this->pdo->prepare('SELECT public_uuid, kind, amount_cents, due_at_utc, status, paid_at FROM payment_schedules WHERE agreement_id = :id ORDER BY kind');
        $statement->execute(['id' => $agreementId]);
        return $statement->fetchAll();
    }

    /** @return list<array<string, mixed>> */
    public function attempts(int $agreementId): array
    {
        $statement = $this->pdo->prepare(
            'SELECT pa.provider, pa.provider_payment_id, pa.amount_cents, pa.currency, pa.status, pa.failure_code, pa.created_at ' .
            'FROM payment_attempts pa JOIN payment_schedules ps ON ps.id = pa.schedule_id WHERE ps.agreement_id = :id ORDER BY pa.created_at DESC'
        );
        $statement->execute(['id' => $agreementId]);
        return $statement->fetchAll();
    }

    /** @return list<array<string, mixed>> */
    public function consents(int $agreementId): array
    {
        $statement = $this->pdo->prepare('SELECT consent_type, provider, amount_cents, scheduled_charge_at, accepted_at, terms_version FROM payment_consents WHERE agreement_id = :id ORDER BY accepted_at DESC');
        $statement->execute(['id' => $agreementId]);
        return $statement->fetchAll();
    }

    /** @return list<array<string, mixed>> */
    public function audits(int $agreementId, string $agreementUuid): array
    {
        $statement = $this->pdo->prepare(
            'SELECT event_type, actor_type, created_at FROM audit_events WHERE aggregate_public_uuid = :agreement_uuid ' .
            'OR aggregate_public_uuid IN (SELECT public_uuid FROM payment_schedules WHERE agreement_id = :agreement_id) ' .
            'ORDER BY created_at DESC LIMIT 40'
        );
        $statement->execute(['agreement_uuid' => $agreementUuid, 'agreement_id' => $agreementId]);
        return $statement->fetchAll();
    }

    /** @param array<string, mixed> $agreement */
    public function recordCheckoutConsents(array $agreement, string $ipHash, string $userAgent): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO payment_consents (public_uuid, agreement_id, provider, consent_type, terms_version, amount_cents, scheduled_charge_at, accepted_at, ip_hash, user_agent_summary) ' .
            'VALUES (:uuid, :agreement_id, :provider, :consent_type, :terms_version, :amount_cents, :scheduled_charge_at, :accepted_at, :ip_hash, :user_agent) ' .
            'ON CONFLICT(agreement_id, consent_type) DO NOTHING'
        );
        foreach ([
            ['NON_REFUNDABLE_RESERVATION', (int) $agreement['reservation_cents'], null],
            ['FUTURE_BALANCE_CHARGE', (int) $agreement['balance_cents'], (string) $agreement['balance_due_at_utc']],
        ] as [$type, $amount, $scheduledAt]) {
            $statement->bindValue('uuid', Uuid::v4());
            $statement->bindValue('agreement_id', (int) $agreement['id'], PDO::PARAM_INT);
            $statement->bindValue('provider', 'PAYPAL');
            $statement->bindValue('consent_type', $type);
            $statement->bindValue('terms_version', (string) $agreement['terms_version']);
            $statement->bindValue('amount_cents', $amount, PDO::PARAM_INT);
            $statement->bindValue('scheduled_charge_at', $scheduledAt);
            $statement->bindValue('accepted_at', gmdate('Y-m-d H:i:s.u'));
            $statement->bindValue('ip_hash', $ipHash, PDO::PARAM_LOB);
            $statement->bindValue('user_agent', mb_substr($userAgent, 0, 255));
            $statement->execute();
        }
    }

    public function revokeLink(int $agreementId): bool
    {
        $statement = $this->pdo->prepare(
            "UPDATE payment_agreements SET link_revoked_at = :now WHERE id = :id AND link_revoked_at IS NULL " .
            "AND status NOT IN ('RESERVATION_PAID', 'FULLY_PAID') AND NOT EXISTS (" .
            "SELECT 1 FROM provider_resources WHERE agreement_id = :resource_agreement_id AND provider = 'PAYPAL' AND resource_type = 'SUBSCRIPTION')"
        );
        $statement->execute(['id' => $agreementId, 'resource_agreement_id' => $agreementId, 'now' => gmdate('Y-m-d H:i:s.u')]);
        return $statement->rowCount() === 1;
    }

    public function replaceLink(int $agreementId, ?\DateTimeImmutable $expiresAt): string
    {
        $token = PaymentLink::generateToken();
        $statement = $this->pdo->prepare(
            "UPDATE payment_agreements SET public_token_hash = :token_hash, link_expires_at = :expires_at, link_revoked_at = NULL WHERE id = :id " .
            "AND status NOT IN ('RESERVATION_PAID', 'FULLY_PAID') AND NOT EXISTS (" .
            "SELECT 1 FROM provider_resources WHERE agreement_id = :resource_agreement_id AND provider = 'PAYPAL' AND resource_type = 'SUBSCRIPTION')"
        );
        $statement->bindValue('token_hash', PaymentLink::hash($token), PDO::PARAM_LOB);
        $statement->bindValue('expires_at', $expiresAt?->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
        $statement->bindValue('id', $agreementId, PDO::PARAM_INT);
        $statement->bindValue('resource_agreement_id', $agreementId, PDO::PARAM_INT);
        $statement->execute();
        if ($statement->rowCount() !== 1) {
            throw new \DomainException('This payment link cannot be replaced after payment confirmation.');
        }
        return $token;
    }

    private function detailSelect(): string
    {
        return 'SELECT a.id, a.public_uuid, a.monday_item_id, a.source_lead_id, a.source_quote_id, a.source_quote_version, a.recipient_name, a.recipient_email, a.recipient_phone, a.service_name, a.event_at_utc, a.event_location, a.internal_notes, a.currency, a.total_cents, a.reservation_cents, a.balance_cents, ' .
            'a.balance_due_at_utc, a.balance_timezone, a.status, a.provider, a.link_expires_at, a.link_revoked_at, a.link_expired_event_at, a.terms_version, a.reservation_policy_version, a.created_at, ' .
            'pr.external_id AS paypal_subscription_id, pr.status AS paypal_status, pr.start_at_utc AS paypal_start_at_utc ' .
            'FROM payment_agreements a ' .
            "LEFT JOIN provider_resources pr ON pr.agreement_id = a.id AND pr.provider = 'PAYPAL' AND pr.resource_type = 'SUBSCRIPTION'";
    }
}
