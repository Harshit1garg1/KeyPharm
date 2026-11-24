# Keypharm PoC implementation plan

> **Planning input, historical (20 November 2026).** Superseded; it assumed typed pallet references and web middleware. Current state: [context.md](../../context.md), scope: [prd-poc.md](../prd-poc.md).

**Architecture decision:** Build one carton comparison engine in APK. Offline and online modes differ only in manifest source and evidence delivery. Every scan runs and saves locally. Pallet reference is typed; no pallet RFID tag, Pilot workflow, WMS interface, or release override.

Basis: [functional design](/C:/Users/joep%20van%20loosbroek/Downloads/keypharm-PoC/keypaharm_functional_design.md), [C72 demo build](/C:/Users/joep%20van%20loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/build.gradle), [reader activity](/C:/Users/joep%20van%20loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/activity/BaseTabFragmentActivity.java), [inventory demo](/C:/Users/joep%20van%20loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/fragment/UHFReadTagFragment.java), [settings demo](/C:/Users/joep%20van%20loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/fragment/UHFSetFragment.java). Design describes offline only; client decision adds web middleware to this PoC.

## 1. Stack

| Deliverable | Recommendation | Reason; rejected alternative |
|---|---|---|
| APK | Kotlin, Android Views/XML, Room/SQLite, WorkManager for online retries. `minSdk 26`, `compileSdk 34`, `targetSdk 34` for controlled C72 sideload, **subject to device validation**. | Direct Java AAR interop; Views fit small, glove-friendly UI and demo behavior. Reject Flutter/PWA: extra bridge around hardware SDK. Room supports durable local structured data; WorkManager supports constrained retries. [Room](https://developer.android.com/training/data-storage/room), [WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work). |
| Web | Laravel, SQLite, server-rendered Blade; one HTTPS VPS with scheduled database/file backup. | One reader and small PoC workload need modest operations. Reject React SPA plus separate API/PostgreSQL deployment: more moving parts for same review/upload screens. Laravel supports SQLite. [Laravel database docs](https://laravel.com/framework/docs/12.x/database). |

Demo actually targets **33**, while compiling against **34**. Treat SDK 34 as proposed PoC target, not proof AAR works there. Google Play distribution would require a newer target under current Play rules; sideload plan avoids making Play release a PoC dependency. [Android target requirements](https://developer.android.com/google/play/requirements/target-sdk).

## 2. Modules

- **APK:** `reader` (C72 adapter), `domain` (manifest validation and set comparison), `data` (Room, evidence, outbox), `sync` (HTTP and retries), `ui` (setup, scan, result, history, export), `export` (CSV and readable summary).
- **Web:** `ManifestImport`, `ManifestPublication`, `DeviceApi`, `EvidenceIngest`, `ReviewExport`, `AuthAudit`. Blade screens: upload/errors, manifest versions, sessions/runs, exception detail, export.
- One schema/CSV/API contract document governs both importers. Server may **verify** device totals, but never becomes scan-time comparison authority.

## 3. Data model

Same logical IDs and evidence shape on device and server; Room and web migrations implement local constraints independently.

| Table | Key fields and rules |
|---|---|
| `session` | UUID, planned test ID, creator/operator, created/closed UTC, location, status, `mode=OFFLINE/ONLINE`, `manifest_source=FILE/WEB`, sync state, selected final run UUID, sign-off. Offline sessions remain `LOCAL_ONLY`. |
| `test_case` | Session UUID, planned/executed state, product group, pallet type, carton count, label dimensions/type/position/orientation, wrapping/shielding, scan method/instructions, missing-test reason. Supports coverage review. |
| `pallet` | UUID, session/test UUID, **typed** `pallet_ref`, location, storage level, pallet type. No pallet EPC column. |
| `manifest_version` | UUID, pallet UUID, version number, source/file name or server ID, source hash, imported/published UTC, validation state, physical verifier/time, supersedes UUID, correction reason. Runs pin exact version UUID and hash. |
| `manifest_line` | Manifest version UUID, source row, normalized EPC, optional carton ref/SKU/description. Unique EPC within version; reject ambiguous carton mappings. |
| `label_allocation` | Allocation UUID, category (candidate/test/reserve), physical label count, assigned EPC when known, actor/time. Sum allocated physical labels capped at 500; reusing same carton in later tests does not count twice. |
| `scan_run` | UUID, pallet/manifest version UUID, sequence, first/rescan, reason, operator, start/end UTC, monotonic duration, method, device/firmware/SDK, profile version, actual readable RF settings, status, interruption reason, result counts. Finalized row immutable. |
| `observed_epc` | Run UUID + normalized EPC unique, first/last seen, read count, available RSSI/phase/antenna/channel. Repeated sightings remain diagnostic, never extra cartons. |
| `exception_action`, `audit_event` | Run/EPC, classification, action, actor, time, reason, prior/new state. Append only; corrections and investigations never edit run evidence. |
| `attachment`, `sync_outbox` | Optional file reference/hash; queued upload UUID, payload hash, attempts, last error, acknowledged UTC. Server also keeps registered device/token identity and server receipt time. |

Comparison: `matched=E∩O`, `missing=E−O`, `unexpected=O−E`; completeness `|matched|/|E|`, undefined for empty/invalid `E`. Missing yields **Incomplete**; any unexpected yields **Hold**. An investigated EPC remains Unexpected in its original run. Clean result requires another run after physical correction. PoC session can close with a failed result after required review/sign-off; closing does not turn it into Match.

## 4. Manifest CSV contract

Header: `pallet_ref,epc,carton_ref,sku,description`. UTF-8, optional BOM, standard quoted CSV, one pallet per file, one outer carton per row. `pallet_ref` and `epc` required. Preserve leading zeroes; trim surrounding whitespace and normalize EPC to uppercase. Never derive SKU from unknown EPC.

**Provisional PoC EPC rule:** exactly **24 hex characters** (96 bits), no `0x`, separators, spaces, or empty value. Confirm against actual encoded labels before freezing template; Keypharm EPC scheme is unresolved in design §15. Reject whole import on wrong header, mixed pallet refs, invalid length/hex, duplicate EPC, zero rows, or more than 500 unique rows. Report **every bad source row**, including both duplicate rows. Report duplicate carton refs and missing/ambiguous SKU mappings; require SKU mapping for planned mixed-SKU reporting. Keep failed import log; corrected file creates new manifest version. Physical verifier accepts validated version before scan.

Both APK and web run same contract fixtures. Web publishes only validated, verified versions; APK validates downloaded content again.

## 5. Sync protocol

Device uses HTTPS and a revocable, per-device bearer credential provisioned from authenticated web administration. Store credential encrypted with Android Keystore-backed key. Web reviewers use named accounts; device token cannot upload manifests.

| Endpoint | Shape / result |
|---|---|
| `GET /api/v1/manifests?cursor=…` | Published version IDs, version numbers, hashes, pallet refs. |
| `GET /api/v1/manifests/{id}/versions/{version}` | Immutable manifest metadata plus lines. APK validates and atomically caches before selection. |
| `PUT /api/v1/sessions/{uuid}/evidence` | Closed session bundle: test/pallet metadata, pinned manifest UUID/hash, all finalized runs, observed EPC aggregates, exceptions/audit, sign-off, payload SHA-256. Server returns receipt ID and review state. |
| `GET /api/v1/sessions/{uuid}/receipt` | Reconcile uncertain acknowledgement after timeout. Optional photo upload uses separate immutable attachment UUID/hash if photos enter scope. |

UUIDs originate on device even offline. Identical UUID **and** payload hash returns same receipt; same UUID with different hash returns `409` and retains both records for review, without overwriting accepted evidence. Web manifest revision never changes version pinned to a run. If newer version appears during offline work, server accepts old-version evidence as **stale/needs review**; next run requires explicit selection of new version. Any divergent status or mapping is a recorded conflict under §10, not last-write-wins.

Outbox commits with evidence in one local transaction. Retry with network constraint and exponential backoff. Pull failure leaves last complete cached version usable; partially downloaded version stays unavailable. Push interruption leaves local evidence intact; retry same UUID/hash and check receipt if acknowledgement was lost. Offline mode has no server dependency or automatic upload.

## 6. C72 reader design

Define small `Reader` interface: initialize, apply/read profile, start, stop, observation stream, state, release. C72 adapter alone imports `RFIDWithUHFUART`; fake reader drives tests. Initialize off UI thread; release after stop. Never copy demo’s process kill or unrestricted settings screen.

Demo uses `setInventoryCallback`, `startInventoryTag(InventoryParameter)`, `stopInventory`; callback then posts reads to main thread. Treat callback thread as unspecified: send events to bounded single consumer, aggregate by `(run UUID, EPC)`, persist checkpoints, throttle UI updates. Queue overflow or failed stop marks run **interrupted**, never silently drops evidence. On stop, disable intake, call SDK stop, drain accepted events, finalize once. Late callbacks cannot enter next run.

Map trigger keycodes from demo to same explicit Start/Stop action as screen button; ignore key repeats and triggers outside scan screen. Verify actual C72 keycode on device. Reader failure/disconnect, app interruption, or low battery warning stops safely and retains partial run; reconnect starts new run. Battery status comes from Android unless SDK exposes more.

Approved ETSI profile applies `setFrequencyMode(0x04)` and verifies readback before **every** run. Set/read back power and RF link; record actual values or “unavailable,” never assume success from requested values. Demo exposes `getPower`, `getFrequencyMode`, `getRFLink`; polarization and antenna details need physical/device verification. Lock non-ETSI choices and factory reset out of PoC UI. Start with reported 30 dBm only after local compliance and hardware check.

## 7. Requirement trace

**P/Both PoC portion:** `A` APK, `W` web, `D` device data/domain, `X` export. Pilot-only rows remain excluded.

| FR | Component and PoC behavior |
|---|---|
| 01 | A/D: OFFLINE or ONLINE source/delivery flag; **Pilot Outbound half excluded**. |
| 02 | A/D: UUID session, actor, UTC, location, status. |
| 03–04 | A/D and W: one-pallet EPC manifest, shared validation rules, row errors. |
| 05 | A/D/X: full airplane-mode flow. |
| 06 | **Pilot only; excluded.** |
| 07–10 | A reader/UI: readiness, approved profile/ETSI, manual timed scans. |
| 11–12 | A/D: per-run dedup aggregates; separate immutable rescan. |
| 13–16 | A/D: set comparison, defined denominator, status, duplicate control. |
| 17–19 | A/D: unexpected investigation, missing search, required rescan reason; append-only actions. |
| 20 | A reader/D: available SDK diagnostics only; nullable fields. |
| 21–24 | A/D: setup metadata, named physical verifier, 500-label ledger, scan method. |
| 25 | **Pilot only; excluded.** PoC wrapper location/shielding still recorded under 21/27. |
| 26–28 | A/D/X: storage level, notes (photos optional), coverage and sign-off before close. |
| 29–30 | **Pilot only; excluded.** No PoC acceptance override. |
| 31 | A/X and W: CSV evidence tables plus readable summary; web export for synced sessions. |
| 32 | **Pilot only; excluded.** PoC evidence upload is separate client decision. |
| 33 | A and W: search/filter session, pallet, SKU, date, result, location, reader/operator. |
| 34 | A/D/X: durable commits, unsynced/unexported indicator, controlled backup export. |
| 35 | A/D and W: manifest/profile/template version and change audit. |

| AT | Verification owner |
|---|---|
| 01–02 | A comparison/UI: homogeneous and mixed SKU; pallet and SKU views. |
| 03–04 | D/UI: preserved first pass, selected final run, missing count/status. |
| 05–06 | D/UI: unexpected carton and neighboring tag retained, zone note, Hold. |
| 07 | Both importers: duplicate row errors; scan blocked. |
| 08 | A/D/X: pomegranate configuration, per-run misses and comparative export. |
| 09 | D/W/X: ground/level 1/level 2 separate segments. |
| 10 | A/D: wrapper zone, shielding, profile and unexpected set. |
| 11–12 | Reader/D/X: interruption with partial evidence; airplane-mode restart/export. |
| 13 | **Pilot only; excluded.** No operator override exists in PoC. |
| 14 | X/W: exported rows and totals reconcile to saved run. |

Ambiguities needing explicit policy: whether “investigated” unexpected reads can ever clear Hold without a clean rescan; optional carton/SKU mapping outside mixed tests; whether a closed PoC session may report incomplete planned coverage after signed explanation. Recommendations above choose conservative evidence preservation and permit signed session closure without claiming pallet Match.

## 8. Build order and gates

1. **Contract gate:** inspect real encoded EPC samples, C72 Android/firmware, trigger key and SDK metadata; freeze CSV, JSON, profile and result-state fixtures. Checkpoint: sample file imports identically on APK test harness and web.
2. **Offline vertical slice:** Room schema → import/verification → fake-reader run → compare → rescan → close → local CSV/summary. Checkpoint: AT-03/04/07/12/14 pass in airplane mode; app restart preserves evidence.
3. **Hardware gate:** integrate AAR, ETSI readback, trigger, stop/drain, disconnect and battery cases. Checkpoint: real C72 completes AT-01/05/06/11; no missed callback overflow; RF snapshot matches observed device settings.
4. **Web gate:** manifest upload/versioning, publication, device auth, evidence endpoint, review/export; then device outbox. Checkpoint: interrupted pull/push, duplicate PUT, stale revision and `409` conflict preserve local and server evidence.
5. **Acceptance gate:** execute AT-01–12 and 14 on device and web; compare CSV totals, first-pass/final KPIs, mixed pallet, liquid product, inventory levels and wrapper shielding. Unit tests cover sets, duplicates, zero denominator, manifest revisions and status; Android instrumentation covers SAF, Room recovery and C72 lifecycle; web API tests cover auth, validation, idempotency and conflicts. Security review checks credential scope, upload limits, CSV formula escaping and export access.

## 9. Ten risks and client-only questions

1. **AAR/device mismatch:** confirm exact C72 firmware, Android version and SDK build on physical unit.
2. **Unknown EPC encoding:** obtain sample labels and approved length/format; 96-bit rule stays provisional.
3. **RF compliance:** confirm ETSI profile and permitted power at test site; demo permits other regions.
4. **Callback pressure:** measure peak reads; overflow must interrupt run, not inflate completeness.
5. **Storage:** use Android document picker for CSV import/export; avoid demo’s broad storage permissions. [Android SAF guidance](https://developer.android.com/training/data-storage/shared/documents-files).
6. **Clock drift/time zones:** store UTC timestamps, original zone and monotonic run duration; show server receipt time separately.
7. **Identity collisions:** UUID uniqueness plus payload hash; duplicate physical EPC labels remain impossible to distinguish by RFID alone.
8. **Manifest drift:** confirm who may publish corrections and whether stale-version runs can be reviewed as valid evidence.
9. **Ghost reads:** define permitted scan zone, neighboring-stock distance and whether clean rescan is required after investigation.
10. **Data custody:** confirm retention, device handover/backup owner, web host, reviewer accounts, and whether optional photos or Dutch UI matter for PoC.

### HANDOFF — docs

- Produced: read-only implementation plan and CSV/API/data contracts above.
- Contract: carton EPC identity; typed pallet reference; device-only comparison; immutable version-pinned runs; idempotent evidence upload.
- Assumptions: one C72, small PoC workload, controlled APK sideload, provisional 96-bit EPC rule.
- Do NOT change: client’s PoC-only scope or offline scan independence.
- Open risks: physical SDK behavior, EPC format, RF approval and Keypharm exception policy require validation before build.

Skipped: code, deployment and live-device tests; read-only request. Risk: provisional EPC length and SDK 34 compatibility need physical confirmation.