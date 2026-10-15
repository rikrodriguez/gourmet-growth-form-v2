<?php

declare(strict_types=1);

$root = dirname(__DIR__);
$composer = $root . '/vendor/autoload.php';

if (is_file($composer)) {
    require $composer;
    return;
}

spl_autoload_register(static function (string $class) use ($root): void {
    $prefix = 'Gourmet\\Payments\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }

    $relative = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = $root . '/src/' . $relative . '.php';
    if (is_file($file)) {
        require $file;
    }
});
