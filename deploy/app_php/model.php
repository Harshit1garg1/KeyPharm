<?php

declare(strict_types=1);

const PRODUCT_CODES = [
    'Physalis' => 'DEMO-PHY',
    'Tiger Balm' => 'DEMO-TB',
    'Biotona' => 'DEMO-BIO',
];

const DEMO_ROLES = [
    'admin' => 'Administrator',
    'operator' => 'Operator',
    'supervisor' => 'Supervisor',
    'reviewer' => 'Reviewer',
];

const MANIFEST_COLUMNS = ['pallet_ref', 'pallet_epc', 'carton_ref', 'carton_epc', 'sku'];
const SKU_COLUMNS = ['pallet_ref', 'pallet_epc', 'sku', 'quantity'];
const TYPED_SKU_COLUMNS = ['pallet_ref', 'pallet_epc', 'sku', 'quantity', 'pallet_type'];

const EXPORT_COLUMNS = [
    'SessionID', 'Mode', 'TransactionRef', 'PalletRef', 'TestID', 'RunID', 'RunType', 'RunStart', 'RunEnd',
    'DurationSeconds', 'Location', 'StorageLevel', 'SKU', 'CartonRef', 'ExpectedEPC', 'ObservedEPC',
    'Classification', 'ReaderModel', 'DeviceID', 'RegionProfile', 'PowerSetting', 'ScanMethod', 'LabelType',
    'LabelPosition', 'ShieldingStatus', 'CompletenessPct', 'ResultStatus', 'ExceptionCode', 'Operator',
    'Reviewer', 'Disposition', 'Notes', 'ReadCount', 'FirstSeen', 'LastSeen', 'RSSI', 'ProfileVersion',
];

function defaultInventoryOptions(): array
{
    return [
        'palletMaterials' => [
            ['code' => 'PLAS', 'label' => 'Plastic'],
            ['code' => 'MET', 'label' => 'Metal'],
            ['code' => 'WOOD', 'label' => 'Wood'],
        ],
        'palletSizes' => [
            ['code' => 'S', 'label' => 'S'],
            ['code' => 'M', 'label' => 'M'],
            ['code' => 'L', 'label' => 'L'],
        ],
        'cartonSizes' => [
            ['code' => 'XS', 'label' => 'XS'],
            ['code' => 'S', 'label' => 'S'],
            ['code' => 'M', 'label' => 'M'],
            ['code' => 'L', 'label' => 'L'],
        ],
    ];
}

function normalizeEpc(mixed $value): string
{
    return strtoupper(trim((string)($value ?? '')));
}

function productSku(mixed $value): string
{
    $str = (string)($value ?? '');
    return $str === 'Juice' ? 'Physalis' : $str;
}

function cartonSku(array $carton): string
{
    if (!empty($carton['variant_size'])) {
        return ($carton['sku'] ?? '') . '-' . $carton['variant_size'];
    }
    $label = (string)($carton['carton'] ?? '');
    $sku = (string)($carton['sku'] ?? '');
    if (preg_match('/^(.+)-([A-Z0-9]+)-\d+$/i', $label, $m)) {
        if (strtoupper($m[1]) === strtoupper($sku)) {
            return $sku . '-' . strtoupper($m[2]);
        }
    }
    return $sku;
}

function demoSku(mixed $sku): string
{
    $s = (string)($sku ?? '');
    return PRODUCT_CODES[$s] ?? strtoupper($s);
}

function skuProduct(mixed $sku): string
{
    $value = (string)($sku ?? '');
    $upper = strtoupper($value);
    foreach (PRODUCT_CODES as $product => $code) {
        $family = strtoupper($product);
        if ($upper === $code || $upper === $family) {
            return $product;
        }
        if (str_starts_with($upper, $family . '-')) {
            return $product . substr($upper, strlen($family));
        }
    }
    return productSku($value);
}

function validEpc(string $value): bool
{
    return preg_match('/^(?:[0-9A-F]{2}){2,31}$/', $value) === 1;
}

function stripBom(string $text): string
{
    return str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text;
}

function splitCsvCells(string $line, int $row, string $sep, int $size = 5): array
{
    $q = preg_quote($sep, '/');
    $pattern = '/(?:^|' . $q . ')(?:"((?:[^"]|"")*)"|([^"' . $q . ']*))(?=' . $q . '|$)/u';
    if (!preg_match_all($pattern, $line, $matches, PREG_SET_ORDER)) {
        throw new HttpError('Row ' . $row . ': expected ' . ($size === 5 ? 'five' : $size) . ' CSV fields.', 400);
    }
    $joined = '';
    $cells = [];
    foreach ($matches as $m) {
        $joined .= $m[0];
        if (isset($m[1]) && $m[1] !== '' && ($m[0][0] === '"' || ($m[0][0] === $sep && ($m[0][1] ?? '') === '"'))) {
            $cells[] = trim(str_replace('""', '"', $m[1]));
        } elseif (($m[0][0] ?? '') === '"' || (($m[0][0] ?? '') === $sep && ($m[0][1] ?? '') === '"')) {
            $cells[] = trim(str_replace('""', '"', $m[1] ?? ''));
        } else {
            $cells[] = trim($m[2] ?? '');
        }
    }
    if ($joined !== $line || count($cells) !== $size) {
        throw new HttpError('Row ' . $row . ': expected ' . ($size === 5 ? 'five' : $size) . ' CSV fields.', 400);
    }
    return $cells;
}

function parseCsvRows(mixed $text, array $headers): array
{
    if (!is_string($text)) {
        throw new HttpError('Choose a CSV.', 400);
    }
    $clean = trim(stripBom($text));
    $lines = preg_split('/\r?\n/', $clean) ?: [];
    $header = array_shift($lines) ?? '';
    $sep = null;
    $target = implode(',', $headers);
    foreach ([',', ';'] as $cand) {
        $cols = array_map(static fn(string $c): string => trim($c), explode($cand, strtolower($header)));
        if (implode(',', $cols) === $target) {
            $sep = $cand;
            break;
        }
    }
    if ($sep === null) {
        throw new HttpError('Use the template headers and at least one data row.', 400);
    }
    $rows = [];
    $q = preg_quote($sep, '/');
    foreach ($lines as $idx => $line) {
        if (preg_replace('/[\s"' . $q . ']/u', '', $line) === '') {
            continue;
        }
        $rows[] = splitCsvCells($line, $idx + 2, $sep, count($headers));
    }
    if ($rows === []) {
        throw new HttpError('Use the template headers and at least one data row.', 400);
    }
    return $rows;
}

function csvCell(mixed $value): string
{
    $str = (string)($value ?? '');
    if (!preg_match('/^-?\d+(\.\d+)?$/', $str) && (preg_match('/^[\s\x00-\x1f]*[=+@-]/', $str) || preg_match('/^[\t\r\n]/', $str))) {
        $str = "'" . $str;
    }
    return '"' . str_replace('"', '""', $str) . '"';
}

function palletCodeFromOptions(string $value, array $options): string
{
    foreach ($options as $option) {
        if (strcasecmp((string)$option['code'], $value) === 0 || strcasecmp((string)$option['label'], $value) === 0) {
            return (string)$option['code'];
        }
    }
    return preg_replace('/[^A-Z0-9]/', '', strtoupper($value)) ?? '';
}

function palletIdentifier(array $pallet, ?array $options = null): string
{
    $opts = $options ?? defaultInventoryOptions();
    return 'PAL-' . palletCodeFromOptions((string)$pallet['material'], $opts['palletMaterials'])
        . '-' . palletCodeFromOptions((string)$pallet['size'], $opts['palletSizes']);
}

function matchesPalletIdentifier(string $required, string $actual): bool
{
    if ($required === $actual) {
        return true;
    }
    $parts = explode(' / ', $required, 2);
    if (count($parts) === 2 && $parts[1] !== '') {
        return palletIdentifier(['material' => $parts[0], 'size' => $parts[1]]) === $actual;
    }
    return false;
}

function palletCartonCount(array $pallet): int
{
    if (isset($pallet['requirements']) && is_array($pallet['requirements'])) {
        $sum = 0;
        foreach ($pallet['requirements'] as $row) {
            $sum += (int)($row['quantity'] ?? 0);
        }
        return $sum;
    }
    return count($pallet['cartons'] ?? []);
}

function skuManifestCsv(array $pallets): string
{
    $typed = false;
    foreach ($pallets as $p) {
        if (!empty($p['palletType'])) {
            $typed = true;
            break;
        }
    }
    $lines = [implode(',', $typed ? TYPED_SKU_COLUMNS : SKU_COLUMNS)];
    foreach ($pallets as $pallet) {
        foreach ($pallet['requirements'] ?? [] as $req) {
            $row = [$pallet['pallet'], $pallet['palletEpc'], demoSku($req['sku']), $req['quantity']];
            if ($typed) {
                $row[] = $pallet['palletType'] ?? '';
            }
            $lines[] = implode(',', array_map('csvCell', $row));
        }
    }
    return implode("\n", $lines);
}

function parseSkuManifest(string $text, array $columns = SKU_COLUMNS): array
{
    $pallets = [];
    $tags = [];
    $labels = 0;
    foreach (parseCsvRows($text, $columns) as $rowVals) {
        $pallet = (string)($rowVals[0] ?? '');
        $tag = (string)($rowVals[1] ?? '');
        $code = (string)($rowVals[2] ?? '');
        $value = (string)($rowVals[3] ?? '');
        $palletType = (string)($rowVals[4] ?? '');
        $palletEpc = normalizeEpc($tag);
        $sku = skuProduct($code);
        if (!preg_match('/^\d+$/', $value)) {
            throw new HttpError('Enter a pallet reference, EPC, SKU and whole carton quantity.', 400);
        }
        $quantity = (int)$value;
        if ($pallet === '' || strlen($pallet) > 80 || preg_match('/^[=+@-]/', $pallet) || !validEpc($palletEpc) || $sku === '' ||
            $quantity < 1 || $quantity > 499) {
            throw new HttpError('Enter a pallet reference, EPC, SKU and whole carton quantity.', 400);
        }
        if (!isset($pallets[$pallet])) {
            if (isset($tags[$palletEpc])) {
                throw new HttpError('A pallet EPC can appear under one pallet reference only.', 400);
            }
            $tags[$palletEpc] = true;
            $entry = ['pallet' => $pallet, 'palletEpc' => $palletEpc, 'cartons' => [], 'requirements' => []];
            if ($palletType !== '') {
                $entry['palletType'] = $palletType;
            }
            $pallets[$pallet] = $entry;
            $labels++;
        }
        $entry =& $pallets[$pallet];
        if ($entry['palletEpc'] !== $palletEpc || ($entry['palletType'] ?? '') !== $palletType ||
            array_filter($entry['requirements'], static fn(array $r): bool => $r['sku'] === $sku) !== []) {
            throw new HttpError('Use one quantity per SKU on each pallet.', 400);
        }
        $entry['requirements'][] = ['sku' => $sku, 'quantity' => $quantity];
        unset($entry);
        $labels += $quantity;
        if ($labels > 500) {
            throw new HttpError('A manifest can use up to 500 labels.', 400);
        }
    }
    $list = array_values($pallets);
    $base = count($list) === 1 ? $list[0] : ['pallet' => count($list) . ' pallets', 'palletEpc' => '', 'cartons' => []];
    return array_merge($base, ['matchBy' => 'sku', 'pallets' => $list]);
}

function parseManifest(string $text): array
{
    $lines = preg_split('/\r?\n/', trim(stripBom($text))) ?: [];
    $header = strtolower(array_shift($lines) ?? '');
    foreach ([',', ';'] as $cand) {
        $cols = array_map(static fn(string $f): string => trim($f), explode($cand, $header));
        $joined = implode(',', $cols);
        if ($joined === implode(',', SKU_COLUMNS)) {
            return parseSkuManifest($text);
        }
        if ($joined === implode(',', TYPED_SKU_COLUMNS)) {
            return parseSkuManifest($text, TYPED_SKU_COLUMNS);
        }
    }
    $sep = null;
    foreach ([',', ';'] as $cand) {
        $cols = array_map(static fn(string $h): string => trim($h), explode($cand, $header));
        if (implode(',', $cols) === implode(',', MANIFEST_COLUMNS)) {
            $sep = $cand;
            break;
        }
    }
    if ($sep === null) {
        throw new HttpError('Use the five headers from the sample CSV, separated by commas or semicolons.', 400);
    }
    if ($lines === []) {
        throw new HttpError('Manifest needs at least one carton.', 400);
    }
    $pallets = [];
    $palletRefs = [];
    $epcs = [];
    $references = [];
    $errors = [];
    $q = preg_quote($sep, '/');
    foreach ($lines as $idx => $line) {
        $row = $idx + 2;
        if (preg_replace('/[\s"' . $q . ']/u', '', $line) === '') {
            continue;
        }
        try {
            [$pallet, $palletTag, $carton, $tag, $sku] = splitCsvCells($line, $row, $sep);
            $palletEpc = normalizeEpc($palletTag);
            $epc = normalizeEpc($tag);
            if ($pallet === '' || $carton === '') {
                throw new HttpError('Row ' . $row . ': provide pallet and carton references.', 400);
            }
            if (!validEpc($palletEpc) || !validEpc($epc)) {
                throw new HttpError('Row ' . $row . ': EPC must be even-length hexadecimal.', 400);
            }
            if ($epc === $palletEpc || isset($epcs[$epc]) || isset($palletRefs[$epc])) {
                throw new HttpError('Row ' . $row . ': duplicate EPC.', 400);
            }
            $upperRef = strtoupper($carton);
            if (isset($references[$upperRef])) {
                throw new HttpError('Row ' . $row . ': duplicate carton reference.', 400);
            }
            if (isset($pallets[$pallet]) && $pallets[$pallet]['palletEpc'] !== $palletEpc) {
                throw new HttpError('Row ' . $row . ': pallet ' . $pallet . ' already has another pallet EPC.', 400);
            }
            if (!isset($pallets[$pallet])) {
                if (isset($palletRefs[$palletEpc]) || isset($epcs[$palletEpc])) {
                    throw new HttpError('Row ' . $row . ': pallet EPC is already used in this file.', 400);
                }
                $pallets[$pallet] = ['pallet' => $pallet, 'palletEpc' => $palletEpc, 'cartons' => []];
                $palletRefs[$palletEpc] = $pallet;
            }
            $epcs[$epc] = true;
            $references[$upperRef] = true;
            $pallets[$pallet]['cartons'][] = ['epc' => $epc, 'carton' => $carton, 'sku' => productSku($sku)];
        } catch (Throwable $e) {
            $errors[] = $e->getMessage();
        }
    }
    if ($errors !== []) {
        $shown = array_slice($errors, 0, 20);
        if (count($errors) > 20) {
            $shown[] = "\u{2026}and " . (count($errors) - 20) . ' more rows.';
        }
        throw new HttpError(implode("\n", $shown), 400);
    }
    $list = array_values($pallets);
    if ($list === []) {
        throw new HttpError('Manifest needs at least one carton.', 400);
    }
    if (count($list) === 1) {
        return array_merge($list[0], ['pallets' => $list]);
    }
    return ['pallet' => 'Any of ' . count($list) . ' pallets', 'palletEpc' => '', 'cartons' => [], 'pallets' => $list];
}

function palletsOf(?array $m): array
{
    if (!$m) {
        return [];
    }
    if (!empty($m['pallets']) && is_array($m['pallets'])) {
        return $m['pallets'];
    }
    return [$m];
}

function manifestCartons(?array $m): array
{
    $out = [];
    foreach (palletsOf($m) as $pallet) {
        foreach ($pallet['cartons'] ?? [] as $c) {
            $out[] = $c;
        }
    }
    return $out;
}

function outboundManifestConflict(array $manifest, array $inventory, array $sessions, ?string $currentId): string
{
    $expected = [];
    foreach (manifestCartons($manifest) as $c) {
        $expected[$c['epc']] = true;
    }
    $shipped = [];
    foreach ($inventory as $c) {
        if (($c['state'] ?? '') === 'dispatched' && isset($expected[$c['epc']])) {
            $shipped[$c['epc']] = true;
        }
    }
    if ($shipped !== []) {
        $refs = [];
        foreach ($sessions as $session) {
            if (empty($session['dispatchedAt'])) {
                continue;
            }
            foreach (manifestCartons($session['manifest'] ?? null) as $c) {
                if (isset($shipped[$c['epc']])) {
                    $refs[] = $session['testId'];
                    break;
                }
            }
        }
        return 'This manifest contains cartons already dispatched'
            . ($refs !== [] ? ' under ' . implode(', ', $refs) : '')
            . '. Change the CSV to use cartons currently on hand.';
    }
    $assigned = [];
    foreach ($sessions as $session) {
        if (($session['id'] ?? null) === $currentId || !empty($session['dispatchedAt'])) {
            continue;
        }
        foreach (manifestCartons($session['manifest'] ?? null) as $c) {
            if (isset($expected[$c['epc']])) {
                $assigned[] = $session['testId'];
                break;
            }
        }
    }
    if ($assigned !== []) {
        return 'This manifest contains cartons assigned to ' . implode(', ', $assigned)
            . '. Open or reopen the existing session to continue verification, or change the CSV if the assignment is a mistake.';
    }
    return '';
}

function receiptProducts(array $task): array
{
    $quantities = $task['quantities'] ?? null;
    if ($quantities === null) {
        $quantities = [];
        foreach ($task['expected'] ?? [] as $carton) {
            $sku = $carton['sku'];
            $quantities[$sku] = ($quantities[$sku] ?? 0) + 1;
        }
    }
    $identifiers = $task['identifiers'] ?? array_map(static fn(string $sku): array => [$sku, $sku], array_keys($quantities));
    $receivedSet = array_flip($task['received'] ?? []);
    $result = [];
    foreach ($identifiers as [$identifier, $sku]) {
        if (isset($task['receivedBySku']) && array_key_exists($sku, $task['receivedBySku'])) {
            $receivedCount = (int)$task['receivedBySku'][$sku];
        } else {
            $receivedCount = 0;
            foreach ($task['expected'] ?? [] as $c) {
                if ($c['sku'] === $sku && isset($receivedSet[$c['epc']])) {
                    $receivedCount++;
                }
            }
        }
        $result[] = [
            'identifier' => $identifier,
            'sku' => $sku,
            'remaining' => (int)$quantities[$sku] - $receivedCount,
        ];
    }
    return $result;
}

function receiptSizes(array $task, string $sku, array $sizes): array
{
    if (($task['mode'] ?? '') === 'SKU') {
        return $sizes;
    }
    $receivedSet = array_flip($task['received'] ?? []);
    $outstanding = [];
    foreach ($task['expected'] ?? [] as $carton) {
        if ($carton['sku'] === $sku && !isset($receivedSet[$carton['epc']])) {
            $outstanding[] = $carton;
        }
    }
    if ($outstanding === []) {
        return $sizes;
    }
    foreach ($outstanding as $carton) {
        if (cartonSku($carton) === $sku) {
            return $sizes;
        }
    }
    $codes = [];
    foreach ($outstanding as $carton) {
        $codes[substr(cartonSku($carton), strlen($sku) + 1)] = true;
    }
    $byCode = [];
    foreach ($sizes as $s) {
        $byCode[$s['code']] = $s;
    }
    $out = [];
    foreach (array_keys($codes) as $code) {
        $out[] = $byCode[$code] ?? ['code' => $code, 'label' => $code];
    }
    return $out;
}

function pendingPallet(array $session): ?array
{
    $matches = $session['palletMatches'] ?? [];
    foreach ($session['manifest']['pallets'] ?? [] as $pallet) {
        if (empty($matches[$pallet['palletEpc']])) {
            return $pallet;
        }
    }
    return null;
}

function lockTo(array $manifest, array $pallet): array
{
    $copy = $manifest;
    $copy['pallet'] = $pallet['pallet'];
    $copy['palletEpc'] = $pallet['palletEpc'];
    $copy['cartons'] = $pallet['cartons'];
    if (array_key_exists('requirements', $pallet)) {
        $copy['requirements'] = $pallet['requirements'];
    } else {
        unset($copy['requirements']);
    }
    if (array_key_exists('palletType', $pallet)) {
        $copy['palletType'] = $pallet['palletType'];
    } else {
        unset($copy['palletType']);
    }
    return $copy;
}

function tagsOfPallet(array $p): array
{
    $tags = [$p['palletEpc'] ?? ''];
    foreach ($p['cartons'] ?? [] as $c) {
        $tags[] = $c['epc'];
    }
    return $tags;
}

function otherPallet(?array $manifest, string $epc): ?string
{
    foreach (palletsOf($manifest) as $p) {
        if (($p['palletEpc'] ?? '') !== ($manifest['palletEpc'] ?? '') && in_array($epc, tagsOfPallet($p), true)) {
            return $p['pallet'];
        }
    }
    return null;
}

function compareManifest(array $manifest, array $observed, array $inventory = []): array
{
    if (!empty($manifest['requirements'])) {
        $remaining = [];
        foreach ($manifest['requirements'] as $req) {
            $remaining[skuProduct($req['sku'])] = (int)$req['quantity'];
        }
        $catalog = [];
        foreach ($inventory as $carton) {
            if (($carton['state'] ?? '') === 'available') {
                $catalog[$carton['epc']] = $carton;
            }
        }
        $matched = [];
        $extra = [];
        $matchedCartons = [];
        $seen = [];
        $palletEpc = $manifest['actualPalletEpc'] ?? ($manifest['palletEpc'] ?? '');
        foreach ($observed as $raw) {
            $epc = normalizeEpc($raw);
            if ($epc === '' || $epc === $palletEpc || isset($seen[$epc])) {
                continue;
            }
            $seen[$epc] = true;
            $carton = $catalog[$epc] ?? null;
            $sku = null;
            if ($carton !== null) {
                $variant = cartonSku($carton);
                $sku = !empty($remaining[$variant]) ? $variant : $carton['sku'];
            }
            if ($sku === null || empty($remaining[$sku])) {
                $extra[] = $epc;
                continue;
            }
            $remaining[$sku]--;
            $matched[] = $epc;
            $item = ['epc' => $epc, 'sku' => $carton['sku'], 'carton' => $carton['carton']];
            if (!empty($carton['variant_size'])) {
                $item['variant_size'] = $carton['variant_size'];
            }
            $matchedCartons[] = $item;
        }
        $expected = palletCartonCount($manifest);
        $missing = [];
        foreach ($remaining as $sku => $qty) {
            for ($i = 0; $i < $qty; $i++) {
                $missing[] = $sku;
            }
        }
        return [
            'expected' => $expected,
            'matched' => $matched,
            'missing' => $missing,
            'extra' => $extra,
            'matchedCartons' => $matchedCartons,
            'percent' => round(count($matched) * 1000 / $expected) / 10,
            'status' => $extra !== [] ? 'Hold' : ($missing !== [] ? 'Incomplete' : 'Match'),
        ];
    }

    $expected = [];
    foreach ($manifest['cartons'] ?? [] as $c) {
        $expected[$c['epc']] = true;
    }
    $seen = [];
    $palletEpc = $manifest['palletEpc'] ?? '';
    foreach ($observed as $raw) {
        $epc = normalizeEpc($raw);
        if ($epc !== '' && $epc !== $palletEpc) {
            $seen[$epc] = true;
        }
    }
    $matched = [];
    $missing = [];
    foreach (array_keys($expected) as $epc) {
        if (isset($seen[$epc])) {
            $matched[] = $epc;
        } else {
            $missing[] = $epc;
        }
    }
    $extra = [];
    foreach (array_keys($seen) as $epc) {
        if (!isset($expected[$epc])) {
            $extra[] = $epc;
        }
    }
    $expectedCount = count($expected);
    $percent = $expectedCount > 0 ? round(count($matched) * 1000 / $expectedCount) / 10 : null;
    $status = $extra !== [] ? 'Hold' : (($missing !== [] || $expectedCount === 0) ? 'Incomplete' : 'Match');
    return [
        'expected' => $expectedCount,
        'matched' => $matched,
        'missing' => $missing,
        'extra' => $extra,
        'percent' => $percent,
        'status' => $status,
    ];
}

function compareOutbound(array $manifest, array $observed, array $inventory, array $blockedSet): array
{
    $eligible = [];
    $refused = [];
    foreach ($observed as $epc) {
        if (isset($blockedSet[$epc])) {
            $refused[] = $epc;
        } else {
            $eligible[] = $epc;
        }
    }
    $result = compareManifest($manifest, $eligible, $inventory);
    if ($refused !== []) {
        $result['extra'] = array_values(array_unique(array_merge($result['extra'], $refused)));
        $result['status'] = 'Hold';
    }
    return $result;
}

function canCloseSession(?array $session, ?array $review, string $role): bool
{
    if (!in_array($role, ['operator', 'admin', 'supervisor'], true) || !$session || !empty($session['closedAt'])) {
        return false;
    }
    $hasRun = false;
    foreach ($session['runs'] ?? [] as $run) {
        if (in_array($run['state'] ?? '', ['Finished', 'Interrupted'], true)) {
            $hasRun = true;
            break;
        }
    }
    if (!$hasRun || empty($review['reviewed'])) {
        return false;
    }
    return trim((string)($review['coverage'] ?? '')) !== '';
}

function manifestForRun(array $s, array $run): ?array
{
    $manifest = null;
    $targetRev = $run['manifestRevision'] ?? null;
    foreach (array_merge($s['manifestRevisions'] ?? [], isset($s['manifest']) ? [$s['manifest']] : []) as $m) {
        if ($m && ($m['revision'] ?? null) === $targetRev) {
            $manifest = $m;
            break;
        }
    }
    $manifest ??= $s['manifest'] ?? null;
    if ($manifest && !empty($manifest['pallets'])) {
        foreach ($manifest['pallets'] as $entry) {
            if (($entry['palletEpc'] ?? '') === ($run['palletEpc'] ?? null)) {
                return lockTo($manifest, $entry);
            }
        }
    }
    return $manifest;
}

function specEvidenceCsv(array $store): string
{
    $rows = [EXPORT_COLUMNS];
    foreach ($store['sessions'] ?? [] as $s) {
        $firstPassByPallet = [];
        foreach ($s['runs'] ?? [] as $run) {
            if (empty($run['result'])) {
                continue;
            }
            $r = $run['result'];
            $p = $run['profile'] ?? [];
            $m = manifestForRun($s, $run);
            $key = (string)($m['palletEpc'] ?? '');
            $rescan = isset($firstPassByPallet[$key]);
            $firstPassByPallet[$key] = true;
            $cartons = [];
            foreach (($r['matchedCartons'] ?? $m['cartons'] ?? []) as $c) {
                $cartons[$c['epc']] = $c;
            }
            $notes = [];
            $disposition = [];
            foreach ($s['logs'] ?? [] as $log) {
                if (($log['run'] ?? null) !== ($run['id'] ?? null)) {
                    continue;
                }
                if (($log['action'] ?? '') === 'Run note') {
                    $notes[] = $log['detail'];
                } elseif (str_starts_with((string)($log['action'] ?? ''), 'Unexpected EPC ')) {
                    $parts = explode(' / ', (string)($log['detail'] ?? ''));
                    $epc = array_shift($parts);
                    $outcome = substr($log['action'], strlen('Unexpected EPC '));
                    $disposition[$epc] = [
                        'outcome' => strtoupper(substr($outcome, 0, 1)) . substr($outcome, 1),
                        'note' => implode(' / ', $parts),
                    ];
                }
            }
            $buildRow = static function (string $epc, string $classification, bool $expected, bool $observed, string $code, ?string $note = null) use ($s, $run, $r, $p, $m, $rescan, $cartons, $notes, $disposition): array {
                $c = $cartons[$epc] ?? null;
                $read = $run['observations'][$epc] ?? null;
                if (is_int($read)) {
                    $read = ['count' => $read];
                }
                $d = $disposition[$epc] ?? null;
                $allNotes = array_values(array_filter(array_merge([
                    $note,
                    !empty($run['reason']) ? 'Rescan reason: ' . $run['reason'] : null,
                    $d['note'] ?? null,
                ], $notes), static fn($v): bool => $v !== null && $v !== ''));
                return [
                    $s['id'] ?? '',
                    $s['mode'] ?? 'POC',
                    '',
                    $m['pallet'] ?? null,
                    $s['testId'] ?? null,
                    $run['id'] ?? null,
                    $rescan ? 'Rescan' : 'First pass',
                    $run['startedAt'] ?? null,
                    $run['endedAt'] ?? null,
                    $run['elapsedSeconds'] ?? null,
                    $s['location'] ?? null,
                    $s['level'] ?? null,
                    $c['sku'] ?? null,
                    $c['carton'] ?? null,
                    $expected ? $epc : '',
                    $observed ? $epc : '',
                    $classification,
                    $p['model'] ?? ($p['name'] ?? null),
                    $p['deviceId'] ?? null,
                    $p['region'] ?? null,
                    $p['powerDbm'] ?? null,
                    $run['method'] ?? ($s['method'] ?? null),
                    $s['label'] ?? null,
                    $s['placement'] ?? null,
                    $s['shielding'] ?? null,
                    $r['percent'] ?? null,
                    ($run['state'] ?? '') === 'Finished' ? ($r['status'] ?? null) : ($run['state'] ?? null),
                    $code,
                    $run['operator'] ?? null,
                    $s['closure']['actor'] ?? null,
                    $d['outcome'] ?? null,
                    implode(' | ', $allNotes),
                    $read['count'] ?? null,
                    $read['first'] ?? null,
                    $read['last'] ?? null,
                    $read['rssi'] ?? null,
                    $p['version'] ?? null,
                ];
            };

            if (!empty($m['requirements'])) {
                foreach ($r['matched'] ?? [] as $epc) {
                    $rows[] = $buildRow($epc, 'Matched', false, true, '');
                }
                foreach ($r['missing'] ?? [] as $sku) {
                    $missing = $buildRow('', 'Missing', false, false, 'MISSING_CARTON');
                    $missing[12] = $sku;
                    $rows[] = $missing;
                }
            } else {
                $matched = $r['matched'] ?? [];
                foreach ($m['cartons'] ?? [] as $c) {
                    $seen = in_array($c['epc'], $matched, true);
                    $rows[] = $buildRow($c['epc'], $seen ? 'Matched' : 'Missing', true, $seen, $seen ? '' : 'MISSING_CARTON');
                }
            }
            foreach ($r['extra'] ?? [] as $epc) {
                $other = otherPallet($m, $epc);
                $rows[] = $buildRow($epc, 'Unexpected', false, true, $other ? 'OTHER_PALLET_EPC' : 'UNEXPECTED_EPC', $other ? 'Belongs to pallet ' . $other : null);
            }
            if ($key !== '' && isset($run['observations'][$key])) {
                $rows[] = $buildRow($key, 'Pallet tag', false, true, '');
            }
        }
    }
    return "\xEF\xBB\xBF" . implode("\r\n", array_map(static fn(array $r): string => implode(',', array_map('csvCell', $r)), $rows)) . "\r\n";
}

function parsePlan(string $text): array
{
    $tests = [];
    $ids = [];
    foreach (preg_split('/\r?\n/', $text) ?: [] as $rawLine) {
        $line = trim($rawLine);
        if ($line === '') {
            continue;
        }
        $parts = preg_split('/\s+/', $line) ?: [];
        $id = array_shift($parts) ?? '';
        $upper = strtoupper($id);
        if (isset($ids[$upper])) {
            throw new HttpError('Duplicate planned test ' . $id . '.', 400);
        }
        $ids[$upper] = true;
        $tests[] = ['id' => $id, 'title' => implode(' ', $parts)];
    }
    if ($tests === []) {
        throw new HttpError('Enter at least one planned test, one per line.', 400);
    }
    return $tests;
}
