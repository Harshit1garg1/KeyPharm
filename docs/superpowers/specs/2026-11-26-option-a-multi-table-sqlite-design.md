# Option A: Separated Multi-Table SQLite Schema & 300-Row User Activity Cap

## Context
Keep all existing JSON sync structures (`sessions`, `pallet_manifests`, `stock_tasks`), UI views, and debug `Reset demo data` behavior unchanged, while separating distinct domain/history record types into dedicated SQLite tables inside `workspace.sqlite` for long-term record preservation and straightforward TransIP migration later.

## Tables Added / Extended
1. `devices`: persists handheld `device_id`, `first_seen_at`, `last_contact_at`, `last_role`, `last_actor` in SQLite instead of Node RAM `Map`.
2. `settings_history`: appends every `setControls` change (`at`, `actor`, `role`, `revision`, `controls_json`).
3. `manifest_revisions`: mirrors every manifest version per outbound session.
4. `pallet_attempts`: mirrors every pallet identification attempt per session.
5. `scan_runs` & `scan_observations`: mirrors every carton scan pass and per-EPC read/outcome row (`matched`, `extra`, `pallet_tag`, `missing`, `observed`).
6. `stock_task_runs`: mirrors every inbound receipt & stock count scan pass from `stock_tasks`.
7. `carton_archive`: archives unregistered carton/mapping rows before `untag()` removes them from `cartons` / `stock_mappings`.
8. `audit`: extended with `role`, `actor_name`, `detail`, records workspace + stock + settings user activity, and trims older rows beyond `300` max (`ORDER BY id DESC LIMIT 300`) without affecting any domain data tables.

## Startup Migration & Reset
- On `createWorkspace(path)`, missing tables/columns are added idempotently, existing `sessions` / `stock_tasks` JSON rows are backfilled into the new tables, and `audit` is trimmed to 300 rows.
- `reset()` clears all workspace tables cleanly for debugging until `Reset demo data` is retired before production.
