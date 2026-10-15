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
// The materializer has already verified these two original Dropbox assets.
// Keep a literal allowlist: this fixture never exposes an arbitrary runtime,
// configuration, source, ledger or filesystem path through the HTTP server.
$assetPath = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
$assets = ['/assets/app.css' => ['app.css', 'text/css; charset=utf-8'],
    '/assets/app.js' => ['app.js', 'text/javascript; charset=utf-8']];
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && is_string($assetPath) && isset($assets[$assetPath])) {
    [$name, $contentType] = $assets[$assetPath];
    $file = $root . '/public/assets/' . $name;
    if (!is_file($file)) { http_response_code(404); return; }
    header('Content-Type: ' . $contentType);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    readfile($file);
    return;
}
require $root . '/bootstrap/autoload.php';
require __DIR__ . '/operational-config.php';
$config = operationalFixtureConfigV2($root, $directory);
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
