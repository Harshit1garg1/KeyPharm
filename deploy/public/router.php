<?php
// Local test router for `php -S 127.0.0.1:8791 deploy/public/router.php`
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$staticMimes = [
    'css' => 'text/css; charset=utf-8',
    'mjs' => 'text/javascript; charset=utf-8',
    'png' => 'image/png',
    'svg' => 'image/svg+xml',
    'woff2' => 'font/woff2',
];
if ($path !== '/' && $path !== '/dashboard.css' && $path !== '/dashboard-theme.mjs' && $path !== '/InterVariable.woff2') {
    $target = __DIR__ . $path;
    $ext = pathinfo($path, PATHINFO_EXTENSION);
    if (isset($staticMimes[$ext]) && is_file($target)) {
        // Still pass through index.php so auth guard & Cache-Control headers match production.
    }
}
require __DIR__ . '/index.php';
