<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

final readonly class Request
{
    /** @param array<string, string> $query @param array<string, string> $post @param array<string, string> $cookies @param array<string, string> $headers */
    public function __construct(
        public string $method,
        public string $path,
        public array $query,
        public array $post,
        public array $cookies,
        public string $ipAddress,
        public string $userAgent,
        public bool $https,
        public string $rawBody,
        public array $headers,
    ) {
    }

    public static function fromGlobals(): self
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = parse_url($uri, PHP_URL_PATH);
        $forwarded = mb_strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));

        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (!is_string($value) || !str_starts_with($key, 'HTTP_')) {
                continue;
            }
            $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
        }

        return new self(
            method: mb_strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            path: is_string($path) ? rawurldecode($path) : '/',
            query: array_map(static fn (mixed $value): string => is_string($value) ? $value : '', $_GET),
            post: array_map(static fn (mixed $value): string => is_string($value) ? $value : '', $_POST),
            cookies: array_map(static fn (mixed $value): string => is_string($value) ? $value : '', $_COOKIE),
            ipAddress: (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'),
            userAgent: mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
            https: (($_SERVER['HTTPS'] ?? '') === 'on') || $forwarded === 'https',
            rawBody: (string) file_get_contents('php://input'),
            headers: $headers,
        );
    }
}
