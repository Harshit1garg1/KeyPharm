# Keypharm RFID POC

KeyPharm RFID PoC for the C72 and a local PC dashboard. The Android app is version 0.9.21 (version code 42). Use Simulation to rehearse with sample data or RFID handheld to scan physical tags from a matching manifest. See [context.md](context.md) for the latest handoff.

## Run the connected demo

Run `node tools/workspace-server.mjs` with Node 24 and open the dashboard at `http://127.0.0.1:8790`. The [connected demo guide](docs/connected-poc.md) covers accounts, setup, C72 sync, session approval, batch dispatch, inventory, and reset.

## Run the standalone handheld demo

1. Open **Keypharm RFID POC** on the C72. Create a test session and choose **Simulation**.
2. As **Test lead**, enter the day's planned tests under **PoC test plan** (one per line: Test ID, then description). New sessions pre-fill the first test not yet run. Tap the name chip at the top right and enter **Your name** (it signs every record and is remembered for next time); the same menu switches the role. Each session screen shows a four-step strip (Cartons, Verify, Scan, Close) and one card for the step due now; when that step belongs to another role, the card offers **Switch to …**. Load the sample manifest as **Test lead**, record physical verification as **Supervisor**, then scan as **Operator**. Everything else (setup, carton list, reader, log, export) sits folded under **Details**.
3. Tap **Open pallet scanner**, then hold and release the demo trigger to identify the pallet. The app opens **Scan cartons** with **Clean match** selected in **Demo reads**.
4. Select **Unexpected extra** before scanning to demonstrate **Hold: unexpected reads**. Continue stays disabled, and the next scan gets an automatic reason. Select **Clean match** and retry to enable Continue. A rescan after a clean match requires a reason. Open **Session details** for previous attempts, investigations and the **By SKU** breakdown of each run.
5. Add a note to any run if useful. Confirm the match, then review and close the test. **Export this test** exports just that record. From **Sessions**, export the evidence through Android's share sheet: `keypharm-<time>.csv` (functional design section 8 columns, one row per EPC per run), `keypharm-<time>-records.csv` (full session record and audit log) and a readable summary (with results grouped by test configuration). The Evidence section lists sessions changed since their last export. With two or more sessions, the search box above the list filters by test, pallet, SKU, location, level, name, date or next step.
6. Tap **Share web dashboard** (all records are shared; the Test lead can untick **Include hardware and imported records** to share samples only). Scan the QR code or open the private link from a device on the same trusted Wi-Fi network with the handheld app running. The dark overview shows totals across all shared records, recent sessions, and carton scan outcomes. Open a section in the left menu to search and inspect its latest 50 entries. An open dashboard shows the last fetched records and refresh time if the connection drops. Stop sharing from the handheld when finished.

For a physical test, start a session with **C72 hardware**. The Test lead can select **Use live sample** on a build containing the captured set, **Choose CSV** to import a different set, or **Build from scan** to make the manifest on the C72: scan one pallet's tags, untick strays, check the preselected pallet tag (strongest signal), then **Use as manifest** or **Save CSV file**. Verify the contents, open the scanner, then tap **Start scan** / **Stop scan** or hold the trigger near the pallet tag. Both scan steps use the power selected by the Test lead. Other tags can stay nearby during pallet identification. One CSV may list several pallets (same five columns, several `pallet_ref`/`pallet_epc` values). The pallet scan locks one pallet: any of its tags counts (pallet tag or carton), and the pallet whose tag reads with the strongest signal wins, then the one with more tags read. The lock and its RSSI go into the session log. When **Scan cartons** opens, scan again. Only the locked pallet's cartons count. A tag of another pallet in the file shows as **Belongs to pallet X** (`OTHER_PALLET_EPC` in the export), any other tag as **Outside this pallet** (`UNEXPECTED_EPC`); both keep the run on Hold. The pallet EPC is excluded from carton counts.

Simulation uses a separate synthetic sample. To build with the physical sample, place the validated CSV at `app/src/main/assets/private-live-sample.csv`. This file is ignored by Git and bundled in that APK. Keep APKs containing live EPCs within the test team.

To adjust the range, select **Test lead** and tap the **C72 reader** row at the top of the home screen, or **Details → Reader settings** inside a hardware session. The C72 supports 5–30 dBm for this POC. Set power while idle, verify the displayed read-back, and return to the approved test power after sorting tags. The ETSI region remains read-only. Setting power needs a name in the header menu. A change made inside a session is logged there; a change from the home screen goes to the **Device log** under Evidence. Each scan records its actual power and the reader profile version.

## Build and update

For physical tag testing, convert a Chainway UHF XLS export on a PC with Python and `xlrd` installed:

```powershell
python tools/uhf-xls-to-manifests.py input.xls build/live-manifests
```

The converter uses workbook order, with up to 14 tags per test pallet. Each group's first tag is the pallet tag. The remaining tags are cartons with test references. The XLS file provides tag observations, so these assignments are for the POC. Copy each generated CSV to the C72 and import it in a separate hardware session. Scan near the designated pallet tag for identification. Keep fallback tags outside the carton scan zone unless testing an unexpected read.

- Use JDK 17 and Android SDK platform/build tools 34. Place the Chainway `DeviceAPI_ver20251103_release.aar` in `app/libs`. The local sample at `../Demo-uhf_as/uhf-uart-demo/app/libs` supplied this POC build. [Chainway C72 SDK support](https://www.chainway.net/Support/Info/10).
- The C72 carries one app, `be.keypharm.rfid.poc.dev`. Build it with the verified Windows offline script (pass JDK 17; JDK 21 crashes d8):
  `./tools/build-android.ps1 -Jdk "C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot" -Package be.keypharm.rfid.poc.dev -Label "Keypharm RFID POC Dev"`
  It writes `build/keypharm-poc-<versionName>-dev-debug.apk` (version read from `app/build.gradle`). `./gradlew.bat :app:assembleDebug` also works with access to the Gradle dependencies.
- Install or update with `adb install -r build/keypharm-poc-<versionName>-dev-debug.apk` (add `-s <serial>` when the C72 shows twice, over USB and Wi-Fi). `-r` keeps the app's data.
- **Signing key:** the first build creates `build/debug.keystore` (password `android`, alias `androiddebugkey`). The app on the C72 was signed by the copy in `Downloads/KeyPharm-repo/build/`. `build/` is not in Git, so back that file up: a build with another key cannot update the app, and uninstalling it deletes every session on the device.
- Before bumping the version, fetch `Harshit-Dev` and check the C72's installed `versionCode` (`adb shell dumpsys package be.keypharm.rfid.poc.dev`); Android refuses a lower code.
- Run `node --test tests/model.test.mjs`. Optional browser smoke test with Python Playwright and Chromium is `python tests/browser_smoke.py`.

| To change | Edit |
| --- | --- |
| Trial CSV columns, EPC validation, roles, allocation or match rule | `app/src/main/assets/model.mjs` |
| Handheld workflow and demo cases | `app/src/main/assets/handheld.mjs` |
| Trigger codes, file picker and Android integration | `MainActivity.java` under `app/src/main/java/be/keypharm/rfid/` |
| Reader SDK, approved-region check and capture | `C72Reader.java` in the same directory |
| Read-only records feed and dashboard | `DashboardServer.java` and `app/src/main/assets/dashboard.mjs` |
| Layout, colors and sizing | `app/src/main/assets/style.css` |

Dashboard sharing includes all committed records by default; the Test lead can untick **Include hardware and imported records** to share sample sessions only. Access and retention rules are still open (Q-12). The private link grants read access while active. Local roles are not authenticated; the name entered on the device is recorded as creator, operator, verifier and sign-off. The default allocation counts each session's manifest cartons, pallet, candidate labels and reserves against the 500-label cap. The real accounting rule remains open in Q-10.

## Scope and acceptance

- [Project context and handoff](context.md)
- [PoC PRD: scope, status and milestones](docs/prd-poc.md)
- [Functional design (source)](keypaharm_functional_design.md)
- [POC and Pilot scope](docs/poc-and-pilot-scope.md)
- [Questionaire](docs/questionaire.md)
- [Approved demo design](docs/demo-design.md)

Verification on the C72 EEA with Android 13 confirmed app installation, SDK inventory start/stop, UHF observations, Android press/release event handling and evidence file creation; a live run matched 13 of 13 cartons and held on a stray tag. A clean hardware match, the two-pallet lock scan, the physical missing/extra/neighbour tests and an airplane-mode dress rehearsal are still pending. The real EPC and manifest formats remain open. Milestone status: [docs/prd-poc.md](docs/prd-poc.md).
