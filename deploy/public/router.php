<?php
// Local test router for `php -S 127.0.0.1:18791 deploy/public/router.php`
// Emulates subfolder hosting when KEYPHARM_TEST_BASE=/keypharm is set.
$base = getenv('KEYPHARM_TEST_BASE') ?: '';
if ($base !== '') {
    $uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    if (str_starts_with($uriPath, $base)) {
        $_SERVER['SCRIPT_NAME'] = $base . '/index.php';
    }
}
require __DIR__ . '/index.php';
