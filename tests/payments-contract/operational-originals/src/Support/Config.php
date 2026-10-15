<?php

declare(strict_types=1);

namespace Gourmet\Payments\Support;

final readonly class Config
{
    public function __construct(
        public string $root,
        public string $environment,
        public string $appUrl,
        public string $appKey,
        public string $sqlitePath,
        public int $sqliteBusyTimeoutMs,
        public int $sessionTtl,
        public int $loginMaxAttempts,
        public int $loginWindowSeconds,
    ) {
    }

    public static function fromEnv(string $root, Env $env): self
    {
        return new self(
            root: $root,
            environment: $env->get('APP_ENV', 'staging') ?? 'staging',
            appUrl: rtrim($env->get('APP_URL', 'http://localhost:8080') ?? 'http://localhost:8080', '/'),
            appKey: $env->get('APP_KEY', '') ?? '',
            sqlitePath: $env->get('PAYMENTS_SQLITE_PATH', $root . '/storage/gourmet-payments.sqlite') ?? ($root . '/storage/gourmet-payments.sqlite'),
            sqliteBusyTimeoutMs: max(1000, $env->int('PAYMENTS_SQLITE_BUSY_TIMEOUT_MS', 5000)),
            sessionTtl: $env->int('SESSION_TTL_SECONDS', 28800),
            loginMaxAttempts: $env->int('LOGIN_MAX_ATTEMPTS', 5),
            loginWindowSeconds: $env->int('LOGIN_WINDOW_SECONDS', 900),
        );
    }

    public function hasLedgerConfiguration(): bool
    {
        if ($this->sqlitePath === '' || str_starts_with($this->sqlitePath, $this->root . '/public/')) {
            return false;
        }

        if (!$this->isProduction()) {
            return true;
        }

        return str_starts_with($this->sqlitePath, $this->root . '/storage/')
            || str_starts_with($this->sqlitePath, dirname($this->root) . '/storage/')
            || str_starts_with($this->sqlitePath, dirname($this->root) . '/.private/');
    }

    public function hasValidAppKey(): bool
    {
        return preg_match('/\A[a-f0-9]{64}\z/i', $this->appKey) === 1;
    }

    public function isProduction(): bool
    {
        return $this->environment === 'production';
    }
}
