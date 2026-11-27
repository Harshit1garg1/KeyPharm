<?php

declare(strict_types=1);

final class HttpError extends RuntimeException
{
    public int $status;

    public function __construct(string $message, int $status = 409)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function fail(string $message, int $status = 409): never
{
    throw new HttpError($message, $status);
}

function nowIso(): string
{
    $dt = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    return substr($dt->format('Y-m-d\TH:i:s.u'), 0, 23) . 'Z';
}

function uuid4(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function jsonObject(mixed $value): object|array
{
    if ($value instanceof stdClass) {
        return $value;
    }
    if (is_array($value)) {
        return $value === [] ? new stdClass() : $value;
    }
    return new stdClass();
}

function jsonEncodeStrict(mixed $value): string
{
    $encoded = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($encoded === false) {
        throw new RuntimeException('JSON encoding failed: ' . json_last_error_msg());
    }
    return $encoded;
}

final class WorkspaceDb
{
    public PDO $pdo;
    private int $txDepth = 0;

    public function __construct(array $dbConfig)
    {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $dbConfig['host'] ?? 'localhost',
            (int)($dbConfig['port'] ?? 3306),
            $dbConfig['name'] ?? 'abiote_keypharm',
            $dbConfig['charset'] ?? 'utf8mb4'
        );
        $this->pdo = new PDO($dsn, $dbConfig['user'] ?? '', $dbConfig['pass'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $this->pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    }

    public function ensureSchema(string $schemaPath): void
    {
        $row = $this->pdo->query("SHOW TABLES LIKE 'settings'")->fetch();
        if ($row !== false) {
            return;
        }
        $sql = file_get_contents($schemaPath);
        if ($sql === false) {
            throw new RuntimeException('Cannot read schema.sql');
        }
        foreach (explode(';', $sql) as $stmt) {
            $trimmed = trim($stmt);
            if ($trimmed === '' || preg_match('/^(--.*|\s)*$/', $trimmed)) {
                continue;
            }
            $this->pdo->exec($trimmed);
        }
    }

    public function atomic(callable $fn): mixed
    {
        if ($this->txDepth > 0) {
            return $fn();
        }
        $lock = $this->pdo->prepare("SELECT GET_LOCK('keypharm_workspace', 10) AS got");
        $lock->execute();
        $got = (int)($lock->fetch()['got'] ?? 0);
        if ($got !== 1) {
            throw new HttpError('Workspace is busy. Try again.', 503);
        }
        $this->txDepth = 1;
        $this->pdo->beginTransaction();
        try {
            $result = $fn();
            if ($this->pdo->inTransaction()) {
                $this->pdo->commit();
            }
            return $result;
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        } finally {
            $this->txDepth = 0;
            try {
                $this->pdo->query("SELECT RELEASE_LOCK('keypharm_workspace')");
            } catch (Throwable) {
            }
        }
    }

    public function getOne(string $sql, array $params = []): ?array
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function getAll(string $sql, array $params = []): array
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public function run(string $sql, array $params = []): int
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }
}
