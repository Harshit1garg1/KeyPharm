<?php

declare(strict_types=1);

$appDir = is_dir(__DIR__ . '/app_php') ? __DIR__ . '/app_php' : dirname(__DIR__) . '/app_php';
require_once $appDir . '/db.php';
require_once $appDir . '/model.php';
require_once $appDir . '/auth.php';
require_once $appDir . '/stock.php';
require_once $appDir . '/workspace.php';

$config = require $appDir . '/config.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'");

$sendJson = static function (int $status, mixed $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo jsonEncodeStrict($body);
    exit;
};

$sendCsv = static function (string $filename, string $content): never {
    http_response_code(200);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    echo $content;
    exit;
};

$basePath = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? ''))), '/');
if ($basePath === '.') {
    $basePath = '';
}
$cookiePath = $basePath . '/';
$signInUrl = $basePath . '/dashboard/sign-in';

$dashboardSignIn = static function (string $message = '') use ($basePath, $signInUrl): never {
    http_response_code($message !== '' ? 401 : 200);
    header('Content-Type: text/html; charset=utf-8');
    $alert = $message !== '' ? '<p role="alert">' . htmlspecialchars($message, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p>' : '';
    echo '<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>Sign in | KeyPharm</title><link rel="stylesheet" href="' . $basePath . '/dashboard.css"><script type="module" src="' . $basePath . '/dashboard-theme.mjs"></script><main class="dashboard-sign-in">'
        . '<header><h1>Sign in</h1><div class="dashboard-toolbar-actions"><button type="button" id="dashboard-theme" aria-label="Dark mode" title="Dark mode" hidden></button></div></header>'
        . $alert
        . '<form method="post" action="' . $signInUrl . '">'
        . '<label>Username<input name="username" autocomplete="username" required></label>'
        . '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'
        . '<button class="primary-button">Sign in</button></form></main></html>';
    exit;
};

try {
    $db = new WorkspaceDb($config['db']);
    $db->ensureSchema(dirname($appDir) . '/sql/schema.sql');
    $auth = new WorkspaceAuth($db, $config['auth']);

    $hardwareCsv = '';
    $liveCsvPath = $config['assets']['live_sample_csv'] ?? '';
    if (is_string($liveCsvPath) && $liveCsvPath !== '' && is_file($liveCsvPath)) {
        $hardwareCsv = (string)file_get_contents($liveCsvPath);
    }
    $workspace = new WorkspaceStore($db, $hardwareCsv);

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $rawPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    if ($method === 'GET' && $basePath !== '' && $rawPath === $basePath) {
        header('Location: ' . $cookiePath, true, 301);
        exit;
    }
    $path = ($basePath !== '' && str_starts_with($rawPath, $basePath))
        ? (substr($rawPath, strlen($basePath)) ?: '/')
        : $rawPath;
    $authorization = authorizationHeader();
    $role = (string)($_SERVER['HTTP_X_KEYPHARM_ROLE'] ?? 'operator');
    $handheld = str_starts_with($authorization, 'Bearer ');
    $dashboardId = $_COOKIE[DASHBOARD_COOKIE] ?? null;

    if ($handheld || empty($dashboardId)) {
        $user = $auth->authenticate($authorization, $role);
    } elseif ($auth->dashboardSessionValid($dashboardId)) {
        $user = $authorization !== '' ? $auth->authenticate($authorization, $role) : $auth->userForRole($role);
    } else {
        $user = null;
    }

    $deviceHeader = $_SERVER['HTTP_X_KEYPHARM_DEVICE_ID'] ?? null;
    $deviceId = ($handheld && is_string($deviceHeader) && preg_match('/^[0-9a-f]{1,16}$/i', $deviceHeader))
        ? strtolower($deviceHeader)
        : null;

    if ($method === 'POST' && in_array($path, ['/dashboard/sign-in', '/dashboard/sign-out'], true)) {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        $host = (string)($_SERVER['HTTP_HOST'] ?? '');
        $secFetch = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
        $expectedOrigin = requestScheme() . '://' . $host;
        $localForm = ($origin === $expectedOrigin || $origin === 'http://' . $host || $origin === 'https://' . $host)
            || ((!$origin || $origin === 'null') && $secFetch === 'same-origin');
        if (!$localForm) {
            $sendJson(403, ['message' => 'Open the action from the KeyPharm dashboard.']);
        }
        $contentType = explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0];
        if ($contentType !== 'application/x-www-form-urlencoded') {
            fail('Unsupported request format.', 415);
        }
        if ($path === '/dashboard/sign-in') {
            $u = (string)($_POST['username'] ?? '');
            $p = (string)($_POST['password'] ?? '');
            if (!$auth->verifyPassword($u, $p)) {
                $dashboardSignIn('Check your username and password.');
            }
            if (!empty($dashboardId)) {
                $auth->removeDashboardSession($dashboardId);
            }
            $auth->startDashboardSession($cookiePath);
            header('Location: ' . $cookiePath, true, 303);
        } else {
            if (!empty($dashboardId)) {
                $auth->removeDashboardSession($dashboardId);
            }
            $auth->setDashboardCookie('signed-out', $cookiePath);
            header('Location: ' . $signInUrl, true, 303);
        }
        exit;
    }

    if ($method === 'GET' && $path === '/dashboard/sign-in') {
        $dashboardSignIn();
    }

    $signInAsset = $method === 'GET' && in_array($path, ['/dashboard.css', '/dashboard-theme.mjs', '/InterVariable.woff2'], true);
    if ($user === null && !$signInAsset) {
        if ($path === '/' && $method === 'GET') {
            header('Location: ' . $signInUrl, true, 303);
            exit;
        }
        $sendJson(401, ['message' => 'Sign in with a KeyPharm demo account.']);
    }

    $pages = [
        '/' => 'dashboard.html',
        '/dashboard.css' => 'dashboard.css',
        '/dashboard.mjs' => 'dashboard.mjs',
        '/dashboard-theme.mjs' => 'dashboard-theme.mjs',
        '/dashboard-model.mjs' => 'dashboard-model.mjs',
        '/workspace-dashboard.mjs' => 'workspace-dashboard.mjs',
        '/stock-dashboard.mjs' => 'stock-dashboard.mjs',
        '/model.mjs' => 'model.mjs',
        '/qrcode-generator.mjs' => 'qrcode-generator.mjs',
        '/keypharm-favicon.svg' => 'keypharm-favicon.svg',
        '/keypharm-logo-hd.png' => 'keypharm-logo-hd.png',
        '/keypharm-logo.png' => 'keypharm-logo.png',
        '/InterVariable.woff2' => 'InterVariable.woff2',
    ];
    $mime = [
        'html' => 'text/html; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'mjs' => 'text/javascript; charset=utf-8',
        'png' => 'image/png',
        'svg' => 'image/svg+xml',
        'woff2' => 'font/woff2',
    ];

    if ($method === 'GET') {
        if ($path === '/records') {
            $sendJson(200, $workspace->records());
        }
        if ($path === '/api/stock-workflows') {
            $devices = $workspace->devices();
            $resp = $workspace->stockTasks();
            $resp['devices'] = $devices;
            $resp['device'] = $devices !== [] ? $devices[count($devices) - 1] : null;
            $sendJson(200, $resp);
        }
        if ($path === '/api/carton-history') {
            $epc = $_GET['epc'] ?? null;
            if (!$epc) {
                $sendJson(400, ['message' => 'Choose a carton.']);
            }
            $sendJson(200, $workspace->stockOps->events((string)$epc));
        }
        if ($path === '/api/workspace') {
            if ($handheld) {
                $workspace->recordDevice($deviceId ?? 'default', $user);
            }
            $sessions = $workspace->records()['sessions'];
            $stockTasks = !$handheld ? [] : array_values(array_filter(
                $workspace->stockTasks()['tasks'],
                static fn(array $task): bool =>
                    ($user['role'] === 'operator' && !in_array($task['status'], ['Reviewed', 'Cancelled'], true)) ||
                    ($user['role'] === 'admin' && ($task['type'] ?? '') === 'receipt' && $task['status'] !== 'Cancelled')
            ));
            $allManifests = $workspace->palletManifests();
            if (!$handheld && $user['role'] === 'admin') {
                $palletManifests = array_values(array_filter($allManifests, static fn(array $i): bool => ($i['status'] ?? '') !== 'Cancelled'));
            } elseif ($deviceId && $user['role'] === 'operator') {
                $palletManifests = array_values(array_filter(
                    $allManifests,
                    static fn(array $i): bool => ($i['deviceId'] ?? '') === $deviceId && ($i['status'] ?? '') === 'Awaiting pallet scan'
                ));
            } else {
                $palletManifests = [];
            }
            $managesManifests = !$handheld && $user['role'] === 'admin';
            $payload = [
                'user' => $user,
                'generation' => $workspace->generation(),
                'inventory' => $workspace->stockOps->inventory(),
                'palletManifests' => $palletManifests,
            ];
            if ($managesManifests) {
                $payload['assignedCartonEpcs'] = $workspace->assignedCartonEpcs();
                $payload['existingPallets'] = $workspace->existingPallets();
                $payload['skuAvailability'] = $workspace->skuAvailability();
            }
            $payload['palletInventory'] = $workspace->palletCatalog();
            if ($handheld) {
                $payload['verificationClaims'] = $workspace->verificationClaims();
                $payload['palletClaims'] = $workspace->palletClaims();
            }
            $payload['removedSessions'] = $handheld ? $workspace->removedSessions() : [];
            $payload['devices'] = !$handheld ? $workspace->devices() : [];
            $payload['controls'] = $workspace->settings();
            $payload['outboundLocations'] = $workspace->stockOps->outboundLocations();
            $payload['sessions'] = $sessions;
            $payload['stockTasks'] = $stockTasks;
            $outbound = $workspace->outbound($user, $sessions);
            $payload['approvable'] = $outbound['approvable'];
            $payload['dispatchable'] = $outbound['dispatchable'];
            $sendJson(200, $payload);
        }
        if ($path === '/api/pallet-manifest.csv') {
            if ($handheld || $user['role'] !== 'admin') {
                $sendJson(403, ['message' => 'Administrator access required.']);
            }
            $id = $_GET['id'] ?? '';
            $draft = null;
            foreach ($workspace->palletManifests() as $item) {
                if ($item['id'] === $id && ($item['status'] ?? '') !== 'Cancelled') {
                    $draft = $item;
                    break;
                }
            }
            if ($draft === null || empty($draft['csv'])) {
                $sendJson(404, ['message' => 'Manifest not found.']);
            }
            $sendCsv('pallet-manifest.csv', (string)$draft['csv']);
        }
        if ($path === '/api/evidence.csv') {
            $sendCsv('keypharm-evidence.csv', specEvidenceCsv($workspace->records()));
        }
        if (preg_match('/^\/api\/(stock|movements|receipts|counts|receipt-template)\.csv$/', $path, $m)) {
            $sendCsv('keypharm-' . $m[1] . '.csv', $workspace->stockOps->report($m[1]));
        }
        if ($path === '/api/sample' || $path === '/api/physical-sample') {
            $sendJson(200, ['csv' => $workspace->sample($path === '/api/physical-sample' ? 'C72 hardware' : 'Simulation')]);
        }
        if (isset($pages[$path])) {
            $asset = $pages[$path];
            $file = __DIR__ . '/' . $asset;
            if (!is_file($file)) {
                $sendJson(404, ['message' => 'Page not found.']);
            }
            $content = (string)file_get_contents($file);
            if ($path === '/') {
                if (empty($dashboardId) && !$handheld) {
                    $auth->startDashboardSession($cookiePath);
                }
                $content = str_replace('</head>', '<script type="module" src="workspace-dashboard.mjs"></script></head>', $content);
            }
            $ext = pathinfo($asset, PATHINFO_EXTENSION);
            http_response_code(200);
            header('Content-Type: ' . ($mime[$ext] ?? 'application/octet-stream'));
            echo $content;
            exit;
        }
    }

    if ($method === 'POST' && str_starts_with($path, '/api/')) {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        if ($origin !== null && $origin !== '') {
            $originHost = (string)(parse_url($origin, PHP_URL_HOST) ?? '');
            $originPort = parse_url($origin, PHP_URL_PORT);
            $originHostPort = $originHost . ($originPort !== null ? ':' . $originPort : '');
            if ($originHostPort !== (string)($_SERVER['HTTP_HOST'] ?? '')) {
                $sendJson(403, ['message' => 'Open the API from the KeyPharm dashboard.']);
            }
        }
        $contentType = explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0];
        if ($contentType !== 'application/json') {
            fail('Unsupported request format.', 415);
        }
        $raw = (string)file_get_contents('php://input');
        if (strlen($raw) > 1000000) {
            fail('Request is too large.', 413);
        }
        try {
            $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            fail('Invalid JSON request body.', 400);
        }
        if (!is_array($body)) {
            fail('Invalid JSON request body.', 400);
        }

        if ($path === '/api/login') {
            if (!str_starts_with($authorization, 'Basic ')) {
                $sendJson(401, ['message' => 'Sign in with a password.']);
            }
            $sendJson(200, [
                'user' => array_merge($user, ['role' => 'operator', 'name' => DEMO_ROLES['operator'], 'canSwitch' => true]),
                'token' => $auth->token(),
            ]);
        }
        if ($path === '/api/reset') {
            $sendJson(200, $workspace->reset($user, $body));
        }
        if ((int)($body['generation'] ?? 0) !== $workspace->generation()) {
            $sendJson(409, ['message' => 'Demo data was reset. Sync or refresh before making changes.']);
        }
        if ($path === '/api/pallet-manifest') {
            if ($handheld && (!$deviceId || !in_array($body['action'] ?? '', ['scan', 'register-pallet'], true))) {
                $sendJson(403, ['message' => 'A registered handheld is required for this scan.']);
            }
            $nowMs = floor(microtime(true) * 1000);
            $activeDevices = [];
            foreach ($workspace->devices() as $d) {
                $ts = strtotime((string)($d['lastContact'] ?? ''));
                if (!empty($d['deviceId']) && $ts !== false && ($nowMs - ($ts * 1000)) < 60000) {
                    $activeDevices[] = $d['deviceId'];
                }
            }
            $sendJson(200, $workspace->palletManifest($user, $body, $deviceId, $activeDevices));
        }
        if ($path === '/api/session') {
            $sendJson(201, $workspace->create($user, $body));
        }
        if ($path === '/api/action') {
            $sendJson(200, $workspace->action($user, $body, !$handheld));
        }
        if ($path === '/api/dispatch') {
            $sendJson(200, $workspace->dispatchSelected($user, $body));
        }
        if ($path === '/api/stock-action') {
            if (($body['reader'] ?? '') === 'hardware' && !$handheld) {
                $sendJson(403, ['message' => 'Capture live RFID reads on the handheld.']);
            }
            if (!empty($body['scenario']) && !$handheld) {
                $sendJson(403, ['message' => 'Run stock simulations on the handheld.']);
            }
            if (($body['action'] ?? '') === 'receive-carton' && !$handheld) {
                $sendJson(403, ['message' => 'Receive cartons on the handheld.']);
            }
            $sendJson(200, $workspace->stockCommand($user, $body, !$handheld));
        }
        if ($path === '/api/sync') {
            $sendJson(200, $workspace->sync($user, $body));
        }
        if ($path === '/api/settings') {
            $sendJson(200, $workspace->setControls($user, $body));
        }
    }

    $sendJson(404, ['message' => 'Page not found.']);
} catch (HttpError $error) {
    $sendJson($error->status, ['message' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('KeyPharm workspace error: ' . $error->getMessage());
    $sendJson(500, ['message' => 'Workspace is unavailable.']);
}
