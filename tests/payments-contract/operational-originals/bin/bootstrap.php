<?php

declare(strict_types=1);

use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Support\Config;
use Gourmet\Payments\Support\Env;

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$root = dirname(__DIR__);
require $root . '/bootstrap/autoload.php';
$config = Config::fromEnv($root, Env::load($root . '/.env'));
$logger = new JsonLogger($root . '/storage/logs/cli.jsonl');

return [$root, $config, $logger];
