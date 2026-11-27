import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const source = resolve(process.argv[2] || 'D:/New Project/Work/Keypharm/build/connected-poc/workspace.sqlite');
const output = resolve(process.argv[3] || 'D:/New Project/Work/Keypharm-transip/deploy/sql/seed-current-data.sql');

const db = new DatabaseSync(source, {readOnly: true});

const q = value => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  return "'" + String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\0', '\\0')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll("'", "\\'") + "'";
};

const tables = [
  'settings',
  'cartons',
  'pallet_inventory',
  'pallet_manifests',
  'dashboard_sessions',
  'sessions',
  'operations',
  'audit',
  'devices',
  'settings_history',
  'manifest_revisions',
  'pallet_attempts',
  'scan_runs',
  'scan_observations',
  'workspace_locations',
  'stock_tasks',
  'stock_commands',
  'stock_mappings',
  'stock_events',
  'stock_task_runs',
  'carton_archive',
];

const rowidTables = new Set(['sessions', 'pallet_manifests', 'stock_tasks']);
const existing = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
);

const lines = [
  '-- Snapshot exported read-only from: ' + source,
  '-- Target database: abiote_keypharm (MariaDB InnoDB)',
  'SET NAMES utf8mb4;',
  'SET FOREIGN_KEY_CHECKS = 0;',
  '',
];

const summary = [];
for (const table of tables) {
  lines.push(`DELETE FROM \`${table}\`;`);
  if (!existing.has(table)) {
    summary.push(`${table}: 0 (missing in source)`);
    continue;
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const selectCols = rowidTables.has(table) ? [...cols, 'rowid AS seq'] : cols;
  const rows = db.prepare(`SELECT ${selectCols.join(', ')} FROM ${table}`).all();
  summary.push(`${table}: ${rows.length}`);
  if (!rows.length) continue;
  const colNames = rowidTables.has(table) ? [...cols, 'seq'] : cols;
  const colList = colNames.map(c => '`' + c + '`').join(', ');
  for (const row of rows) {
    const vals = colNames.map(c => q(row[c])).join(', ');
    lines.push(`INSERT INTO \`${table}\` (${colList}) VALUES (${vals});`);
  }
  lines.push('');
}

lines.push('SET FOREIGN_KEY_CHECKS = 1;', '');
await writeFile(output, lines.join('\n'), 'utf8');
db.close();
console.log('Exported to:', output);
for (const line of summary) console.log(' ', line);
