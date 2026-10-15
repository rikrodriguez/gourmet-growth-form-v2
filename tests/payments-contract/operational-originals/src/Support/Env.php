<?php

declare(strict_types=1);

namespace Gourmet\Payments\Support;

final class Env
{
    /** @var array<string, string> */
    private array $values = [];

    public static function load(string $path): self
    {
        $env = new self();
        if (!is_file($path)) {
            return $env;
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '' || str_starts_with($trimmed, '#') || !str_contains($trimmed, '=')) {
                continue;
            }

            [$key, $value] = explode('=', $trimmed, 2);
            $key = trim($key);
            if (!preg_match('/^[A-Z][A-Z0-9_]*$/', $key)) {
                continue;
            }

            $value = trim($value);
            if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) {
                $value = substr($value, 1, -1);
            }
            $env->values[$key] = $value;
        }

        return $env;
    }

    public function get(string $key, ?string $default = null): ?string
    {
        $system = getenv($key);
        if ($system !== false) {
            return $system;
        }

        return $this->values[$key] ?? $default;
    }

    public function require(string $key): string
    {
        $value = $this->get($key);
        if ($value === null || $value === '') {
            throw new \RuntimeException(sprintf('Required configuration is missing: %s', $key));
        }

        return $value;
    }

    public function int(string $key, int $default): int
    {
        $value = $this->get($key);
        return $value === null || $value === '' ? $default : (int) $value;
    }
}
