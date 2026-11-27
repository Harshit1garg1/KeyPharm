<?php
$base = [
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'abiote_keypharm',
        'user' => 'abiote_harshit',
        'pass' => '',
        'charset' => 'utf8mb4',
    ],
    'auth' => [
        'username' => 'testing',
        'password' => 'testing123',
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

foreach ([
    ['KEYPHARM_DB_HOST', 'db', 'host'],
    ['KEYPHARM_DB_NAME', 'db', 'name'],
    ['KEYPHARM_DB_USER', 'db', 'user'],
    ['KEYPHARM_DB_PASS', 'db', 'pass'],
    ['KEYPHARM_DEMO_USER', 'auth', 'username'],
    ['KEYPHARM_DEMO_PASS', 'auth', 'password'],
] as [$envKey, $sec, $field]) {
    $val = getenv($envKey);
    if ($val !== false) {
        $base[$sec][$field] = $val;
    }
}
if (($portEnv = getenv('KEYPHARM_DB_PORT')) !== false && $portEnv !== '') {
    $base['db']['port'] = (int)$portEnv;
}

return $base;
