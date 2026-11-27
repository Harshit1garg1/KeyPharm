-- KeyPharm TransIP MariaDB Schema (21 tables matching SQLite workspace-store & stock-workflows)
-- Engine: InnoDB, Charset: utf8mb4, Collation: utf8mb4_unicode_ci

CREATE TABLE IF NOT EXISTS `settings` (
  `key` VARCHAR(64) NOT NULL PRIMARY KEY,
  `value` LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cartons` (
  `epc` VARCHAR(64) NOT NULL PRIMARY KEY,
  `carton` VARCHAR(128) NOT NULL,
  `sku` VARCHAR(64) NOT NULL,
  `physical` TINYINT NOT NULL DEFAULT 0,
  `state` VARCHAR(32) NOT NULL DEFAULT 'available',
  `reservation` VARCHAR(128) NULL,
  `location` VARCHAR(191) NOT NULL DEFAULT 'Outbound staging',
  `variant_size` VARCHAR(32) NULL,
  `batch_lot` VARCHAR(128) NULL,
  `units_per_carton` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pallet_inventory` (
  `epc` VARCHAR(64) NOT NULL PRIMARY KEY,
  `reference` VARCHAR(191) NOT NULL,
  `sku` VARCHAR(64) NOT NULL,
  `size` VARCHAR(64) NOT NULL,
  `material` VARCHAR(64) NOT NULL,
  `shape` VARCHAR(64) NOT NULL DEFAULT 'Unspecified',
  `removed` TINYINT NOT NULL DEFAULT 0,
  UNIQUE KEY `uniq_pallet_reference` (`reference`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pallet_manifests` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `body` LONGTEXT NOT NULL,
  `seq` BIGINT NOT NULL AUTO_INCREMENT,
  UNIQUE KEY `uniq_pallet_manifests_seq` (`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dashboard_sessions` (
  `id` VARCHAR(128) NOT NULL PRIMARY KEY,
  `expires` BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sessions` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `revision` INT NOT NULL,
  `body` LONGTEXT NOT NULL,
  `seq` BIGINT NOT NULL AUTO_INCREMENT,
  UNIQUE KEY `uniq_sessions_seq` (`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `operations` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `actor` VARCHAR(64) NOT NULL,
  `session` VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `at` VARCHAR(64) NOT NULL,
  `actor` VARCHAR(64) NOT NULL,
  `action` VARCHAR(128) NOT NULL,
  `session` VARCHAR(128) NOT NULL,
  `role` VARCHAR(32) NULL,
  `actor_name` VARCHAR(128) NULL,
  `detail` TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `devices` (
  `device_id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `first_seen_at` VARCHAR(64) NOT NULL,
  `last_contact_at` VARCHAR(64) NOT NULL,
  `last_role` VARCHAR(32) NULL,
  `last_actor` VARCHAR(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `settings_history` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `at` VARCHAR(64) NOT NULL,
  `actor` VARCHAR(128) NOT NULL,
  `role` VARCHAR(32) NOT NULL,
  `revision` INT NOT NULL,
  `controls_json` LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `manifest_revisions` (
  `session_id` VARCHAR(64) NOT NULL,
  `revision` INT NOT NULL,
  `source` VARCHAR(128) NULL,
  `pallet_ref` VARCHAR(128) NULL,
  `pallet_epc` VARCHAR(64) NULL,
  `carton_count` INT NOT NULL,
  `imported_at` VARCHAR(64) NULL,
  `manifest_json` LONGTEXT NOT NULL,
  PRIMARY KEY (`session_id`, `revision`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pallet_attempts` (
  `id` VARCHAR(128) NOT NULL PRIMARY KEY,
  `session_id` VARCHAR(64) NOT NULL,
  `manifest_revision` INT NULL,
  `actor` VARCHAR(128) NULL,
  `locked_pallet` VARCHAR(128) NULL,
  `pallet_epc` VARCHAR(64) NULL,
  `result` VARCHAR(64) NULL,
  `started_at` VARCHAR(64) NULL,
  `ended_at` VARCHAR(64) NULL,
  `profile_json` LONGTEXT NULL,
  `observations_json` LONGTEXT NULL,
  KEY `pallet_attempts_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scan_runs` (
  `id` VARCHAR(128) NOT NULL PRIMARY KEY,
  `session_id` VARCHAR(64) NOT NULL,
  `pallet_epc` VARCHAR(64) NULL,
  `manifest_revision` INT NULL,
  `operator` VARCHAR(128) NULL,
  `source` VARCHAR(64) NULL,
  `state` VARCHAR(32) NULL,
  `status` VARCHAR(32) NULL,
  `expected_count` INT NULL,
  `matched_count` INT NULL,
  `missing_count` INT NULL,
  `extra_count` INT NULL,
  `percent` DOUBLE NULL,
  `reason` TEXT NULL,
  `notes` TEXT NULL,
  `error` TEXT NULL,
  `started_at` VARCHAR(64) NULL,
  `ended_at` VARCHAR(64) NULL,
  `elapsed_seconds` INT NULL,
  `profile_json` LONGTEXT NULL,
  `result_json` LONGTEXT NULL,
  KEY `scan_runs_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scan_observations` (
  `run_id` VARCHAR(128) NOT NULL,
  `epc` VARCHAR(64) NOT NULL,
  `outcome` VARCHAR(32) NOT NULL,
  `read_count` INT NOT NULL,
  `rssi` DOUBLE NULL,
  `first_seen_at` VARCHAR(64) NULL,
  `last_seen_at` VARCHAR(64) NULL,
  PRIMARY KEY (`run_id`, `epc`),
  KEY `scan_observations_epc` (`epc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workspace_locations` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `name` VARCHAR(191) NOT NULL,
  `archived` TINYINT NOT NULL DEFAULT 0,
  UNIQUE KEY `uniq_workspace_locations_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_tasks` (
  `id` VARCHAR(128) NOT NULL PRIMARY KEY,
  `revision` INT NOT NULL,
  `body` LONGTEXT NOT NULL,
  `seq` BIGINT NOT NULL AUTO_INCREMENT,
  UNIQUE KEY `uniq_stock_tasks_seq` (`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_commands` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `actor` VARCHAR(64) NOT NULL,
  `body` LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_mappings` (
  `epc` VARCHAR(64) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `at` VARCHAR(64) NOT NULL,
  `actor` VARCHAR(128) NOT NULL,
  `ref` VARCHAR(128) NOT NULL,
  `epc` VARCHAR(64) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `before_state` TEXT NOT NULL,
  `after_state` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `source` VARCHAR(64) NOT NULL,
  KEY `stock_events_epc` (`epc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_task_runs` (
  `id` VARCHAR(128) NOT NULL PRIMARY KEY,
  `task_id` VARCHAR(128) NOT NULL,
  `task_type` VARCHAR(32) NOT NULL,
  `actor` VARCHAR(128) NULL,
  `source` VARCHAR(64) NULL,
  `identifier` VARCHAR(128) NULL,
  `expected_count` INT NULL,
  `matched_count` INT NULL,
  `missing_count` INT NULL,
  `unexpected_count` INT NULL,
  `unknown_count` INT NULL,
  `outstanding` INT NULL,
  `recorded_at` VARCHAR(64) NULL,
  `confirmed_at` VARCHAR(64) NULL,
  `confirmed_by` VARCHAR(128) NULL,
  `superseded_at` VARCHAR(64) NULL,
  `reason` TEXT NULL,
  `observations_json` LONGTEXT NULL,
  `result_json` LONGTEXT NULL,
  KEY `stock_task_runs_task` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `carton_archive` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `archived_at` VARCHAR(64) NOT NULL,
  `archived_by` VARCHAR(128) NOT NULL,
  `task_id` VARCHAR(128) NOT NULL,
  `reason` TEXT NOT NULL,
  `epc` VARCHAR(64) NOT NULL,
  `carton` VARCHAR(128) NOT NULL,
  `sku` VARCHAR(64) NOT NULL,
  `physical` TINYINT NOT NULL,
  `prior_state` VARCHAR(32) NOT NULL,
  `prior_location` VARCHAR(191) NOT NULL,
  `batch_lot` VARCHAR(128) NULL,
  `units_per_carton` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
