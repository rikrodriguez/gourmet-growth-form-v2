<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use PDO;
use PDOException;

final readonly class IdempotencyGuard
{
    public function __construct(private PDO $pdo)
    {
    }

    public function begin(string $scope, string $key, string $requestHash): void
    {
        try {
            $statement = $this->pdo->prepare(
                'INSERT INTO idempotency_keys (scope, idempotency_key, request_hash, locked_until, expires_at) ' .
                'VALUES (:scope, :key, :hash, :locked_until, :expires_at)'
            );
            $statement->bindValue('scope', $scope);
            $statement->bindValue('key', $key);
            $statement->bindValue('hash', $requestHash, PDO::PARAM_LOB);
            $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
            $statement->bindValue('locked_until', $now->modify('+2 minutes')->format('Y-m-d H:i:s.u'));
            $statement->bindValue('expires_at', $now->modify('+30 days')->format('Y-m-d H:i:s.u'));
            $statement->execute();
        } catch (PDOException $exception) {
            if ($exception->getCode() !== '23000') {
                throw $exception;
            }
            $statement = $this->pdo->prepare(
                'SELECT request_hash, completed_at, locked_until FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key'
            );
            $statement->execute(['scope' => $scope, 'key' => $key]);
            $row = $statement->fetch();
            if (!is_array($row) || !hash_equals((string) $row['request_hash'], $requestHash)) {
                throw new \DomainException('Idempotency key was reused with a different request.');
            }
            $state = $row['completed_at'] !== null ? 'completed' : ($row['locked_until'] === null ? 'ambiguous' : 'in progress');
            throw new \RuntimeException('Provider operation already exists (' . $state . '); reconcile before retry.');
        }
    }

    /**
     * Returns the encrypted, completed response for a safe replay. The caller
     * owns decryption so this ledger never needs the application encryption key.
     *
     * @return array{status:int,ciphertext:string,nonce:string,tag:string}|null
     */
    public function replay(string $scope, string $key, string $requestHash): ?array
    {
        $statement = $this->pdo->prepare(
            'SELECT request_hash, response_status, response_ciphertext, response_nonce, response_tag, completed_at, locked_until ' .
            'FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key LIMIT 1'
        );
        $statement->execute(['scope' => $scope, 'key' => $key]);
        $row = $statement->fetch();
        if (!is_array($row)) {
            return null;
        }
        if (!hash_equals((string) $row['request_hash'], $requestHash)) {
            throw new \DomainException('Idempotency key was reused with a different request.');
        }
        if ($row['completed_at'] === null) {
            $state = $row['locked_until'] === null ? 'ambiguous' : 'in progress';
            throw new \RuntimeException('Provider operation already exists (' . $state . '); reconcile before retry.');
        }
        if (!is_int($row['response_status']) && !ctype_digit((string) $row['response_status'])) {
            throw new \RuntimeException('Completed idempotency response is invalid.');
        }
        foreach (['response_ciphertext', 'response_nonce', 'response_tag'] as $column) {
            if (!is_string($row[$column]) || $row[$column] === '') {
                throw new \RuntimeException('Completed idempotency response cannot be replayed safely.');
            }
        }

        return [
            'status' => (int) $row['response_status'],
            'ciphertext' => $row['response_ciphertext'],
            'nonce' => $row['response_nonce'],
            'tag' => $row['response_tag'],
        ];
    }

    public function complete(string $scope, string $key, int $responseStatus, string $responseHash): void
    {
        $statement = $this->pdo->prepare(
            'UPDATE idempotency_keys SET response_status = :status, response_hash = :response_hash, completed_at = :completed_at, locked_until = NULL ' .
            'WHERE scope = :scope AND idempotency_key = :key'
        );
        $statement->bindValue('status', $responseStatus, PDO::PARAM_INT);
        $statement->bindValue('response_hash', $responseHash, PDO::PARAM_LOB);
        $statement->bindValue('scope', $scope);
        $statement->bindValue('key', $key);
        $statement->bindValue('completed_at', gmdate('Y-m-d H:i:s.u'));
        $statement->execute();
    }

    public function completeEncrypted(
        string $scope,
        string $key,
        int $responseStatus,
        string $responseHash,
        string $ciphertext,
        string $nonce,
        string $tag,
    ): void {
        $statement = $this->pdo->prepare(
            'UPDATE idempotency_keys SET response_status = :status, response_hash = :response_hash, ' .
            'response_ciphertext = :ciphertext, response_nonce = :nonce, response_tag = :tag, ' .
            'completed_at = :completed_at, locked_until = NULL WHERE scope = :scope AND idempotency_key = :key'
        );
        $statement->bindValue('status', $responseStatus, PDO::PARAM_INT);
        $statement->bindValue('response_hash', $responseHash, PDO::PARAM_LOB);
        $statement->bindValue('ciphertext', $ciphertext, PDO::PARAM_LOB);
        $statement->bindValue('nonce', $nonce, PDO::PARAM_LOB);
        $statement->bindValue('tag', $tag, PDO::PARAM_LOB);
        $statement->bindValue('scope', $scope);
        $statement->bindValue('key', $key);
        $statement->bindValue('completed_at', gmdate('Y-m-d H:i:s.u'));
        $statement->execute();
        if ($statement->rowCount() !== 1) {
            throw new \RuntimeException('Idempotency response could not be finalized.');
        }
    }

    public function markAmbiguous(string $scope, string $key): void
    {
        $statement = $this->pdo->prepare(
            'UPDATE idempotency_keys SET locked_until = NULL WHERE scope = :scope AND idempotency_key = :key AND completed_at IS NULL'
        );
        $statement->execute(['scope' => $scope, 'key' => $key]);
    }

    public function releaseDefinitiveFailure(string $scope, string $key): void
    {
        $statement = $this->pdo->prepare(
            'DELETE FROM idempotency_keys WHERE scope = :scope AND idempotency_key = :key AND completed_at IS NULL'
        );
        $statement->execute(['scope' => $scope, 'key' => $key]);
    }
}
