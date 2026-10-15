<?php

declare(strict_types=1);

namespace Gourmet\Payments\Http;

final class Html
{
    public static function escape(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    public static function page(string $title, string $content): string
    {
        $safeTitle = self::escape($title);
        return '<!doctype html><html lang="en"><head><meta charset="utf-8">' .
            '<meta name="viewport" content="width=device-width, initial-scale=1">' .
            '<meta name="robots" content="noindex,nofollow">' .
            '<title>' . $safeTitle . '</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js" defer></script></head>' .
            '<body><main class="shell"><div class="brand">Gourmet Corporation</div>' . $content . '</main></body></html>';
    }
}
