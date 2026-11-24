> **Historical prompt (20 November 2026)** used to request a planning review. Not a requirement. Current state: [context.md](../../context.md).

You are a senior Android architect. Produce an independent, critical, opinionated architecture + implementation plan. Do NOT write code files. Read-only. Markdown output only.

INPUTS (read fully):
1. Functional design: ./keypaharm_functional_design.md (working dir).
2. Chainway C72 UHF SDK demo (Java, Android) in the added dir ending `uhf-uart-demo`. SDK = app/libs/DeviceAPI_ver20251103_release.aar, class com.rscja.deviceapi.RFIDWithUHFUART. See activity/BaseTabFragmentActivity.java (init/free, trigger keycodes), fragment/UHFReadTagFragment.java (setInventoryCallback, startInventoryTag(InventoryParameter), stopInventory, UHFTAGInfo), fragment/UHFSetFragment.java (setPower, setFrequencyMode ETSI=0x04, setRFLink). Demo: minSdk 26, compileSdk 34, targetSdk 33.

FIXED DECISIONS (do not reopen):
- PRIMARY FOCUS = OFFLINE MODE. Build a real, standalone native Android APK for the Chainway C72 that does the whole spec §5.1 PoC flow with zero network: create session -> import manifest file -> physical verification -> reader profile (ETSI locked) -> scan -> compare expected vs observed (matched/missing/unexpected) -> rescan as new immutable run -> close session with sign-off -> export evidence locally.
- Stack: Kotlin, Jetpack Compose, Room (SQLite), Chainway AAR, coroutines/Flow. Sideloaded APK, no Play Store.
- Build PoC profile only. Pilot Outbound (FR-06, 25, 29, 30, 32; AT-13) is OUT for now.
- Identity = one unique EPC per outer carton. Pallets are NOT tagged; pallet = typed local reference. Any non-manifest EPC = Unexpected.
- Manifest enters the APK as a file (CSV via Android document picker / SAF, or a file placed on device). Evidence leaves as CSV (+ human-readable summary) via SAF.
- WEB MIDDLEWARE IS SECONDARY AND DEFERRED. Later (when the APK is online) a plain-PHP web app (no Laravel, simple Head-nets style: PHP + MySQL/SQLite, server-rendered) will let users upload manifests that the APK pulls, and receive completed sessions. DO NOT design or plan the web app in detail now. Only state the minimal decisions the offline APK must make TODAY so that online mode can be bolted on later without rework or data migration (e.g. client-generated UUIDs, UTC timestamps, versioned CSV/JSON schema, append-only runs). Reject anything speculative beyond that (no outbox table, no WorkManager, no auth now) unless you argue it is genuinely cheaper now than later.
- Comparison logic always runs on device.

DELIVER (concise, numbered, tables welcome):
1. Architecture: layers/modules (single Gradle module vs multi — pick and justify), package layout, dependency direction, where the reader SDK is isolated, how a fake reader enables tests/emulator. One diagram in text/mermaid.
2. Room schema: tables + key columns + constraints covering spec §8 (session, pallet, manifest_version, manifest_line, scan_run, observed_epc, exception_action, audit_event, label_allocation, test metadata). How immutability of finalized runs and manifest versioning are enforced.
3. Manifest CSV contract: columns, EPC validation (hex/length, provisional), duplicates, row-level errors, one pallet per file or not.
4. Reader integration: interface, threading (SDK callback thread -> dedup -> Room), batching, trigger key, stop/drain/finalize, disconnect/battery -> interrupted run, ETSI lock + readback, capturing actual RF settings per run.
5. Run/session state machine (spec §9.3 states) and status rules (Match/Incomplete/Hold), completeness math, first-pass vs final.
6. Screens (spec §6, PoC subset) with Compose navigation graph; glove-friendly UX notes.
7. Export: file set + columns (spec §8 recommended columns), schema version, reconciliation (AT-14).
8. Online-later seam: the short list of things to do now vs explicitly not now.
9. FR-01..FR-35 and AT-01..AT-14 mapping for the offline PoC (mark excluded ones).
10. Phased build order: 6-10 phases, each with a verifiable checkpoint and the tests that prove it (JVM unit tests for domain, Room instrumentation, on-device C72 checks).
11. Top 10 risks + open questions only the client can answer.
