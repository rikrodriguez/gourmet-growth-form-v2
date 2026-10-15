<?php

declare(strict_types=1);

// When this file is used as the PHP built-in server router, let the server
// deliver real public assets instead of routing them through the application.
if (PHP_SAPI === 'cli-server') {
    $path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $asset = is_string($path) ? __DIR__ . $path : null;
    if ($asset !== null && $path !== '/' && is_file($asset)) {
        return false;
    }
}

use Gourmet\Payments\Http\Application;
use Gourmet\Payments\Http\Request;
use Gourmet\Payments\Database\Connection;
use Gourmet\Payments\Database\Migrator;
use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Support\Config;
use Gourmet\Payments\Support\Env;

$root = dirname(__DIR__);
// Hostinger's V1 fallback keeps the application below public_html/app and
// passes the document root explicitly from its tiny public front controller.
// Local and conventional deployments keep using the application root itself.
$siteRoot = getenv('GOURMET_PAYMENTS_SITE_ROOT') ?: $root;
$hostingerConfig = dirname($root) . '/config/production.env';
if ($siteRoot === $root && is_file($hostingerConfig)) {
    $siteRoot = dirname($root);
}

$envPath = $siteRoot === $root
    ? $root . '/.env'
    : (is_file($hostingerConfig) ? $hostingerConfig : $siteRoot . '/.private/production.env');
require $root . '/bootstrap/autoload.php';

$env = Env::load($envPath);
$config = Config::fromEnv($root, $env);
$logger = new JsonLogger($siteRoot . '/storage/logs/application.jsonl');

ini_set('display_errors', '0');
error_reporting(E_ALL);

// This small private ledger is deployed without a shell dependency.  Apply only
// the versioned SQLite migrations under an exclusive lock before serving a
// request, so a newly deployed instance cannot run against a partial schema.
try {
    (new Migrator(Connection::open($config), $root . '/migrations/sqlite'))->migrate();
} catch (\Throwable $exception) {
    $logger->log('error', 'sqlite.bootstrap_failed', ['exception_class' => $exception::class]);
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"status":"degraded"}';
    exit;
}

(new Application($config, $logger))->handle(Request::fromGlobals())->send();
