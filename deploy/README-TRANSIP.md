# KeyPharm TransIP Deployment Guide (`https://web.abiot.eu/keypharm/`)

Target folder on TransIP Webhosting (PHP 8.x + MariaDB): `subsites/web.abiot.eu/keypharm/`

## 1. Configure Database Password
Update `deploy/app_php/config.local.php` (gitignored, already created) with your TransIP MariaDB host (check TransIP Control Panel -> Databases if not `localhost`) and password for `abiote_harshit` / `abiote_keypharm`.

## 2. Upload files to TransIP (`subsites/web.abiot.eu/keypharm/`)
Run from Windows PowerShell / CMD (prompts once for SSH password, skips `router.php`, preserves `.htaccess`):
```powershell
cmd /c 'tar -C "D:\New Project\Work\Keypharm-transip\deploy" --exclude="public/router.php" -czf - public app_php sql | ssh abioteu@abiote.ssh.transip.me "mkdir -p subsites/web.abiot.eu/keypharm && cd subsites/web.abiot.eu/keypharm && tar -xzf - && mv -f public/* public/.htaccess . && rmdir public"'
```

## 3. Import Schema + Existing SQLite Records
In phpMyAdmin (for database `abiote_keypharm`):
1. First import `deploy/sql/schema.sql` (creates all 21 InnoDB tables).
2. Then import `deploy/sql/seed-current-data.sql` (restores all current cartons, pallets, sessions, scan runs, observations, stock tasks, settings, locations, devices, and audit logs).
   - If local SQLite updates later: `node tools/export-sqlite-to-mariadb.mjs`.

## 4. Verify Web + Install Rebuilt Android APK on C72
- Dashboard URL: `https://web.abiot.eu/keypharm/` (`testing` / `testing123`)
- Direct protection check: `https://web.abiot.eu/keypharm/app_php/config.local.php` must return `403`.
- Rebuilt APK: `build/keypharm-poc-0.9.36-transip-debug.apk`
- Package ID: `be.keypharm.rfid.poc.transip` (Label: `Keypharm IOT`).
- Handheld API endpoint baked in: `https://web.abiot.eu/keypharm/api/`
