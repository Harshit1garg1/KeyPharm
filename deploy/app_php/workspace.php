<?php

declare(strict_types=1);

const WORKSPACE_PRODUCTS = [
    ['sku' => 'Physalis', 'quantity' => 20],
    ['sku' => 'Tiger Balm', 'quantity' => 15],
    ['sku' => 'Biotona', 'quantity' => 35],
];

const AUDIT_CAP = 300;
const REVIEW_ROLES = ['admin', 'reviewer'];
const DISPATCH_ROLES = ['admin', 'supervisor'];
const SESSION_ACTION_ROLES = [
    'manifest' => ['admin'],
    'reopen' => ['admin'],
    'physical' => ['supervisor'],
    'approve' => REVIEW_ROLES,
    'dispatch' => DISPATCH_ROLES,
    'remove' => ['admin'],
];

final class WorkspaceStore
{
    public WorkspaceDb $db;
    public StockWorkflows $stockOps;
    private array $eligible;

    public function __construct(WorkspaceDb $db, string $hardwareCsv = '')
    {
        $this->db = $db;
        $this->eligible = array_column(WORKSPACE_PRODUCTS, 'sku');
        $this->stockOps = new StockWorkflows(
            $db,
            WORKSPACE_PRODUCTS,
            fn(array $user, string $action, string $ref, string $detail = ''): string => $this->recordAudit($user, $action, $ref, $detail)
        );
        $this->bootstrap($hardwareCsv);
    }

    private function productFamily(string $sku): string
    {
        foreach (WORKSPACE_PRODUCTS as $product) {
            if (str_starts_with($sku, $product['sku'] . '-')) {
                return $product['sku'];
            }
        }
        return $sku;
    }

    private function cartonsOf(?array $m): array
    {
        return manifestCartons($m);
    }

    private function palletCsv(array $pallets): string
    {
        $lines = ['pallet_ref,pallet_epc,carton_ref,carton_epc,sku'];
        foreach ($pallets as $p) {
            foreach ($p['cartons'] ?? [] as $c) {
                $row = [$p['pallet'], $p['palletEpc'], $c['carton'], $c['epc'], $c['sku']];
                $lines[] = implode(',', array_map(
                    static fn($v): string => '"' . str_replace('"', '""', (string)($v ?? '')) . '"',
                    $row
                ));
            }
        }
        return implode("\n", $lines);
    }

    private function validateManifest(?array $m): array
    {
        if (!is_array($m) || empty($m['pallets']) || !is_array($m['pallets'])) {
            fail('Load a valid manifest.', 400);
        }
        $csv = ($m['matchBy'] ?? '') === 'sku' ? skuManifestCsv($m['pallets']) : $this->palletCsv($m['pallets']);
        return parseManifest($csv);
    }

    private function draftPallets(array $draft): array
    {
        if (isset($draft['pallets']) && is_array($draft['pallets'])) {
            return $draft['pallets'];
        }
        if (!empty($draft['csv'])) {
            return [[
                'pallet' => $draft['reference'] ?? '',
                'palletEpc' => $draft['palletEpc'] ?? '',
                'cartons' => $draft['cartons'] ?? [],
            ]];
        }
        return [];
    }

    private function recordAudit(?array $user, string $action, string $sessionRef, string $detail = ''): string
    {
        $at = nowIso();
        $this->db->run(
            'INSERT INTO `audit` (at, actor, action, session, role, actor_name, detail) VALUES (?,?,?,?,?,?,?)',
            [$at, $user['id'] ?? '', $action, $sessionRef, $user['role'] ?? null, $user['name'] ?? null, $detail]
        );
        $cutoff = $this->db->getOne('SELECT id FROM `audit` ORDER BY id DESC LIMIT 1 OFFSET ' . AUDIT_CAP);
        if ($cutoff !== null) {
            $this->db->run('DELETE FROM `audit` WHERE id <= ?', [(int)$cutoff['id']]);
        }
        return $at;
    }

    private function bootstrap(string $hardwareCsv): void
    {
        $hasSample = $this->db->getOne("SELECT value FROM `settings` WHERE `key` = 'sample'");
        if ($hasSample === null) {
            $this->db->atomic(function () use ($hardwareCsv): void {
                if ($this->db->getOne("SELECT value FROM `settings` WHERE `key` = 'sample'") !== null) {
                    return;
                }
                $this->stockOps->ensureLocationsSeeded();
                $hardware = trim($hardwareCsv) !== '' ? parseManifest($hardwareCsv) : null;
                $live = $this->cartonsOf($hardware);
                $mappings = [];
                foreach ($live as $i => $carton) {
                    $mappings[$carton['epc']] = WORKSPACE_PRODUCTS[$i % count(WORKSPACE_PRODUCTS)]['sku'];
                }
                foreach (WORKSPACE_PRODUCTS as $productIndex => $prod) {
                    $sku = $prod['sku'];
                    $quantity = $prod['quantity'];
                    $tagged = array_values(array_filter($live, static fn(array $c): bool => ($mappings[$c['epc']] ?? '') === $sku));
                    foreach ($tagged as $c) {
                        $label = preg_match('/^Carton \d+$/', $c['carton']) ? $this->stockOps->nextCartonLabel($sku) : $c['carton'];
                        $this->db->run(
                            "INSERT INTO `cartons` (epc, carton, sku, physical, state, location) VALUES (?, ?, ?, 1, 'available', ?)",
                            [$c['epc'], $label, $sku, OUTBOUND_STAGING]
                        );
                    }
                    for ($i = count($tagged); $i < $quantity; $i++) {
                        $epc = 'D3' . dechex($productIndex) . str_pad(strtoupper(dechex($i + 1)), 21, '0', STR_PAD_LEFT);
                        $this->db->run(
                            "INSERT INTO `cartons` (epc, carton, sku, physical, state, location) VALUES (?, ?, ?, 0, 'available', ?)",
                            [$epc, $this->stockOps->nextCartonLabel($sku), $sku, OUTBOUND_STAGING]
                        );
                    }
                }
                $header = 'pallet_ref,pallet_epc,carton_ref,carton_epc,sku';
                $makeSampleCsv = static function (array $rows) use ($header): string {
                    $lines = [$header];
                    foreach ($rows as $row) {
                        $lines[] = implode(',', array_map(
                            static fn($v): string => '"' . str_replace('"', '""', (string)($v ?? '')) . '"',
                            $row
                        ));
                    }
                    return implode("\n", $lines) . "\n";
                };
                $counts = [14, 10, 16];
                $simRows = [];
                foreach (WORKSPACE_PRODUCTS as $idx => $prod) {
                    $rows = $this->db->getAll(
                        'SELECT epc, carton, sku FROM `cartons` WHERE physical = 0 AND sku = ? ORDER BY epc LIMIT ' . $counts[$idx],
                        [$prod['sku']]
                    );
                    foreach ($rows as $c) {
                        $simRows[] = ['KP-DEMO-40', 'D40000000000000000000001', $c['carton'], $c['epc'], $c['sku']];
                    }
                }
                $simulationCsv = $makeSampleCsv($simRows);
                $physicalCsv = '';
                if ($hardware !== null) {
                    $physRows = [];
                    foreach ($hardware['pallets'] as $p) {
                        foreach ($p['cartons'] as $c) {
                            $labelRow = $this->db->getOne('SELECT carton FROM `cartons` WHERE epc = ?', [$c['epc']]);
                            $physRows[] = [$p['pallet'], $p['palletEpc'], $labelRow['carton'], $c['epc'], $mappings[$c['epc']]];
                        }
                    }
                    $physicalCsv = $makeSampleCsv($physRows);
                }
                $this->db->run('INSERT INTO `settings` (`key`, `value`) VALUES (?, ?)', ['sample', $simulationCsv]);
                $this->db->run('INSERT INTO `settings` (`key`, `value`) VALUES (?, ?)', ['physical', $physicalCsv]);
                $this->stockOps->seed();
            });
        } else {
            $this->stockOps->ensureLocationsSeeded();
            $this->stockOps->seed();
        }
    }

    private function normalizeSessionShape(array $s): array
    {
        $s['allocation'] = jsonObject($s['allocation'] ?? []);
        if (array_key_exists('palletMatches', $s) && is_array($s['palletMatches'])) {
            $s['palletMatches'] = jsonObject($s['palletMatches']);
        }
        $s['palletAttempts'] = array_map(static function (array $attempt): array {
            $attempt['observations'] = jsonObject($attempt['observations'] ?? []);
            return $attempt;
        }, $s['palletAttempts'] ?? []);
        $s['runs'] = array_map(static function (array $run): array {
            $run['observations'] = jsonObject($run['observations'] ?? []);
            if (isset($run['result']['extraSkus']) && is_array($run['result']['extraSkus'])) {
                $run['result']['extraSkus'] = jsonObject($run['result']['extraSkus']);
            }
            return $run;
        }, $s['runs'] ?? []);
        $s['logs'] = $s['logs'] ?? [];
        return $s;
    }

    private function readSession(string $id): ?array
    {
        $row = $this->db->getOne('SELECT id, revision, body FROM `sessions` WHERE id = ?', [$id]);
        if ($row === null) {
            return null;
        }
        $decoded = json_decode((string)$row['body'], true);
        if (!is_array($decoded)) {
            $decoded = [];
        }
        $decoded['workspaceRevision'] = (int)$row['revision'];
        return $this->normalizeSessionShape($decoded);
    }

    public function sessions(): array
    {
        $rows = $this->db->getAll('SELECT id FROM `sessions` ORDER BY seq DESC');
        $out = [];
        foreach ($rows as $row) {
            $s = $this->readSession((string)$row['id']);
            if ($s !== null) {
                $out[] = $s;
            }
        }
        return $out;
    }

    public function activeSessions(): array
    {
        return array_values(array_filter($this->sessions(), static fn(array $s): bool => empty($s['removedAt'])));
    }

    public function removedSessions(): array
    {
        return array_values(array_map(
            static fn(array $s): string => (string)$s['id'],
            array_filter($this->sessions(), static fn(array $s): bool => !empty($s['removedAt']))
        ));
    }

    private function inventoryOptions(): array
    {
        $row = $this->db->getOne("SELECT value FROM `settings` WHERE `key` = 'inventory-options'");
        return $row !== null ? (json_decode((string)$row['value'], true) ?: defaultInventoryOptions()) : defaultInventoryOptions();
    }

    public function settings(): array
    {
        $row = $this->db->getOne("SELECT value FROM `settings` WHERE `key` = 'test-controls'");
        $base = $row !== null
            ? (json_decode((string)$row['value'], true) ?: ['revision' => 0, 'plan' => [], 'power' => null])
            : ['revision' => 0, 'plan' => [], 'power' => null];
        $base['revision'] = (int)($base['revision'] ?? 0);
        if (array_key_exists('sessionPowers', $base) && is_array($base['sessionPowers'])) {
            $base['sessionPowers'] = jsonObject($base['sessionPowers']);
        }
        $base['inventoryOptions'] = $this->inventoryOptions();
        return $base;
    }

    public function generation(): int
    {
        $row = $this->db->getOne("SELECT value FROM `settings` WHERE `key` = 'generation'");
        return (int)($row['value'] ?? 0);
    }

    private function syncSessionRecords(array $s): void
    {
        $revisions = [];
        foreach (array_merge($s['manifestRevisions'] ?? [], !empty($s['manifest']) ? [$s['manifest']] : []) as $m) {
            if ($m) {
                $revisions[(int)($m['revision'] ?? 1)] = $m;
            }
        }
        foreach ($revisions as $rev => $m) {
            $this->db->run(
                'INSERT INTO `manifest_revisions` (session_id, revision, source, pallet_ref, pallet_epc, carton_count, imported_at, manifest_json)
                VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE manifest_json = VALUES(manifest_json)',
                [
                    $s['id'],
                    $rev,
                    $m['source'] ?? null,
                    $m['pallet'] ?? null,
                    $m['palletEpc'] ?? null,
                    $this->expectedCartons($m),
                    $m['importedAt'] ?? null,
                    jsonEncodeStrict($m),
                ]
            );
        }
        foreach ($s['palletAttempts'] ?? [] as $i => $attempt) {
            $this->db->run(
                'INSERT INTO `pallet_attempts` (id, session_id, manifest_revision, actor, locked_pallet, pallet_epc, result, started_at, ended_at, profile_json, observations_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE result = VALUES(result), observations_json = VALUES(observations_json)',
                [
                    $attempt['id'] ?? ($s['id'] . ':attempt:' . $i),
                    $s['id'],
                    $attempt['manifestRevision'] ?? null,
                    $attempt['actor'] ?? null,
                    $attempt['lockedPallet'] ?? null,
                    $attempt['palletEpc'] ?? null,
                    $attempt['result'] ?? null,
                    $attempt['startedAt'] ?? null,
                    $attempt['endedAt'] ?? null,
                    jsonEncodeStrict($attempt['profile'] ?? null),
                    jsonEncodeStrict(jsonObject($attempt['observations'] ?? [])),
                ]
            );
        }
        $palletEpcs = [];
        foreach (($s['manifest']['pallets'] ?? (!empty($s['manifest']['palletEpc']) ? [$s['manifest']] : [])) as $p) {
            if (!empty($p['palletEpc'])) {
                $palletEpcs[$p['palletEpc']] = true;
            }
        }
        foreach ($s['runs'] ?? [] as $i => $run) {
            $runId = (string)($run['id'] ?? ($s['id'] . ':run:' . $i));
            $r = $run['result'] ?? null;
            $status = ($run['state'] ?? '') === 'Interrupted' ? 'Interrupted' : ($r['status'] ?? $run['state'] ?? null);
            $this->db->run(
                'INSERT INTO `scan_runs`
                (id, session_id, pallet_epc, manifest_revision, operator, source, state, status, expected_count, matched_count, missing_count, extra_count, percent, reason, notes, error, started_at, ended_at, elapsed_seconds, profile_json, result_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
                state=VALUES(state), status=VALUES(status), matched_count=VALUES(matched_count), missing_count=VALUES(missing_count),
                extra_count=VALUES(extra_count), percent=VALUES(percent), reason=VALUES(reason), notes=VALUES(notes), error=VALUES(error),
                ended_at=VALUES(ended_at), elapsed_seconds=VALUES(elapsed_seconds), result_json=VALUES(result_json)',
                [
                    $runId,
                    $s['id'],
                    $run['palletEpc'] ?? null,
                    $run['manifestRevision'] ?? null,
                    $run['operator'] ?? null,
                    $run['source'] ?? null,
                    $run['state'] ?? null,
                    $status,
                    $r['expected'] ?? null,
                    isset($r['matched']) ? count($r['matched']) : null,
                    isset($r['missing']) ? count($r['missing']) : null,
                    isset($r['extra']) ? count($r['extra']) : null,
                    $r['percent'] ?? null,
                    $run['reason'] ?? null,
                    $run['note'] ?? ($run['notes'] ?? null),
                    $run['error'] ?? null,
                    $run['startedAt'] ?? null,
                    $run['endedAt'] ?? null,
                    $run['elapsedSeconds'] ?? null,
                    jsonEncodeStrict($run['profile'] ?? null),
                    jsonEncodeStrict($r),
                ]
            );
            $this->db->run('DELETE FROM `scan_observations` WHERE run_id = ?', [$runId]);
            $matchedSet = array_flip($r['matched'] ?? []);
            $extraSet = array_flip($r['extra'] ?? []);
            $seen = [];
            foreach ($run['observations'] ?? [] as $epc => $info) {
                $epcStr = (string)$epc;
                $seen[$epcStr] = true;
                $outcome = isset($matchedSet[$epcStr]) ? 'matched' : (isset($extraSet[$epcStr]) ? 'extra' : (($epcStr === ($run['palletEpc'] ?? '') || isset($palletEpcs[$epcStr])) ? 'pallet_tag' : 'observed'));
                $count = is_int($info) ? $info : (int)($info['count'] ?? 1);
                $this->db->run(
                    'REPLACE INTO `scan_observations` (run_id, epc, outcome, read_count, rssi, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
                    [
                        $runId,
                        $epcStr,
                        $outcome,
                        $count,
                        is_array($info) ? ($info['rssi'] ?? null) : null,
                        is_array($info) ? ($info['first'] ?? null) : null,
                        is_array($info) ? ($info['last'] ?? null) : null,
                    ]
                );
            }
            foreach ($r['missing'] ?? [] as $missingEpc) {
                if (!isset($seen[$missingEpc])) {
                    $this->db->run(
                        "REPLACE INTO `scan_observations` (run_id, epc, outcome, read_count, rssi, first_seen_at, last_seen_at) VALUES (?,?, 'missing', 0, NULL, NULL, NULL)",
                        [$runId, $missingEpc]
                    );
                }
            }
        }
    }

    public function reset(array $user, array $input): array
    {
        return $this->db->atomic(function () use ($user, $input): array {
            if ($user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            if (($input['confirm'] ?? '') !== 'RESET') {
                fail('Type RESET to confirm.', 400);
            }
            if ((int)($input['generation'] ?? -1) !== $this->generation()) {
                fail('The workspace changed. Refresh before resetting.');
            }
            $next = $this->generation() + 1;
            foreach (['operations', 'audit', 'devices', 'settings_history', 'manifest_revisions', 'pallet_attempts', 'scan_observations', 'scan_runs', 'sessions', 'pallet_manifests'] as $table) {
                $this->db->run("DELETE FROM `$table`");
            }
            $this->db->run("DELETE FROM `settings` WHERE `key` = 'test-controls'");
            $this->db->run("UPDATE `cartons` SET state = 'available', reservation = NULL");
            $this->stockOps->reset();
            $this->db->run(
                "INSERT INTO `settings` (`key`, `value`) VALUES ('generation', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                [(string)$next]
            );
            return ['generation' => $next];
        });
    }

    public function setControls(array $user, array $input): array
    {
        return $this->db->atomic(function () use ($user, $input): array {
            if ($user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            $current = $this->settings();
            if (($current['lastOperation'] ?? null) === ($input['operationId'] ?? null)) {
                return $current;
            }
            if (empty($input['operationId']) || ($input['revision'] ?? null) !== $current['revision']) {
                fail('Test controls changed. Refresh and review them.');
            }
            if (array_key_exists('inventoryOption', $input)) {
                $opt = $input['inventoryOption'] ?? [];
                $group = (string)($opt['group'] ?? '');
                $action = (string)($opt['action'] ?? '');
                $label = $opt['label'] ?? null;
                $material = $group === 'palletMaterials';
                $name = is_string($label) ? trim($label) : '';
                $norm = class_exists('Normalizer') ? Normalizer::normalize($name, Normalizer::FORM_KD) : $name;
                $candidate = strtoupper(preg_replace('/[^a-z0-9]/i', '', (string)$norm) ?? '');
                $generated = strlen($candidate) > 4 ? substr($candidate, 0, (int)floor(strlen($candidate) / 2)) : $candidate;
                $codeInput = strtoupper(trim((string)($opt['code'] ?? '')));
                $code = $codeInput !== '' ? $codeInput : ($material && $action === 'add' ? $generated : '');
                if (!$material && $action === 'add' && $code === '') {
                    fail('Enter a size code.', 400);
                }
                $defaults = defaultInventoryOptions();
                if (!array_key_exists($group, $defaults) || !preg_match('/^[A-Z0-9]{1,20}$/', $code)) {
                    fail('Enter a valid option code.', 400);
                }
                $options = &$current['inventoryOptions'][$group];
                if ($action === 'add') {
                    $displayName = $name !== '' ? $name : $code;
                    $upperName = strtoupper($displayName);
                    $existingIdx = null;
                    foreach ($options as $idx => $entry) {
                        if ($entry['code'] === $code) {
                            $existingIdx = $idx;
                            break;
                        }
                    }
                    $restoring = $existingIdx !== null && !empty($options[$existingIdx]['archived']) &&
                        (!$material || strtoupper($options[$existingIdx]['label']) === $upperName);
                    $conflict = false;
                    foreach ($options as $idx => $entry) {
                        if ($restoring && $idx === $existingIdx) {
                            continue;
                        }
                        if (($material || empty($entry['archived'])) &&
                            ($entry['code'] === $code || strtoupper($entry['label']) === $upperName ||
                            strtoupper($entry['label']) === $code || $entry['code'] === $upperName)) {
                            $conflict = true;
                            break;
                        }
                    }
                    if (strlen($displayName) > 40 || $conflict) {
                        fail('That option code or name is already in use.', 400);
                    }
                    if ($restoring) {
                        $options[$existingIdx]['label'] = $displayName;
                        unset($options[$existingIdx]['archived']);
                    } else {
                        $options[] = ['code' => $code, 'label' => $displayName];
                    }
                } elseif ($action === 'remove') {
                    $activeIndices = [];
                    $matchIdx = null;
                    foreach ($options as $idx => $entry) {
                        if (empty($entry['archived'])) {
                            $activeIndices[] = $idx;
                            if ($entry['code'] === $code) {
                                $matchIdx = $idx;
                            }
                        }
                    }
                    if (count($activeIndices) <= 1 || $matchIdx === null) {
                        fail('Keep at least one option in each list.', 400);
                    }
                    $options[$matchIdx]['archived'] = true;
                } else {
                    fail('Choose add or remove.', 400);
                }
                unset($options);
                $this->db->run(
                    "INSERT INTO `settings` (`key`, `value`) VALUES ('inventory-options', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                    [jsonEncodeStrict($current['inventoryOptions'])]
                );
            }
            if (array_key_exists('plan', $input)) {
                if (!is_string($input['plan']) || strlen($input['plan']) > 12000) {
                    fail('Enter a valid test plan.', 400);
                }
                $current['plan'] = trim($input['plan']) !== '' ? parsePlan($input['plan']) : [];
            }
            if (array_key_exists('power', $input)) {
                $p = $input['power'];
                if ($p !== null && (!is_int($p) || $p < 5 || $p > 30)) {
                    fail('Use 5 to 30 dBm.', 400);
                }
                $current['power'] = $p === null ? null : ['requested' => $p, 'requestedAt' => nowIso(), 'by' => $user['name']];
            }
            foreach (['stockPower', 'palletPower', 'lookupPower', 'identifyPower'] as $key) {
                if (!array_key_exists($key, $input)) {
                    continue;
                }
                $p = $input[$key];
                if (!($key === 'lookupPower' && $p === null) && (!is_int($p) || $p < 5 || $p > 30)) {
                    fail('Use 5 to 30 dBm.', 400);
                }
                $current[$key] = $p;
            }
            if (array_key_exists('sessionPowers', $input)) {
                $sp = $input['sessionPowers'];
                if (!is_array($sp) || ($sp !== [] && array_is_list($sp))) {
                    fail('Enter valid session power settings.', 400);
                }
                $powers = (array)($current['sessionPowers'] ?? []);
                foreach ($sp as $id => $p) {
                    $sess = $this->readSession((string)$id);
                    if (($sess['source'] ?? '') !== 'C72 hardware') {
                        fail('Hardware session not found.', 404);
                    }
                    if ($p === null) {
                        unset($powers[$id]);
                    } else {
                        if (!is_int($p) || $p < 5 || $p > 30) {
                            fail('Use 5 to 30 dBm.', 400);
                        }
                        $powers[$id] = $p;
                    }
                }
                $current['sessionPowers'] = jsonObject($powers);
            }
            if (array_key_exists('applied', $input)) {
                if (empty($current['power']) || ($current['power']['requested'] ?? null) !== $input['applied']) {
                    fail('The requested reader power changed.');
                }
                $current['power']['applied'] = $input['applied'];
                $current['power']['appliedAt'] = nowIso();
            }
            $current['lastOperation'] = $input['operationId'];
            $current['revision']++;
            $storedControls = $current;
            unset($storedControls['inventoryOptions']);
            $encodedControls = jsonEncodeStrict($storedControls);
            $this->db->run(
                "INSERT INTO `settings` (`key`, `value`) VALUES ('test-controls', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                [$encodedControls]
            );
            $this->db->run(
                'INSERT INTO `settings_history` (at, actor, role, revision, controls_json) VALUES (?,?,?,?,?)',
                [nowIso(), $user['name'], $user['role'], $current['revision'], $encodedControls]
            );
            $changedKeys = array_values(array_filter(array_keys($input), static fn(string $k): bool => !in_array($k, ['operationId', 'revision'], true)));
            $this->recordAudit($user, 'Settings updated', 'workspace', implode(',', $changedKeys));
            return $current;
        });
    }

    public function sample(string $source): string
    {
        $key = $source === 'C72 hardware' ? 'physical' : 'sample';
        $row = $this->db->getOne('SELECT value FROM `settings` WHERE `key` = ?', [$key]);
        return (string)($row['value'] ?? '');
    }

    private function audit(array &$s, array $user, string $action, string $detail = ''): void
    {
        $at = $this->recordAudit($user, $action, (string)$s['id'], $detail);
        $s['logs'][] = ['at' => $at, 'actor' => $user['name'], 'action' => $action, 'detail' => $detail];
    }

    private function writeSession(array $s, int $revision): array
    {
        $snapshot = $s;
        unset($snapshot['workspaceRevision']);
        $snapshot['allocation'] = jsonObject($snapshot['allocation'] ?? []);
        if (array_key_exists('palletMatches', $snapshot) && is_array($snapshot['palletMatches'])) {
            $snapshot['palletMatches'] = jsonObject($snapshot['palletMatches']);
        }
        $snapshot['palletAttempts'] = array_map(static function (array $a): array {
            $a['observations'] = jsonObject($a['observations'] ?? []);
            return $a;
        }, $snapshot['palletAttempts'] ?? []);
        $snapshot['runs'] = array_map(static function (array $r): array {
            $r['observations'] = jsonObject($r['observations'] ?? []);
            if (isset($r['result']['extraSkus']) && is_array($r['result']['extraSkus'])) {
                $r['result']['extraSkus'] = jsonObject($r['result']['extraSkus']);
            }
            return $r;
        }, $snapshot['runs'] ?? []);
        $this->db->run(
            'INSERT INTO `sessions` (id, revision, body) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE revision = VALUES(revision), body = VALUES(body)',
            [$s['id'], $revision, jsonEncodeStrict($snapshot)]
        );
        $this->syncSessionRecords($s);
        return $this->readSession($s['id']);
    }

    public function recordDevice(?string $deviceId, ?array $user): void
    {
        $id = $deviceId ?: 'default';
        $at = nowIso();
        $this->db->run(
            'INSERT INTO `devices` (device_id, first_seen_at, last_contact_at, last_role, last_actor)
            VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE
            last_contact_at = VALUES(last_contact_at), last_role = VALUES(last_role), last_actor = VALUES(last_actor)',
            [$id, $at, $at, $user['role'] ?? null, $user['name'] ?? null]
        );
    }

    public function devices(): array
    {
        $rows = $this->db->getAll('SELECT device_id, last_contact_at, last_role, last_actor FROM `devices` ORDER BY last_contact_at ASC');
        return array_map(static function (array $row): array {
            $entry = [];
            if ($row['device_id'] !== 'default') {
                $entry['deviceId'] = $row['device_id'];
            }
            $entry['lastContact'] = $row['last_contact_at'];
            $entry['lastRole'] = $row['last_role'];
            $entry['lastActor'] = $row['last_actor'];
            return $entry;
        }, $rows);
    }

    private function stock(string $epc): ?array
    {
        return $this->stockOps->carton($epc);
    }

    private function expectedCartons(?array $manifest): int
    {
        $total = 0;
        foreach ($manifest['pallets'] ?? [] as $pallet) {
            $total += palletCartonCount($pallet);
        }
        return $total;
    }

    private function requiredRows(?array $manifest): array
    {
        $out = [];
        foreach ($manifest['pallets'] ?? [] as $pallet) {
            foreach ($pallet['requirements'] ?? [] as $req) {
                $out[] = $req;
            }
        }
        return $out;
    }

    private function verifiedCartons(array $s): array
    {
        if (($s['manifest']['matchBy'] ?? '') !== 'sku') {
            return $this->cartonsOf($s['manifest'] ?? null);
        }
        $runIds = array_flip(array_values($s['palletMatches'] ?? []));
        $runs = $s['runs'] ?? [];
        $lastRunId = $runs !== [] ? ($runs[count($runs) - 1]['id'] ?? null) : null;
        $out = [];
        foreach ($runs as $run) {
            if (isset($runIds[$run['id']]) || (empty($s['palletMatches']) && !empty($s['confirmedAt']) && $run['id'] === $lastRunId)) {
                foreach ($run['result']['matchedCartons'] ?? [] as $mc) {
                    $out[] = $mc;
                }
            }
        }
        return $out;
    }

    private function skuCapacity(?string $currentId = null, array $ignoreDrafts = []): array
    {
        $available = [];
        foreach (WORKSPACE_PRODUCTS as $p) {
            $available[$p['sku']] = 0;
        }
        $otherSessions = array_values(array_filter(
            $this->activeSessions(),
            static fn(array $s): bool => $s['id'] !== $currentId && empty($s['dispatchedAt'])
        ));
        $otherDrafts = array_values(array_filter(
            $this->palletManifests(),
            static fn(array $d): bool => !in_array($d['id'], $ignoreDrafts, true) && ($d['status'] ?? '') === 'Manifest ready'
        ));
        $committed = array_merge(array_map(static fn(array $s) => $s['manifest'] ?? null, $otherSessions), $otherDrafts);
        $fixed = [];
        foreach ($committed as $m) {
            foreach ($this->cartonsOf($m) as $c) {
                $fixed[$c['epc']] = true;
            }
        }
        $counted = [];
        foreach ($otherSessions as $sessionIdx => $session) {
            if (($session['manifest']['matchBy'] ?? '') !== 'sku') {
                continue;
            }
            $matched = $this->verifiedCartons($session);
            $used = [];
            foreach ($matched as $carton) {
                $fixed[$carton['epc']] = true;
                $row = $this->stock($carton['epc']);
                if (!$row || !$row['physical'] || $row['state'] !== 'available') {
                    continue;
                }
                $sku = cartonSku($row);
                $used[$sku] = ($used[$sku] ?? 0) + 1;
            }
            $counted[$sessionIdx] = $used;
        }
        foreach ($this->stockOps->inventory() as $carton) {
            if (!$carton['physical'] || $carton['state'] !== 'available' || isset($fixed[$carton['epc']])) {
                continue;
            }
            $skus = array_unique([$carton['sku'], cartonSku($carton)]);
            foreach ($skus as $sku) {
                $available[$sku] = ($available[$sku] ?? 0) + 1;
            }
        }
        foreach ($committed as $mIdx => $manifest) {
            $used = $counted[$mIdx] ?? null;
            $rows = $this->requiredRows($manifest);
            usort($rows, function (array $a, array $b): int {
                $aSame = ($a['sku'] === $this->productFamily($a['sku'])) ? 1 : 0;
                $bSame = ($b['sku'] === $this->productFamily($b['sku'])) ? 1 : 0;
                return $aSame <=> $bSame;
            });
            foreach ($rows as $row) {
                $sku = skuProduct($row['sku']);
                $outstanding = (int)$row['quantity'];
                if ($used !== null) {
                    foreach ($used as $key => $count) {
                        if ($key !== $sku && $this->productFamily((string)$key) !== $sku) {
                            continue;
                        }
                        $covered = min($outstanding, $count);
                        $used[$key] = $count - $covered;
                        $outstanding -= $covered;
                    }
                    $counted[$mIdx] = $used;
                }
                foreach (array_unique([$sku, $this->productFamily($sku)]) as $key) {
                    $available[$key] = ($available[$key] ?? 0) - $outstanding;
                }
            }
        }
        foreach ($available as $sku => $count) {
            $fam = $this->productFamily((string)$sku);
            if ($fam !== $sku) {
                $available[$sku] = min($count, $available[$fam] ?? 0);
            }
        }
        return $available;
    }

    public function skuAvailability(): object|array
    {
        return jsonObject($this->skuCapacity());
    }

    private function checkStock(array $manifest, ?string $currentId = null, array $ignoreDrafts = []): void
    {
        if (($manifest['matchBy'] ?? '') === 'sku') {
            $availability = $this->skuCapacity($currentId, $ignoreDrafts);
            foreach ($this->requiredRows($manifest) as $row) {
                $sku = skuProduct($row['sku']);
                $family = $this->productFamily($sku);
                $avail = max(0, min($availability[$sku] ?? 0, $availability[$family] ?? 0));
                if (!in_array($family, $this->eligible, true) || $row['quantity'] > $avail) {
                    fail('Only ' . $avail . ' cartons of ' . $sku . ' are available.');
                }
                foreach (array_unique([$sku, $family]) as $key) {
                    $availability[$key] = ($availability[$key] ?? 0) - $row['quantity'];
                }
            }
            return;
        }
        foreach ($manifest['pallets'] ?? [] as $pallet) {
            if ($this->db->getOne('SELECT 1 AS ok FROM `pallet_inventory` WHERE epc = ? AND removed = 1', [$pallet['palletEpc']]) !== null) {
                fail('This manifest includes a pallet removed from inventory.');
            }
        }
        $inventory = [];
        foreach ($this->cartonsOf($manifest) as $c) {
            $carton = $this->stock($c['epc']);
            if (!in_array($c['sku'], $this->eligible, true) || ($carton['sku'] ?? null) !== $c['sku']) {
                fail('EPC ' . $c['epc'] . ' has no matching stock SKU.');
            }
            if ($carton['state'] === 'removed') {
                fail('EPC ' . $c['epc'] . ' was removed from stock.');
            }
            if ($carton['state'] === 'expected') {
                fail('EPC ' . $c['epc'] . ' has not been received.');
            }
            $inventory[] = $carton;
        }
        $conflict = outboundManifestConflict($manifest, $inventory, $this->activeSessions(), $currentId);
        if ($conflict !== '') {
            fail($conflict);
        }
        $expected = array_flip(array_map(static fn(array $c): string => $c['epc'], $this->cartonsOf($manifest)));
        foreach ($this->palletManifests() as $item) {
            if (in_array($item['id'], $ignoreDrafts, true) || !in_array($item['status'] ?? '', ['Pallet scanned', 'Manifest ready'], true)) {
                continue;
            }
            foreach ($this->draftPallets($item) as $pallet) {
                foreach ($pallet['cartons'] ?? [] as $carton) {
                    if (isset($expected[$carton['epc']])) {
                        fail('This manifest contains cartons assigned to draft manifest ' . $item['reference'] . '. Remove that manifest or choose different cartons.');
                    }
                }
            }
        }
        foreach ($this->activeSessions() as $s) {
            if ($s['id'] === $currentId || ($s['manifest']['matchBy'] ?? '') !== 'sku' || !empty($s['dispatchedAt'])) {
                continue;
            }
            foreach ($this->verifiedCartons($s) as $carton) {
                if (isset($expected[$carton['epc']])) {
                    fail('This manifest contains cartons assigned to ' . $s['testId'] . '.');
                }
            }
        }
    }

    public function palletManifests(): array
    {
        $rows = $this->db->getAll('SELECT body FROM `pallet_manifests` ORDER BY seq DESC');
        return array_map(static fn(array $r): array => json_decode((string)$r['body'], true) ?: [], $rows);
    }

    private function savePalletManifest(array $draft): array
    {
        $this->db->run(
            'INSERT INTO `pallet_manifests` (id, body) VALUES (?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body)',
            [$draft['id'], jsonEncodeStrict($draft)]
        );
        return $draft;
    }

    public function assignedCartonEpcs(): array
    {
        $epcs = [];
        foreach ($this->palletManifests() as $draft) {
            if (($draft['status'] ?? '') === 'Cancelled') {
                continue;
            }
            foreach ($this->draftPallets($draft) as $pallet) {
                foreach ($pallet['cartons'] ?? [] as $c) {
                    $epcs[$c['epc']] = true;
                }
            }
        }
        foreach ($this->activeSessions() as $s) {
            foreach ($this->verifiedCartons($s) as $c) {
                $epcs[$c['epc']] = true;
            }
        }
        return array_keys($epcs);
    }

    public function existingPallets(): array
    {
        $sessions = $this->activeSessions();
        $sessionPallets = [];
        $sessionCartons = [];
        foreach ($sessions as $s) {
            foreach ($s['manifest']['pallets'] ?? [] as $pallet) {
                if (!empty($pallet['palletEpc'])) {
                    $sessionPallets[$pallet['palletEpc']] = true;
                }
            }
            foreach ($this->cartonsOf($s['manifest'] ?? null) as $c) {
                $sessionCartons[$c['epc']] = true;
            }
        }
        $out = [];
        foreach ($this->palletManifests() as $draft) {
            if (($draft['status'] ?? '') !== 'Manifest ready' || ($draft['matchBy'] ?? '') === 'sku') {
                continue;
            }
            foreach ($this->draftPallets($draft) as $pallet) {
                if (isset($sessionPallets[$pallet['palletEpc'] ?? ''])) {
                    continue;
                }
                $ok = true;
                foreach ($pallet['cartons'] ?? [] as $c) {
                    $st = $this->stock($c['epc']);
                    if (($st['state'] ?? '') !== 'available' || isset($sessionCartons[$c['epc']])) {
                        $ok = false;
                        break;
                    }
                }
                if ($ok) {
                    $out[] = array_merge(['draftId' => $draft['id']], $pallet);
                }
            }
        }
        return $out;
    }

    private function readyManifest(array $draft, array $pallets, array $ignoreDrafts): array
    {
        $total = 0;
        foreach ($pallets as $pallet) {
            $total += 1 + palletCartonCount($pallet);
        }
        if ($total > 500) {
            fail('A manifest can use up to 500 labels.', 400);
        }
        $csv = ($draft['matchBy'] ?? '') === 'sku' ? skuManifestCsv($pallets) : $this->palletCsv($pallets);
        $this->checkStock(parseManifest($csv), null, $ignoreDrafts);
        $draft['pallets'] = $pallets;
        $draft['csv'] = $csv;
        $draft['status'] = 'Manifest ready';
        $draft['generatedAt'] = nowIso();
        return $draft;
    }

    private function palletAvailable(string $epc, ?string $id = null): void
    {
        $used = $this->stock($epc) !== null;
        if (!$used) {
            foreach ($this->palletManifests() as $draft) {
                if ($draft['id'] !== $id && ($draft['status'] ?? '') !== 'Cancelled') {
                    if (($draft['palletEpc'] ?? '') === $epc) {
                        $used = true;
                        break;
                    }
                    foreach ($this->draftPallets($draft) as $p) {
                        if (($p['palletEpc'] ?? '') === $epc) {
                            $used = true;
                            break 2;
                        }
                    }
                }
            }
        }
        if (!$used) {
            foreach ($this->activeSessions() as $s) {
                $manifests = array_merge(!empty($s['manifest']) ? [$s['manifest']] : [], $s['manifestRevisions'] ?? []);
                foreach ($manifests as $m) {
                    foreach ($m['pallets'] ?? [] as $p) {
                        if (($p['palletEpc'] ?? '') === $epc) {
                            $used = true;
                            break 3;
                        }
                    }
                    foreach ($this->cartonsOf($m) as $c) {
                        if ($c['epc'] === $epc) {
                            $used = true;
                            break 3;
                        }
                    }
                }
            }
        }
        if ($used) {
            fail('This EPC is already registered. Scan an unused pallet tag.');
        }
    }

    private function catalogPallet(array $pallet): array
    {
        unset($pallet['shape'], $pallet['removed']);
        $identifier = preg_match('/^PAL-[A-Z0-9]+-[A-Z0-9]+$/', (string)$pallet['sku']) ? $pallet['sku'] : palletIdentifier($pallet);
        $pallet['identifier'] = $identifier;
        return $pallet;
    }

    public function palletClaims(): object|array
    {
        $used = [];
        foreach ($this->palletManifests() as $draft) {
            if (($draft['status'] ?? '') !== 'Manifest ready') {
                continue;
            }
            foreach ($this->draftPallets($draft) as $pallet) {
                if (empty($pallet['palletType']) && !empty($pallet['palletEpc'])) {
                    $used[$pallet['palletEpc']] = ['id' => $draft['id'], 'reference' => $draft['reference'], 'status' => 'In manifest'];
                }
            }
        }
        foreach ($this->sessions() as $session) {
            if (empty($session['dispatchedAt']) && !empty($session['removedAt'])) {
                continue;
            }
            foreach ($session['manifest']['pallets'] ?? [] as $pallet) {
                $actual = null;
                foreach ($session['palletAttempts'] ?? [] as $attempt) {
                    if (($attempt['manifestRevision'] ?? null) === ($session['manifest']['revision'] ?? null) &&
                        ($attempt['palletEpc'] ?? null) === ($pallet['palletEpc'] ?? null) &&
                        ($attempt['result'] ?? null) === 'Identified') {
                        $actual = $attempt['actualPalletEpc'] ?? null;
                    }
                }
                $epc = !empty($pallet['palletType']) ? $actual : ($pallet['palletEpc'] ?? null);
                if ($epc && (($used[$epc]['status'] ?? '') !== 'Dispatched')) {
                    $used[$epc] = [
                        'id' => $session['id'],
                        'reference' => $session['testId'],
                        'status' => !empty($session['dispatchedAt']) ? 'Dispatched' : 'In session',
                    ];
                }
            }
        }
        return jsonObject($used);
    }

    private function palletClaimsMap(): array
    {
        return (array)$this->palletClaims();
    }

    public function palletCatalog(): array
    {
        $claims = $this->palletClaimsMap();
        $rows = $this->db->getAll('SELECT * FROM `pallet_inventory` WHERE removed = 0 ORDER BY reference');
        return array_map(function (array $pallet) use ($claims): array {
            $rec = $this->catalogPallet($pallet);
            $rec['status'] = $claims[$pallet['epc']]['status'] ?? 'On hand';
            return $rec;
        }, $rows);
    }

    private function importPallets(mixed $text): array
    {
        if (!is_string($text)) {
            fail('Choose a pallet inventory CSV.', 400);
        }
        $columns = ['pallet_ref', 'pallet_epc', 'sku', 'size', 'material'];
        $firstLine = preg_split('/\r?\n/', $text, 2)[0] ?? '';
        $header = array_map(static fn(string $c): string => trim(strtolower($c)), preg_split('/[,;]/', stripBom($firstLine)) ?: []);
        $legacy = in_array('sku', $header, true);
        $expectedHeaders = $legacy
            ? (in_array('shape', $header, true) ? array_merge($columns, ['shape']) : $columns)
            : ['pallet_ref', 'pallet_epc', 'material', 'size'];
        $rows = parseCsvRows($text, $expectedHeaders);
        $options = $this->inventoryOptions();
        $palletMaterials = $options['palletMaterials'];
        $palletSizes = $options['palletSizes'];
        if (count($rows) > 500) {
            fail('Import up to 500 pallets at a time.', 400);
        }
        foreach ($rows as $rowVals) {
            $reference = $rowVals[0] ?? '';
            $tag = $rowVals[1] ?? '';
            $code = $rowVals[2] ?? '';
            $size = $rowVals[3] ?? '';
            $oldMaterial = $rowVals[4] ?? '';
            $epc = normalizeEpc($tag);
            $material = $legacy ? $oldMaterial : $code;
            foreach ([$reference, $size, $material] as $v) {
                if ($v === '' || strlen($v) > 80 || preg_match('/^[=+@-]/', $v)) {
                    fail('Each pallet needs a valid reference, EPC, material and size.', 400);
                }
            }
            if (!validEpc($epc)) {
                fail('Each pallet needs a valid reference, EPC, material and size.', 400);
            }
            if ($this->db->getOne('SELECT 1 AS ok FROM `pallet_inventory` WHERE epc = ? OR reference = ?', [$epc, $reference]) !== null ||
                $this->stock($epc) !== null) {
                fail('Pallet reference or EPC already exists: ' . $reference . '.');
            }
            $this->palletAvailable($epc);
            $materialOption = null;
            foreach ($palletMaterials as $o) {
                if (empty($o['archived']) && (strtoupper($o['code']) === strtoupper($material) || strtoupper($o['label']) === strtoupper($material))) {
                    $materialOption = $o;
                    break;
                }
            }
            $sizeOption = null;
            foreach ($palletSizes as $o) {
                if (empty($o['archived']) && (strtoupper($o['code']) === strtoupper($size) || strtoupper($o['label']) === strtoupper($size))) {
                    $sizeOption = $o;
                    break;
                }
            }
            if (!$legacy && ($materialOption === null || $sizeOption === null)) {
                fail('Use a configured pallet material and size.', 400);
            }
            $identifier = ($materialOption && $sizeOption)
                ? 'PAL-' . $materialOption['code'] . '-' . $sizeOption['code']
                : palletIdentifier(['material' => $material, 'size' => $size]);
            $this->db->run(
                'INSERT INTO `pallet_inventory` (epc, reference, sku, size, material) VALUES (?,?,?,?,?)',
                [$epc, $reference, $identifier, $sizeOption['label'] ?? $size, $materialOption['label'] ?? $material]
            );
        }
        return ['imported' => count($rows), 'reference' => count($rows) . ' pallets'];
    }

    public function palletManifest(array $user, array $input, ?string $deviceId, array $devices): array
    {
        return $this->db->atomic(function () use ($user, $input, $deviceId, $devices): array {
            $result = $this->runPalletManifest($user, $input, $deviceId, $devices);
            $this->recordAudit($user, 'Manifest ' . ($input['action'] ?? ''), (string)($result['id'] ?? $input['id'] ?? ''), (string)($input['reference'] ?? $result['reference'] ?? ''));
            return $result;
        });
    }

    private function runPalletManifest(array $user, array $input, ?string $deviceId, array $devices): array
    {
        $action = (string)($input['action'] ?? '');
        if ($action === 'remove-pallet') {
            if ($deviceId || $user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            $reason = is_string($input['reason'] ?? null) ? trim($input['reason']) : '';
            if ($reason === '' || strlen($reason) > 240) {
                fail('Enter a removal reason of up to 240 characters.', 400);
            }
            $catalog = $this->palletCatalog();
            $targetEpc = normalizeEpc($input['epc'] ?? '');
            $pallet = null;
            foreach ($catalog as $row) {
                if ($row['epc'] === $targetEpc) {
                    $pallet = $row;
                    break;
                }
            }
            if ($pallet === null || $pallet['status'] !== 'On hand') {
                fail('Only an on-hand pallet can be removed.');
            }
            $typedSlots = [];
            foreach ($this->palletManifests() as $draft) {
                if (($draft['status'] ?? '') === 'Manifest ready') {
                    foreach ($this->draftPallets($draft) as $slot) {
                        if (!empty($slot['palletType'])) {
                            $typedSlots[] = $slot;
                        }
                    }
                }
            }
            foreach ($this->activeSessions() as $session) {
                if (!empty($session['closedAt']) || !empty($session['dispatchedAt'])) {
                    continue;
                }
                foreach ($session['manifest']['pallets'] ?? [] as $slot) {
                    if (!empty($slot['palletType']) && !$this->hasPalletRead($session, $slot)) {
                        $typedSlots[] = $slot;
                    }
                }
            }
            foreach ($typedSlots as $slot) {
                $onHand = count(array_filter($catalog, static fn(array $r): bool => $r['status'] === 'On hand' && matchesPalletIdentifier($slot['palletType'], $r['identifier'])));
                $needed = count(array_filter($typedSlots, static fn(array $other): bool => $other['palletType'] === $slot['palletType']));
                if (matchesPalletIdentifier($slot['palletType'], $pallet['identifier']) && $onHand <= $needed) {
                    fail('This pallet type is needed for an open manifest or session.');
                }
            }
            $this->db->run('UPDATE `pallet_inventory` SET removed = 1 WHERE epc = ?', [$pallet['epc']]);
            $this->stockOps->recordPalletRemoval($user, $pallet, $reason);
            return ['reference' => $pallet['reference']];
        }
        if ($action === 'register-pallet') {
            if (!$deviceId || $user['role'] !== 'operator') {
                fail('Operator access on the handheld is required.', 403);
            }
            $epc = normalizeEpc($input['epc'] ?? '');
            $opts = $this->inventoryOptions();
            $material = null;
            foreach ($opts['palletMaterials'] as $o) {
                if (empty($o['archived']) && $o['code'] === ($input['material'] ?? '')) {
                    $material = $o;
                    break;
                }
            }
            $size = null;
            foreach ($opts['palletSizes'] as $o) {
                if (empty($o['archived']) && $o['code'] === ($input['size'] ?? '')) {
                    $size = $o;
                    break;
                }
            }
            if (!validEpc($epc) || $material === null || $size === null) {
                fail('Choose a configured material and size, and scan a valid EPC.', 400);
            }
            $conflict = $this->tagConflict($epc, null, $this->verificationClaimsMap(), $this->palletClaimsMap());
            if ($conflict !== '') {
                fail($conflict);
            }
            $identifier = 'PAL-' . $material['code'] . '-' . $size['code'];
            $existing = $this->db->getOne('SELECT * FROM `pallet_inventory` WHERE epc = ?', [$epc]);
            if ($existing !== null && !empty($existing['removed'])) {
                fail('This pallet was removed from inventory.');
            }
            if ($existing !== null && $this->catalogPallet($existing)['identifier'] === $identifier) {
                foreach ($this->palletCatalog() as $row) {
                    if ($row['epc'] === $epc) {
                        return $row;
                    }
                }
            }
            if ($existing !== null) {
                fail('This pallet EPC is already registered.');
            }
            $this->palletAvailable($epc);
            $reference = 'PAL-' . substr($epc, -6);
            if ($this->db->getOne('SELECT 1 AS ok FROM `pallet_inventory` WHERE reference = ?', [$reference]) !== null) {
                fail('Another pallet already uses reference ' . $reference . '.');
            }
            $this->db->run(
                'INSERT INTO `pallet_inventory` (epc, reference, sku, size, material) VALUES (?,?,?,?,?)',
                [$epc, $reference, $identifier, $size['label'], $material['label']]
            );
            return $this->catalogPallet(['epc' => $epc, 'reference' => $reference, 'sku' => $identifier, 'size' => $size['label'], 'material' => $material['label']]);
        }
        if (in_array($action, ['import-pallets', 'sku-pallet'], true)) {
            if ($deviceId || $user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            if ($action === 'import-pallets') {
                return $this->importPallets($input['csv'] ?? null);
            }
            $draft = null;
            if (!empty($input['id'])) {
                foreach ($this->palletManifests() as $row) {
                    if ($row['id'] === $input['id'] && ($row['status'] ?? '') === 'Manifest ready' && ($row['matchBy'] ?? '') === 'sku') {
                        $draft = $row;
                        break;
                    }
                }
                if ($draft === null) {
                    fail('Open a ready SKU manifest before adding a pallet.');
                }
            }
            $slots = [];
            if ($draft !== null) {
                foreach ($this->draftPallets($draft) as $p) {
                    $slots[$p['palletEpc']] = true;
                }
            }
            $pallet = null;
            $targetEpc = normalizeEpc($input['palletEpc'] ?? '');
            foreach ($this->palletCatalog() as $row) {
                if ($row['status'] === 'On hand' && !isset($slots[$row['epc']]) &&
                    (!empty($input['palletType']) ? $row['identifier'] === $input['palletType'] : $row['epc'] === $targetEpc)) {
                    $pallet = $row;
                    break;
                }
            }
            if ($pallet === null) {
                fail('Select a pallet currently on hand.');
            }
            if (empty($input['requirements']) || !is_array($input['requirements'])) {
                fail('Enter at least one carton quantity.', 400);
            }
            $requirements = [];
            $seenSkus = [];
            foreach ($input['requirements'] as $req) {
                $sku = skuProduct($req['sku'] ?? '');
                $qty = $req['quantity'] ?? null;
                if (!in_array($this->productFamily($sku), $this->eligible, true) || !is_int($qty) || $qty < 1 || $qty > 499 || isset($seenSkus[$sku])) {
                    fail('Enter one whole quantity per product SKU.', 400);
                }
                $seenSkus[$sku] = true;
                $requirements[] = ['sku' => $sku, 'quantity' => $qty];
            }
            $next = ['pallet' => $pallet['reference'], 'palletEpc' => $pallet['epc'], 'cartons' => [], 'requirements' => $requirements];
            if (!empty($input['palletType'])) {
                $next['palletType'] = $pallet['identifier'];
            }
            $base = $draft ?? ['id' => uuid4(), 'reference' => $pallet['reference'], 'matchBy' => 'sku', 'createdAt' => nowIso(), 'by' => $user['name']];
            $pallets = array_merge($this->draftPallets($base), [$next]);
            return $this->savePalletManifest($this->readyManifest($base, $pallets, [$base['id']]));
        }
        if ($action === 'request') {
            if ($deviceId || $user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            if (!in_array($input['deviceId'] ?? '', $devices, true)) {
                fail('Choose a connected handheld.', 400);
            }
            $reference = trim((string)($input['reference'] ?? ''));
            if ($reference === '' || strlen($reference) > 80 || preg_match('/^[=+@-]/', $reference) || preg_match('/[\r\n]/', $reference)) {
                fail('Enter a valid pallet reference.', 400);
            }
            foreach ($this->palletManifests() as $draft) {
                if (($draft['deviceId'] ?? '') === $input['deviceId'] && ($draft['status'] ?? '') === 'Awaiting pallet scan') {
                    fail('That handheld already has a pending pallet scan.');
                }
            }
            return $this->savePalletManifest([
                'id' => uuid4(),
                'reference' => $reference,
                'deviceId' => $input['deviceId'],
                'status' => 'Awaiting pallet scan',
                'createdAt' => nowIso(),
                'by' => $user['name'],
            ]);
        }
        $draft = null;
        foreach ($this->palletManifests() as $row) {
            if ($row['id'] === ($input['id'] ?? '')) {
                $draft = $row;
                break;
            }
        }
        if ($draft === null) {
            fail('Pallet manifest request not found.', 404);
        }
        if ($action === 'scan') {
            if ($user['role'] !== 'operator' || !$deviceId || $deviceId !== ($draft['deviceId'] ?? '')) {
                fail('This pallet scan is assigned to a different handheld.', 403);
            }
            $epc = normalizeEpc($input['epc'] ?? '');
            if (($draft['status'] ?? '') === 'Pallet scanned' && ($draft['palletEpc'] ?? '') === $epc && ($input['scanReference'] ?? null) === ($draft['scanReference'] ?? null)) {
                return $draft;
            }
            if (($draft['status'] ?? '') !== 'Awaiting pallet scan' || ($input['scanReference'] ?? null) !== ($draft['scanReference'] ?? null)) {
                fail('This pallet scan is no longer pending.');
            }
            if (!validEpc($epc)) {
                fail('Scan a valid pallet EPC.', 400);
            }
            foreach ($this->draftPallets($draft) as $p) {
                if (($p['palletEpc'] ?? '') === $epc) {
                    fail('That pallet is already in this manifest.');
                }
            }
            $this->palletAvailable($epc, $draft['id']);
            return $this->savePalletManifest(array_merge($draft, [
                'palletEpc' => $epc,
                'scannedAt' => nowIso(),
                'scannedBy' => $user['name'],
                'status' => 'Pallet scanned',
            ]));
        }
        if ($deviceId || $user['role'] !== 'admin') {
            fail('Administrator access required.', 403);
        }
        if ($action === 'cancel' && ($input['confirmed'] ?? false) === true && ($draft['status'] ?? '') !== 'Cancelled') {
            return $this->savePalletManifest(array_merge($draft, [
                'status' => 'Cancelled',
                'removedAt' => nowIso(),
                'removedBy' => $user['name'],
            ]));
        }
        if ($action === 'add-existing' && ($draft['status'] ?? '') === 'Manifest ready') {
            $targetEpc = normalizeEpc($input['palletEpc'] ?? '');
            $selected = null;
            foreach ($this->existingPallets() as $p) {
                if ($p['draftId'] !== $draft['id'] && $p['palletEpc'] === $targetEpc) {
                    $selected = $p;
                    break;
                }
            }
            if ($selected === null) {
                fail('That pallet is no longer available. Refresh and choose another pallet.');
            }
            $source = null;
            foreach ($this->palletManifests() as $row) {
                if ($row['id'] === $selected['draftId']) {
                    $source = $row;
                    break;
                }
            }
            $pallets = $this->draftPallets($draft);
            foreach ($pallets as $entry) {
                if (strcasecmp($entry['pallet'], $selected['pallet']) === 0) {
                    fail('This manifest already has a pallet with that reference.');
                }
            }
            $combined = $this->readyManifest($draft, array_merge($pallets, [[
                'pallet' => $selected['pallet'],
                'palletEpc' => $selected['palletEpc'],
                'cartons' => $selected['cartons'],
            ]]), [$draft['id'], $source['id']]);
            $remaining = array_values(array_filter(
                $this->draftPallets($source),
                static fn(array $entry): bool => $entry['palletEpc'] !== $selected['palletEpc']
            ));
            if ($remaining !== []) {
                $last = $remaining[count($remaining) - 1];
                $hasRef = false;
                foreach ($remaining as $entry) {
                    if (strcasecmp($entry['pallet'], $source['reference']) === 0) {
                        $hasRef = true;
                        break;
                    }
                }
                $nextRef = $hasRef ? $source['reference'] : $remaining[0]['pallet'];
                $srcCopy = $source;
                $srcCopy['reference'] = $nextRef;
                unset($srcCopy['scanReference']);
                $srcCopy['palletEpc'] = $last['palletEpc'];
                $this->savePalletManifest($this->readyManifest($srcCopy, $remaining, [$draft['id'], $source['id']]));
            } else {
                $this->savePalletManifest(array_merge($source, ['status' => 'Cancelled', 'mergedInto' => $draft['id']]));
            }
            return $this->savePalletManifest($combined);
        }
        if ($action === 'add-pallet' && ($draft['status'] ?? '') === 'Manifest ready') {
            $scanReference = trim((string)($input['reference'] ?? ''));
            if ($scanReference === '' || strlen($scanReference) > 80 || preg_match('/^[=+@-]/', $scanReference) || preg_match('/[\r\n]/', $scanReference)) {
                fail('Enter a valid pallet reference.', 400);
            }
            $pallets = $this->draftPallets($draft);
            foreach ($pallets as $p) {
                if (strcasecmp($p['pallet'], $scanReference) === 0) {
                    fail('Use a different pallet reference.');
                }
            }
            if (!in_array($draft['deviceId'] ?? '', $devices, true)) {
                fail('Connect the assigned handheld first.');
            }
            foreach ($this->palletManifests() as $other) {
                if (($other['deviceId'] ?? '') === ($draft['deviceId'] ?? '') && ($other['status'] ?? '') === 'Awaiting pallet scan') {
                    fail('That handheld already has a pending pallet scan.');
                }
            }
            return $this->savePalletManifest(array_merge($draft, [
                'pallets' => $pallets,
                'scanReference' => $scanReference,
                'palletEpc' => null,
                'csv' => null,
                'status' => 'Awaiting pallet scan',
            ]));
        }
        if ($action === 'generate' && ($draft['status'] ?? '') === 'Pallet scanned') {
            $epcsIn = $input['epcs'] ?? null;
            if (!is_array($epcsIn) || count($epcsIn) < 1 || count($epcsIn) > 499) {
                fail('Select 1 to 499 cartons.', 400);
            }
            $this->palletAvailable((string)$draft['palletEpc'], $draft['id']);
            $epcs = array_values(array_unique(array_map('normalizeEpc', $epcsIn)));
            if (count($epcs) !== count($epcsIn) || !is_array($input['locations'] ?? null) || count($input['locations']) !== count($epcs)) {
                fail('Preview the selected cartons again.', 400);
            }
            $assigned = array_flip($this->assignedCartonEpcs());
            $cartons = [];
            foreach ($epcs as $idx => $epc) {
                if (isset($assigned[$epc])) {
                    fail('A selected carton is already assigned to a pallet. Refresh and choose an unassigned carton.');
                }
                $carton = $this->stock($epc);
                if ($carton === null || $carton['state'] !== 'available') {
                    fail('A selected carton is no longer available. Review the selection.');
                }
                if ($carton['location'] !== $input['locations'][$idx]) {
                    fail('A pickup location changed. Preview the selected cartons again.');
                }
                $cartons[] = ['epc' => $epc, 'sku' => $carton['sku'], 'carton' => $carton['carton'], 'location' => $carton['location']];
            }
            $pallets = array_merge($this->draftPallets($draft), [[
                'pallet' => $draft['scanReference'] ?? $draft['reference'],
                'palletEpc' => $draft['palletEpc'],
                'cartons' => $cartons,
            ]]);
            return $this->savePalletManifest($this->readyManifest($draft, $pallets, [$draft['id']]));
        }
        if ($action === 'session' && ($draft['status'] ?? '') === 'Manifest ready') {
            foreach ($this->draftPallets($draft) as $pallet) {
                $this->palletAvailable($pallet['palletEpc'], $draft['id']);
                foreach ($pallet['cartons'] ?? [] as $c) {
                    $st = $this->stock($c['epc']);
                    if (($st['state'] ?? '') !== 'available') {
                        fail('A manifest carton is no longer available.');
                    }
                }
            }
            $session = $this->createInternal($user, [
                'testId' => $input['testId'] ?? '',
                'location' => $input['location'] ?? '',
                'source' => 'C72 hardware',
                'csv' => $draft['csv'],
            ], [$draft['id']]);
            unset($draft['sessionRemovedAt']);
            $draft['sessionId'] = $session['id'];
            $draft['status'] = 'Session created';
            return $this->savePalletManifest($draft);
        }
        fail('This action is unavailable for the pallet manifest.');
    }

    private function hasVerifiedMatch(array $s): bool
    {
        if (count($s['manifest']['pallets'] ?? []) > 1) {
            return empty($s['dispatchedAt']) && !empty($s['verifiedBy']) && !empty($s['confirmedAt']) && pendingPallet($s) === null;
        }
        $runs = $s['runs'] ?? [];
        $run = $runs !== [] ? $runs[count($runs) - 1] : null;
        return empty($s['dispatchedAt']) && !empty($s['verifiedBy']) && !empty($s['confirmedAt']) && !empty($s['identified']) &&
            ($run['state'] ?? '') === 'Finished' && ($run['manifestRevision'] ?? null) === ($s['manifest']['revision'] ?? null) &&
            ($run['result']['status'] ?? '') === 'Match' && $this->expectedCartons($s['manifest'] ?? null) > 0;
    }

    private function approveDispatch(array &$s, array $user): void
    {
        $s['acceptedAt'] = nowIso();
        $s['dispatchApproval'] = ['at' => $s['acceptedAt'], 'by' => $user['name'], 'role' => $user['role']];
        $this->audit($s, $user, 'Dispatch approved', (string)$user['name']);
    }

    private function dispatchOne(array $s, array $user): array
    {
        if (!$this->hasVerifiedMatch($s) || (($s['manifest']['matchBy'] ?? '') === 'sku' && count($this->verifiedCartons($s)) !== $this->expectedCartons($s['manifest']))) {
            fail($s['testId'] . ' needs a verified pallet and a clean result.');
        }
        if (empty($s['dispatchApproval'])) {
            if ($user['role'] !== 'admin') {
                fail($s['testId'] . ' needs dispatch approval from the Administrator or Reviewer.');
            }
            $this->approveDispatch($s, $user);
        }
        $cartons = $this->verifiedCartons($s);
        $this->stockOps->stageOutbound($user, $s, array_map(static fn(array $c): string => $c['epc'], $cartons));
        foreach ($cartons as $carton) {
            $before = $this->stock($carton['epc']);
            $changed = $this->db->run("UPDATE `cartons` SET state = 'dispatched', reservation = NULL WHERE epc = ? AND state = 'available'", [$carton['epc']]);
            if ($changed !== 1) {
                fail('Carton ' . $carton['epc'] . ' is no longer on hand for ' . $s['testId'] . '.');
            }
            $this->stockOps->dispatch($user, $s, $before, $this->stock($carton['epc']));
        }
        $s['dispatchedAt'] = nowIso();
        $this->audit($s, $user, 'Dispatch confirmed', count($cartons) . ' cartons');
        return $this->writeSession($s, $s['workspaceRevision'] + 1);
    }

    public function dispatchSelected(array $user, array $input): array
    {
        return $this->db->atomic(function () use ($user, $input): array {
            if (!in_array($user['role'], DISPATCH_ROLES, true)) {
                fail('Administrator or Supervisor access required.', 403);
            }
            if (($input['confirmed'] ?? false) !== true || empty($input['sessions']) || !is_array($input['sessions'])) {
                fail('Select sessions and confirm dispatch.', 400);
            }
            $results = [];
            $seen = [];
            foreach ($input['sessions'] as $selected) {
                if (empty($selected['id']) || isset($seen[$selected['id']])) {
                    fail('Select each session once.', 400);
                }
                $seen[$selected['id']] = true;
                $s = $this->readSession((string)$selected['id']);
                if ($s === null || !empty($s['removedAt']) || $s['workspaceRevision'] !== ($selected['revision'] ?? null)) {
                    fail('A selected session changed. Refresh and review the selection.');
                }
                $results[] = $this->dispatchOne($s, $user);
            }
            return $results;
        });
    }

    private function reviseManifest(array &$s, array $manifest, string $source): void
    {
        if (!empty($s['manifest'])) {
            $s['manifestRevisions'] ??= [];
            $s['manifestRevisions'][] = $s['manifest'];
        }
        $s['manifest'] = array_merge($manifest, [
            'revision' => (int)($s['manifest']['revision'] ?? 0) + 1,
            'source' => $source,
            'importedAt' => nowIso(),
        ]);
        $s['verifiedBy'] = $s['verifiedAt'] = $s['confirmedAt'] = $s['acceptedAt'] = $s['closedAt'] = $s['closure'] = null;
        $s['identified'] = false;
        unset($s['palletMatches'], $s['packedAt'], $s['dispatchApproval']);
        $s['allocation'] = ['cartons' => $this->expectedCartons($manifest), 'pallets' => count($manifest['pallets'])];
    }

    public function create(array $user, array $input): array
    {
        return $this->db->atomic(function () use ($user, $input): array {
            if ($user['role'] !== 'admin') {
                fail('Administrator access required.', 403);
            }
            return $this->createInternal($user, $input);
        });
    }

    private function createInternal(array $user, array $input, array $ignoreDrafts = []): array
    {
        $testId = trim((string)($input['testId'] ?? ''));
        $location = $this->stockOps->chooseLocation(['location' => trim((string)($input['location'] ?? ''))]);
        if ($testId === '' || strlen($testId) > 80) {
            fail('Enter a valid session ID.', 400);
        }
        foreach ($this->activeSessions() as $existing) {
            if ($existing['testId'] === $testId) {
                fail('That session ID already exists.');
            }
        }
        if (!in_array($input['source'] ?? '', ['C72 hardware', 'Simulation'], true)) {
            fail('Choose a valid reader source.', 400);
        }
        $csv = !empty($input['csv']) ? (string)$input['csv'] : (!empty($input['sample']) ? $this->sample((string)$input['source']) : '');
        $manifest = $csv !== '' ? parseManifest($csv) : null;
        $savedDraft = null;
        if (($manifest['matchBy'] ?? '') === 'sku') {
            $targetCsv = skuManifestCsv($manifest['pallets']);
            foreach ($this->palletManifests() as $draft) {
                if (($draft['status'] ?? '') === 'Manifest ready' && ($draft['matchBy'] ?? '') === 'sku' &&
                    skuManifestCsv($this->draftPallets($draft)) === $targetCsv) {
                    $savedDraft = $draft;
                    break;
                }
            }
            if ($savedDraft !== null) {
                $ignoreDrafts = array_values(array_unique(array_merge($ignoreDrafts, [$savedDraft['id']])));
            }
            $catalog = $this->palletCatalog();
            foreach ($manifest['pallets'] as $pallet) {
                if (!empty($pallet['palletType'])) {
                    $required = count(array_filter($manifest['pallets'], static fn(array $r): bool => ($r['palletType'] ?? '') === $pallet['palletType']));
                    $onHand = count(array_filter($catalog, static fn(array $r): bool => $r['status'] === 'On hand' && matchesPalletIdentifier($pallet['palletType'], $r['identifier'])));
                    if ($onHand < $required) {
                        fail('Too few pallets on hand for ' . $pallet['palletType'] . '.');
                    }
                    continue;
                }
                $reg = null;
                foreach ($catalog as $row) {
                    if ($row['epc'] === $pallet['palletEpc']) {
                        $reg = $row;
                        break;
                    }
                }
                if ($reg === null || ($reg['status'] !== 'On hand' && !($savedDraft !== null && $reg['status'] === 'In manifest'))) {
                    fail('Pallet ' . $pallet['pallet'] . ' is unavailable in pallet inventory.');
                }
            }
        }
        if ($manifest !== null) {
            $this->checkStock($manifest, null, $ignoreDrafts);
            $owners = $this->palletClaimsMap();
            foreach ($manifest['pallets'] as $pallet) {
                if (!empty($pallet['palletType'])) {
                    continue;
                }
                $owner = $owners[$pallet['palletEpc']] ?? null;
                if (($owner['status'] ?? '') === 'Dispatched') {
                    fail('Pallet already dispatched.');
                }
                if ($owner !== null && !in_array($owner['id'], $ignoreDrafts, true)) {
                    fail('Pallet assigned to ' . $owner['reference'] . '.');
                }
            }
        }
        $s = [
            'id' => $input['id'] ?? uuid4(),
            'testId' => $testId,
            'location' => $location,
            'level' => 'Ground',
            'product' => 'Mixed cartons',
            'palletType' => 'Mixed',
            'label' => 'UHF',
            'placement' => 'Long side',
            'wrapping' => 'Unwrapped',
            'shielding' => 'Not tested',
            'method' => 'Walk around the pallet',
            'planned' => 'Outbound pallet check',
            'source' => $input['source'],
            'mode' => 'POC',
            'creator' => $user['name'],
            'createdAt' => nowIso(),
            'runs' => [],
            'logs' => [],
            'allocation' => new stdClass(),
        ];
        if ($manifest !== null) {
            $s['manifest'] = array_merge($manifest, [
                'revision' => 1,
                'source' => !empty($input['sample']) ? 'Sample CSV' : 'Dashboard CSV',
                'demo' => !empty($input['sample']),
                'importedAt' => nowIso(),
            ]);
            $s['allocation'] = ['cartons' => $this->expectedCartons($manifest), 'pallets' => count($manifest['pallets'])];
        }
        $this->audit($s, $user, 'Session created');
        $saved = $this->writeSession($s, 1);
        if ($savedDraft !== null) {
            unset($savedDraft['sessionRemovedAt']);
            $savedDraft['sessionId'] = $saved['id'];
            $savedDraft['status'] = 'Session created';
            $this->savePalletManifest($savedDraft);
        }
        return $saved;
    }

    public function action(array $user, array $input, bool $dashboard): array
    {
        return $this->db->atomic(function () use ($user, $input, $dashboard): array {
            $act = (string)($input['action'] ?? '');
            if (!array_key_exists($act, SESSION_ACTION_ROLES) ||
                (!in_array($user['role'], SESSION_ACTION_ROLES[$act], true) && !($dashboard && $user['role'] === 'admin'))) {
                fail('Action is unavailable for this role.', 403);
            }
            $s = $this->readSession((string)($input['id'] ?? ''));
            if ($s === null || !empty($s['removedAt'])) {
                fail('Session not found.', 404);
            }
            if ($act === 'remove' && ($input['confirmed'] ?? false) === true) {
                if ($s['workspaceRevision'] !== ($input['revision'] ?? null)) {
                    fail('Session changed. Refresh and review it.');
                }
                $s['removedAt'] = nowIso();
                $this->audit($s, $user, 'Session removed');
                foreach ($this->palletManifests() as $draft) {
                    if (($draft['sessionId'] ?? '') === $s['id'] && ($draft['status'] ?? '') === 'Session created') {
                        if (!empty($s['dispatchedAt'])) {
                            $draft['sessionRemovedAt'] = nowIso();
                        } else {
                            unset($draft['sessionId']);
                            $draft['status'] = 'Manifest ready';
                        }
                        $this->savePalletManifest($draft);
                        break;
                    }
                }
                return $this->writeSession($s, $s['workspaceRevision'] + 1);
            }
            if ($act === 'dispatch' && !empty($s['dispatchedAt'])) {
                return $s;
            }
            if ($s['workspaceRevision'] !== ($input['revision'] ?? null) || !empty($s['dispatchedAt'])) {
                fail('Session changed. Refresh and review it.');
            }
            if ($act === 'manifest' && (!empty($s['closedAt']) || (empty($s['confirmedAt']) && empty($s['acceptedAt'])))) {
                $manifest = parseManifest(!empty($input['csv']) ? (string)$input['csv'] : $this->sample((string)$s['source']));
                $this->checkStock($manifest, $s['id']);
                if (!empty($s['closedAt'])) {
                    $this->audit($s, $user, 'Session reopened for manifest change');
                }
                $this->reviseManifest($s, $manifest, 'Dashboard CSV');
                $this->audit($s, $user, 'Manifest saved');
            } elseif ($act === 'reopen' && !empty($s['closedAt']) && ($input['confirmed'] ?? false) === true) {
                $manifest = $this->validateManifest($s['manifest'] ?? null);
                $this->checkStock($manifest, $s['id']);
                $this->reviseManifest($s, $manifest, (string)$s['manifest']['source']);
                $this->audit($s, $user, 'Session reopened');
            } elseif ($act === 'physical' && empty($s['closedAt']) && !empty($s['manifest']) && empty($s['verifiedAt']) && ($input['confirmed'] ?? false) === true) {
                $s['verifiedBy'] = $user['name'];
                $s['verifiedAt'] = nowIso();
                $this->audit($s, $user, 'Physical verification', substr((string)($input['note'] ?? ''), 0, 320));
            } elseif ($act === 'approve' && ($input['confirmed'] ?? false) === true) {
                if (!$this->hasVerifiedMatch($s)) {
                    fail('A clean result and verification are required.');
                }
                if (!empty($s['dispatchApproval'])) {
                    return $s;
                }
                $this->approveDispatch($s, $user);
            } elseif ($act === 'dispatch' && ($input['confirmed'] ?? false) === true) {
                return $this->dispatchOne($s, $user);
            } else {
                fail('Action is unavailable for this role or session state.', 403);
            }
            return $this->writeSession($s, $s['workspaceRevision'] + 1);
        });
    }

    public function verificationClaims(): object|array
    {
        $claims = [];
        foreach ($this->palletManifests() as $draft) {
            if (($draft['status'] ?? '') !== 'Manifest ready') {
                continue;
            }
            foreach ($this->cartonsOf($draft) as $c) {
                $claims[$c['epc']] = $draft['id'];
            }
        }
        foreach ($this->activeSessions() as $session) {
            if (!empty($session['dispatchedAt'])) {
                continue;
            }
            foreach ($this->verifiedCartons($session) as $c) {
                $claims[$c['epc']] = $session['id'];
            }
        }
        return jsonObject($claims);
    }

    private function verificationClaimsMap(): array
    {
        return (array)$this->verificationClaims();
    }

    private function tagConflict(string $epc, ?string $sessionId, array $cartonClaims, array $palletOwners): string
    {
        $pallet = $palletOwners[$epc] ?? null;
        $owner = $cartonClaims[$epc] ?? null;
        $st = $this->stock($epc);
        if (($pallet['status'] ?? '') === 'Dispatched' || ($st['state'] ?? '') === 'dispatched') {
            return 'Tag already dispatched.';
        }
        if ($pallet !== null && $pallet['id'] !== $sessionId) {
            return 'Pallet assigned to ' . (!empty($pallet['reference']) ? $pallet['reference'] : 'another session') . '.';
        }
        if ($owner !== null && $owner !== $sessionId) {
            return 'Carton assigned to another session or manifest.';
        }
        return '';
    }

    private function palletRead(array $s, array $pallet): ?array
    {
        $found = null;
        foreach ($s['palletAttempts'] ?? [] as $attempt) {
            if (($attempt['manifestRevision'] ?? null) !== ($s['manifest']['revision'] ?? null) ||
                ($attempt['palletEpc'] ?? null) !== ($pallet['palletEpc'] ?? null)) {
                continue;
            }
            $epc = !empty($pallet['palletType']) ? ($attempt['actualPalletEpc'] ?? '') : ($pallet['palletEpc'] ?? '');
            $obs = (array)($attempt['observations'] ?? []);
            if ($epc !== '' && array_key_exists($epc, $obs)) {
                $found = $attempt;
            }
        }
        return $found;
    }

    private function hasPalletRead(array $s, array $pallet): bool
    {
        return $this->palletRead($s, $pallet) !== null;
    }

    public function sync(array $user, array $change): array
    {
        return $this->db->atomic(function () use ($user, $change): array {
            if ($user['role'] === 'reviewer') {
                fail('Reviewer access is read-only.', 403);
            }
            $incoming = $change['session'] ?? null;
            if (!is_array($incoming) ||
                !preg_match('/^[a-f0-9-]{36}$/i', (string)($incoming['id'] ?? '')) ||
                !preg_match('/^[a-f0-9-]{36}$/i', (string)($change['operationId'] ?? ''))) {
                fail('Invalid session or operation ID.', 400);
            }
            $prior = $this->db->getOne('SELECT * FROM `operations` WHERE id = ?', [$change['operationId']]);
            if ($prior !== null) {
                $formerDemoAccount = $user['id'] === 'testing' && $prior['actor'] === 'handheld';
                if (($prior['actor'] !== $user['id'] && !$formerDemoAccount) || $prior['session'] !== $incoming['id']) {
                    fail('Operation ID is already in use.');
                }
                return $this->readSession((string)$prior['session']);
            }
            $s = $this->readSession((string)$incoming['id']);
            if ($s === null) {
                if (($change['revision'] ?? null) !== 0) {
                    fail('Session no longer exists.');
                }
                $loc = ($incoming['location'] ?? '') === 'Demo staging area' ? OUTBOUND_STAGING : ($incoming['location'] ?? '');
                $s = $this->createInternal($user, array_merge($incoming, ['location' => $loc]));
            } elseif (!empty($s['removedAt']) || $s['workspaceRevision'] !== ($change['revision'] ?? null) || !empty($s['closedAt']) ||
                ((!empty($s['dispatchedAt']) || !empty($s['acceptedAt'])) && empty($incoming['closedAt']))) {
                fail('Server session changed. Local evidence is still on the handheld.');
            }

            $wasConfirmed = !empty($s['confirmedAt']);
            $scanConflict = null;
            $evidenceEditable = empty($s['dispatchedAt']) && empty($s['acceptedAt']);

            if ($evidenceEditable && $user['role'] === 'admin') {
                if (($incoming['manifest']['revision'] ?? null) !== ($s['manifest']['revision'] ?? null) && !empty($incoming['manifest']) && empty($s['confirmedAt'])) {
                    $verified = $this->validateManifest($incoming['manifest']);
                    $this->checkStock($verified, $s['id']);
                    if (!empty($s['manifest'])) {
                        $s['manifestRevisions'] ??= [];
                        $s['manifestRevisions'][] = $s['manifest'];
                    }
                    $s['manifest'] = array_merge($verified, [
                        'revision' => (int)($s['manifest']['revision'] ?? 0) + 1,
                        'source' => $incoming['manifest']['source'] ?? null,
                        'importedAt' => nowIso(),
                    ]);
                    $s['allocation'] = ['cartons' => $this->expectedCartons($verified), 'pallets' => count($verified['pallets'])];
                    $s['verifiedAt'] = $s['verifiedBy'] = null;
                    $s['identified'] = false;
                    unset($s['palletMatches']);
                    $this->audit($s, $user, 'Manifest saved');
                }
            } elseif ($evidenceEditable && $user['role'] === 'supervisor') {
                if (!empty($incoming['verifiedAt']) && empty($s['verifiedAt']) && !empty($s['manifest']) &&
                    ($incoming['manifest']['revision'] ?? null) === ($s['manifest']['revision'] ?? null)) {
                    $s['verifiedBy'] = $user['name'];
                    $s['verifiedAt'] = nowIso();
                    $this->audit($s, $user, 'Physical verification');
                }
            } elseif ($evidenceEditable && $user['role'] === 'operator') {
                $previousAttempts = $s['palletAttempts'] ?? [];
                $attemptIds = [];
                foreach ($previousAttempts as $a) {
                    $attemptIds[(string)($a['id'] ?? $a['startedAt'])] = true;
                }
                $extraAttempts = array_values(array_filter(
                    $incoming['palletAttempts'] ?? [],
                    static fn(array $a): bool => !isset($attemptIds[(string)($a['id'] ?? $a['startedAt'])])
                ));
                $runIds = [];
                foreach ($s['runs'] ?? [] as $r) {
                    $runIds[$r['id']] = true;
                }
                $newRuns = array_values(array_filter(
                    $incoming['runs'] ?? [],
                    static fn(array $r): bool => ($r['state'] ?? '') !== 'Reading' && !isset($runIds[$r['id']])
                ));
                if (empty($s['verifiedAt']) || empty($s['manifest'])) {
                    if ($extraAttempts !== [] || $newRuns !== [] || !empty($incoming['confirmedAt']) || !empty($incoming['palletMatches'])) {
                        fail('The server requires verification before scanning.');
                    }
                    return $s;
                }
                $multi = count($s['manifest']['pallets']) > 1;
                $cartonOwners = $this->verificationClaimsMap();
                $palletOwners = $this->palletClaimsMap();
                $conflictFn = fn(string $epc): string => $this->tagConflict($epc, $s['id'], $cartonOwners, $palletOwners);
                $found = $incoming['manifest']['palletEpc'] ?? null;
                $rejected = null;
                foreach ($extraAttempts as $attempt) {
                    $epc = $attempt['actualPalletEpc'] ?? $attempt['palletEpc'] ?? ((!$multi && !empty($incoming['identified'])) ? $found : null);
                    if ($epc && $conflictFn($epc) !== '' && (($attempt['result'] ?? '') === 'Identified' || !empty($incoming['identified']))) {
                        $rejected = $attempt;
                        break;
                    }
                }
                if ($rejected !== null) {
                    $scanConflict = $conflictFn((string)($rejected['actualPalletEpc'] ?? $rejected['palletEpc'] ?? $found));
                    $s['identified'] = false;
                    $s['palletAttempts'] ??= [];
                    foreach ($extraAttempts as $attempt) {
                        $attempt['result'] = 'Unconfirmed';
                        unset($attempt['palletEpc'], $attempt['actualPalletEpc']);
                        $attempt['actor'] = $user['name'];
                        $s['palletAttempts'][] = $attempt;
                    }
                    foreach ($newRuns as $run) {
                        $epcs = array_map('normalizeEpc', array_keys((array)($run['observations'] ?? [])));
                        $target = null;
                        foreach ($s['manifest']['pallets'] as $pallet) {
                            if ($pallet['palletEpc'] === ($run['palletEpc'] ?? null)) {
                                $target = $pallet;
                                break;
                            }
                        }
                        $manifest = $target !== null ? lockTo($s['manifest'], $target) : $s['manifest'];
                        $blockedSet = array_flip($epcs);
                        $s['runs'][] = array_merge($run, [
                            'operator' => $user['name'],
                            'state' => 'Interrupted',
                            'error' => $scanConflict,
                            'result' => compareOutbound($manifest, $epcs, [], $blockedSet),
                        ]);
                    }
                    $this->audit($s, $user, 'Pallet scan blocked', $scanConflict);
                    $this->db->run('INSERT INTO `operations` (id, actor, session) VALUES (?, ?, ?)', [$change['operationId'], $user['id'], $s['id']]);
                    $saved = $this->writeSession($s, $s['workspaceRevision'] + 1);
                    $saved['scanConflict'] = $scanConflict;
                    return $saved;
                }
                if (!$multi && empty($s['identified']) && !empty($incoming['identified']) && $found) {
                    $locked = null;
                    foreach ($s['manifest']['pallets'] as $p) {
                        if ($p['palletEpc'] === $found) {
                            $locked = $p;
                            break;
                        }
                    }
                    $attemptsIn = $incoming['palletAttempts'] ?? [];
                    $observation = $attemptsIn !== [] ? (array)($attemptsIn[count($attemptsIn) - 1]['observations'] ?? []) : [];
                    $lockOk = false;
                    if ($locked !== null) {
                        if (!empty($locked['palletType'])) {
                            foreach ($extraAttempts as $a) {
                                if (($a['palletEpc'] ?? null) === $found && !empty($a['actualPalletEpc'])) {
                                    $lockOk = true;
                                    break;
                                }
                            }
                        } elseif ($conflictFn($locked['palletEpc']) === '') {
                            $candidates = array_merge([$locked['palletEpc']], array_map(static fn(array $c): string => $c['epc'], $locked['cartons'] ?? []));
                            foreach ($candidates as $epc) {
                                if (array_key_exists($epc, $observation) && $conflictFn($epc) === '') {
                                    $lockOk = true;
                                    break;
                                }
                            }
                        }
                    }
                    if ($lockOk) {
                        $s['manifest'] = array_merge($s['manifest'], $locked);
                        $s['identified'] = true;
                    }
                }
                $catalog = $this->palletCatalog();
                foreach ($extraAttempts as $attempt) {
                    $target = null;
                    foreach ($s['manifest']['pallets'] as $p) {
                        if ($p['palletEpc'] === ($attempt['palletEpc'] ?? null)) {
                            $target = $p;
                            break;
                        }
                    }
                    if (!empty($target['palletType'])) {
                        $actual = normalizeEpc($attempt['actualPalletEpc'] ?? '');
                        $registered = null;
                        foreach ($catalog as $row) {
                            if ($row['epc'] === $actual) {
                                $registered = $row;
                                break;
                            }
                        }
                        $blocked = $conflictFn($actual);
                        if ($blocked !== '') {
                            fail($blocked);
                        }
                        $sameSlot = ($this->palletRead($s, $target)['actualPalletEpc'] ?? null) === $actual;
                        $alreadyUsed = false;
                        foreach ($s['manifest']['pallets'] as $p) {
                            if ($p['palletEpc'] !== $target['palletEpc'] && ($this->palletRead($s, $p)['actualPalletEpc'] ?? null) === $actual) {
                                $alreadyUsed = true;
                                break;
                            }
                        }
                        $obs = (array)($attempt['observations'] ?? []);
                        if (($attempt['manifestRevision'] ?? null) !== $s['manifest']['revision'] ||
                            ($attempt['result'] ?? '') !== 'Identified' ||
                            !array_key_exists($actual, $obs) || $registered === null ||
                            !matchesPalletIdentifier($target['palletType'], $registered['identifier']) ||
                            ($registered['status'] !== 'On hand' && !$sameSlot) || $alreadyUsed) {
                            fail('Pallet EPC is unavailable or does not match the required pallet type.');
                        }
                    }
                    $s['palletAttempts'] ??= [];
                    $s['palletAttempts'][] = array_merge($attempt, ['actor' => $user['name']]);
                }
                $skuConfirmedIds = array_flip(array_merge(
                    array_values((array)($s['palletMatches'] ?? [])),
                    array_values((array)($incoming['palletMatches'] ?? []))
                ));
                $skuTaken = [];
                $rememberSkuMatch = function (array $run) use (&$skuTaken, $s, $skuConfirmedIds): void {
                    if (($s['manifest']['matchBy'] ?? '') === 'sku' && isset($skuConfirmedIds[$run['id']]) &&
                        ($run['state'] ?? '') === 'Finished' && ($run['result']['status'] ?? '') === 'Match') {
                        foreach ($run['result']['matched'] ?? [] as $epc) {
                            $skuTaken[$epc] = $run['palletEpc'] ?? '';
                        }
                    }
                };
                foreach ($s['runs'] ?? [] as $run) {
                    if (($run['manifestRevision'] ?? null) === $s['manifest']['revision']) {
                        $rememberSkuMatch($run);
                    }
                }
                foreach ($newRuns as $incomingRun) {
                    if (isset($runIds[$incomingRun['id']])) {
                        continue;
                    }
                    $runIds[$incomingRun['id']] = true;
                    $target = null;
                    foreach ($s['manifest']['pallets'] as $pallet) {
                        if ($pallet['palletEpc'] === ($incomingRun['palletEpc'] ?? null)) {
                            $target = $pallet;
                            break;
                        }
                    }
                    $identified = $multi
                        ? ($target !== null && empty($s['palletMatches'][$target['palletEpc']]) && $this->hasPalletRead($s, $target))
                        : !empty($s['identified']);
                    $planned = $target ?? (!$multi ? $s['manifest'] : null);
                    $actual = !empty($planned['palletType']) ? ($this->palletRead($s, $planned)['actualPalletEpc'] ?? null) : ($planned['palletEpc'] ?? null);
                    if ($actual && $conflictFn($actual) !== '') {
                        fail($conflictFn($actual));
                    }
                    if (!$identified || ($incomingRun['manifestRevision'] ?? null) !== $s['manifest']['revision'] ||
                        !in_array($incomingRun['state'] ?? '', ['Finished', 'Interrupted'], true) ||
                        ($incomingRun['source'] ?? '') !== $s['source']) {
                        fail('Run does not match the current verified manifest.');
                    }
                    $observations = $incomingRun['observations'] ?? [];
                    $manifest = $multi ? lockTo($s['manifest'], $target) : $s['manifest'];
                    if (!empty($target['palletType'])) {
                        $manifest['actualPalletEpc'] = $actual;
                    }
                    $epcs = array_map('normalizeEpc', array_keys((array)$observations));
                    $blocked = [];
                    foreach ($epcs as $epc) {
                        if ($conflictFn($epc) !== '' || (isset($skuTaken[$epc]) && $skuTaken[$epc] !== ($incomingRun['palletEpc'] ?? ''))) {
                            $blocked[] = $epc;
                        }
                    }
                    $blockedSet = array_flip($blocked);
                    $result = compareOutbound($manifest, $epcs, !empty($manifest['requirements']) ? $this->stockOps->inventory() : [], $blockedSet);
                    if ($blocked !== []) {
                        if ($scanConflict === null) {
                            $firstReason = '';
                            foreach ($blocked as $bEpc) {
                                $msg = $conflictFn($bEpc);
                                if ($msg !== '') {
                                    $firstReason = $msg;
                                    break;
                                }
                            }
                            $scanConflict = $firstReason !== '' ? $firstReason : 'Carton already used on another pallet in this session.';
                        }
                    }
                    $extraSkus = [];
                    foreach ($result['extra'] as $epc) {
                        $c = $this->stock($epc);
                        if ($c !== null) {
                            $extraSkus[$epc] = demoSku(cartonSku($c));
                        }
                    }
                    if ($extraSkus !== []) {
                        $result['extraSkus'] = $extraSkus;
                    }
                    $run = array_merge($incomingRun, [
                        'operator' => $user['name'],
                        'observations' => jsonObject($observations),
                        'result' => $result,
                    ]);
                    $s['runs'][] = $run;
                    $rememberSkuMatch($run);
                    $this->audit($s, $user, 'Carton scan recorded', ($incomingRun['state'] ?? '') === 'Interrupted' ? 'Interrupted' : $result['status']);
                }
                if ($multi) {
                    $confirmed = array_flip(array_values((array)($incoming['palletMatches'] ?? [])));
                    for ($target = pendingPallet($s); $target !== null; $target = pendingPallet($s)) {
                        $run = null;
                        foreach ($s['runs'] as $candidate) {
                            if (($candidate['manifestRevision'] ?? null) === $s['manifest']['revision'] &&
                                ($candidate['palletEpc'] ?? null) === $target['palletEpc']) {
                                $run = $candidate;
                            }
                        }
                        if ($run === null || !isset($confirmed[$run['id']]) || ($run['state'] ?? '') !== 'Finished' || ($run['result']['status'] ?? '') !== 'Match') {
                            break;
                        }
                        if (($s['manifest']['matchBy'] ?? '') === 'sku') {
                            $used = [];
                            foreach ($s['runs'] as $candidate) {
                                if (in_array($candidate['id'], array_values((array)($s['palletMatches'] ?? [])), true)) {
                                    foreach ($candidate['result']['matched'] ?? [] as $mEpc) {
                                        $used[$mEpc] = true;
                                    }
                                }
                            }
                            $overlap = false;
                            foreach ($run['result']['matched'] ?? [] as $mEpc) {
                                if (isset($used[$mEpc])) {
                                    $overlap = true;
                                    break;
                                }
                            }
                            if ($overlap) {
                                break;
                            }
                        }
                        $s['palletMatches'] ??= [];
                        $s['palletMatches'][$target['palletEpc']] = $run['id'];
                        $this->audit($s, $user, 'Clean match confirmed', $target['pallet']);
                    }
                    $target = pendingPallet($s);
                    $s['identified'] = $target !== null && $this->hasPalletRead($s, $target);
                    if ($s['identified']) {
                        $s['manifest'] = lockTo($s['manifest'], $target);
                    }
                    $s['confirmedAt'] = $target !== null ? null : ($s['confirmedAt'] ?? nowIso());
                }
                $lastRun = $s['runs'] !== [] ? $s['runs'][count($s['runs']) - 1] : null;
                if (!$multi && !empty($incoming['confirmedAt']) && !empty($s['identified']) &&
                    ($lastRun['state'] ?? '') === 'Finished' && ($lastRun['result']['status'] ?? '') === 'Match') {
                    if (empty($s['confirmedAt'])) {
                        $this->audit($s, $user, 'Clean match confirmed');
                    }
                    $s['confirmedAt'] ??= nowIso();
                }
            }

            if (!$wasConfirmed && $this->hasVerifiedMatch($s)) {
                $this->stockOps->stageOutbound($user, $s, array_map(static fn(array $c): string => $c['epc'], $this->verifiedCartons($s)));
            }

            if (!empty($incoming['closedAt']) && !($scanConflict && !$this->hasVerifiedMatch($s))) {
                $review = $incoming['closure'] ?? null;
                if (!is_array($review) || !is_string($review['coverage'] ?? null) || strlen($review['coverage']) > 500 ||
                    ($review['reviewed'] ?? false) !== true || !canCloseSession($s, $review, $user['role'])) {
                    fail('Review the saved scans and enter the coverage before closing the session.');
                }
                $s['closedAt'] = nowIso();
                $s['closure'] = ['coverage' => trim($review['coverage']), 'actor' => $user['name'], 'reviewed' => true];
                $this->audit($s, $user, 'Session closed', $s['closure']['coverage']);
            }

            $this->db->run('INSERT INTO `operations` (id, actor, session) VALUES (?, ?, ?)', [$change['operationId'], $user['id'], $s['id']]);
            $saved = $this->writeSession($s, $s['workspaceRevision'] + 1);
            if ($scanConflict !== null) {
                $saved['scanConflict'] = $scanConflict;
            }
            return $saved;
        });
    }

    public function outbound(array $user, array $records): array
    {
        $approvable = [];
        $dispatchable = [];
        if (in_array($user['role'], REVIEW_ROLES, true)) {
            foreach ($records as $s) {
                if (empty($s['dispatchApproval']) && $this->hasVerifiedMatch($s)) {
                    $approvable[] = $s['id'];
                }
            }
        }
        if (in_array($user['role'], DISPATCH_ROLES, true)) {
            foreach ($records as $s) {
                if ((!empty($s['dispatchApproval']) || $user['role'] === 'admin') && $this->hasVerifiedMatch($s)) {
                    $allAvail = true;
                    foreach ($this->verifiedCartons($s) as $c) {
                        if (($this->stock($c['epc'])['state'] ?? '') !== 'available') {
                            $allAvail = false;
                            break;
                        }
                    }
                    if ($allAvail) {
                        $dispatchable[] = $s['id'];
                    }
                }
            }
        }
        return ['approvable' => $approvable, 'dispatchable' => $dispatchable];
    }

    public function records(): array
    {
        return ['sessions' => $this->activeSessions()];
    }

    public function stockTasks(): array
    {
        return [
            'tasks' => array_map([$this->stockOps, 'tagged'], $this->stockOps->tasks()),
            'locations' => $this->stockOps->locations(),
            'locationRecords' => $this->stockOps->locationRecords(),
            'warehouseLocations' => $this->stockOps->warehouseLocations(),
            'countLocations' => $this->stockOps->countLocations(),
            'outboundLocations' => $this->stockOps->outboundLocations(),
            'stagingLocation' => OUTBOUND_STAGING,
            'events' => $this->stockOps->events(),
        ];
    }

    public function stockCommand(array $user, array $input, bool $dashboard): array
    {
        return $this->db->atomic(function () use ($user, $input, $dashboard): array {
            $act = (string)($input['action'] ?? '');
            if ($act === 'receive-carton') {
                $epc = normalizeEpc($input['epc'] ?? '');
                $conflict = $this->tagConflict($epc, null, $this->verificationClaimsMap(), $this->palletClaimsMap());
                if ($conflict !== '') {
                    fail($conflict);
                }
                if ($this->db->getOne('SELECT 1 AS ok FROM `pallet_inventory` WHERE epc = ?', [$epc]) !== null) {
                    fail('This EPC is already registered to a pallet.');
                }
            }
            $location = null;
            if ($dashboard && $user['role'] === 'admin' && in_array($act, ['archive-location', 'rename-location'], true)) {
                foreach ($this->stockOps->locationRecords() as $row) {
                    if ($row['id'] === ($input['locationId'] ?? '') && !$row['archived'] && !$row['protected']) {
                        $location = $row;
                        break;
                    }
                }
            }
            $sessionsAtLocation = $location !== null
                ? array_values(array_filter($this->activeSessions(), static fn(array $s): bool => empty($s['closedAt']) && empty($s['dispatchedAt']) && $s['location'] === $location['name']))
                : [];
            if ($act === 'archive-location' && $sessionsAtLocation !== []) {
                fail('Close the outbound sessions at this location before archiving.');
            }
            if ($act === 'receive-carton') {
                $sizes = array_values(array_filter($this->inventoryOptions()['cartonSizes'], static fn(array $o): bool => empty($o['archived'])));
                $defaultSize = null;
                foreach ($sizes as $o) {
                    if ($o['code'] === 'M') {
                        $defaultSize = $o['code'];
                        break;
                    }
                }
                $size = !empty($input['size']) ? (string)$input['size'] : ($defaultSize ?? $sizes[0]['code']);
                $hasSize = array_filter($sizes, static fn(array $o): bool => $o['code'] === $size) !== [];
                if (empty($input['variantSku']) && !$hasSize) {
                    fail('Choose a configured carton size.', 400);
                }
                $input['size'] = $size;
                $input['cartonSizes'] = $sizes;
            }
            $capacityBefore = $act === 'remove-carton' ? $this->skuCapacity() : null;
            $result = $this->stockOps->command(
                $user,
                $input,
                fn(array $u, array $i): array => $this->createInternal($u, $i),
                $dashboard,
                function (string $epc) use ($act): bool {
                    foreach ($this->activeSessions() as $s) {
                        if (empty($s['dispatchedAt']) || $act === 'untag') {
                            foreach (array_merge($this->verifiedCartons($s), $this->cartonsOf($s['manifest'] ?? null)) as $c) {
                                if ($c['epc'] === $epc) {
                                    return true;
                                }
                            }
                        }
                    }
                    foreach ($this->palletManifests() as $d) {
                        if (!in_array($d['status'] ?? '', ['Cancelled', 'Session created'], true)) {
                            foreach ($this->draftPallets($d) as $p) {
                                foreach ($p['cartons'] ?? [] as $c) {
                                    if ($c['epc'] === $epc) {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                    return false;
                }
            );
            if ($capacityBefore !== null) {
                foreach ($this->skuCapacity() as $sku => $count) {
                    if ($count < min(0, $capacityBefore[$sku] ?? 0)) {
                        fail('This SKU is needed for an open manifest or session.');
                    }
                }
            }
            if ($act === 'rename-location' && !empty($result['reference']) && $result['reference'] !== ($location['name'] ?? null)) {
                foreach ($sessionsAtLocation as $session) {
                    $session['location'] = $result['reference'];
                    $this->audit($session, $user, 'Location renamed', $location['name'] . ' to ' . $result['reference']);
                    $this->writeSession($session, $session['workspaceRevision'] + 1);
                }
            }
            return $result;
        });
    }
}
