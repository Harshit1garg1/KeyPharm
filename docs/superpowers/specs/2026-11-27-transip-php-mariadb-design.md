# KeyPharm TransIP (PHP + MariaDB) Port Design

**Date:** 2026-11-27  
**Target host:** `https://keypharm.abiot.eu/` (TransIP Webhosting)  
**Database:** MariaDB `abiote_keypharm` (user `abiote_harshit`)  
**Workspace folder:** `D:\New Project\Work\Keypharm-transip` (`D:\New Project\Work\Keypharm` left untouched)

## Goal & Compatibility Contract
Port the KeyPharm connected PoC backend (`workspace-server.mjs`, `workspace-store.mjs`, `stock-workflows.mjs`, and backend helpers from `model.mjs`) cleanly to **PHP 8.x + PDO MariaDB** and rebuild a standalone **Android APK** pointing to `https://keypharm.abiot.eu/api/`, with **zero changes** to UI layout, menus, workflows, configurations, or existing data structures.

All existing records, settings (`inventory-options`, `test-controls`, `generation`, `sample`, `physical`), sessions, stock tasks, pallets, cartons, devices, and audit entries from `D:\New Project\Work\Keypharm\build\connected-poc\workspace.sqlite` are exported verbatim into an importable MariaDB SQL file (`deploy/sql/seed-current-data.sql`), alongside idempotent schema creation (`deploy/sql/schema.sql`) for clean installs.

## Folder Structure (`D:\New Project\Work\Keypharm-transip`)
- `deploy/public/` — TransIP document root (`subsites/keypharm.abiot.eu/`):
  - `.htaccess` — Apache rewrite to `index.php`, `HTTP_AUTHORIZATION` header forwarding (`RewriteRule ^ - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`), `.mjs` MIME (`text/javascript`), direct deny for `app_php/` or dotfiles.
  - `index.php` — Front controller routing static/HTML assets, `/dashboard/sign-in`, `/dashboard/sign-out`, `/records`, and `/api/*`.
  - Copied static assets from `app/src/main/assets/` (`dashboard.html`, `dashboard.css`, `dashboard.mjs`, `dashboard-theme.mjs`, `dashboard-model.mjs`, `workspace-dashboard.mjs`, `stock-dashboard.mjs`, `model.mjs`, `qrcode-generator.mjs`, `keypharm-favicon.svg`, `keypharm-logo-hd.png`, `keypharm-logo.png`, `InterVariable.woff2`).
- `deploy/app_php/` — Backend modules (blocked from direct HTTP serving via `.htaccess`, also runnable from outside docroot if placed one directory above `public/`):
  - `config.php` & `config.php.example` — DB DSN/credentials (`abiote_keypharm` / `abiote_harshit` / env override / local override `config.local.php`), demo PoC user (`testing` / `testing123`), path to bundled `private-live-sample.csv` (optional).
  - `db.php` — PDO connection (`ATTR_ERRMODE => ERRMODE_EXCEPTION`, `ATTR_STRINGIFY_FETCHES => false`, `ATTR_EMULATE_PREPARES => false`), `atomic()` helper using MariaDB `GET_LOCK('keypharm_workspace', 10)` + `START TRANSACTION` / `COMMIT` / `ROLLBACK` + `RELEASE_LOCK`, `ensureSchema()`, auto-seed if empty.
  - `auth.php` — Cookie sessions (`dashboard_sessions` table, `HttpOnly; SameSite=Strict`, `Secure` when HTTPS), `Basic` -> HMAC-SHA256 `Bearer` token (`auth-secret` stored in `settings`), role parsing (`operator`, `supervisor`, `admin`, `reviewer`), `X-KeyPharm-Device-Id` check, HTTPS/HTTP `Origin` check.
  - `model.php` — Exact PHP port of backend helpers in `app/src/main/assets/model.mjs` (`normalizeEpc`, `validEpc`, `productSku`, `cartonSku`, `demoSku`, `skuProduct`, `receiptProducts`, `receiptSizes`, `parseCsvRows`, `palletIdentifier`, `matchesPalletIdentifier`, `defaultInventoryOptions`, `skuManifestCsv`, `palletCartonCount`, `parseManifest`, `outboundManifestConflict`, `lockTo`, `pendingPallet`, `compare`, `compareOutbound`, `canClose`, `csvCell`, `specEvidenceCsv`, `manifestFor`, `parsePlan`, plus CSV/EPC helpers).
  - `stock.php` — Exact PHP port of `tools/stock-workflows.mjs` (locations, `cartons`, `stock_tasks`, `stock_commands`, `stock_mappings`, `stock_events`, `stock_task_runs`, `carton_archive`, CSV reports `stock|movements|receipts|counts|receipt-template`).
  - `workspace.php` — Exact PHP port of `tools/workspace-store.mjs` (`settings`, `pallet_inventory`, `pallet_manifests`, `sessions`, `operations`, `audit` with 300-row cap, `devices`, `settings_history`, `manifest_revisions`, `pallet_attempts`, `scan_runs`, `scan_observations`, `syncOne` + conflict detection, `palletManifest`, `dispatch`, `reset`).
- `deploy/sql/schema.sql` — All 21 MariaDB InnoDB (`utf8mb4_unicode_ci`) tables + indexes.
- `deploy/sql/seed-current-data.sql` — Generated directly from `D:\New Project\Work\Keypharm\build\connected-poc\workspace.sqlite` via `tools/export-sqlite-to-mariadb.mjs`.
- `app/src/main/java/be/keypharm/rfid/MainActivity.java` — Updated handheld endpoint `https://keypharm.abiot.eu/api/` with `connectTimeout = 5000`, `readTimeout = 9000`.
- `build/keypharm-poc-0.9.36-transip-debug.apk` — Rebuilt side-by-side APK (`be.keypharm.rfid.poc.transip`, label `Keypharm RFID TransIP`), NOT pushed to C72 via ADB.

## JSON & SQL Parity Guarantees
1. SQLite `BEGIN IMMEDIATE` write exclusivity is reproduced via MariaDB `GET_LOCK('keypharm_workspace', 10)` inside `atomic()` so concurrent handheld/dashboard writes never interleave stale cross-table reads (`skuCapacity`, `tagConflict`).
2. Empty JS objects (`observations`, `bySku`, `extraSkus`, `palletClaims`, `verificationClaims`, `skuAvailability`, `sessionPowers`, `receivedBySku`, `quantities`, `cartonDetails`, `allocation`, `palletMatches`) normalize via helper `asJsonObject()` (`(object)[]`) so `json_encode` never outputs `[]` instead of `{}`.
3. Filtered lists normalize with `array_values(...)` so `json_encode` outputs JSON arrays, never `{"0": ...}`.
4. Numeric columns cast explicitly (`(int)`, `(float)` or native PDO non-stringified integers/floats).

## Verification Plan
- **PHP syntax:** `php -l` on all PHP files under `deploy/public/` & `deploy/app_php/`.
- **PHP + MySQL 8.0 API & DB parity smoke test:** Import `schema.sql` + `seed-current-data.sql` into local MySQL 8.0, run PHP built-in server via `router.php`, verify `/dashboard/sign-in`, `/records`, `/api/login`, `/api/workspace`, stock task receipt/receive-carton/count, pallet manifest creation & session creation, handheld `/api/sync` Hold -> Match + offline conflict `409`, `/api/dispatch`, `/api/settings`, `/api/evidence.csv`, `/api/stock.csv`, and `/api/reset`.
- **Android APK build:** `tools/build-android.ps1 -Package be.keypharm.rfid.poc.transip -Label "Keypharm RFID TransIP"` + `apksigner verify` -> `build/keypharm-poc-0.9.36-transip-debug.apk`. Do not run `adb install`.
