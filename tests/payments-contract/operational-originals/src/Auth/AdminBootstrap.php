<?php

declare(strict_types=1);

namespace Gourmet\Payments\Auth;

use Gourmet\Payments\Security\Secrets;
use Gourmet\Payments\Support\Uuid;
use PDO;

/**
 * One-time first-administrator bootstrap backed only by token hashes.
 */
final readonly class AdminBootstrap
{
    public function __construct(private PDO $pdo)
    {
    }

    public function isAvailable(string $publicId): bool
    {
        if ((int) $this->pdo->query('SELECT COUNT(*) FROM admin_users')->fetchColumn() !== 0) {
            return false;
        }

        $statement = $this->pdo->prepare(
            'SELECT 1 FROM admin_bootstrap_tokens WHERE public_id = :public_id AND consumed_at IS NULL AND expires_at > :now LIMIT 1'
        );
        $statement->execute(['public_id' => $publicId, 'now' => $this->now()]);

        return $statement->fetchColumn() !== false;
    }

    public function createFirstAdmin(string $publicId, string $rawToken, string $email, string $displayName, string $password): bool
    {
        $email = mb_strtolower(trim($email));
        $displayName = trim($displayName);
        if (!preg_match('/\A[a-f0-9]{32}\z/i', $publicId) || !filter_var($email, FILTER_VALIDATE_EMAIL) || $displayName === '' || mb_strlen($displayName) > 120 || strlen($password) < 14) {
            return false;
        }

        $this->pdo->exec('BEGIN IMMEDIATE');
        $transactionOpen = true;
        try {
            if ((int) $this->pdo->query('SELECT COUNT(*) FROM admin_users')->fetchColumn() !== 0) {
                $this->pdo->exec('ROLLBACK');
                return false;
            }

            $lookup = $this->pdo->prepare(
                'SELECT token_hash FROM admin_bootstrap_tokens WHERE public_id = :public_id AND consumed_at IS NULL AND expires_at > :now LIMIT 1'
            );
            $lookup->execute(['public_id' => $publicId, 'now' => $this->now()]);
            $storedHash = $lookup->fetchColumn();
            if (!is_string($storedHash) || !hash_equals($storedHash, Secrets::hashToken($rawToken))) {
                $this->pdo->exec('ROLLBACK');
                return false;
            }

            $consume = $this->pdo->prepare(
                'UPDATE admin_bootstrap_tokens SET consumed_at = :now WHERE public_id = :public_id AND consumed_at IS NULL'
            );
            $consume->execute(['public_id' => $publicId, 'now' => $this->now()]);
            if ($consume->rowCount() !== 1) {
                $this->pdo->exec('ROLLBACK');
                return false;
            }

            $create = $this->pdo->prepare(
                'INSERT INTO admin_users (public_uuid, email, display_name, password_hash) VALUES (:uuid, :email, :name, :password_hash)'
            );
            $create->execute([
                'uuid' => Uuid::v4(),
                'email' => $email,
                'name' => $displayName,
                'password_hash' => Secrets::passwordHash($password),
            ]);

            $this->pdo->exec('COMMIT');
            $transactionOpen = false;
            return true;
        } catch (\Throwable) {
            if ($transactionOpen) {
                $this->pdo->exec('ROLLBACK');
            }
            return false;
        }
    }

    private function now(): string
    {
        return gmdate('Y-m-d H:i:s.u');
    }
}
