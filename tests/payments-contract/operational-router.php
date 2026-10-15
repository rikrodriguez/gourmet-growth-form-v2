<?php

declare(strict_types=1);

// Test composition only: use the original Application and real HTTP request
// adapter with an injected original transport interface. This is not a copy of
// the original public/index.php and does not claim to test that bootstrap.
use Gourmet\Payments\Http\Application;
use Gourmet\Payments\Http\Request;
use Gourmet\Payments\Logging\JsonLogger;
use Gourmet\Payments\Payments\PayPal\PayPalHttpResponse;
use Gourmet\Payments\Payments\PayPal\PayPalHttpTransport;
use Gourmet\Payments\Support\Config;

$root = getenv('GOURMET_SYNTHETIC_RUNTIME_ROOT') ?: '';
$directory = getenv('GOURMET_SYNTHETIC_FIXTURE_DIRECTORY') ?: '';
if (!is_file($directory . '/synthetic-fixture-only') || !is_file($root . '/bootstrap/autoload.php')) {
    throw new RuntimeException('Disposable synthetic HTTP fixture required.');
}
require $root . '/bootstrap/autoload.php';
$config = new Config($root, 'test', 'https://synthetic.invalid', str_repeat('ab', 32),
    $directory . '/storage/ledger.sqlite', 1000, 3600, 5, 900);
$transport = new class($directory) implements PayPalHttpTransport {
    public function __construct(private string $directory) {}
    public function send(string $method, string $url, array $headers, ?string $body, int $timeoutSeconds): PayPalHttpResponse
    {
        file_put_contents($this->directory . '/provider-attempts.log', "blocked\n", FILE_APPEND | LOCK_EX);
        throw new RuntimeException('Synthetic draft attempted provider transport.');
    }
};
(new Application($config, new JsonLogger($directory . '/logs.jsonl'), $transport))
    ->handle(Request::fromGlobals())->send();
