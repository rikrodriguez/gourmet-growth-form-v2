<?php

declare(strict_types=1);

namespace Gourmet\Payments\Database;

use PDO;

final readonly class Migrator
{
    public function __construct(private PDO $pdo, private string $directory)
    {
    }

    /** @return list<string> */
    public function migrate(): array
    {
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
        $lockPath = dirname($this->directory) . '/.sqlite-migrations.lock';
        $lock = fopen($lockPath, 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new \RuntimeException('Unable to acquire the migration lock.');
        }

        try {
            $applied = $this->pdo->query('SELECT version FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN);
            $known = array_fill_keys(array_map('strval', $applied), true);
            $files = glob($this->directory . '/*.sql') ?: [];
            sort($files, SORT_STRING);
            $ran = [];

            foreach ($files as $file) {
                $version = basename($file);
                if (isset($known[$version])) {
                    continue;
                }
                $sql = file_get_contents($file);
                if ($sql === false) {
                    throw new \RuntimeException('Unable to read migration: ' . $version);
                }

                if (str_contains($sql, '-- migrate:non-transactional')) {
                    $this->runNonTransactionalMigration($sql, $version);
                } else {
                    $this->pdo->beginTransaction();
                    try {
                        $this->pdo->exec($sql);
                        $this->recordMigration($version);
                        $this->pdo->commit();
                    } catch (\Throwable $exception) {
                        if ($this->pdo->inTransaction()) {
                            $this->pdo->rollBack();
                        }
                        throw $exception;
                    }
                }
                $ran[] = $version;
            }

            return $ran;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function recordMigration(string $version): void
    {
        $statement = $this->pdo->prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (:version, :applied_at)');
        $statement->execute(['version' => $version, 'applied_at' => gmdate('Y-m-d H:i:s.u')]);
    }

    private function runNonTransactionalMigration(string $sql, string $version): void
    {
        try {
            $this->pdo->exec('PRAGMA foreign_keys = OFF');
            $this->pdo->exec($sql);
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            $violations = $this->pdo->query('PRAGMA foreign_key_check')->fetchAll();
            if ($violations !== []) {
                throw new \RuntimeException('SQLite foreign-key validation failed after migration.');
            }
            $this->recordMigration($version);
        } finally {
            $this->pdo->exec('PRAGMA foreign_keys = ON');
        }
    }
}
