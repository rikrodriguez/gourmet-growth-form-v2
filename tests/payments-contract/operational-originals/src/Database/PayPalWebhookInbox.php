<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Payments\VerifiedWebhook;
use PDO;
use PDOException;

final readonly class PayPalWebhookInbox
{
    public function __construct(private PDO $pdo)
    {
    }

    public function accept(VerifiedWebhook $event): bool
    {
        try {
            $statement = $this->pdo->prepare(
                "INSERT INTO provider_webhook_events (provider, provider_event_id, event_type, payload_hash) " .
                "VALUES ('PAYPAL', :event_id, :event_type, :payload_hash)"
            );
            $statement->bindValue('event_id', $event->providerEventId);
            $statement->bindValue('event_type', $event->eventType);
            $binaryHash = ctype_xdigit($event->payloadHash) && strlen($event->payloadHash) === 64
                ? hex2bin($event->payloadHash)
                : false;
            if ($binaryHash === false) {
                throw new \DomainException('Webhook payload hash must be SHA-256 hexadecimal.');
            }
            $statement->bindValue('payload_hash', $binaryHash, PDO::PARAM_LOB);
            $statement->execute();

            return true;
        } catch (PDOException $exception) {
            if ($exception->getCode() === '23000' || str_contains($exception->getMessage(), 'UNIQUE constraint failed')) {
                return false;
            }
            throw $exception;
        }
    }
}
