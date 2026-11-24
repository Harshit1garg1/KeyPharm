# Keypharm Offline APK Implementation Plan

> **Not adopted.** Kotlin/Compose plan superseded by the WebView + Java app. Kept for reference only. Current state: [context.md](../../../context.md), scope: [prd-poc.md](../../prd-poc.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sideloaded Kotlin/Compose APK for the Chainway C72 that runs the full spec §5.1 PoC flow offline: import manifest, scan, compare, rescan, close, and export reconciled evidence.

**Architecture:** Single `:app` module. Rules live in a pure-Kotlin `domain` package. Room with SQLite triggers makes runs and verified manifests immutable. A `Reader` interface has a Chainway adapter and a fake. Callback reads are de-duplicated in a concurrent map and checkpointed to Room. No network code.

**Tech Stack:** Kotlin 2.x, Jetpack Compose (BOM), Navigation-Compose, Room + KSP, coroutines/Flow, JUnit4 + kotlinx-coroutines-test, AndroidX test (Room instrumentation, Compose UI test), Chainway `DeviceAPI_ver20251103_release.aar`.

**Spec:** `keypaharm_functional_design.md` + design `docs/architecture.md` (read both; section refs below are architecture.md §n unless prefixed "spec").

## Global Constraints

- `minSdk 26`, `compileSdk 34`, `targetSdk 33`; applicationId `com.trc.keypharm`.
- No `android.permission.INTERNET`; no HTTP, WorkManager, Hilt, or CSV library dependencies.
- Only `com.trc.keypharm.reader.chainway` may import `com.rscja.*`. `domain` imports no `android.*` or `androidx.*`.
- IDs: `UUID.randomUUID().toString()`. Room times: epoch millis UTC. Export times: ISO-8601 with `Z`.
- ETSI region byte `0x04`; scan start is blocked unless `getFrequencyMode()` reads back `0x04`.
- Label cap 500 (warn at ≥ 450). Provisional EPC rule: hex, length % 4 == 0, 16..32 chars, warn if ≠ 24.
- Every change bumps `versionCode` (+1) and `versionName`. APK output is named `keypharm-poc-<versionName>.apk`. Each task ends with a commit on branch `feat/offline-apk`. No AI attribution in commits.
- Status shown as icon + text (never color only); primary touch targets ≥ 56 dp, Scan button 80 dp tall.

## Review Focus

1. **EPC formatting drift:** a manifest from Excel has lowercase letters, spaces, a BOM, or `;` delimiters, while the reader returns uppercase. The same tag must match. Pinned in Task 3 (`normalizes_excel_formats`) and Task 2 (`reader_and_manifest_epc_normalize_equal`).
2. **Late callbacks after Stop:** they must not appear in the stopped run or the next one. Pinned in Task 6 (`late_callback_not_stored`).
3. **App killed mid-scan:** on relaunch the run is `INTERRUPTED` with partial reads kept, and the next scan is a new run. Pinned in Task 4 (`scanning_runs_become_interrupted_on_recover`) and Task 6.
4. **Manifest re-imported after runs exist:** old runs keep their pinned revision and counts. Pinned in Task 4 (`reimport_keeps_old_run_pinned`).
5. **Same tag read 500×, plus ghost tags:** the carton count equals unique manifest EPCs, and ghosts show as unexpected, never as cartons. Pinned in Task 2 (`repeated_reads_count_once`) and Task 6 (`flood_of_repeats_one_row`).

---

### Task 0: Device spike (C72 truth)

**Files:**
- Create: `docs/research/c72-spike.md`
- Create: `spike/` throwaway app copied from the demo (not committed to `app/`)

- [ ] **Step 1:** `git init`, add a `.gitignore` (`.remember/`, `build/`, `.gradle/`, `local.properties`, `*.keystore`), commit the docs on `main`, then create `feat/offline-apk`.
- [ ] **Step 2:** On the physical C72, record: Android version, `getVersion()`, `getHardwareVersion()`, the trigger keycode actually emitted (log `onKeyDown`), and `getFrequencyMode()` before and after `setFrequencyMode(0x04)`. Also record `getPower()` after `setPower(30)`, `getRFLink()`, and which `UHFTAGInfo` fields are non-empty (RSSI/TID/phase/antenna).
- [ ] **Step 3:** Measure callbacks/sec with 20 tags in the field. Check whether callbacks arrive after `stopInventory()` returns (log the timestamp delta). Check whether init/free work from a non-main thread.
- [ ] **Step 4:** Read 3 real Keypharm-encoded labels and note EPC length/format. If no labels are available, write "pending D-03".
- [ ] **Step 5:** Write findings to `docs/research/c72-spike.md`. If the keycode or ETSI behaviour differs from architecture.md §6, update §6 before Task 5. Commit.

**Pass:** spike doc answers every item above. Tasks 5–6 constants come from it.

### Task 1: Project skeleton

**Files:** `settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml`, `app/build.gradle.kts`, `app/libs/DeviceAPI_ver20251103_release.aar` (copy from demo), `app/src/main/AndroidManifest.xml`, `app/src/main/java/com/trc/keypharm/{KeypharmApp.kt, AppContainer.kt, MainActivity.kt}`

**Interfaces:**
- Produces: `class AppContainer(context: Context) { val db: KeypharmDb; val repo: Repository; val reader: Reader }`. Real or fake reader is chosen by `BuildConfig.FAKE_READER` (true for `debug` on emulator via a `fake` product flavor, false for `c72`).

- [ ] **Step 1:** Generate a Compose app with the versions above. Add flavors `fake` and `c72` (dimension `reader`). Add `implementation(files("libs/DeviceAPI_ver20251103_release.aar"))` to `c72Implementation` only. Set `versionCode 1`, `versionName "0.1.0"`, and APK naming per Global Constraints.
- [ ] **Step 2:** Run `./gradlew assembleFakeDebug assembleC72Debug`. Expected: BUILD SUCCESSFUL, two APKs named `keypharm-poc-0.1.0*.apk`.
- [ ] **Step 3:** Install the c72 APK on the device and launch it. Expected: blank Home, no crash. Commit.

### Task 2: Domain core

**Files:** create `app/src/main/java/com/trc/keypharm/domain/{Epc.kt, Comparison.kt, ResultPolicy.kt, LabelCap.kt}`; test `app/src/test/java/com/trc/keypharm/domain/ComparisonTest.kt`, `EpcTest.kt`

**Interfaces (Produces):**
- `object Epc { fun normalize(raw: String): String; fun validate(norm: String): EpcCheck }` where `EpcCheck` = `Ok | Warn(reason) | Error(reason)`.
- `data class Comparison(val matched: Set<String>, val missing: Set<String>, val unexpected: Set<String>) { val completenessPct: Double? }` and `fun compare(expected: Set<String>, observed: Set<String>): Comparison`.
- `enum class RunResult { MATCH, INCOMPLETE, HOLD }` and `fun resultOf(c: Comparison): RunResult`.
- `fun labelCapCheck(allocated: Int, adding: Int): CapCheck` → `Ok | Warn | Block` (Block if total > 500, Warn if total ≥ 450).
- Shared types in `domain/Types.kt` (used by Tasks 4–6): `data class ObservedAgg(epc:String, firstSeen:Long, lastSeen:Long, readCount:Int, rssiLast:String?, rssiMax:String?, tid:String?, phase:Int?)`, `data class RfReadback(region:Int, powerDbm:Int, rfLink:Int)`, `data class DeviceInfo(model:String, sdk:String?, firmware:String?, hw:String?, deviceId:String)`.

- [ ] **Step 1: Write failing tests.**
  - `full_match`: E={A,B}, O={A,B} → missing ∅, unexpected ∅, pct 100.0, MATCH.
  - `one_missing`: E={A,B}, O={A} → missing {B}, pct 50.0, INCOMPLETE.
  - `ghost_only`: E={A}, O={A,X} → unexpected {X}, pct 100.0, HOLD.
  - `missing_beats_unexpected`: E={A,B}, O={A,X} → INCOMPLETE.
  - `empty_expected_no_pct`: E=∅ → `completenessPct == null`.
  - `repeated_reads_count_once`: observed is built from list `[A,A,A,B]` → matched size 2.
  - `reader_and_manifest_epc_normalize_equal`: `normalize(" e280-1160 6000 0000 0000 0001 ")` == `normalize("E28011606000000000000001")`.
  - `epc_rules`: `"E28011606000000000000001"` Ok; `"E2801160600000000000000G"` Error; `"E2801160600000000000000"` (23) Error; 16-char Warn; 36-char Error.
  - `label_cap`: (448,1) Ok, (449,1) Warn, (499,1) Warn, (500,1) Block.
- [ ] **Step 2:** Run `./gradlew testFakeDebugUnitTest --tests '*domain*'`. Expected: FAIL (unresolved).
- [ ] **Step 3:** Implement. Completeness = `matched.size * 100.0 / expected.size`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Commit.

### Task 3: Manifest CSV reader

**Files:** create `domain/ManifestParser.kt`; test `app/src/test/.../domain/ManifestParserTest.kt`, fixtures `app/src/test/resources/manifests/*.csv`

**Interfaces:**
- Consumes: `Epc`, `labelCapCheck`.
- Produces: `fun parseManifest(bytes: ByteArray, expectedPalletRef: String, alreadyAllocated: Set<String>, allocatedCount: Int): ManifestParse`. Here `ManifestParse(lines: List<ManifestLine>, errors: List<RowIssue>, warnings: List<RowIssue>)`, `ManifestLine(rowNo:Int, epc:String, cartonRef:String?, sku:String?, description:String?)`, and `RowIssue(rowNo:Int?, message:String)`. `lines` is empty whenever `errors` is non-empty.

- [ ] **Step 1: Write failing tests** with fixtures:
  - `valid_comma`: 3 rows → 3 lines, no errors.
  - `normalizes_excel_formats`: BOM + `;` + lowercase EPC + CRLF + quoted description containing `;` → parsed equal to `valid_comma`.
  - `duplicate_epc_reports_both_rows`: rows 2 and 5 same EPC → errors have rowNo 2 and 5, `lines` empty (AT-07).
  - `duplicate_carton_ref`: error.
  - `mixed_pallet_ref`: file error. `pallet_ref_mismatch_with_test`: file error.
  - `missing_epc_column`, `zero_rows`: file errors.
  - `missing_sku_is_warning`: line kept, warning "unmapped".
  - `over_label_cap`: allocatedCount 498, 3 new EPCs → error. EPCs already in `alreadyAllocated` do not count again.
- [ ] **Step 2:** Run `./gradlew testFakeDebugUnitTest --tests '*ManifestParser*'`. Expected: FAIL.
- [ ] **Step 3:** Implement an RFC-4180 split (quotes, doubled quotes, CR/LF). Detect the delimiter by the header line: `;` if it has no `,`.
- [ ] **Step 4:** Run → PASS. Commit.

### Task 4: Room schema, triggers, repository

**Files:** create `data/db/{Entities.kt, Daos.kt, KeypharmDb.kt, Triggers.kt}`, `data/Repository.kt`; test `app/src/androidTest/java/com/trc/keypharm/data/RepositoryTest.kt`

**Interfaces:**
- Consumes: `parseManifest`, `compare`, `resultOf`.
- Produces (`Repository`, all `suspend`):
  - `createSession(name, location, operatorId): String`, `addTest(sessionId, TestMeta): String`
  - `importManifest(testId, bytes, sourceName, actorId, reason?): ImportOutcome` (`Saved(revision) | Rejected(ManifestParse)`), `verifyManifest(versionId, verifierId, notes)`
  - `startRun(testId, operatorId, rescanReason?, info: DeviceInfo, rf: RfReadback): String`. Throws if the manifest is unverified, a run is `SCANNING`, or `rescanReason` is null for run_no > 1.
  - `checkpoint(runId, aggs: Collection<ObservedAgg>)`, `finalizeRun(runId, endedAt, durationMs): RunSummary`, `interruptRun(runId, reason)`
  - `recoverInterrupted(): Int`, `addExceptionAction(...)`, `setFinalRun(testId, runId)`, `closeSession(sessionId, actorId, notes)`
  - `observeSession(id): Flow<SessionView>`
- Schema per architecture.md §4. Triggers are created in `RoomDatabase.Callback.onCreate`, plus a migration test hook.

- [ ] **Step 1: Write failing instrumentation tests** (in-memory DB):
  - `finalized_run_rejects_update` and `finalized_run_rejects_observed_insert`: expect `SQLiteConstraintException`.
  - `verified_manifest_immutable`.
  - `reimport_keeps_old_run_pinned`: run on rev 1, import rev 2 → run still references rev 1 and keeps its counts.
  - `rescan_requires_reason`.
  - `scanning_runs_become_interrupted_on_recover`: `startRun`, checkpoint 2 EPCs, `recoverInterrupted()` → state INTERRUPTED, 2 observed rows kept, result null, audit event present.
  - `finalize_writes_counts_and_result`: E={A,B}, checkpoint {A,X} → INCOMPLETE, matched 1, missing 1, unexpected 1, pct 50.0.
  - `closed_session_read_only`.
- [ ] **Step 2:** Run `./gradlew connectedFakeDebugAndroidTest --tests '*RepositoryTest*'` on an emulator. Expected: FAIL.
- [ ] **Step 3:** Implement. `finalizeRun` does the read of E and O, `compare`, and the update in one `withTransaction`. Trigger SQL: `BEFORE UPDATE ON scan_run WHEN OLD.state <> 'SCANNING' BEGIN SELECT RAISE(ABORT,'run immutable'); END;` plus the equivalents for DELETE, `observed_epc` (via parent state), `manifest_version`/`manifest_line` (when `verified_at` is not null), and `session` (when CLOSED).
- [ ] **Step 4:** Run → PASS. Commit.

### Task 5: Chainway adapter + fake reader

**Files:** create `reader/{Reader.kt, Types.kt}`, `reader/fake/FakeReader.kt`, `app/src/c72/java/com/trc/keypharm/reader/chainway/C72Reader.kt`, `platform/TriggerKeys.kt`; test `app/src/test/.../reader/FakeReaderTest.kt`

**Interfaces:**
- Consumes: `RfReadback`, `DeviceInfo` (Task 2).
- Produces: `Reader` exactly as architecture.md §6. Also `data class TagRead(epc:String, atMillis:Long, rssi:String?, tid:String?, phase:Int?)` and `class FakeReader(script: FakeScript) : Reader` with scripts `FULL`, `ONE_MISSING`, `GHOSTS`, `DISCONNECT_MID`, `LATE_AFTER_STOP`.
- `object TriggerKeys { val codes: Set<Int> }` (from the Task 0 spike); `MainActivity.onKeyDown` emits to `SharedFlow<Unit>` when `repeatCount == 0`.

- [ ] **Step 1: Write failing test** `fake_late_after_stop_emits_after_stop_returns`: after `stop()` returns, the callback still fires once (this models the hardware for Task 6).
- [ ] **Step 2:** Implement `FakeReader`, then `C72Reader`. All SDK calls go on `newSingleThreadContext("rfid")`. `applyEtsiProfile` throws `RegionLockException` if the readback is ≠ 0x04.
- [ ] **Step 3:** Run `./gradlew testFakeDebugUnitTest --tests '*FakeReader*'` → PASS.
- [ ] **Step 4: On C72:** debug screen button "ETSI check" shows the readback values; the trigger toggles a log line. Record results in `c72-spike.md`. Commit.

### Task 6: Scan capture pipeline

**Files:** create `reader/ScanCapture.kt`, `ui/scan/ScanController.kt`; test `app/src/test/.../reader/ScanCaptureTest.kt`

**Interfaces:**
- Consumes: `Reader`, `Repository.startRun/checkpoint/finalizeRun/interruptRun`.
- Produces: `class ScanCapture { fun onTag(t: TagRead); fun close(); fun drainDirty(): List<ObservedAgg>; val uniqueCount: Int; val lateCount: Int }`. `onTag` does `ConcurrentHashMap.compute` while open and increments `lateCount` once closed. `class ScanController(reader, repo, scope)` with `start(testId, operatorId, reason?)`, `stop(): RunSummary`, `state: StateFlow<ScanUiState>`. It checkpoints every 1500 ms, samples UI at 100 ms, and runs the stop sequence from architecture.md §6.

- [ ] **Step 1: Write failing tests** (virtual time, fake repo):
  - `flood_of_repeats_one_row`: 10,000 reads of A + 1 of B → 2 aggregates, A.readCount 10000.
  - `late_callback_not_stored`: `LATE_AFTER_STOP` → finalized run has no late EPC, `lateCount == 1`, audit logged; the next run's capture starts empty.
  - `disconnect_mid_scan_interrupts`: `DISCONNECT_MID` → `interruptRun` called, checkpointed reads kept.
  - `checkpoint_every_1500ms`: advance 3100 ms → 2 checkpoints.
  - `new_unique_triggers_feedback_once`: A,A,B → 2 feedback events.
- [ ] **Step 2:** Run `./gradlew testFakeDebugUnitTest --tests '*ScanCapture*'` → FAIL. Implement. Run → PASS.
- [ ] **Step 3: On C72:** scan 20 tags 5 times. Unique count is stable and the UI is smooth; pull the battery mid-scan → after relaunch the run is INTERRUPTED (AT-11). Commit.

### Task 7: Session, test, manifest, verification screens

**Files:** create `ui/theme/*`, `ui/nav/NavGraph.kt`, `ui/{home,sessions,session,test,manifest,verify,settings}/*Screen.kt` + ViewModels; test `app/src/androidTest/.../ui/SetupFlowTest.kt`

**Interfaces:** consumes `Repository`; manifest import uses `ActivityResultContracts.OpenDocument(arrayOf("text/*","text/csv","application/vnd.ms-excel"))`.

- [ ] **Step 1: Write failing Compose test** `setup_flow_blocks_scan_until_verified`: create session → add test (pallet ref "P-001", level GROUND) → import the fixture with a duplicate → row errors are visible and Scan is disabled → import the valid fixture → Scan is still disabled → verify → Scan is enabled.
- [ ] **Step 2:** Implement the screens per architecture.md §8 (Settings: operators CRUD, label ledger count, power within approved limit; admin role only).
- [ ] **Step 3:** Run `./gradlew connectedFakeDebugAndroidTest --tests '*SetupFlow*'` → PASS. Commit.

### Task 8: Scan, result, exceptions, rescan screens

**Files:** create `ui/{scan,result,exceptions}/*`; test `app/src/androidTest/.../ui/ScanFlowTest.kt`

- [ ] **Step 1: Write failing Compose tests** (fake reader):
  - `first_pass_then_rescan_keeps_both`: `ONE_MISSING` → result INCOMPLETE 50% → rescan requires a reason chip → `FULL` → MATCH. Test view shows first-pass 50% and final 100% (AT-03/04).
  - `ghost_shows_hold_and_action_does_not_change_result`: `GHOSTS` → HOLD; mark NEIGHBOURING_TAG with a note → run still HOLD, action listed (AT-05/06).
  - `back_disabled_while_scanning`.
  - `status_has_text_not_color_only`: node with text "INCOMPLETE" exists.
- [ ] **Step 2:** Implement. Result screen has a SKU filter (AT-02).
- [ ] **Step 3:** Run → PASS. **On C72:** AT-01, AT-02, AT-04, AT-05, AT-06 with real tags; trigger toggles scan. Commit.

### Task 9: Close session + history

**Files:** create `ui/close/*`, extend `ui/sessions` search; test `app/src/androidTest/.../ui/CloseFlowTest.kt`

- [ ] **Step 1: Write failing tests:**
  - `close_requires_review_and_signoff`: a planned test that is neither executed nor skipped-with-reason blocks Close; a non-Match test needs review notes; after sign-off, every edit control is gone (FR-28).
  - `search_filters`: by pallet ref, SKU, level, result.
- [ ] **Step 2:** Implement. Run → PASS. Commit.

### Task 10: Export + reconciliation

**Files:** create `data/export/{CsvWriter.kt, Exporter.kt, Reconciler.kt}`, `ui/export/*`; tests `app/src/test/.../export/CsvWriterTest.kt`, `app/src/androidTest/.../export/ExportTest.kt`

**Interfaces:** `suspend fun export(sessionId: String, out: OutputStream): ExportResult` writes the file set in architecture.md §9. `fun reconcile(zip: ByteArray): List<String>` returns mismatches (empty = pass).

- [ ] **Step 1: Write failing tests:**
  - `csv_escapes_quotes_and_formulas`: `=SUM(A1)` → `'=SUM(A1)`; `a"b,c` → `"a""b,c"`.
  - `evidence_header_matches_spec_order`: the first 32 columns equal the spec §8 list.
  - `export_reconciles` (AT-14): a seeded session with 2 tests and 3 runs (match, incomplete, interrupted) → `reconcile(zip)` is empty; `export.json` checksums verify.
  - `tampered_zip_fails_reconcile`: alter one count → non-empty.
- [ ] **Step 2:** Implement. SAF via `ActivityResultContracts.CreateDocument("application/zip")`. Show success only after `reconcile` passes on the bytes read back from the URI.
- [ ] **Step 3:** Run both suites → PASS. **On C72:** export in airplane mode, copy to PC, open the CSVs in Excel (`;`/UTF-8 renders correctly). Commit.

### Task 11: Acceptance + gates

- [ ] **Step 1:** Run `./gradlew lint testFakeDebugUnitTest connectedFakeDebugAndroidTest assembleC72Release`. Expected: all green, `keypharm-poc-<version>.apk` signed.
- [ ] **Step 2:** On the C72, in airplane mode, run AT-01…AT-12 and AT-14 (AT-13 excluded) and tick each in `docs/acceptance.md` with run IDs. AT-12: force-stop and reopen; everything persists.
- [ ] **Step 3:** Security gate: run `ecc:security-review` on the diff. Check for no `INTERNET` permission, the CSV formula guard, `allowBackup=false` (the export is the controlled backup, FR-34), and no exported components besides `MainActivity`. No unresolved HIGH.
- [ ] **Step 4:** Tag `v<versionName>`. Commit.

---

## Spec coverage check

FR-01 (Home mode tile) T7 · 02 T4/T7 · 03–04 T3/T7 · 05 all · 07–10 T5/T6/T8 · 11–12 T4/T6 · 13–15 T2/T4 · 16 T2/T3 · 17–19 T8 · 20 T5 (nullable diag) · 21–22 T7 · 23 T2/T3/T7 · 24 T7 · 26 T7/T9 · 27 notes T7/T8 (photos deferred) · 28 T9 · 31 T10 · 33 T9 · 34 T4/T10 · 35 T4 audit + T7 settings. Excluded: FR-06, 25, 29, 30, 32; AT-13.
AT-01/02/04/05/06 T8 · 03 T8 · 07 T3/T7 · 08–10 T7 metadata + T11 · 11 T6 · 12 T11 · 14 T10.
