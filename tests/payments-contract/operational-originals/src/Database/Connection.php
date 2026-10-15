<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use Gourmet\Payments\Support\Config;
use PDO;

final class Connection
{
    public static function open(Config $config): PDO
    {
        if (!$config->hasLedgerConfiguration()) {
            throw new \RuntimeException('SQLite ledger configuration is incomplete.');
        }
        if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
            throw new \RuntimeException('PDO SQLite is unavailable.');
        }
        $directory = dirname($config->sqlitePath);
        if (!is_dir($directory) || !is_writable($directory)) {
            throw new \RuntimeException('SQLite ledger directory is unavailable.');
        }

        $pdo = new PDO('sqlite:' . $config->sqlitePath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = ' . (int) $config->sqliteBusyTimeoutMs);
        $pdo->exec('PRAGMA synchronous = NORMAL');

        return $pdo;
    }
}
