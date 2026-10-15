<?php

declare(strict_types=1);

use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;

[$root, $config, $logger] = require __DIR__ . '/bootstrap.php';

try {
    $ran = (new Migrator(Connection::open($config), $root . '/migrations/sqlite'))->migrate();
    $logger->log('info', 'database.migrations_completed', ['count' => count($ran)]);
    echo $ran === [] ? "Database is up to date.\n" : "Applied migrations:\n- " . implode("\n- ", $ran) . "\n";
    exit(0);
} catch (Throwable $exception) {
    $logger->log('error', 'database.migrations_failed', ['exception_class' => $exception::class]);
    fwrite(STDERR, "Migration failed. Check private logs.\n");
    exit(1);
}
