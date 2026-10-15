<?php

declare(strict_types=1);

namespace Gourmet\Payments\Logging;

final readonly class JsonLogger
{
    public function __construct(private string $path)
    {
    }

    /** @param array<string, mixed> $context */
    public function log(string $level, string $event, array $context = []): void
    {
        $record = [
            'timestamp' => gmdate('c'),
            'level' => $level,
            'event' => $event,
            'context' => Redactor::context($context),
        ];
        $line = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($line === false) {
            return;
        }

        $directory = dirname($this->path);
        if (!is_dir($directory)) {
            mkdir($directory, 0750, true);
        }
        file_put_contents($this->path, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
    }
}
