# KeyPharm TransIP PHP + MariaDB Implementation Plan

> **For agentic workers:** Execute task-by-task, verifying PHP syntax, SQL import, API JSON parity, and Android APK build before finishing.

**Goal:** Deliver a TransIP-ready (`https://keypharm.abiot.eu/`) PHP 8.x + MariaDB port preserving all existing data, settings, menus, and UI unchanged, plus a rebuilt side-by-side Android APK in `D:\New Project\Work\Keypharm-transip`.

**Architecture:** Vanilla PHP 8.x + PDO MariaDB (no Composer dependencies) under `deploy/public/` + `deploy/app_php/`, advisory-locked transactions (`GET_LOCK`), normalized 21-table schema matching SQLite Option A, one-shot SQLite-to-MariaDB exporter for current records, and `MainActivity.java` URL patch.

**Tech Stack:** PHP 8.3 (PDO MySQL), MariaDB/MySQL 8 (InnoDB `utf8mb4_unicode_ci`), Apache `.htaccess`, Vanilla ES Modules (existing frontend), Android Java + SDK 34 (`build-android.ps1`).

---

### Task 1: Runtime Prep & SQLite Data Inspection
- Verify PHP 8.3 CLI + `pdo_mysql` installed locally and MySQL 8.0 service (`MYSQL80`) accessible for test DB.
- Export current SQLite DB tables/settings/records from `D:\New Project\Work\Keypharm\build\connected-poc\workspace.sqlite` via `tools/export-sqlite-to-mariadb.mjs` -> `deploy/sql/seed-current-data.sql`.

### Task 2: MariaDB Schema (`deploy/sql/schema.sql`) & PHP Config (`deploy/app_php/config.php`, `db.php`)
- Create `schema.sql` with all 21 InnoDB tables + indexes.
- Create `config.php`, `config.php.example`, `db.php` (`atomic()` lock, `ensureSchema()`, auto-seed if `settings` empty).

### Task 3: PHP Domain & CSV/EPC Rules (`deploy/app_php/model.php`)
- Port all backend-used helpers from `app/src/main/assets/model.mjs` with deterministic parity tests against `model.mjs` for CSV parsing, `parseManifest`, `compare`, `compareOutbound`, `skuProduct`, `cartonSku`, `palletIdentifier`, `specEvidenceCsv`, `parsePlan`.

### Task 4: PHP Auth & Stock Workflows (`deploy/app_php/auth.php`, `stock.php`)
- Port `workspace-server.mjs` cookie + `Basic`/`Bearer` HMAC auth (`settings` `auth-secret`).
- Port `tools/stock-workflows.mjs` (locations, cartons, stock tasks/commands/mappings/events/task_runs, carton_archive, CSV reports).

### Task 5: PHP Workspace Store & Front Controller (`deploy/app_php/workspace.php`, `deploy/public/index.php`, `.htaccess`, static assets)
- Port `tools/workspace-store.mjs` (`syncSessionRecords`, `reset`, `setControls`, `palletCatalog`, `palletManifest`, `skuCapacity`, `checkStock`, `create`, `action`, `dispatch`, `syncOne`, `verificationClaims`, `palletClaims`, `records`, `devices`).
- Copy dashboard static assets into `deploy/public/` and wire `.htaccess` + `index.php` routing + CSP/Origin/Secure cookie headers + `router.php` for PHP built-in test server.

### Task 6: Android Endpoint Update & APK Rebuild
- Edit `D:\New Project\Work\Keypharm-transip\app\src\main\java\be\keypharm\rfid\MainActivity.java` lines `389–391` to `https://keypharm.abiot.eu/api/`, `connectTimeout = 5000`, `readTimeout = 9000`.
- Remove unused `private-live-sample.csv` assumptions (none present) and run `.\tools\build-android.ps1 -Package be.keypharm.rfid.poc.transip -Label "Keypharm RFID TransIP"`. Verify `build\keypharm-poc-0.9.36-transip-debug.apk` with `apksigner verify`. Do NOT send to C72 via ADB.

### Task 7: Parity Verification (`php -l`, MySQL 8.0 API Smoke, Test Suite, Deployment Readme)
- Run `php -l` across all `.php` files.
- Import `schema.sql` + `seed-current-data.sql` into test DB on MySQL 8.0 and run API + Playwright/HTTP parity tests verifying sign-in, `api/workspace`, stock tasks, manifest builder, sync, dispatch, CSV reports, and reset.
- Write `deploy/README-TRANSIP.md` with exact TransIP upload & DB import steps.
