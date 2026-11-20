# Keypharm RFID POC

Offline C72 handheld workflow with a read-only web dashboard. Use Simulation to demonstrate the workflow with sample data, or C72 hardware to read physical tags from a matching manifest.

## Run the demo

1. Open **Keypharm RFID POC** on the C72. Create a test session and choose **Simulation**.
2. Select **Test lead**, load the sample manifest, and save it. Select **Supervisor** and record physical verification. Return to **Operator**.
3. Hold and release the demo trigger to identify the pallet. Hold and release again for the first carton scan. The default simulated run misses one carton.
4. Select **Unexpected extra**, enter a rescan reason, and retry. Continue stays disabled. Repeat with **Clean match**. Continue enables after release. Previous attempts remain available.
5. Confirm the match, then review and close the test. From **Sessions**, export the evidence through Android's share sheet: `keypharm-<time>.csv` (functional design section 8 columns, one row per EPC per run), `keypharm-<time>-records.csv` (full session record and audit log) and a readable summary.
6. Tap **Share web dashboard**. Open the private link in a browser on the same trusted Wi-Fi network, with the handheld app running. The browser fetches committed records and logs only while the app is reachable. If the connection drops, an already open dashboard shows the last fetched records and their refresh time. Stop sharing from the handheld when finished.

For a physical test, start a session with **C72 hardware**, import the matching pallet and carton EPCs, verify the contents, and use the physical trigger. Check the reader status before scanning. The sample manifest contains synthetic EPCs.

## Build and update

- Use JDK 17 and Android SDK platform/build tools 34. Place the Chainway `DeviceAPI_ver20251103_release.aar` in `app/libs`. The local sample at `../Demo-uhf_as/uhf-uart-demo/app/libs` supplied this POC build. [Chainway C72 SDK support](https://www.chainway.net/Support/Info/10).
- Run `./gradlew.bat :app:assembleDebug` with access to the Gradle dependencies. The verified Windows offline alternative is `./tools/build-android.ps1`, which writes `build/keypharm-poc-<versionName>-debug.apk` (version read from `app/build.gradle`) using the installed SDK tools.
- Install or update with `adb -d install -r build/keypharm-poc-<versionName>-debug.apk`. Keep the same signing key for updates so Android preserves local app data. The offline build creates its demo key at `build/debug.keystore`.
- Run `node --test tests/model.test.mjs`. Optional browser smoke test with Python Playwright and Chromium is `python tests/browser_smoke.py`.

| To change | Edit |
| --- | --- |
| Trial CSV columns, EPC validation, roles, allocation or match rule | `app/src/main/assets/model.mjs` |
| Handheld workflow and demo cases | `app/src/main/assets/handheld.mjs` |
| Trigger codes, file picker and Android integration | `MainActivity.java` under `app/src/main/java/be/keypharm/rfid/` |
| Reader SDK, approved-region check and capture | `C72Reader.java` in the same directory |
| Read-only records feed and dashboard | `DashboardServer.java` and `app/src/main/assets/dashboard.mjs` |
| Layout, colors and sizing | `app/src/main/assets/style.css` |

Dashboard sharing defaults to sample simulation records. The Test lead can include all committed local records after the access and retention choices in Q-12 are agreed. The private link grants read access while active. Local identities demonstrate roles for the POC. The default allocation counts each session's manifest cartons, pallet, candidate labels and reserves against the 500-label cap. The real accounting rule remains open in Q-10.

## Scope and acceptance

- [Project context and handoff](context.md)

- [POC and Pilot scope](docs/poc-and-pilot-scope.md)
- [Questionaire](docs/questionaire.md)
- [Approved demo design](docs/demo-design.md)

USB verification on the C72 EEA with Android 13 confirmed app installation, SDK inventory start/stop, UHF observations, Android press/release event handling and evidence file creation. The dashboard records were compared with a simulated session on the C72. The physical trigger and a complete tagged pallet/carton match still need hands-on acceptance with known tags. The real manifest format remains open.
