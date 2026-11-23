# Keypharm RFID POC

Offline C72 handheld workflow with a read-only web dashboard. Use Simulation to demonstrate the workflow with sample data, or C72 hardware to read physical tags from a matching manifest.

## Run the demo

1. Open **Keypharm RFID POC** on the C72. Create a test session and choose **Simulation**.
2. As **Test lead**, enter the day's planned tests under **PoC test plan** (one per line: Test ID, then description). New sessions pre-fill the first test not yet run. Tap the name chip at the top left and enter **Your name** (it signs every record and is remembered for next time); the same menu switches the role. Each session screen shows a four-step strip (Cartons, Verify, Scan, Close) and one card for the step due now; when that step belongs to another role, the card offers **Switch to …**. Load the sample manifest as **Test lead**, record physical verification as **Supervisor**, then scan as **Operator**. Everything else (setup, carton list, reader, log, export) sits folded under **Details**.
3. Tap **Open pallet scanner**, then hold and release the demo trigger to identify the pallet. Once the pallet matches, the app opens **Scan cartons**. Hold and release again. The default simulated run misses one carton.
4. Select **Unexpected extra**, enter a rescan reason, and retry. Continue stays disabled. Repeat with **Clean match**. Continue enables after release. The Carton status list labels expected, waiting, missing and unexpected EPCs. Open **Session details** for previous attempts and investigations.
5. Add a note to any run if useful. Confirm the match, then review and close the test. **Export this test** exports just that record. From **Sessions**, export the evidence through Android's share sheet: `keypharm-<time>.csv` (functional design section 8 columns, one row per EPC per run), `keypharm-<time>-records.csv` (full session record and audit log) and a readable summary.
6. Tap **Share web dashboard**. Scan the QR code or open the private link from a device on the same trusted Wi-Fi network with the handheld app running. Overview totals use all shared records. Open a section in the left menu to search and inspect its latest 50 entries. An open dashboard shows the last fetched records and refresh time if the connection drops. Stop sharing from the handheld when finished.

For a physical test, start a session with **C72 hardware**. The Test lead can select **Use live sample** on a build containing the captured set, or **Choose CSV** to import a different set. Verify the contents, open the scanner, then tap **Start scan** / **Stop scan** or hold the trigger near the pallet tag. Both scan steps use the power selected by the Test lead. Other tags can stay nearby during pallet identification. One CSV may list several pallets (same five columns, several `pallet_ref`/`pallet_epc` values). The pallet scan locks one pallet: any of its tags counts (pallet tag or carton), and the pallet whose tag reads with the strongest signal wins, then the one with more tags read. The lock and its RSSI go into the session log. When **Scan cartons** opens, scan again. Only the locked pallet's cartons count. A tag of another pallet in the file shows as **Belongs to pallet X** (`OTHER_PALLET_EPC` in the export), any other tag as **Outside this pallet** (`UNEXPECTED_EPC`); both keep the run on Hold. The pallet EPC is excluded from carton counts.

Simulation uses a separate synthetic sample. To build with the physical sample, place the validated CSV at `app/src/main/assets/private-live-sample.csv`. This file is ignored by Git and bundled in that APK. Keep APKs containing live EPCs within the test team.

To adjust the range, select **Test lead** in an open hardware session and open **Reader** under **Details**. The C72 supports 5–30 dBm for this POC. Set power while idle, verify the displayed read-back, and return to the approved test power after sorting tags. The ETSI region remains read-only. The session log records confirmed changes, and each scan records its actual power.

## Build and update

For physical tag testing, convert a Chainway UHF XLS export on a PC with Python and `xlrd` installed:

```powershell
python tools/uhf-xls-to-manifests.py input.xls build/live-manifests
```

The converter uses workbook order, with up to 14 tags per test pallet. Each group's first tag is the pallet tag. The remaining tags are cartons with test references. The XLS file provides tag observations, so these assignments are for the POC. Copy each generated CSV to the C72 and import it in a separate hardware session. Scan near the designated pallet tag for identification. Keep fallback tags outside the carton scan zone unless testing an unexpected read.

- Use JDK 17 and Android SDK platform/build tools 34. Place the Chainway `DeviceAPI_ver20251103_release.aar` in `app/libs`. The local sample at `../Demo-uhf_as/uhf-uart-demo/app/libs` supplied this POC build. [Chainway C72 SDK support](https://www.chainway.net/Support/Info/10).
- Run `./gradlew.bat :app:assembleDebug` with access to the Gradle dependencies. The verified Windows offline alternative is `./tools/build-android.ps1`, which writes `build/keypharm-poc-<versionName>-debug.apk` (version read from `app/build.gradle`) using the installed SDK tools.
- Install or update with `adb -d install -r build/keypharm-poc-<versionName>-debug.apk`. Keep the same signing key for updates so Android preserves local app data. The offline build creates its demo key at `build/debug.keystore`.
- To install next to an existing copy instead of replacing it, build with a different package: `./tools/build-android.ps1 -Package be.keypharm.rfid.poc.dev -Label "Keypharm RFID POC Dev"` (writes `build/keypharm-poc-<versionName>-dev-debug.apk`). Each copy keeps its own local data. Only one app can use the UHF reader at a time, so close the other copy before scanning.
- Run `node --test tests/model.test.mjs`. Optional browser smoke test with Python Playwright and Chromium is `python tests/browser_smoke.py`.

| To change | Edit |
| --- | --- |
| Trial CSV columns, EPC validation, roles, allocation or match rule | `app/src/main/assets/model.mjs` |
| Handheld workflow and demo cases | `app/src/main/assets/handheld.mjs` |
| Trigger codes, file picker and Android integration | `MainActivity.java` under `app/src/main/java/be/keypharm/rfid/` |
| Reader SDK, approved-region check and capture | `C72Reader.java` in the same directory |
| Read-only records feed and dashboard | `DashboardServer.java` and `app/src/main/assets/dashboard.mjs` |
| Layout, colors and sizing | `app/src/main/assets/style.css` |

Dashboard sharing defaults to sample simulation records. The Test lead can include all committed local records after the access and retention choices in Q-12 are agreed. The private link grants read access while active. Local roles are not authenticated; the name entered on the device is recorded as creator, operator, verifier and sign-off. The default allocation counts each session's manifest cartons, pallet, candidate labels and reserves against the 500-label cap. The real accounting rule remains open in Q-10.

## Scope and acceptance

- [Project context and handoff](context.md)

- [POC and Pilot scope](docs/poc-and-pilot-scope.md)
- [Questionaire](docs/questionaire.md)
- [Approved demo design](docs/demo-design.md)

USB verification on the C72 EEA with Android 13 confirmed app installation, SDK inventory start/stop, UHF observations, Android press/release event handling and evidence file creation. The dashboard records were compared with a simulated session on the C72. The physical trigger and a complete tagged pallet/carton match still need hands-on acceptance with known tags. The real manifest format remains open.
