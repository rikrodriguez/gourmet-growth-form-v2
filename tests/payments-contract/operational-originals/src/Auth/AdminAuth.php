<?php

declare(strict_types=1);

namespace Gourmet\Payments\Auth;

use Gourmet\Payments\Security\Secrets;
use Gourmet\Payments\Support\Uuid;
use PDO;

final readonly class AdminAuth
{
    public function __construct(
        private PDO $pdo,
        private string $appKey,
        private int $ttlSeconds,
        private int $maxAttempts,
        private int $windowSeconds,
    ) {
    }

    /** @return array{raw_token:string,csrf_token:string,expires_at:string}|null */
    public function login(string $email, string $password, string $ipAddress, string $userAgent): ?array
    {
        $email = mb_strtolower(trim($email));
        $ipHash = Secrets::privacyHash($ipAddress, $this->appKey);
        if ($this->isRateLimited($email, $ipHash)) {
            return null;
        }

        $statement = $this->pdo->prepare('SELECT id, password_hash, status FROM admin_users WHERE email = :email LIMIT 1');
        $statement->execute(['email' => $email]);
        $user = $statement->fetch();
        if (!is_array($user) || $user['status'] !== 'ACTIVE' || !Secrets::passwordVerify($password, (string) $user['password_hash'])) {
            $this->recordFailure($email, $ipHash);
            return null;
        }

        $this->clearFailures($email, $ipHash);
        $session = AdminSession::issue(new \DateTimeImmutable('now', new \DateTimeZone('UTC')), $this->ttlSeconds);
        $this->pdo->prepare('DELETE FROM admin_sessions WHERE admin_user_id = :user_id AND expires_at <= :now')
            ->execute(['user_id' => $user['id'], 'now' => gmdate('Y-m-d H:i:s.u')]);

        $insert = $this->pdo->prepare(
            'INSERT INTO admin_sessions (public_uuid, admin_user_id, token_hash, csrf_token_hash, user_agent_summary, expires_at) ' .
            'VALUES (:uuid, :user_id, :token_hash, :csrf_hash, :user_agent, :expires_at)'
        );
        $insert->bindValue('uuid', Uuid::v4());
        $insert->bindValue('user_id', $user['id'], PDO::PARAM_INT);
        $insert->bindValue('token_hash', $session['token_hash'], PDO::PARAM_LOB);
        $insert->bindValue('csrf_hash', $session['csrf_hash'], PDO::PARAM_LOB);
        $insert->bindValue('user_agent', mb_substr($userAgent, 0, 255));
        $insert->bindValue('expires_at', $session['expires_at']);
        $insert->execute();

        return [
            'raw_token' => $session['raw_token'],
            'csrf_token' => $session['csrf_token'],
            'expires_at' => $session['expires_at'],
        ];
    }

    /** @return array<string, mixed>|null */
    public function userForToken(string $rawToken): ?array
    {
        if ($rawToken === '') {
            return null;
        }
        $statement = $this->pdo->prepare(
            'SELECT u.id, u.email, u.display_name, s.expires_at FROM admin_sessions s ' .
            'JOIN admin_users u ON u.id = s.admin_user_id ' .
            'WHERE s.token_hash = :token_hash AND s.revoked_at IS NULL AND s.expires_at > :now AND u.status = \'ACTIVE\' LIMIT 1'
        );
        $statement->bindValue('token_hash', Secrets::hashToken($rawToken), PDO::PARAM_LOB);
        $statement->bindValue('now', gmdate('Y-m-d H:i:s.u'));
        $statement->execute();
        $user = $statement->fetch();
        return is_array($user) ? $user : null;
    }

    public function validateCsrf(string $rawSession, string $csrfToken): bool
    {
        if ($rawSession === '' || $csrfToken === '') {
            return false;
        }
        $statement = $this->pdo->prepare(
            'SELECT csrf_token_hash FROM admin_sessions WHERE token_hash = :token_hash AND revoked_at IS NULL AND expires_at > :now LIMIT 1'
        );
        $statement->bindValue('token_hash', Secrets::hashToken($rawSession), PDO::PARAM_LOB);
        $statement->bindValue('now', gmdate('Y-m-d H:i:s.u'));
        $statement->execute();
        $stored = $statement->fetchColumn();
        return is_string($stored) && hash_equals($stored, Secrets::hashToken($csrfToken));
    }

    public function logout(string $rawToken): void
    {
        if ($rawToken === '') {
            return;
        }
        $statement = $this->pdo->prepare('UPDATE admin_sessions SET revoked_at = :now WHERE token_hash = :token_hash');
        $statement->bindValue('token_hash', Secrets::hashToken($rawToken), PDO::PARAM_LOB);
        $statement->bindValue('now', gmdate('Y-m-d H:i:s.u'));
        $statement->execute();
    }

    private function isRateLimited(string $email, string $ipHash): bool
    {
        $cutoff = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->modify('-' . $this->windowSeconds . ' seconds')
            ->format('Y-m-d H:i:s.u');
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM admin_login_attempts WHERE email = :email AND ip_hash = :ip_hash ' .
            'AND attempted_at >= :cutoff'
        );
        $statement->bindValue('email', $email);
        $statement->bindValue('ip_hash', $ipHash, PDO::PARAM_LOB);
        $statement->bindValue('cutoff', $cutoff);
        $statement->execute();
        return (int) $statement->fetchColumn() >= $this->maxAttempts;
    }

    private function recordFailure(string $email, string $ipHash): void
    {
        $statement = $this->pdo->prepare('INSERT INTO admin_login_attempts (email, ip_hash) VALUES (:email, :ip_hash)');
        $statement->bindValue('email', $email);
        $statement->bindValue('ip_hash', $ipHash, PDO::PARAM_LOB);
        $statement->execute();
    }

    private function clearFailures(string $email, string $ipHash): void
    {
        $statement = $this->pdo->prepare('DELETE FROM admin_login_attempts WHERE email = :email AND ip_hash = :ip_hash');
        $statement->bindValue('email', $email);
        $statement->bindValue('ip_hash', $ipHash, PDO::PARAM_LOB);
        $statement->execute();
    }
}
