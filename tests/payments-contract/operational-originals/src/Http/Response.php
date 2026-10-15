<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

final class Response
{
    /** @var array<string, string> */
    private array $headers;
    /** @var list<array{name:string,value:string,expires:int,path:string,secure:bool,httpOnly:bool,sameSite:string}> */
    private array $cookies = [];

    /** @param array<string, string> $headers */
    public function __construct(
        private readonly string $body,
        private readonly int $status = 200,
        array $headers = [],
    ) {
        $this->headers = $headers;
    }

    /** @param array<string, mixed> $payload */
    public static function json(array $payload, int $status = 200): self
    {
        return new self(
            json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
            $status,
            ['Content-Type' => 'application/json; charset=utf-8'],
        );
    }

    public static function html(string $html, int $status = 200): self
    {
        return new self($html, $status, ['Content-Type' => 'text/html; charset=utf-8']);
    }

    public static function redirect(string $location): self
    {
        return new self('', 303, ['Location' => $location]);
    }

    public function withHeaders(array $headers): self
    {
        $clone = clone $this;
        $clone->headers = array_merge($clone->headers, $headers);
        return $clone;
    }

    public function withCookie(string $name, string $value, int $expires, bool $httpOnly): self
    {
        $clone = clone $this;
        $clone->cookies[] = [
            'name' => $name,
            'value' => $value,
            'expires' => $expires,
            'path' => '/',
            'secure' => true,
            'httpOnly' => $httpOnly,
            'sameSite' => 'Strict',
        ];
        return $clone;
    }

    public function send(): never
    {
        http_response_code($this->status);
        foreach ($this->headers as $name => $value) {
            header($name . ': ' . $value);
        }
        foreach ($this->cookies as $cookie) {
            setcookie($cookie['name'], $cookie['value'], [
                'expires' => $cookie['expires'],
                'path' => $cookie['path'],
                'secure' => $cookie['secure'],
                'httponly' => $cookie['httpOnly'],
                'samesite' => $cookie['sameSite'],
            ]);
        }
        echo $this->body;
        exit;
    }
}
