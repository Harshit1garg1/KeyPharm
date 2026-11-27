<?php

declare(strict_types=1);

const INBOUND_STAGING = 'Inbound staging';
const OUTBOUND_STAGING = 'Outbound staging';
const PROTECTED_LOCATIONS = [INBOUND_STAGING, OUTBOUND_STAGING, 'Hold'];
const DEFAULT_LOCATIONS = ['Storage', INBOUND_STAGING, OUTBOUND_STAGING, 'Hold'];
const LEGACY_LOCATIONS = ['receiving' => INBOUND_STAGING, 'staging' => OUTBOUND_STAGING];
const RECEIPT_ID = 'KP-IN-40';
const OUTBOUND_REF = 'KP-RECEIVED-40';
const DEMO_PALLET = 'D60000000000000000000001';
const UNKNOWN_TAG = 'F60000000000000000000001';
const RECEIPT_HEADERS = ['receipt_ref', 'source_ref', 'destination_location', 'sku', 'expected_cartons', 'carton_id', 'epc'];
const RECEIPT_OPTIONAL_HEADERS = ['product_identifier', 'batch_lot', 'units_per_carton'];
const DEMO_SIZES = ['XS', 'S', 'M', 'L'];

final class StockWorkflows
{
    private WorkspaceDb $db;
    private array $products;
    /** @var callable */
    private $onAudit;

    public function __construct(WorkspaceDb $db, array $products, ?callable $onAudit = null)
    {
        $this->db = $db;
        $this->products = $products;
        $this->onAudit = $onAudit ?? static function (): void {};
    }

    public static function inboundEpc(int $number): string
    {
        return 'D5' . str_pad(strtoupper(dechex($number)), 22, '0', STR_PAD_LEFT);
    }

    private function legacyLocation(mixed $name): string
    {
        $str = (string)($name ?? '');
        return LEGACY_LOCATIONS[strtolower($str)] ?? $str;
    }

    private function field(mixed $value, string $label): string
    {
        if (!is_string($value) || trim($value) === '' || strlen($value) > 240) {
            fail('Enter ' . $label . '.', 400);
        }
        return trim($value);
    }

    private function makeCsv(array $header, array $rows): string
    {
        $lines = [implode(',', $header)];
        foreach ($rows as $row) {
            $lines[] = implode(',', array_map('csvCell', $row));
        }
        return implode("\r\n", $lines) . "\r\n";
    }

    public function nextCartonLabel(string $sku, ?string $size = null): string
    {
        $size ??= DEMO_SIZES[random_int(0, count(DEMO_SIZES) - 1)];
        $rows = $this->db->getAll('SELECT carton FROM `cartons` WHERE sku = ?', [$sku]);
        $highest = 0;
        $prefix = $sku . '-';
        foreach ($rows as $row) {
            $carton = (string)$row['carton'];
            if (str_starts_with($carton, $prefix) && preg_match('/^[A-Z0-9]+-(\d+)$/i', substr($carton, strlen($prefix)), $m)) {
                $highest = max($highest, (int)$m[1]);
            }
        }
        return $prefix . $size . '-' . str_pad((string)($highest + 1), 2, '0', STR_PAD_LEFT);
    }

    public function ensureLocationsSeeded(): void
    {
        $names = [];
        foreach (DEFAULT_LOCATIONS as $name) {
            $names[] = $name;
            $this->db->run(
                'INSERT IGNORE INTO `workspace_locations` (id, name, archived) VALUES (?, ?, 0)',
                [$name, $name]
            );
        }
        $placeholders = implode(',', array_fill(0, 3, '?'));
        $this->db->run(
            "UPDATE `workspace_locations` SET archived = 0 WHERE name IN ($placeholders)",
            [INBOUND_STAGING, OUTBOUND_STAGING, 'Hold']
        );
    }

    public function locationRecords(): array
    {
        $rows = $this->db->getAll(
            "SELECT id, name, archived FROM `workspace_locations` ORDER BY archived,
            CASE name WHEN 'Storage' THEN 0 WHEN 'Inbound staging' THEN 1 WHEN 'Outbound staging' THEN 2 WHEN 'Hold' THEN 4 ELSE 3 END, name"
        );
        return array_map(static function (array $row): array {
            return [
                'id' => (string)$row['id'],
                'name' => (string)$row['name'],
                'archived' => (int)$row['archived'],
                'protected' => in_array($row['name'], PROTECTED_LOCATIONS, true),
            ];
        }, $rows);
    }

    public function locations(): array
    {
        return array_values(array_map(
            static fn(array $r): string => $r['name'],
            array_filter($this->locationRecords(), static fn(array $r): bool => !$r['archived'])
        ));
    }

    public function warehouseLocations(): array
    {
        return array_values(array_map(
            static fn(array $r): string => $r['name'],
            array_filter($this->locationRecords(), static fn(array $r): bool => !$r['archived'] && !$r['protected'])
        ));
    }

    public function countLocations(): array
    {
        return $this->locations();
    }

    public function outboundLocations(): array
    {
        return array_merge($this->warehouseLocations(), [OUTBOUND_STAGING]);
    }

    private function preferredLocation(string $id): ?string
    {
        $saved = $this->db->getOne('SELECT name FROM `workspace_locations` WHERE id = ? AND archived = 0', [$id]);
        if ($saved !== null) {
            return (string)$saved['name'];
        }
        foreach ($this->locations() as $name) {
            if ($name !== 'Hold') {
                return $name;
            }
        }
        return null;
    }

    public function carton(string $epc): ?array
    {
        $row = $this->db->getOne('SELECT * FROM `cartons` WHERE epc = ?', [$epc]);
        return $row === null ? null : $this->normalizeCartonRow($row);
    }

    private function normalizeCartonRow(array $row): array
    {
        $out = [
            'epc' => (string)$row['epc'],
            'carton' => (string)$row['carton'],
            'sku' => (string)$row['sku'],
            'physical' => (int)$row['physical'],
            'state' => (string)$row['state'],
            'reservation' => $row['reservation'],
            'location' => (string)$row['location'],
            'variant_size' => $row['variant_size'],
            'batch_lot' => $row['batch_lot'],
            'units_per_carton' => $row['units_per_carton'] === null ? null : (int)$row['units_per_carton'],
        ];
        if (array_key_exists('registered', $row)) {
            $out['registered'] = (int)$row['registered'];
        }
        return $out;
    }

    private function readTask(array $row): array
    {
        $decoded = json_decode((string)$row['body'], true);
        if (!is_array($decoded)) {
            $decoded = [];
        }
        $decoded['revision'] = (int)$row['revision'];
        return $this->normalizeTaskShape($decoded);
    }

    private function normalizeTaskShape(array $task): array
    {
        if (array_key_exists('quantities', $task) && is_array($task['quantities'])) {
            $task['quantities'] = jsonObject($task['quantities']);
        }
        if (array_key_exists('receivedBySku', $task) && is_array($task['receivedBySku'])) {
            $task['receivedBySku'] = jsonObject($task['receivedBySku']);
        }
        if (array_key_exists('cartonDetails', $task) && is_array($task['cartonDetails'])) {
            $task['cartonDetails'] = jsonObject($task['cartonDetails']);
        }
        $task['runs'] = array_map(static function (array $run): array {
            $run['observations'] = jsonObject($run['observations'] ?? []);
            $run['bySku'] = jsonObject($run['bySku'] ?? []);
            return $run;
        }, $task['runs'] ?? []);
        return $task;
    }

    public function get(string $id): ?array
    {
        $row = $this->db->getOne('SELECT id, revision, body FROM `stock_tasks` WHERE id = ?', [$id]);
        return $row === null ? null : $this->readTask($row);
    }

    public function tasks(): array
    {
        $rows = $this->db->getAll('SELECT id, revision, body FROM `stock_tasks` ORDER BY seq DESC');
        return array_map([$this, 'readTask'], $rows);
    }

    public function inventory(): array
    {
        $rows = $this->db->getAll(
            "SELECT c.*, EXISTS (SELECT 1 FROM `stock_mappings` m WHERE m.epc = c.epc) AS registered
            FROM `cartons` c WHERE c.state NOT IN ('expected', 'removed') ORDER BY c.sku, c.carton"
        );
        return array_map([$this, 'normalizeCartonRow'], $rows);
    }

    public function tagged(array $task): array
    {
        if (($task['type'] ?? '') !== 'receipt') {
            return $task;
        }
        $list = [];
        foreach ($task['received'] ?? [] as $epc) {
            $c = $this->carton((string)$epc);
            if ($c !== null) {
                $list[] = [
                    'epc' => $c['epc'],
                    'sku' => $c['sku'],
                    'reference' => $c['carton'],
                    'state' => $c['state'],
                ];
            }
        }
        $task['tagged'] = $list;
        return $task;
    }

    private function stockVersion(): int
    {
        $row = $this->db->getOne(
            "SELECT COALESCE(MAX(id), 0) AS version FROM `stock_events`
            WHERE action NOT IN ('Receipt cancelled', 'Count cancelled', 'Pallet removed')"
        );
        return (int)($row['version'] ?? 0);
    }

    private function syncTaskRuns(array $task): void
    {
        $this->db->run('DELETE FROM `stock_task_runs` WHERE task_id = ?', [$task['id']]);
        foreach ($task['runs'] ?? [] as $index => $run) {
            $matched = count($run['found'] ?? []);
            $missing = count($run['missing'] ?? []);
            $unexpected = count($run['unexpected'] ?? []);
            $unknown = count($run['unknown'] ?? []);
            $outstanding = $run['outstanding'] ?? null;
            $expected = $matched + ($outstanding !== null ? (int)$outstanding : $missing);
            $this->db->run(
                'INSERT INTO `stock_task_runs`
                (id, task_id, task_type, actor, source, identifier, expected_count, matched_count, missing_count, unexpected_count, unknown_count, outstanding, recorded_at, confirmed_at, confirmed_by, superseded_at, reason, observations_json, result_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [
                    $run['id'] ?? ($task['id'] . ':run:' . $index),
                    $task['id'],
                    $task['type'],
                    $run['actor'] ?? null,
                    $run['source'] ?? null,
                    $run['identifier'] ?? null,
                    $expected,
                    $matched,
                    $missing,
                    $unexpected,
                    $unknown,
                    $outstanding,
                    $run['at'] ?? null,
                    $run['confirmedAt'] ?? null,
                    $run['confirmedBy'] ?? null,
                    $run['supersededAt'] ?? null,
                    $run['reason'] ?? null,
                    jsonEncodeStrict(jsonObject($run['observations'] ?? [])),
                    jsonEncodeStrict([
                        'found' => $run['found'] ?? [],
                        'missing' => $run['missing'] ?? [],
                        'unexpected' => $run['unexpected'] ?? [],
                        'unknown' => $run['unknown'] ?? [],
                        'bySku' => jsonObject($run['bySku'] ?? []),
                    ]),
                ]
            );
        }
    }

    public function save(array $task): array
    {
        $revision = (int)($task['revision'] ?? 0);
        $body = $task;
        unset($body['revision'], $body['tagged']);
        if (isset($body['quantities']) && is_array($body['quantities'])) {
            $body['quantities'] = jsonObject($body['quantities']);
        }
        if (isset($body['receivedBySku']) && is_array($body['receivedBySku'])) {
            $body['receivedBySku'] = jsonObject($body['receivedBySku']);
        }
        if (isset($body['cartonDetails']) && is_array($body['cartonDetails'])) {
            $body['cartonDetails'] = jsonObject($body['cartonDetails']);
        }
        $body['runs'] = array_map(static function (array $run): array {
            $run['observations'] = jsonObject($run['observations'] ?? []);
            $run['bySku'] = jsonObject($run['bySku'] ?? []);
            return $run;
        }, $body['runs'] ?? []);
        $this->db->run(
            'INSERT INTO `stock_tasks` (id, revision, body) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE revision = VALUES(revision), body = VALUES(body)',
            [$task['id'], $revision + 1, jsonEncodeStrict($body)]
        );
        $this->syncTaskRuns($task);
        return $this->get($task['id']) ?? $task;
    }

    public function record(array $user, string $ref, array $before, array $after, string $action, string $reason, string $source): void
    {
        $this->db->run(
            'INSERT INTO `stock_events` (at, actor, ref, epc, action, before_state, after_state, reason, source)
            VALUES (?,?,?,?,?,?,?,?,?)',
            [
                nowIso(),
                $user['name'] ?? '',
                $ref,
                $after['epc'] ?? '',
                $action,
                jsonEncodeStrict(['state' => $before['state'] ?? null, 'location' => $before['location'] ?? null]),
                jsonEncodeStrict(['state' => $after['state'] ?? null, 'location' => $after['location'] ?? null]),
                $reason,
                $source,
            ]
        );
    }

    public function seed(): void
    {
        if ($this->get(RECEIPT_ID) !== null) {
            return;
        }
        $expected = [];
        for ($i = 0; $i < 40; $i++) {
            $epc = self::inboundEpc($i + 1);
            $sku = $this->products[$i % count($this->products)]['sku'];
            $item = ['epc' => $epc, 'carton' => $this->nextCartonLabel($sku), 'sku' => $sku];
            $this->db->run(
                "INSERT INTO `cartons` (epc, carton, sku, physical, state, location) VALUES (?, ?, ?, 0, 'expected', ?)",
                [$item['epc'], $item['carton'], $item['sku'], INBOUND_STAGING]
            );
            $expected[] = $item;
        }
        $this->save([
            'id' => RECEIPT_ID,
            'type' => 'receipt',
            'revision' => 0,
            'location' => $this->preferredLocation('Storage') ?? 'Storage',
            'sourceRef' => 'Demo delivery',
            'status' => 'Ready',
            'createdAt' => nowIso(),
            'expected' => $expected,
            'received' => [],
            'runs' => [],
        ]);
    }

    public function reset(): void
    {
        $this->db->run('DELETE FROM `stock_events`');
        $this->db->run('DELETE FROM `stock_commands`');
        $this->db->run('DELETE FROM `stock_task_runs`');
        $this->db->run('DELETE FROM `stock_tasks`');
        $this->db->run('DELETE FROM `carton_archive`');
        $this->db->run('DELETE FROM `cartons` WHERE epc IN (SELECT epc FROM `stock_mappings`)');
        $this->db->run('DELETE FROM `stock_mappings`');
        $this->db->run('UPDATE `cartons` SET location = ?', [OUTBOUND_STAGING]);
        for ($number = 1; $number <= 40; $number++) {
            $this->db->run('DELETE FROM `cartons` WHERE epc = ?', [self::inboundEpc($number)]);
        }
        $this->seed();
    }

    public function chooseLocation(array $input): string
    {
        $location = $this->legacyLocation($input['location'] ?? '');
        if (!in_array($location, $this->outboundLocations(), true)) {
            fail('Choose a working location.', 400);
        }
        return $location;
    }

    private function openCount(array $user, array $input): array
    {
        $location = (string)($input['location'] ?? '');
        if (!in_array($location, $this->countLocations(), true)) {
            fail('Choose a stock count location.', 400);
        }
        $expected = array_values(array_filter(
            $this->inventory(),
            static fn(array $c): bool => $c['location'] === $location && $c['state'] !== 'dispatched'
        ));
        return $this->save([
            'id' => uuid4(),
            'type' => 'count',
            'reference' => 'Count ' . $location,
            'revision' => 0,
            'location' => $location,
            'status' => 'Ready',
            'createdAt' => nowIso(),
            'actor' => $user['name'],
            'stockVersion' => $this->stockVersion(),
            'expected' => $expected,
            'runs' => [],
        ]);
    }

    private function prepareReceipt(mixed $text): array
    {
        $firstLine = is_string($text) ? (preg_split('/\r?\n/', ltrim($text), 2)[0] ?? '') : '';
        $headerCols = preg_split('/[,;]/', strtolower($firstLine)) ?: [];
        $header = array_map('trim', $headerCols);
        $optional = array_slice($header, count(RECEIPT_HEADERS));
        if (count(array_unique($optional)) !== count($optional) ||
            array_filter($optional, static fn(string $n): bool => !in_array($n, RECEIPT_OPTIONAL_HEADERS, true)) !== []) {
            fail('Use the receipt template headers.', 400);
        }
        $rows = parseCsvRows($text, array_merge(RECEIPT_HEADERS, $optional));
        if (count($rows) > 500) {
            fail('Use up to 500 receipt lines.', 400);
        }
        [$id, $sourceRef, $destinationName] = $rows[0];
        $location = $this->legacyLocation($destinationName);
        $quantities = [];
        $cartonDetails = [];
        $identifiers = [];
        $expected = [];
        $seen = [];
        $mode = ($rows[0][6] ?? '') !== '' ? 'EPC' : 'SKU';
        $knownSkus = array_column($this->products, 'sku');
        $warehouse = $this->warehouseLocations();
        $allTasks = $this->tasks();

        foreach ($rows as $index => $cells) {
            $rowPrefix = 'Row ' . ($index + 2) . ': ';
            [$ref, $source, $destination, $rawSku, $count, $cartonId, $tag] = $cells;
            $values = array_slice($cells, 7);
            $optMap = [];
            foreach ($optional as $i => $name) {
                $optMap[$name] = $values[$i] ?? '';
            }
            $productIdentifier = $optMap['product_identifier'] ?? '';
            $batchLot = $optMap['batch_lot'] ?? '';
            $unitsRaw = $optMap['units_per_carton'] ?? '';
            $sku = productSku($rawSku);
            $identifier = $productIdentifier !== '' ? $productIdentifier : $sku;
            if ($id === '' || $sourceRef === '' || strlen($id) > 80 || strlen($sourceRef) > 100 ||
                $ref !== $id || $source !== $sourceRef || $this->legacyLocation($destination) !== $location ||
                ($location !== INBOUND_STAGING && !in_array($location, $warehouse, true))) {
                fail($rowPrefix . 'use one receipt reference, source and destination.', 400);
            }
            if (!preg_match('/^\d+$/', $count)) {
                fail($rowPrefix . 'use a known SKU and a quantity from 1 to 500.', 400);
            }
            $quantity = (int)$count;
            if (!in_array($sku, $knownSkus, true) || $quantity < 1 || $quantity > 500) {
                fail($rowPrefix . 'use a known SKU and a quantity from 1 to 500.', 400);
            }
            if (strlen($identifier) > 100 || (isset($identifiers[$identifier]) && $identifiers[$identifier] !== $sku)) {
                fail($rowPrefix . 'use a Product Identifier that maps to one SKU.', 400);
            }
            $units = null;
            if ($unitsRaw !== '') {
                if (!preg_match('/^\d+$/', $unitsRaw) || (int)$unitsRaw < 1) {
                    fail($rowPrefix . 'units per carton must be a positive whole number.', 400);
                }
                $units = (int)$unitsRaw;
            }
            if (strlen($batchLot) > 100) {
                fail($rowPrefix . 'batch/lot must be 100 characters or fewer.', 400);
            }
            $details = ['batch_lot' => $batchLot !== '' ? $batchLot : null, 'units_per_carton' => $units];
            $prev = $cartonDetails[$sku] ?? null;
            if ($prev !== null && ($prev['batch_lot'] !== $details['batch_lot'] || $prev['units_per_carton'] !== $details['units_per_carton'])) {
                fail($rowPrefix . 'use a separate receipt for this SKU with a different batch/lot or units per carton.', 400);
            }
            $cartonDetails[$sku] = $details;
            $identifiers[$identifier] = $sku;

            if ($mode === 'EPC') {
                $epc = normalizeEpc($tag);
                $known = $this->carton($epc);
                $claimedElsewhere = false;
                foreach ($allTasks as $task) {
                    if (($task['type'] ?? '') === 'receipt' && ($task['status'] ?? '') !== 'Cancelled' && ($task['id'] ?? '') !== $id) {
                        foreach ($task['expected'] ?? [] as $item) {
                            if ($item['epc'] === $epc) {
                                $claimedElsewhere = true;
                                break 2;
                            }
                        }
                    }
                }
                if ($quantity !== 1 || $cartonId === '' || strlen($cartonId) > 80 || !validEpc($epc) || isset($seen[$epc]) ||
                    ($known !== null && ($known['sku'] !== $sku || $known['carton'] !== $cartonId || $known['state'] !== 'expected')) ||
                    $claimedElsewhere) {
                    fail($rowPrefix . 'use one carton with a unique, consistent EPC mapping.', 400);
                }
                $seen[$epc] = true;
                $expected[] = ['epc' => $epc, 'carton' => $cartonId, 'sku' => $sku];
            } elseif ($tag !== '' || $cartonId !== '') {
                fail($rowPrefix . 'keep identity fields empty in SKU comparison mode.', 400);
            }
            $quantities[$sku] = ($quantities[$sku] ?? 0) + $quantity;
        }

        if (array_sum($quantities) > 500) {
            fail('Use up to 500 expected cartons.', 400);
        }
        $identifierPairs = [];
        foreach ($identifiers as $ident => $skuVal) {
            $identifierPairs[] = [$ident, $skuVal];
        }
        return [
            'id' => $id,
            'sourceRef' => $sourceRef,
            'location' => $location,
            'mode' => $mode,
            'quantities' => jsonObject($quantities),
            'expected' => $expected,
            'identifiers' => $identifierPairs,
            'cartonDetails' => jsonObject($cartonDetails),
        ];
    }

    private function register(array $user, array $input, string $source = 'Manual entry'): array
    {
        $epc = normalizeEpc($input['epc'] ?? '');
        $name = $this->field($input['carton'] ?? '', 'a carton reference');
        $knownSkus = array_column($this->products, 'sku');
        if (!validEpc($epc) || strlen($name) > 80 || !in_array($input['sku'] ?? '', $knownSkus, true)) {
            fail('Enter a valid EPC, carton and SKU.', 400);
        }
        $known = $this->carton($epc);
        if ($known !== null) {
            if ($known['carton'] !== $name || $known['sku'] !== $input['sku']) {
                fail('This EPC is already mapped to a different carton or SKU.');
            }
            return $known;
        }
        if ($this->db->getOne('SELECT 1 AS ok FROM `cartons` WHERE LOWER(carton) = LOWER(?)', [$name]) !== null) {
            fail('This carton reference already has an EPC.');
        }
        $this->db->run(
            "INSERT INTO `cartons` (epc, carton, sku, physical, state, location) VALUES (?, ?, ?, ?, 'expected', ?)",
            [$epc, $name, $input['sku'], $source === 'C72 hardware' ? 1 : 0, INBOUND_STAGING]
        );
        $this->db->run('INSERT INTO `stock_mappings` (epc) VALUES (?)', [$epc]);
        $mapped = $this->carton($epc);
        $this->record($user, 'Carton mapping', [], $mapped, 'EPC registered', '', $source);
        return $mapped;
    }

    private function receiveCarton(array $user, array $task, array $input): array
    {
        if (($task['type'] ?? '') !== 'receipt' || ($task['status'] ?? '') === 'Completed') {
            fail('This receipt is closed.');
        }
        $lines = receiptProducts($task);
        $line = null;
        foreach ($lines as $candidate) {
            if ($candidate['identifier'] === ($input['identifier'] ?? null)) {
                $line = $candidate;
                break;
            }
        }
        if ($line === null || $line['remaining'] < 1) {
            fail('Choose a Product Identifier with cartons still outstanding.');
        }
        $simulated = ($input['simulation'] ?? false) === true;
        $receivedSet = array_flip($task['received'] ?? []);
        $planned = null;
        if ($simulated && ($task['mode'] ?? '') !== 'SKU') {
            foreach ($task['expected'] ?? [] as $item) {
                if ($item['sku'] === $line['sku'] && !isset($receivedSet[$item['epc']]) &&
                    (empty($input['variantSku']) || cartonSku($item) === $item['sku'] || demoSku(cartonSku($item)) === $input['variantSku'])) {
                    $planned = $item;
                    break;
                }
            }
        }
        $epc = $simulated
            ? ($planned['epc'] ?? 'D7' . substr(strtoupper(str_replace('-', '', uuid4())), 0, 22))
            : normalizeEpc($input['epc'] ?? '');
        if (!validEpc($epc)) {
            fail('Scan one valid carton EPC.', 400);
        }
        $before = $this->carton($epc);
        if (isset($receivedSet[$epc])) {
            fail('This EPC is already tagged' . ($before ? ' to ' . $before['sku'] : '') . ' in this task.');
        }
        if ($before !== null && $before['state'] !== 'expected') {
            fail('This EPC is already tagged to ' . $before['sku'] . '.');
        }
        $expected = null;
        foreach ($task['expected'] ?? [] as $item) {
            if ($item['epc'] === $epc) {
                $expected = $item;
                break;
            }
        }
        if ($expected !== null && $expected['sku'] !== $line['sku']) {
            fail('This EPC is already assigned to ' . $expected['sku'] . '.');
        }
        foreach ($this->tasks() as $other) {
            if (($other['type'] ?? '') === 'receipt' && ($other['status'] ?? '') !== 'Cancelled' && ($other['id'] ?? '') !== $task['id']) {
                foreach ($other['expected'] ?? [] as $item) {
                    if ($item['epc'] === $epc) {
                        fail('This EPC is assigned to another receipt.');
                    }
                }
            }
        }
        if ($before !== null && $before['sku'] !== $line['sku']) {
            fail('This EPC is already assigned to ' . $before['sku'] . '.');
        }
        if (!empty($input['variantSku'])) {
            $variant = demoSku($line['sku'] . '-' . ($input['size'] ?? ''));
            $sizes = receiptSizes($task, $line['sku'], $input['cartonSizes'] ?? []);
            $sizeValid = array_filter($sizes, static fn(array $r): bool => $r['code'] === ($input['size'] ?? '')) !== [];
            if ($input['variantSku'] !== $variant || !$sizeValid) {
                fail('Choose an available SKU for this product.', 400);
            }
            foreach (array_filter([$expected, $before]) as $row) {
                $cSku = cartonSku($row);
                if ($cSku !== $line['sku'] && demoSku($cSku) !== $variant) {
                    fail('This EPC belongs to a different SKU.');
                }
            }
        }
        $source = $simulated ? 'Simulation' : 'C72 hardware';
        $before ??= $this->register($user, [
            'epc' => $epc,
            'sku' => $line['sku'],
            'carton' => $expected['carton'] ?? $this->nextCartonLabel($line['sku'], !empty($input['size']) ? (string)$input['size'] : null),
        ], $source);
        $at = nowIso();
        $remBySku = [];
        foreach ($lines as $item) {
            $remBySku[$item['sku']] = $item['remaining'];
        }
        $remaining = array_sum($remBySku) - 1;
        $details = $task['cartonDetails'][$line['sku']] ?? null;
        $this->db->run(
            "UPDATE `cartons` SET state='available', location=?, physical=GREATEST(physical, ?), batch_lot=?, units_per_carton=?, variant_size=COALESCE(?, variant_size) WHERE epc=?",
            [
                $task['location'],
                $simulated ? 0 : 1,
                $details['batch_lot'] ?? null,
                $details['units_per_carton'] ?? null,
                !empty($input['variantSku']) ? $input['size'] : null,
                $epc,
            ]
        );
        $this->record($user, $task['id'], $before, $this->carton($epc), 'Received', 'Product Identifier: ' . $line['identifier'], $source);

        $receivedForSku = 0;
        foreach ($task['expected'] ?? [] as $item) {
            if ($item['sku'] === $line['sku'] && isset($receivedSet[$item['epc']])) {
                $receivedForSku++;
            }
        }
        $task['receivedBySku'] ??= [];
        $task['receivedBySku'][$line['sku']] = ($task['receivedBySku'][$line['sku']] ?? $receivedForSku) + 1;
        $task['received'][] = $epc;
        $task['runs'][] = [
            'id' => uuid4(),
            'at' => $at,
            'actor' => $user['name'],
            'source' => $source,
            'identifier' => $line['identifier'],
            'observations' => [$epc => 1],
            'found' => [$epc],
            'missing' => [],
            'unexpected' => [],
            'unknown' => [],
            'outstanding' => $remaining,
            'bySku' => [$line['sku'] => 1],
            'confirmedAt' => $at,
            'confirmedBy' => $user['name'],
        ];
        $task['status'] = $remaining > 0 ? 'Partially received' : 'Completed';
        return $this->save($task);
    }

    private function simulate(array $task, string $scenario): array
    {
        $receivedSet = array_flip($task['received'] ?? []);
        $expected = [];
        foreach ($task['expected'] ?? [] as $item) {
            if (!isset($receivedSet[$item['epc']])) {
                $expected[] = $item['epc'];
            }
        }
        if (($task['type'] ?? '') === 'receipt' && $scenario === 'partial') {
            return array_slice($expected, 0, 38);
        }
        if ($scenario === 'missing') {
            return array_slice($expected, 0, -1);
        }
        if ($scenario === 'unknown') {
            $expected[] = UNKNOWN_TAG;
            return $expected;
        }
        if ($scenario !== 'match') {
            fail('Choose a simulation scenario.', 400);
        }
        if ($expected !== []) {
            $expected[] = $expected[0];
        }
        return $expected;
    }

    private function scan(array $user, array $task, array $input): array
    {
        if (in_array($task['status'] ?? '', ['Completed', 'Reviewed', 'Cancelled'], true)) {
            fail('This record is closed.');
        }
        $receivedSet = array_flip($task['received'] ?? []);
        $expected = array_values(array_filter(
            $task['expected'] ?? [],
            static fn(array $item): bool => !isset($receivedSet[$item['epc']])
        ));
        if (($task['mode'] ?? '') === 'SKU' && !empty($input['scenario'])) {
            fail('Import EPC reads for a SKU-only receipt.', 400);
        }
        $epcs = !empty($input['scenario']) ? $this->simulate($task, (string)$input['scenario']) : ($input['epcs'] ?? null);
        if (!is_array($epcs) || count($epcs) > 4000) {
            fail('Enter up to 4,000 EPC reads.', 400);
        }
        $observations = [];
        foreach ($epcs as $raw) {
            $epc = normalizeEpc($raw);
            if (!validEpc($epc)) {
                fail('Every EPC must be even-length hexadecimal.', 400);
            }
            $reads = ($input['reader'] ?? '') === 'hardware' ? ($input['readCounts'][$epc] ?? 1) : 1;
            if (!is_int($reads) || $reads < 1 || $reads > 1000000) {
                fail('Invalid reader count.', 400);
            }
            $observations[$epc] = ($observations[$epc] ?? 0) + $reads;
        }
        $ids = array_keys($observations);
        $outstanding = null;
        if (($task['mode'] ?? '') === 'SKU') {
            $limits = (array)($task['quantities'] ?? []);
            foreach ($task['received'] ?? [] as $epc) {
                $c = $this->carton((string)$epc);
                $limits[$c['sku']]--;
            }
            $claims = [];
            foreach ($this->tasks() as $other) {
                if ($other['id'] !== $task['id']) {
                    foreach ($other['expected'] ?? [] as $item) {
                        $claims[$item['epc']] = true;
                    }
                }
            }
            $expected = [];
            foreach ($ids as $id) {
                $item = $this->carton($id);
                if ($item === null || $item['state'] !== 'expected' || !(($limits[$item['sku']] ?? 0) > 0) || isset($claims[$item['epc']])) {
                    continue;
                }
                $limits[$item['sku']]--;
                $expected[] = $item;
            }
            $outstanding = array_sum($limits);
        }
        $result = compareManifest(['cartons' => $expected], $ids);
        $bySku = [];
        $cartonsById = [];
        foreach ($ids as $epc) {
            $cartonsById[$epc] = $this->carton($epc);
        }
        foreach ($this->products as $product) {
            $sku = $product['sku'];
            $count = 0;
            foreach ($ids as $epc) {
                if (($cartonsById[$epc]['sku'] ?? null) === $sku) {
                    $count++;
                }
            }
            $bySku[$sku] = $count;
        }
        $unexpected = [];
        $unknown = [];
        foreach ($result['extra'] as $epc) {
            if ($this->carton($epc) !== null) {
                $unexpected[] = $epc;
            } else {
                $unknown[] = $epc;
            }
        }
        $at = nowIso();
        $run = [
            'id' => uuid4(),
            'at' => $at,
            'actor' => $user['name'],
            'source' => !empty($input['scenario']) ? 'Simulation' : (($input['reader'] ?? '') === 'hardware' ? 'C72 hardware' : 'Imported EPC reads'),
            'observations' => jsonObject($observations),
            'found' => $result['matched'],
            'missing' => $result['missing'],
            'bySku' => jsonObject($bySku),
            'unexpected' => $unexpected,
            'unknown' => $unknown,
        ];
        if ($outstanding !== null) {
            $run['outstanding'] = $outstanding;
        }
        $task['runs'][] = $run;
        $task['status'] = !empty($task['received']) ? 'Partially received' : 'In progress';
        return $this->save($task);
    }

    private function confirmReceipt(array $user, array $task, array $input): array
    {
        $runs = $task['runs'] ?? [];
        $runIndex = count($runs) - 1;
        $run = $runIndex >= 0 ? $runs[$runIndex] : null;
        if (($task['status'] ?? '') === 'Completed' || $run === null || !empty($run['confirmedAt']) || !empty($run['supersededAt']) || empty($run['found'])) {
            fail('Scan and review new cartons first.');
        }
        $partial = !empty($run['outstanding']) || !empty($run['missing']) || !empty($run['unexpected']) || !empty($run['unknown']);
        $reason = $partial ? $this->field($input['reason'] ?? '', 'a reason for the partial receipt or discrepancy') : '';
        $remainingBySku = [];
        foreach (receiptProducts($task) as $line) {
            $remainingBySku[$line['sku']] = $line['remaining'];
        }
        $receivedSet = array_flip($task['received'] ?? []);
        foreach ($run['found'] as $epc) {
            $before = $this->carton($epc);
            if ($before === null || $before['state'] !== 'expected' || isset($receivedSet[$epc])) {
                fail('This carton was already received. Run a new scan.');
            }
            $rem = $remainingBySku[$before['sku']] ?? 0;
            if (!($rem > 0)) {
                fail('This scan contains more cartons than are outstanding for ' . $before['sku'] . '.');
            }
            $remainingBySku[$before['sku']] = $rem - 1;
            $details = $task['cartonDetails'][$before['sku']] ?? null;
            $this->db->run(
                "UPDATE `cartons` SET state='available', location=?, physical=GREATEST(physical, ?), batch_lot=?, units_per_carton=? WHERE epc=?",
                [
                    $task['location'],
                    ($run['source'] ?? '') === 'C72 hardware' ? 1 : 0,
                    $details['batch_lot'] ?? null,
                    $details['units_per_carton'] ?? null,
                    $epc,
                ]
            );
            $this->record($user, $task['id'], $before, $this->carton($epc), 'Received', $reason, (string)$run['source']);
            $task['received'][] = $epc;
            $receivedSet[$epc] = true;
            $task['receivedBySku'] ??= [];
            $task['receivedBySku'][$before['sku']] = ($task['receivedBySku'][$before['sku']] ?? 0) + 1;
        }
        $task['runs'][$runIndex]['confirmedAt'] = nowIso();
        $task['runs'][$runIndex]['confirmedBy'] = $user['name'];
        $task['runs'][$runIndex]['reason'] = $reason;
        $total = isset($task['quantities']) ? array_sum((array)$task['quantities']) : count($task['expected'] ?? []);
        $task['status'] = $total === count($task['received'] ?? []) ? 'Completed' : 'Partially received';
        return $this->save($task);
    }

    private function untag(array $user, array $task, array $input, callable $usedInOutbound): array
    {
        $epc = normalizeEpc($input['epc'] ?? '');
        $before = $this->carton($epc);
        $last = $this->db->getOne('SELECT action, ref FROM `stock_events` WHERE epc = ? ORDER BY id DESC LIMIT 1', [$epc]);
        if (($task['type'] ?? '') !== 'receipt' || !in_array($epc, $task['received'] ?? [], true) ||
            !empty($task['outbound']) || $usedInOutbound($epc) ||
            ($before['state'] ?? '') !== 'available' || $before['location'] !== $task['location'] ||
            ($last['action'] ?? '') !== 'Received' || ($last['ref'] ?? '') !== $task['id']) {
            fail('Only a received carton that has not moved or been assigned to outbound can be untagged.');
        }
        $reason = $this->field($input['reason'] ?? '', 'an untag reason');
        $planned = false;
        foreach ($task['expected'] ?? [] as $item) {
            if ($item['epc'] === $epc) {
                $planned = true;
                break;
            }
        }
        if ($planned) {
            $this->db->run("UPDATE `cartons` SET state='expected', location=? WHERE epc=?", [INBOUND_STAGING, $epc]);
        } else {
            $this->db->run(
                'INSERT INTO `carton_archive` (archived_at, archived_by, task_id, reason, epc, carton, sku, physical, prior_state, prior_location, batch_lot, units_per_carton)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [
                    nowIso(),
                    $user['name'],
                    $task['id'],
                    $reason,
                    $before['epc'],
                    $before['carton'],
                    $before['sku'],
                    $before['physical'] ?? 0,
                    $before['state'],
                    $before['location'],
                    $before['batch_lot'] ?? null,
                    $before['units_per_carton'] ?? null,
                ]
            );
            $this->db->run('DELETE FROM `stock_mappings` WHERE epc = ?', [$epc]);
            $this->db->run('DELETE FROM `cartons` WHERE epc = ?', [$epc]);
        }
        $this->record(
            $user,
            $task['id'],
            $before,
            ['epc' => $epc, 'state' => $planned ? 'expected' : 'untagged', 'location' => INBOUND_STAGING],
            'Carton untagged',
            $reason,
            'Manual confirmation'
        );
        $receivedSet = array_flip($task['received'] ?? []);
        $expectedCountForSku = 0;
        foreach ($task['expected'] ?? [] as $item) {
            if ($item['sku'] === $before['sku'] && isset($receivedSet[$item['epc']])) {
                $expectedCountForSku++;
            }
        }
        $counted = $task['receivedBySku'][$before['sku']] ?? $expectedCountForSku;
        $task['receivedBySku'] ??= [];
        $task['receivedBySku'][$before['sku']] = max(0, $counted - 1);
        $task['received'] = array_values(array_filter($task['received'] ?? [], static fn(string $v): bool => $v !== $epc));
        $task['status'] = $task['received'] !== [] ? 'Partially received' : 'Ready';
        $lastIdx = count($task['runs'] ?? []) - 1;
        if ($lastIdx >= 0 && empty($task['runs'][$lastIdx]['confirmedAt'])) {
            $task['runs'][$lastIdx]['supersededAt'] = nowIso();
        }
        return $this->save($task);
    }

    private function move(array $user, array $input): array
    {
        $before = $this->carton(normalizeEpc($input['epc'] ?? ''));
        if ($before === null || $before['location'] !== ($input['from'] ?? null) ||
            $before['state'] !== ($input['state'] ?? null) || !in_array($before['state'], ['available', 'held'], true)) {
            fail('Stock changed. Reopen the carton before moving it.');
        }
        $hold = ($input['action'] ?? '') === 'hold';
        $lastHold = $hold ? null : $this->db->getOne(
            "SELECT before_state FROM `stock_events` WHERE epc = ? AND action = 'Held' ORDER BY id DESC LIMIT 1",
            [$before['epc']]
        );
        $previous = $lastHold !== null ? (json_decode((string)$lastHold['before_state'], true)['location'] ?? null) : null;
        $warehouse = $this->warehouseLocations();
        $destination = $hold ? 'Hold' : (in_array($previous, $warehouse, true) ? $previous : $warehouse[0]);
        $state = $hold ? 'held' : 'available';
        if ($hold ? $before['state'] !== 'available' : $before['state'] !== 'held') {
            fail('This movement is unavailable for the carton.');
        }
        if ($before['location'] === $destination && $before['state'] === $state) {
            fail('Choose a different location.');
        }
        $reason = $this->field($input['reason'] ?? '', 'a movement reason');
        $this->db->run('UPDATE `cartons` SET location = ?, state = ? WHERE epc = ?', [$destination, $state, $before['epc']]);
        $after = $this->carton($before['epc']);
        $this->record($user, 'Stock movement', $before, $after, $hold ? 'Held' : 'Released from hold', $reason, 'Manual confirmation');
        return $after;
    }

    private function reviewCount(array $user, array $task, array $input): array
    {
        if (in_array($task['status'] ?? '', ['Reviewed', 'Cancelled'], true)) {
            fail('This count is closed.');
        }
        if (empty($task['runs'])) {
            fail('Scan the count before review.');
        }
        if (($task['stockVersion'] ?? -1) !== $this->stockVersion()) {
            fail('Stock changed after this snapshot. Cancel this count and open a new one before reviewing.');
        }
        $run = end($task['runs']);
        $epc = normalizeEpc($input['epc'] ?? '');
        $changed = $epc !== '';
        $issue = $changed || !empty($run['missing']) || !empty($run['unexpected']) || !empty($run['unknown']);
        $reason = $issue ? $this->field($input['reason'] ?? '', 'a review reason') : '';
        if ($changed) {
            $before = $this->carton($epc);
            if (in_array($task['location'], PROTECTED_LOCATIONS, true)) {
                fail('Use the staging workflow to move stock to this location.');
            }
            if (!in_array($epc, $run['unexpected'] ?? [], true) || ($before['state'] ?? '') !== 'available' || $before['location'] === $task['location']) {
                fail('Choose a physically verified extra carton recorded at another location.');
            }
            $this->db->run('UPDATE `cartons` SET location = ? WHERE epc = ?', [$task['location'], $epc]);
            $this->record($user, $task['id'], $before, $this->carton($epc), 'Count correction', $reason, (string)$run['source']);
        }
        $task['review'] = ['at' => nowIso(), 'by' => $user['name'], 'reason' => $reason, 'epc' => $epc !== '' ? $epc : null];
        $task['status'] = 'Reviewed';
        return $this->save($task);
    }

    private function prepareOutbound(array $user, array $task, callable $createFn): array
    {
        if (($task['type'] ?? '') !== 'receipt' || ($task['status'] ?? '') !== 'Completed' || !empty($task['outbound'])) {
            fail('Complete the receipt first.');
        }
        foreach ($task['received'] ?? [] as $epc) {
            $c = $this->carton((string)$epc);
            if (($c['state'] ?? '') !== 'available') {
                fail('Every carton must be on hand.');
            }
        }
        $ref = $task['id'] === RECEIPT_ID ? OUTBOUND_REF : (substr($task['id'], 0, 75) . '-OUT');
        $pallet = $task['id'] === RECEIPT_ID ? DEMO_PALLET : ('D6' . substr(strtoupper(str_replace('-', '', uuid4())), 0, 22));
        $rows = [];
        foreach ($task['received'] ?? [] as $epc) {
            $item = $this->carton((string)$epc);
            $rows[] = [$ref, $pallet, $item['carton'], $item['epc'], $item['sku']];
        }
        $manifest = $this->makeCsv(['pallet_ref', 'pallet_epc', 'carton_ref', 'carton_epc', 'sku'], $rows);
        $session = $createFn($user, ['testId' => $ref, 'location' => OUTBOUND_STAGING, 'source' => 'Simulation', 'csv' => $manifest]);
        $task['outbound'] = $session['id'];
        return $this->save($task);
    }

    private function manageLocation(array $input): array
    {
        $action = (string)($input['action'] ?? '');
        $location = $this->db->getOne('SELECT * FROM `workspace_locations` WHERE id = ? AND archived = 0', [$input['locationId'] ?? '']);
        if ($action !== 'add-location' && ($location === null || in_array($location['name'], PROTECTED_LOCATIONS, true))) {
            fail('This location cannot be changed.');
        }
        $name = $action === 'archive-location' ? (string)$location['name'] : $this->field($input['name'] ?? '', 'a location name');
        if ($action !== 'archive-location') {
            $lower = strtolower($name);
            if (array_key_exists($lower, LEGACY_LOCATIONS)) {
                fail('This location name is reserved.', 400);
            }
            foreach (PROTECTED_LOCATIONS as $prot) {
                if (strtolower($prot) === $lower) {
                    fail('This location name is reserved.', 400);
                }
            }
        }
        if (strlen($name) > 100 || preg_match('/^[=+@-]/', $name) || preg_match('/[\r\n]/', $name)) {
            fail('Enter a valid location name.', 400);
        }
        $openTasks = [];
        if ($location !== null) {
            foreach ($this->tasks() as $t) {
                if ($t['location'] === $location['name'] && !in_array($t['status'], ['Completed', 'Reviewed', 'Cancelled'], true)) {
                    $openTasks[] = $t;
                }
            }
        }
        if ($action === 'archive-location') {
            if (count($this->locations()) <= 2) {
                fail('Keep at least one working location.');
            }
            $warehouse = $this->warehouseLocations();
            if (count($warehouse) === 1 && in_array($name, $warehouse, true)) {
                fail('Keep at least one warehouse destination.');
            }
            if ($openTasks !== [] || $this->db->getOne("SELECT 1 AS ok FROM `cartons` WHERE location = ? AND state <> 'dispatched'", [$name]) !== null) {
                fail('Move stock out of this location and complete its open tasks before archiving.');
            }
            $this->db->run('UPDATE `workspace_locations` SET archived = 1 WHERE id = ?', [$location['id']]);
        } else {
            $duplicate = $this->db->getOne('SELECT id FROM `workspace_locations` WHERE name = ?', [$name]);
            if ($duplicate !== null && $duplicate['id'] !== ($location['id'] ?? null)) {
                fail('A location with that name already exists.');
            }
            if ($action === 'add-location') {
                $this->db->run('INSERT IGNORE INTO `workspace_locations` (id, name, archived) VALUES (?, ?, 0)', [uuid4(), $name]);
            } elseif ($name !== $location['name']) {
                $this->db->run('UPDATE `workspace_locations` SET name = ? WHERE id = ?', [$name, $location['id']]);
                $this->db->run("UPDATE `cartons` SET location = ? WHERE location = ? AND state <> 'dispatched'", [$name, $location['name']]);
                foreach ($openTasks as $t) {
                    $t['location'] = $name;
                    if (($t['type'] ?? '') === 'count') {
                        $t['reference'] = 'Count ' . $name;
                    }
                    foreach ($t['expected'] ?? [] as $k => $item) {
                        if (($item['location'] ?? null) === $location['name']) {
                            $t['expected'][$k]['location'] = $name;
                        }
                    }
                    $this->save($t);
                }
            }
        }
        return ['reference' => $name];
    }

    public function command(array $user, array $input, callable $createFn, bool $dashboard, callable $usedInOutbound): array
    {
        $locationActions = ['add-location', 'rename-location', 'archive-location'];
        $roles = [
            'add-location' => 'admin', 'rename-location' => 'admin', 'archive-location' => 'admin',
            'count' => 'operator', 'scan' => 'operator', 'receive' => 'operator', 'receive-carton' => 'operator',
            'review' => 'supervisor', 'cancel-count' => 'supervisor', 'hold' => 'supervisor',
            'release' => 'supervisor', 'outbound' => 'admin', 'register' => 'admin', 'receipt' => 'admin',
            'preview' => 'admin', 'untag' => 'admin', 'cancel-receipt' => 'admin', 'remove-carton' => 'admin',
        ];
        $action = (string)($input['action'] ?? '');
        if (in_array($action, $locationActions, true) && !$dashboard) {
            fail('Configure locations on the dashboard.', 403);
        }
        $operatorCancel = $action === 'cancel-count' && $user['role'] === 'operator';
        if (!array_key_exists($action, $roles) || ($user['role'] !== $roles[$action] && !$operatorCancel && !($dashboard && $user['role'] === 'admin'))) {
            fail('This role cannot perform that action.', 403);
        }
        if ($action === 'preview') {
            return $this->prepareReceipt($input['csv'] ?? null);
        }
        if (!preg_match('/^[a-f0-9-]{36}$/i', (string)($input['operationId'] ?? ''))) {
            fail('Invalid operation ID.', 400);
        }
        $body = jsonEncodeStrict($input);
        $prior = $this->db->getOne('SELECT * FROM `stock_commands` WHERE id = ?', [$input['operationId']]);
        if ($prior !== null) {
            if ($prior['actor'] !== $user['id'] || $prior['body'] !== $body) {
                fail('Operation ID is already in use.');
            }
            return in_array($action, ['receive-carton', 'untag'], true)
                ? $this->tagged($this->get((string)$input['id']) ?? [])
                : ['saved' => true];
        }
        if ($action === 'remove-carton') {
            if (!$dashboard) {
                fail('Remove stock on the dashboard.', 403);
            }
            $before = $this->carton(normalizeEpc($input['epc'] ?? ''));
            if ($before === null || !in_array($before['state'], ['available', 'held'], true) ||
                $before['state'] !== ($input['state'] ?? null) || $before['location'] !== ($input['from'] ?? null)) {
                fail('Stock changed. Refresh before removing the carton.');
            }
            $inCount = false;
            foreach ($this->tasks() as $t) {
                if (($t['type'] ?? '') === 'count' && in_array($t['status'] ?? '', ['Ready', 'In progress'], true)) {
                    foreach ($t['expected'] ?? [] as $item) {
                        if ($item['epc'] === $before['epc']) {
                            $inCount = true;
                            break 2;
                        }
                    }
                }
            }
            if ($usedInOutbound($before['epc']) || $inCount) {
                fail('This carton is assigned to outbound work or an open count.');
            }
            $reason = $this->field($input['reason'] ?? '', 'a removal reason');
            $this->db->run("UPDATE `cartons` SET state = 'removed' WHERE epc = ?", [$before['epc']]);
            $this->record($user, $before['carton'], $before, $this->carton($before['epc']), 'Carton removed', $reason, 'Manual confirmation');
            $result = ['reference' => $before['carton']];
        } elseif (in_array($action, $locationActions, true)) {
            $result = $this->manageLocation($input);
        } elseif ($action === 'receipt') {
            $task = $this->prepareReceipt($input['csv'] ?? null);
            if ($this->get($task['id']) !== null) {
                fail('This receipt reference already exists.');
            }
            foreach ($task['expected'] as $item) {
                $this->register($user, $item);
            }
            $result = $this->save(array_merge($task, [
                'type' => 'receipt',
                'status' => 'Ready',
                'revision' => 0,
                'createdAt' => nowIso(),
                'received' => [],
                'runs' => [],
            ]));
        } elseif ($action === 'register') {
            $result = $this->register($user, $input);
        } elseif (in_array($action, ['hold', 'release'], true)) {
            $result = $this->move($user, $input);
        } elseif ($action === 'count') {
            $result = $this->openCount($user, $input);
        } else {
            $task = $this->get((string)($input['id'] ?? ''));
            if ($task === null || $task['revision'] !== ($input['revision'] ?? null)) {
                fail('This record changed. Refresh before continuing.');
            }
            if (($task['status'] ?? '') === 'Cancelled') {
                fail('This task is cancelled.');
            }
            if (($action === 'cancel-receipt' && $task['type'] === 'receipt') ||
                ($action === 'cancel-count' && $task['type'] === 'count')) {
                if ($task['type'] === 'receipt' && !$dashboard) {
                    fail('Cancel receipts on the dashboard.', 403);
                }
                if ($task['type'] === 'count' && !in_array($task['status'], ['Ready', 'In progress'], true)) {
                    fail('Only unfinished counts can be cancelled.');
                }
                $reason = $this->field($input['reason'] ?? '', 'a cancellation reason');
                $task['status'] = 'Cancelled';
                $task['cancelled'] = ['at' => nowIso(), 'by' => $user['name'], 'reason' => $reason];
                $result = $this->save($task);
                $this->record(
                    $user,
                    $task['id'],
                    $task,
                    array_merge($result, ['epc' => '']),
                    $task['type'] === 'receipt' ? 'Receipt cancelled' : 'Count cancelled',
                    $reason,
                    'Manual confirmation'
                );
            } elseif ($action === 'scan') {
                $result = $this->scan($user, $task, $input);
            } elseif ($action === 'receive' && $task['type'] === 'receipt') {
                $result = $this->confirmReceipt($user, $task, $input);
            } elseif ($action === 'receive-carton') {
                $result = $this->tagged($this->receiveCarton($user, $task, $input));
            } elseif ($action === 'untag') {
                $result = $this->tagged($this->untag($user, $task, $input, $usedInOutbound));
            } elseif ($action === 'review' && $task['type'] === 'count') {
                $result = $this->reviewCount($user, $task, $input);
            } elseif ($action === 'outbound') {
                $result = $this->prepareOutbound($user, $task, $createFn);
            } else {
                fail('Action is unavailable for this record.');
            }
        }
        $this->db->run('INSERT INTO `stock_commands` (id, actor, body) VALUES (?, ?, ?)', [$input['operationId'], $user['id'], $body]);
        ($this->onAudit)($user, 'Stock ' . $action, (string)($input['id'] ?? $result['id'] ?? $result['reference'] ?? 'stock'), (string)($input['reason'] ?? $result['reference'] ?? ''));
        return $result;
    }

    public function events(?string $epc = null): array
    {
        $rows = $epc !== null
            ? $this->db->getAll('SELECT * FROM `stock_events` WHERE epc = ? ORDER BY id DESC', [$epc])
            : $this->db->getAll('SELECT * FROM `stock_events` ORDER BY id DESC LIMIT 50');
        return array_map(static function (array $e): array {
            $e['id'] = (int)$e['id'];
            return $e;
        }, $rows);
    }

    public function report(string $type): string
    {
        if ($type === 'receipt-template') {
            return $this->makeCsv(
                array_merge(RECEIPT_HEADERS, RECEIPT_OPTIONAL_HEADERS),
                [['KP-IN-CSV', 'Demo delivery', INBOUND_STAGING, $this->products[0]['sku'], 2, '', '', $this->products[0]['sku'], 'LOT-DEMO-01', 10]]
            );
        }
        if ($type === 'stock') {
            return $this->makeCsv(
                ['carton', 'epc', 'sku', 'location', 'stock_state', 'batch_lot', 'units_per_carton'],
                array_map(static fn(array $c): array => [$c['carton'], $c['epc'], $c['sku'], $c['location'], $c['state'], $c['batch_lot'], $c['units_per_carton']], $this->inventory())
            );
        }
        if ($type === 'movements') {
            $events = $this->db->getAll('SELECT * FROM `stock_events` ORDER BY id');
            return $this->makeCsv(
                ['reference', 'epc', 'action', 'actor', 'time_utc', 'before', 'after', 'reason', 'input_source'],
                array_map(static fn(array $e): array => [$e['ref'], $e['epc'], $e['action'], $e['actor'], $e['at'], $e['before_state'], $e['after_state'], $e['reason'], $e['source']], $events)
            );
        }
        $kind = $type === 'receipts' ? 'receipt' : 'count';
        $rows = [];
        foreach ($this->tasks() as $t) {
            if (($t['type'] ?? '') !== $kind) {
                continue;
            }
            foreach ($t['runs'] ?? [] as $run) {
                $obs = (array)($run['observations'] ?? []);
                foreach (['found', 'missing', 'unexpected', 'unknown'] as $status) {
                    foreach ($run[$status] ?? [] as $epc) {
                        $rows[] = [
                            $t['type'] === 'count' ? $t['reference'] : $t['id'],
                            $t['location'],
                            $run['id'],
                            $run['at'],
                            $run['actor'],
                            $run['source'],
                            $epc,
                            $status,
                            $obs[$epc] ?? 0,
                        ];
                    }
                }
            }
        }
        return $this->makeCsv(['reference', 'location', 'run_id', 'time_utc', 'actor', 'input_source', 'epc', 'classification', 'reads'], $rows);
    }

    public function stageOutbound(array $user, array $session, array $epcs): void
    {
        foreach ($epcs as $epc) {
            $before = $this->carton((string)$epc);
            if ($before === null || $before['state'] !== 'available') {
                fail('A verified carton is no longer on hand.');
            }
            if ($before['location'] === OUTBOUND_STAGING) {
                continue;
            }
            $this->db->run("UPDATE `cartons` SET location = ? WHERE epc = ? AND state = 'available'", [OUTBOUND_STAGING, $epc]);
            $this->record($user, $session['testId'], $before, $this->carton((string)$epc), 'Staged for outbound', 'Clean pallet scan confirmed', (string)$session['source']);
        }
    }

    public function recordPalletRemoval(array $user, array $pallet, string $reason): void
    {
        $this->record($user, (string)$pallet['reference'], ['state' => 'On hand'], ['epc' => $pallet['epc'], 'state' => 'Removed'], 'Pallet removed', $reason, 'Manual confirmation');
    }

    public function dispatch(array $user, array $session, array $before, array $after): void
    {
        $this->record($user, $session['testId'], $before, $after, 'Dispatched', '', (string)$session['source']);
    }
}
