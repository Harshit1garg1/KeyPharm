# Keypharm offline APK architecture and implementation plan

> **Planning input, historical (20 November 2026).** Fed the Kotlin plan that was not adopted. Current state: [context.md](../../context.md), scope: [prd-poc.md](../prd-poc.md).

**Recommendation:** Build one Android app with a small, testable domain core. Make each scan run an independent evidence record. Treat online exchange as a future input and output path; comparison stays on C72.

Basis: [functional design](</C:/Users/joep van loosbroek/Downloads/keypharm-PoC/keypaharm_functional_design.md>), C72 demo [reader lifecycle](</C:/Users/joep van loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/activity/BaseTabFragmentActivity.java>), [inventory](</C:/Users/joep van loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/fragment/UHFReadTagFragment.java>), and [RF settings](</C:/Users/joep van loosbroek/Downloads/EE-Collection/EE-Collection-Developer-Handover/EE-Collection-Developer-Handover/Demo-uhf_as/uhf-uart-demo/app/src/main/java/com/example/uhf/fragment/UHFSetFragment.java>). Demo proves API usage, not production behavior or firmware compatibility.

## 1. Architecture

**Pick single `:app` Gradle module.** PoC has one device, one workflow, one release artifact. Multi-module build adds boundaries without useful deployment separation. Enforce boundaries through packages and tests; split modules only if another app needs domain logic later.

| Package | Owns |
|---|---|
| `ui` | Compose screens, navigation, ViewModels |
| `domain` | Session rules, EPC validation, set comparison, state transitions; pure Kotlin |
| `data` | Room entities, DAOs, repositories, CSV import and export |
| `reader` | `Reader` interface, Chainway adapter, fake reader |
| `platform` | SAF picker, trigger key dispatch, battery and device details |

```text
Compose → ViewModels → domain operations → repository interfaces
                               ↑                    ↓
                         Reader interface       Room / SAF
                               ↑
                    Chainway adapter or fake
```

Only `reader.chainway` imports `com.rscja.deviceapi.*`. Fake reader emits scripted EPCs, errors, and late callbacks; JVM tests exercise domain logic, emulator tests exercise UI and Room. C72 tests establish hardware truth. No network library, DI framework, or generalized plugin system needed. Room uses asynchronous DAO work so reads and writes stay off UI thread. [Android Room guidance](https://developer.android.com/training/data-storage/room/async-queries)

## 2. Room data contract

All IDs: client-generated UUIDs. All timestamps: UTC ISO 8601 in exports; store epoch milliseconds in Room. Foreign keys enabled. No cascade deletion of evidence.

| Table | Key columns and constraints |
|---|---|
| `session` | `id`, `mode='POC'`, creator, created/closed times, location, status, sign-off actor/time/notes; closed session read-only |
| `pallet` | `id`, `session_id`, typed `pallet_ref`, location, storage level, pallet type; unique `(session_id,pallet_ref)` |
| `test_case` | `id`, session/pallet IDs, planned `test_id`, product mix, label type/dimensions/position, orientation, wrapping, shielding, scan method, instructions, planned/executed/skipped reason; unique `(session_id,test_id)` |
| `manifest_version` | `id`, `pallet_id`, revision, file name/hash, import time, approval and physical-verification actor/time/notes; unique `(pallet_id,revision)` |
| `manifest_line` | version ID, row number, EPC, carton ref, SKU, description; unique `(version_id,epc)` and unique non-null carton ref per version |
| `scan_run` | `id`, test ID, manifest-version ID, run number/type/reason, start/end, lifecycle, operator, reader/device ID, profile version, actual region/power/RF link, method, expected/matched/missing/unexpected counts, result; unique `(test_id,run_number)` |
| `observed_epc` | run ID, normalized EPC, first/last seen, read count, optional RSSI/phase/channel; primary key `(run_id,epc)` |
| `exception_action` | UUID, run ID, EPC, missing/unexpected kind, action, actor, reason, time; append-only |
| `audit_event` | UUID, session ID, actor, time, action, record ID, before/after summary, reason; append-only |
| `label_allocation` | One row per physical label, UUID, optional unique EPC, purpose (`candidate`, `carton`, `reserve`), allocation time/actor; total rows capped at 500 across PoC sessions |

Use one transaction to approve import and one to finalize run. Reject edits/deletes to finalized `scan_run` and its `observed_epc` rows with SQLite triggers, backed by DAO rules. Manifest versions become immutable once approved or referenced by a run; correction creates revision and audit event. A run pins exactly one version. A revised manifest cannot reinterpret older runs. Do not infer two physical cartons from one EPC: physical verifier must flag duplicate label assignment.

## 3. Manifest CSV v1

**One pallet per file.** Session may hold multiple pallets and files. Keeps import errors and physical verification tied to one expected set.

Required columns: `schema_version,pallet_ref,epc`. Optional: `carton_ref,sku,description`. One row per outer carton; no quantity column because EPC is unique identity. Require identical `schema_version=1` and `pallet_ref` across rows. Show pallet ref for confirmation against typed local ref. Preserve source filename and SHA-256; copy validated rows into Room, then release source URI.

Provisional EPC rule: trim surrounding whitespace, uppercase, preserve leading zeros; require even-length hex, provisionally 8–64 characters, without `0x` or separators. **Confirm actual encoding and length from sample labels before freezing rule.** Reject empty file, malformed headers, malformed EPCs, duplicate EPCs, duplicate non-empty carton refs, and ambiguous supplied SKU/carton mapping. Report every row number and cause; commit no partial manifest. Optional SKU absence remains visible as unmapped, without inventing product identity. Re-import creates new revision, never edits old version.

Use Android document picker for device files, including files copied to device. SAF grants access to selected documents without broad storage permission. [Android SAF guide](https://developer.android.com/guide/topics/providers/document-provider)

## 4. Reader contract and capture

`Reader`: initialize/close, readiness stream, apply approved profile, read actual settings, start(callback), stop. Callback carries EPC, receipt time, and available diagnostics. Adapter alone owns `RFIDWithUHFUART`.

- Initialize off main thread; free on shutdown. Demo uses `getInstance()`, `init()`, `free()`, `setInventoryCallback()`, `startInventoryTag(InventoryParameter)`, and `stopInventory()`.
- Before every run, set ETSI with `setFrequencyMode(0x04)` and verify `getFrequencyMode()==0x04`. Read back power with `getPower()` and link with `getRFLink()`; block start on mismatch or unreadable mandatory setting. No region picker. Record antenna/polarization only when hardware can substantiate it.
- Activity dispatches verified C72 trigger keycode to same start/stop action as large on-screen button. Ignore key repeat; test actual C72 keycode. Do not copy demo’s broad keycode list blindly.
- Callback never writes UI or Room directly. Single consumer timestamps, validates, deduplicates by EPC, updates first/last/count, then batches Room writes. Bound queue; overflow marks run interrupted instead of silently dropping evidence.
- Stop sequence: disable new start, call SDK stop, drain accepted callback queue, persist batch, finalize counts and settings in one transaction. Verify on C72 whether callbacks can arrive after stop returns. Late or uncertain callbacks flag capture integrity; never attach them to next run.
- Reader failure, critical battery, process restart, or failed stop leaves partial observations in an **Interrupted** run. Recovery starts a new run. Battery signal source and thresholds need C72 verification.

## 5. State and result rules

Keep lifecycle separate from comparison outcome:

```text
Draft → Import invalid / Awaiting physical check → Ready
Ready → Scanning → Stopping → Finalized
                    ↘ Interrupted
Finalized → Review → Rescan (new run) or Close session
```

Spec §9.3 maps as follows: `Invalid manifest` blocks Ready; `Reader error` produces Interrupted; `Unexpected reads` is a retained exception and Hold reason. Let `E` equal pinned manifest EPC set and `O` equal EPCs from **one** run. Matched `E∩O`; missing `E−O`; unexpected `O−E`; completeness `|E∩O|/|E|×100`. Zero or invalid expected count blocks scan and has no percentage.

**PoC result policy:** missing > 0 → **Incomplete**; otherwise unexpected > 0 or unresolved integrity exception → **Hold**; otherwise → **Match**. Investigating unexpected EPC never erases its classification. Closure is evidence sign-off, not shipment acceptance: session may close with Incomplete/Hold after review and explanation. First pass always run 1; final result points to selected completed run, with no union across runs. If manifest revision changes between runs, display that fact beside KPI comparison.

## 6. Compose navigation and warehouse UX

`Home → Sessions → Create/Open → Manifest & physical check → Reader setup → Scan → Result → Exception detail → Review/close → History/export`. Result links to rescan reason, then new Scan. Test metadata and planned matrix live in Create/Open and Review. No Pilot or general Administration screen in PoC.

Keep Start/Stop large and reachable one-handed with gloves. Show **Reading**, **Stopping**, and **Comparison complete** as text; count unique EPCs separately from total reads. Show missing and unexpected counts even when completeness is 100%. Use text plus icon, sound/vibration for new EPC and reader failure, restrained feedback for repeats. Prevent accidental navigation during scan; surface interrupted recovery on relaunch.

## 7. Evidence export

One SAF-created ZIP contains UTF-8 CSV files and `summary.md`; one export action avoids half a visible file set. Include `schema_version=1` in each CSV, stable UUIDs, UTC timestamps, explicit empty values, and a checksum inventory. Reopen/verify written package before showing success. SAF supports user-selected creation target. [Android document API](https://developer.android.com/reference/android/content/Intent)

| File | Core columns |
|---|---|
| `sessions.csv` | SessionID, Mode, TestID, PalletRef, location, creator, sign-off, close status/notes |
| `test_cases.csv` | Planned/executed/skipped, product mix, storage level, pallet type, label type/position, orientation, wrapping, shielding, scan method |
| `manifest_lines.csv` | ManifestVersionID/revision/hash, row, ExpectedEPC, CartonRef, SKU, description, verifier/time |
| `runs.csv` | RunID, RunType/reason, pinned version, start/end/duration, counts, completeness, result, operator, reader/device ID, ETSI, actual power/link, profile version |
| `run_epcs.csv` | One row per `E∪O` per run: ExpectedEPC, ObservedEPC, Classification, first/last seen, read count, available diagnostics |
| `exception_actions.csv` | RunID, EPC, exception code, action, actor, time, reason/disposition |
| `audit_events.csv` | Actor, time, action, record, before/after, reason |
| `label_allocations.csv` | Label ID/EPC, purpose, actor, allocated time |

`summary.md` shows first-pass and final run separately, planned versus executed tests, every non-Match result, and sign-off. AT-14 gate: independently recompute each run’s sets/counts from exported manifest and EPC rows; compare with `runs.csv` and app summary. Never mark export complete before check passes.

## 8. Online-later seam

**Do now:** UUIDs; UTC timestamps; immutable versioned manifests/runs; explicit schema versions; source provenance; stable local repository operations for import and completed-session export. These prevent identity and evidence migration later.

**Do later:** PHP app, API, authentication, network state, outbox, WorkManager, sync retries, server IDs, conflict UI. None improves offline PoC. Future manifest pull can feed same validation/import operation; future upload can serialize same completed local records. Device remains comparison authority.

## 9. Requirement coverage

| FR | Offline PoC mapping |
|---|---|
| 01 | PoC mode stamped; Pilot selection excluded |
| 02 | Session UUID, actor, time, location, status |
| 03 | One-pallet CSV, optional carton/SKU |
| 04 | Whole-file validation and row errors |
| 05 | Airplane-mode full flow |
| 06 | **Excluded: Pilot import/interface** |
| 07 | Reader readiness and blocked start |
| 08–09 | Fixed approved ETSI profile; actual readback |
| 10–12 | Manual control, unique evidence, separate immutable runs |
| 13–15 | Device set comparison, completeness, status |
| 16 | Manifest/physical duplicate controls |
| 17–19 | Unexpected/missing actions and required rescan reason |
| 20 | Available diagnostics only |
| 21–22 | Test metadata and named physical verifier |
| 23 | Global 500-label allocation cap |
| 24 | Recorded scan method/instructions |
| 25 | **Excluded: Pilot station profile/automatic trigger**; PoC shielding note retained |
| 26 | Location and storage level |
| 27 | Notes; optional photos deferred |
| 28 | Coverage review and sign-off |
| 29–30 | **Excluded: Pilot release/override** |
| 31 | Local CSV evidence package and summary |
| 32 | **Excluded: Pilot result exchange** |
| 33 | Local session/test/pallet/date/status search |
| 34 | Restart persistence and controlled export |
| 35 | Manifest/profile change audit; fixed RF profile |

| AT | Proof |
|---|---|
| 01–02 | C72 homogeneous/mixed scans; EPC identity and SKU filter |
| 03 | Two runs retained; first-pass KPI stable |
| 04–06 | Missing, extra carton, neighboring tag; Hold/Incomplete and notes |
| 07 | Duplicate row errors; no scan |
| 08–10 | Separate pomegranate, level, wrapper/shielding records |
| 11 | Reader-loss partial evidence, Interrupted, new run |
| 12 | Airplane mode, app restart, export |
| 13 | **Excluded: Pilot override** |
| 14 | Export recomputation equals app counts/status |

## 10. Build order and gates

| Phase | Checkpoint | Proof |
|---|---|---|
| 1. Device spike | Exact C72/Android/firmware/AAR combination initializes, reads, stops, frees; trigger and RF readback documented | On-device smoke test |
| 2. Domain | EPC normalization, manifest validation, comparison, result rules fixed | JVM tests for duplicates, empty expected set, missing/unexpected, rescan isolation |
| 3. Room | Schema and immutable revisions/runs work | Instrumentation tests for FK, transaction rollback, restart, mutation rejection |
| 4. Import and setup | SAF import, row errors, physical check, 500-label ledger | Parser tests; emulator document picker; Room cap test |
| 5. Reader pipeline | Callback batching, stop/drain, interruption | Fake-reader bursts/late callbacks; C72 repeated scans and loss |
| 6. Core UI | Create through result and exception actions usable offline | Compose navigation checks; glove walkthrough on C72 |
| 7. Close and history | Coverage review, signed closure, first/final views | State tests; restart and read-only closure check |
| 8. Export and acceptance | Reconciled package, signed APK | AT-01–12 and AT-14 on C72; lint/build; security review with no unresolved high findings |

## 11. Top risks and client decisions

| Rank | Risk | Control |
|---:|---|---|
| 1 | SDK/firmware mismatch | Phase-1 C72 spike before app build |
| 2 | Callback loss or late delivery | Bounded queue, drain test, Interrupted on uncertainty |
| 3 | Invalid EPC policy | Confirm real encoded samples before rule freeze |
| 4 | Ghost reads at wrapper | Retain all unexpected EPCs; record shielding/zone |
| 5 | Duplicate physical labels | Named physical verification; quarantine evidence |
| 6 | RF region or power drift | ETSI set/readback before each run; block mismatch |
| 7 | Power loss during scan | Batch commits, interrupted recovery, new run |
| 8 | Misleading 100% KPI | Show unexpected count and first/final separately |
| 9 | Lost data during device handover | Verified export before device clear; backup policy |
| 10 | CSV/SAF provider variation | Test device’s actual file provider and export reopen |

**Client answers needed:** approved EPC encoding and sample files; who physically verifies and signs off; whether a closed Hold/Incomplete PoC session is valid evidence; planned test matrix and scan instructions; approved power/RF link and test location; label allocation accounting for candidates/reserves; required export recipient, retention, and Dutch UI need. Hardware callback, battery, and settings behavior require supplier/device testing, not policy guesses.

Skipped: code, web design, build, and C72 execution. Risk: SDK callback behavior and EPC rule remain unverified until device spike and client samples.