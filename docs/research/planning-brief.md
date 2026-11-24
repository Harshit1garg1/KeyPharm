> **Historical prompt (20 November 2026)** used to request a planning review. Not a requirement. Current state: [context.md](../../context.md).

You are a senior architect. Produce an independent, critical implementation plan. Do NOT write code. Read-only.

INPUTS (read them fully):
1. Functional design: ./keypaharm_functional_design.md (in the working dir).
2. Chainway C72 UHF SDK demo (Java, Android): the --add-dir path ending in uhf-uart-demo. SDK = app/libs/DeviceAPI_ver20251103_release.aar, class com.rscja.deviceapi.RFIDWithUHFUART. See BaseTabFragmentActivity.java (init/free, trigger keycodes), fragment/UHFReadTagFragment.java (setInventoryCallback, startInventoryTag(InventoryParameter), stopInventory, UHFTAGInfo), fragment/UHFSetFragment.java (setPower, setFrequencyMode ETSI=0x04, setRFLink, etc.).

SCOPE DECISIONS ALREADY MADE BY THE CLIENT (do not reopen):
- Build ONLY the PoC (not the Pilot). Real Chainway C72 device is available.
- Identity is carton-level only: one unique EPC per outer carton. Pallets are NOT RFID-tagged; pallet is a typed/local reference (spec section 8). Any non-manifest EPC = Unexpected.
- Two deliverables: (a) Android APK on the C72, (b) a web app.
- APK works in two modes: OFFLINE = fully standalone, user imports a formatted manifest file into the APK, scans, APK compares expected vs observed (matched/missing/unexpected), stores runs locally, exports evidence. ONLINE = the web app acts as middleware: manifests are uploaded to the web app and pulled by the APK; completed sessions/runs/results are pushed to the web app for review/export.
- The comparison logic must be identical in both modes and must run on the device (scan must never depend on network).

DELIVER (markdown, concise, opinionated, numbered):
1. Recommended stack for APK (language, UI toolkit, local DB, min/target SDK given the demo uses minSdk 26 / compileSdk 34) and for web app (backend, DB, frontend, hosting for a PoC), with one-line justification each and the main rejected alternative.
2. Module/package structure for both.
3. Data model (tables + key fields) covering spec section 8, mode/source flag, sync state, immutability of runs, manifest versioning.
4. Manifest file format (CSV columns, validation rules incl. EPC hex/length, duplicates, row-level errors) usable both for APK import and web upload.
5. Sync protocol: endpoints, payload shapes, idempotency (client-generated UUIDs), device auth for PoC, conflict rules (spec 10 'offline sync conflict'), retry/queue, what happens when connectivity drops mid-flow.
6. Reader integration design: wrapping RFIDWithUHFUART behind an interface, threading (callback thread vs UI), dedup, trigger key, disconnect/battery handling, capturing profile (power, region, RF link) per run, ETSI lock.
7. Mapping of every PoC-relevant FR (FR-01..FR-35, P or Both) and AT-01..AT-14 to the component that satisfies it; flag anything ambiguous.
8. Phased build order with verifiable checkpoints, and a test strategy (unit tests for comparison logic, instrumentation on device, web API tests).
9. Top 10 risks / gotchas (SDK, Android storage/SAF, time zones, ID collisions, EPC formats, etc.) and open questions that only the client can answer.
