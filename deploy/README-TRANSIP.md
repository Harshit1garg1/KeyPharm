# KeyPharm TransIP Deployment Guide (`keypharm.abiot.eu`)

Target folder structure for TransIP Webhosting (PHP 8.x + MariaDB):

## 1. Upload files to TransIP
Inside `subsites/keypharm.abiot.eu/` (or your subsite document root):
1. Upload everything inside `deploy/public/` directly into the subsite document root (`index.php`, `.htaccess`, `dashboard.html`, `*.mjs`, `*.css`, logos, font). Do **not** upload `router.php` (only used for local CLI smoke tests).
2. Upload `deploy/app_php/` and `deploy/sql/` either:
   - One level above the subsite root if TransIP allows, **or**
   - Inside `subsites/keypharm.abiot.eu/app_php/` and `sql/` (already blocked from web access by `.htaccess`).

## 2. Configure Database Password
Copy `app_php/config.php.example` to `app_php/config.local.php` and set your TransIP MariaDB password for `abiote_harshit` / `abiote_keypharm`:
```php
<?php
return [
    'db' => [
        'host' => 'localhost', // Check TransIP panel if DB host differs from localhost
        'port' => 3306,
        'name' => 'abiote_keypharm',
        'user' => 'abiote_harshit',
        'pass' => 'YOUR_TRANSiP_DB_PASSWORD',
    ],
];
```

## 3. Import Schema + Existing SQLite Records
In phpMyAdmin (for database `abiote_keypharm`):
1. First import `deploy/sql/schema.sql` (creates all 21 InnoDB tables with exact structure).
2. Then import `deploy/sql/seed-current-data.sql` (restores all current cartons, pallets, sessions, scan runs, observations, stock tasks, settings, locations, devices, and audit logs from your local workspace).
   - If you ever want to re-export newer local data before going live:
     `node tools/export-sqlite-to-mariadb.mjs`

## 4. Install Rebuilt Android APK on C72
- Rebuilt APK location: `build/keypharm-poc-0.9.36-transip-debug.apk`
- Package ID: `be.keypharm.rfid.poc.transip` (Label: `Keypharm RFID TransIP` — installs alongside your existing local Dev app without overwriting it).
- Server endpoint baked in: `https://keypharm.abiot.eu/api/`
- Sign in on dashboard and handheld with `testing` / `testing123` (change password in `config.local.php` or `KEYPHARM_DEMO_PASS` when ready).
