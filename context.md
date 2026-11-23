# Keypharm RFID POC handoff

Updated 20 November 2026. The approved Android POC is implemented and was installed on the Chainway C72 over USB. Keep the workflow and its assumptions easy to change as Keypharm confirms the remaining requirements.

## Requirements and decisions

The source is Marc Flederus's *Keypharm Mobile RFID Application — Functional Design for Proof of Concept and Pilot*, v1.0, 17 November 2026. The source document stays outside this repository. [POC and Pilot scope](docs/poc-and-pilot-scope.md) maps its requirements and acceptance scenarios. [Approved design](docs/demo-design.md) and [questionnaire](docs/questionaire.md) record the user decisions and their status.

- The POC runs locally on one C72. It covers outer cartons and tagged pallets, physical contents verification, reader configuration evidence, independent scan attempts, local records and evidence export. The source sets a one-day test and up to 500 RFID labels.
- A pallet is identified by UHF EPC only. Its known EPC stays separate from carton counts. Each outer carton has one unique expected EPC. A pallet identification attempt with unknown tags stays unconfirmed under the demo rule.
- Hold the physical trigger to start inventory. Release to stop and finalize. Repeat key events during the hold count as one attempt. Keep Continue disabled during capture and for interrupted runs, missing EPCs or any unexpected EPC. A run with all expected tags plus an extra is 100% complete and stays on Hold. Investigating an extra tag records a log and requires a clean rescan.
- On the C72 a scan runs from the on-screen Start scan / Stop scan button or by holding the trigger. Unexpected EPCs can be marked investigated, removed from zone, neighbouring tag or unresolved. An attempt counts distinct carton EPCs and stores repeat count, first/last timestamps and RSSI if available. Each rescan starts empty and requires a reason. Previous and current results show the EPC evidence and which cartons are newly seen or still missing. First-pass metrics stay visible.
- Keep failed attempts as evidence. Session closure records reviewed coverage, skipped-test reasons and sign-off. Continue confirms a clean pallet result. Any unexpected EPC keeps the run on Hold, even after it is marked investigated, removed from zone or neighbouring tag; the marking is evidence only. Continue unlocks only after a rescan reads every expected carton and no unexpected EPC (decision 2026-11-23, checklist gap 6). Closure can document a failed test.
- The Test lead loads and revises the manifest before carton scanning. Supervisor verifies contents and can sign off. Operator and Test lead run scans and confirm clean matches. Reviewer has read access. Roles are local and unauthenticated; the entered person name signs records and fills the Operator and Reviewer export columns.
- The dashboard is a read-only view of records and logs. It fetches when it can reach the running handheld app. An open browser can display its last fetched copy if the handheld goes offline. Handheld scanning, saving and evidence export work offline.
- Pilot is future work. It adds a defined outbound transaction, agreed manifest/result exchange, operational roles, Accept/Hold policy and audited supervisor exceptions. Wrapper automation, label writing or printing, and retail-item tagging are outside this POC.

## Current implementation

The Android app packages local HTML, CSS and JavaScript in a WebView. Java connects to the Chainway SDK, handles physical keys and scan lifecycle, opens the Android file picker and share sheet, and serves the dashboard on the demo Wi-Fi. The core comparison and CSV rules are plain JavaScript and can run in Node for testing.

| Area | File |
| --- | --- |
| Provisional CSV schema, validation, role permissions, trial label accounting, comparison and export | [model.mjs](app/src/main/assets/model.mjs) |
| Local sessions, role selection, scans, recovery, verification, sign-off and dashboard sharing controls | [handheld.mjs](app/src/main/assets/handheld.mjs) |
| Android bridge, physical trigger mapping and file handling | [MainActivity.java](app/src/main/java/be/keypharm/rfid/MainActivity.java) |
| Chainway initialization, ETSI and power readback at connect and at the start of every run, and inventory | [C72Reader.java](app/src/main/java/be/keypharm/rfid/C72Reader.java) |
| Read-only HTTP routes and browser records view | [DashboardServer.java](app/src/main/java/be/keypharm/rfid/DashboardServer.java), [dashboard.mjs](app/src/main/assets/dashboard.mjs) |
| Screen styling and shared color tokens | [style.css](app/src/main/assets/style.css) |

The CSV template uses `pallet_ref,pallet_epc,carton_ref,carton_epc,sku` with one row per carton for one pallet. Headers are case-insensitive, commas or Excel semicolons both work, SKU may be blank, and every bad row is listed at once. The template is available in the app. The included sample and its EPCs are synthetic. Demo allocation counts cartons, one pallet tag, candidates and reserves across sessions. A pre-scan revision replaces the session's current allocation. Actual treatment of already-used tags and replacements is still open.

The app retains completed attempts and audit events locally. During a hardware run, observations are periodically checkpointed. A restarted app marks an unfinished run as Interrupted and retains the last checkpoint. Each run stores the region, power and device ID read back when that run started. A new unique EPC gives a short beep and vibration; an interrupted run gives an error tone. Export produces the section 8 evidence CSV, the full records CSV and a readable summary through Android's share sheet.

Dashboard sharing uses a private link on port 8787 on the same trusted Wi-Fi. It defaults to committed sample simulation records. The Test lead can explicitly include other committed records once access and retention are agreed. The dashboard has no record editing or scan controls. Stop sharing when finished.

## Build and run

Follow the [README](README.md) for the demo walkthrough, SDK dependency and build commands. Use JDK 17, Android SDK 34 and the Chainway `DeviceAPI_ver20251103_release.aar`. Put the AAR in `app/libs`. The repository does not carry a copy of the vendor AAR, the generated APK, or the signing key. The Windows SDK build script produces a signed debug APK at `build/keypharm-poc-<versionName>-debug.apk`. Keep the same local signing key when updating the installed package `be.keypharm.rfid.poc` so Android can preserve its data.

On the C72, open **Keypharm RFID POC → Sessions → Evidence → Share web dashboard**. Copy the link and open it in a browser on the same Wi-Fi. Keep the handheld app running. Simulation mode supplies a matching pallet and selectable missing, extra, clean and interrupted carton scenarios.

## Verified and pending

- Verified seven Node tests and the Playwright flow covering local roles, failed and clean scans, persistence after reload, and dashboard disconnect and reconnect.
- Built the signed debug APK with the Windows SDK script, installed it over USB and launched it on the C72 EEA running Android 13, build `C72.AD13.EEA.20250304.V1.12`.
- Verified SDK inventory start and stop and observed UHF reads on the real device. The device reported `E710_V7.1.9`, ETSI and 30 dBm. Antenna polarization was unavailable on the tested SDK path. These are observed settings for that device.
- Verified Android press/repeat/release handling with injected events. Verified that the installed app produced evidence files and that the dashboard served committed demo records, rejected writes and became unreachable when sharing stopped.
- Hands-on acceptance still needs the physical trigger and known tagged pallet and cartons. Q-02 remains open for the real manifest format and example. Q-10 remains open for allocation accounting. Dashboard access/retention policy is separate from the accepted demo export and backup behavior.

For the next update, record any client answer in [questionaire.md](docs/questionaire.md), update the corresponding requirement or demo decision, and verify through the actual app entry point. Keep Pilot changes separate until that stage begins.
