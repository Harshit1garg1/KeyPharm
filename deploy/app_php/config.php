<?php
$base = [
    'db' => [
        'host' => getenv('KEYPHARM_DB_HOST') ?: 'localhost',
        'port' => (int)(getenv('KEYPHARM_DB_PORT') ?: 3306),
        'name' => getenv('KEYPHARM_DB_NAME') ?: 'abiote_keypharm',
        'user' => getenv('KEYPHARM_DB_USER') ?: 'abiote_harshit',
        'pass' => getenv('KEYPHARM_DB_PASS') ?: '',
        'charset' => 'utf8mb4',
    ],
    'auth' => [
        'username' => getenv('KEYPHARM_DEMO_USER') ?: 'testing',
        'password' => getenv('KEYPHARM_DEMO_PASS') ?: 'testing123',
    ],
    'assets' => [
        'live_sample_csv' => __DIR__ . '/../../app/src/main/assets/private-live-sample.csv',
    ],
];

$localPath = __DIR__ . '/config.local.php';
if (is_file($localPath)) {
    $local = require $localPath;
    if (is_array($local)) {
        $base = array_replace_recursive($base, $local);
    }
}

return $base;
