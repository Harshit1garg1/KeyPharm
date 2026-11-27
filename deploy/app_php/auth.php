<?php

declare(strict_types=1);

const DASHBOARD_SESSION_SECONDS = 43200;
const DASHBOARD_COOKIE = 'keypharm_dashboard';

function base64UrlEncode(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function isHttpsRequest(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        return true;
    }
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') {
        return true;
    }
    return (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
}

function requestScheme(): string
{
    return isHttpsRequest() ? 'https' : 'http';
}

function authorizationHeader(): string
{
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'Authorization'] as $key) {
        if (!empty($_SERVER[$key])) {
            return (string)$_SERVER[$key];
        }
    }
    if (function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) {
            if (strcasecmp((string)$k, 'Authorization') === 0) {
                return (string)$v;
            }
        }
    }
    return '';
}

final class WorkspaceAuth
{
    private WorkspaceDb $db;
    private string $username;
    private string $password;
    private string $secret;
    private string $token;

    public function __construct(WorkspaceDb $db, array $authConfig)
    {
        $this->db = $db;
        $this->username = (string)($authConfig['username'] ?? 'testing');
        $this->password = (string)($authConfig['password'] ?? 'testing123');
        $this->secret = $this->loadOrCreateSecret();
        $this->token = $this->username . '.' . base64UrlEncode(hash_hmac('sha256', $this->password, $this->secret, true));
    }

    private function loadOrCreateSecret(): string
    {
        $row = $this->db->getOne("SELECT `value` FROM `settings` WHERE `key`='auth-secret'");
        if ($row !== null && $row['value'] !== '') {
            return (string)$row['value'];
        }
        $secret = bin2hex(random_bytes(32));
        $this->db->run(
            "INSERT INTO `settings` (`key`, `value`) VALUES ('auth-secret', ?) ON DUPLICATE KEY UPDATE `value`=`value`",
            [$secret]
        );
        $saved = $this->db->getOne("SELECT `value` FROM `settings` WHERE `key`='auth-secret'");
        return (string)($saved['value'] ?? $secret);
    }

    public function token(): string
    {
        return $this->token;
    }

    public function username(): string
    {
        return $this->username;
    }

    public function verifyPassword(string $user, string $pass): bool
    {
        return hash_equals($this->username, $user) && hash_equals($this->password, $pass);
    }

    public function userForRole(string $role): ?array
    {
        if (!array_key_exists($role, DEMO_ROLES)) {
            return null;
        }
        return [
            'id' => $this->username,
            'role' => $role,
            'name' => DEMO_ROLES[$role],
            'canSwitch' => true,
        ];
    }

    public function authenticate(string $header, string $browserRole = 'operator'): ?array
    {
        $parts = explode(' ', $header, 2);
        $scheme = $parts[0] ?? '';
        $input = $parts[1] ?? '';
        $role = null;
        if ($scheme === 'Basic') {
            $decoded = base64_decode($input, true);
            if ($decoded === false) {
                return null;
            }
            $idx = strpos($decoded, ':');
            if ($idx === false) {
                return null;
            }
            if (!$this->verifyPassword(substr($decoded, 0, $idx), substr($decoded, $idx + 1))) {
                return null;
            }
            $role = $browserRole;
        } elseif ($scheme === 'Bearer') {
            $segments = explode('.', $input);
            if (count($segments) < 2 || count($segments) > 3) {
                return null;
            }
            if (!hash_equals($this->token, $segments[0] . '.' . $segments[1])) {
                return null;
            }
            $requested = $segments[2] ?? '';
            $role = in_array($requested, ['admin', 'supervisor'], true) ? $requested : 'operator';
        } else {
            return null;
        }
        return $this->userForRole($role);
    }

    public function setDashboardCookie(string $value, string $cookiePath = '/'): void
    {
        $flags = DASHBOARD_COOKIE . '=' . $value . '; Path=' . $cookiePath . '; Max-Age=' . DASHBOARD_SESSION_SECONDS . '; HttpOnly; SameSite=Strict';
        if (isHttpsRequest()) {
            $flags .= '; Secure';
        }
        header('Set-Cookie: ' . $flags, false);
    }

    public function startDashboardSession(string $cookiePath = '/'): string
    {
        $nowMs = (int)floor(microtime(true) * 1000);
        $expires = $nowMs + DASHBOARD_SESSION_SECONDS * 1000;
        $id = base64UrlEncode(random_bytes(24));
        $this->db->run('DELETE FROM `dashboard_sessions` WHERE `expires` <= ?', [$nowMs]);
        $this->db->run('INSERT INTO `dashboard_sessions` (`id`, `expires`) VALUES (?, ?)', [$id, $expires]);
        $this->setDashboardCookie($id, $cookiePath);
        return $id;
    }

    public function removeDashboardSession(string $id): void
    {
        $this->db->run('DELETE FROM `dashboard_sessions` WHERE `id` = ?', [$id]);
    }

    public function dashboardSessionValid(?string $id): bool
    {
        if ($id === null || $id === '') {
            return false;
        }
        $nowMs = (int)floor(microtime(true) * 1000);
        $row = $this->db->getOne('SELECT 1 AS ok FROM `dashboard_sessions` WHERE `id` = ? AND `expires` > ?', [$id, $nowMs]);
        return $row !== null;
    }
}
