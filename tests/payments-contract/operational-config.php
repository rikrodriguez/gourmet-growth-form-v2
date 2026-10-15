<?php

declare(strict_types=1);

use Gourmet\Payments\Support\Config;

// Fixture construction only. The original Config/Connection select and open
// the real adapter; this file never constructs or injects a substitute PDO.
function operationalFixtureConfigV2(string $root, string $directory, bool $production = false): Config
{
    $bindingFile = $directory . '/database-binding.json';
    $binding = is_file($bindingFile) ? json_decode((string) file_get_contents($bindingFile), true, 8, JSON_THROW_ON_ERROR) : null;
    if ($binding !== null && (!is_array($binding) || !in_array($binding['engine'] ?? null, ['mariadb', 'mysql'], true)
        || ($binding['host'] ?? null) !== '127.0.0.1' || !is_int($binding['port'] ?? null)
        || $binding['port'] < 1 || $binding['port'] > 65535 || ($binding['user'] ?? null) !== 'root'
        || ($binding['password'] ?? null) !== '' || !is_string($binding['database'] ?? null)
        || preg_match('/^[A-Za-z0-9_]+$/D', $binding['database']) !== 1)) {
        throw new RuntimeException('Invalid explicit ephemeral database binding.');
    }
    return new Config(root: $root, environment: $production ? 'production' : 'test', appUrl: 'https://synthetic.invalid',
        appKey: str_repeat('ab', 32), sqlitePath: $directory . '/storage/ledger.sqlite', sqliteBusyTimeoutMs: 1000,
        sessionTtl: 3600, loginMaxAttempts: 5, loginWindowSeconds: 900,
        ledgerDriver: $binding === null ? 'sqlite' : 'mysql', mysqlHost: $binding['host'] ?? '',
        mysqlPort: $binding['port'] ?? 3306, mysqlDatabase: $binding['database'] ?? '',
        mysqlUser: $binding['user'] ?? '', mysqlPassword: $binding['password'] ?? null);
}
