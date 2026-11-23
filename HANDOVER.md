# KeyPharm live RFID POC handover

23 November 2026. Feature branch `Harshit-Dev`. Comparison baseline is GitHub `main` at `2a79461148f523571e5ebace8b5c492fac953fa7` (PR #1, app 0.2.0). This branch produces Android 0.3.3, version code 6.

## What changed from main and why

| Change | Why it was made | Where to look |
| --- | --- | --- |
| Added a separate Chainway XLS-to-manifest converter. Keypharm still imports the existing five-column CSV. | The vendor workbook lists observed tags with TID, user data, count and RSSI. It does not assign pallet or carton roles. Keep the conversion transparent and preserve CSV compatibility. | `tools/uhf-xls-to-manifests.py`, README |
| Added an optional hardware sample containing the one pallet and 13 cartons captured from the actual set. Simulation retains its own sample. | The operator can load known physical tags without manually finding the CSV. The synthetic sample remains suitable for simulation and dashboard demos. | `handheld.mjs`, `MainActivity.java`, ignored `private-live-sample.csv` |
| Separated pallet identification and carton inventory into dedicated screens. Added animation, progress counts, clearly styled controls and carton status badges. | The original session put scan controls alongside setup and evidence. The operator now sees the correct stage and can distinguish expected, waiting, missing and unexpected tags at a glance. | `handheld.mjs`, `style.css`, `tests/browser_smoke.py` |
| Pallet identification uses the current reader power and confirms the exact EPC from the manifest even when other tags are present. Carton inventory uses the same configured power and flags unexpected EPCs. | The operator can work near other tags and adjust read range as needed. The specified pallet EPC remains the identity check. | `C72Reader.java`, `MainActivity.java`, `handheld.mjs` |
| Added Test lead power settings for idle hardware sessions. The app reads back 5–30 dBm adjustments and writes confirmed changes to the session log. | Main captured reader power per scan but exposed no control. The POC assigns approved reader settings to the Test lead. The configuration stays on ETSI. | `C72Reader.java`, `MainActivity.java`, `model.mjs`, `handheld.mjs` |
| Applied the official KeyPharm logo, green and teal palette, and Android launcher icon. | Make the offline handheld and dashboard recognizable while keeping scan states prominent. | `.hallmark/brand-spec.md`, app assets, Android manifest and resource |
| Updated the SDK-only Windows build to include the app resources. | The offline build must resolve the same launcher icon as the Gradle build. | `tools/build-android.ps1` |

The branch preserves the strict carton acceptance rule and the evidence export format from main. Continue only enables after a finished carton run with all expected EPCs and zero unexpected EPCs. Dashboard sharing remains read-only and defaults to sample simulation records.

## Reproduce the internal build

1. Use JDK 17, Android SDK 34, and the Chainway DeviceAPI AAR listed in the [README](README.md).
2. For a hardware-sample build, copy the physical manifest to `app/src/main/assets/private-live-sample.csv`. The source XLS, confirmed EPC CSV and signed debug APK remain local. GitHub carries the source, converter, build tooling and documentation.
3. Run `./tools/build-android.ps1`. The output is `build/keypharm-poc-0.3.3-debug.apk`. For an in-place upgrade on an existing test C72, build with the same private signing key and install with `adb install -r`.
4. Open a C72 hardware session. As Test lead, select **Use live sample** or choose a manifest. Record the physical check as Supervisor, then open **Scan pallet** as Operator. Hold the reader near the marked pallet tag, and release the trigger. On **Scan cartons**, scan the carton set and inspect the result before continuing.

## Remaining decisions and acceptance

- EPC is the authority for pallet identity. Use the Test lead setting to choose a practical reader range. Other tags in range cannot substitute for the manifest's pallet EPC.
- The physically confirmed main set has one pallet plus 13 cartons. The remaining observed EPCs include one unverified stray. Build the fallback manifest after identifying the remaining physical tags.
- Test clean, missing and extra carton runs through the physical trigger in the intended work area. Include an unrelated tag close enough to verify that carton scanning still flags it.
- Confirm the production import format, named identity and retention requirements, label accounting, and how many planned tests belong in a session. Pilot integration and release rules remain future work.

## Verification

- Nine Node tests and the Playwright flow passed on 0.3.3. The browser fixture verifies the live sample action, the shared configured power, pallet confirmation among mixed tags, and the carton exception gate.
- The signed Android SDK build includes the KeyPharm launcher image and the local hardware sample. The C72 upgraded in place to 0.3.2 and launched with its original installation time.
- Earlier live capture read all 13 physically selected carton EPCs at 5 dBm with no unfamiliar EPCs. The standalone conversion and the captured manifest both passed the app parser.
- On 0.3.2, the C72 reported a pallet scan start at 5 dBm and a return to 30 dBm. The intended pallet was out of range at 5 dBm. This fixed-power behavior was removed in 0.3.3. A complete physical pallet and carton match remains pending.
- The C72 upgraded in place to 0.3.3. In a hardware probe, two consecutive inventory runs both used the selected 18 dBm and read 10 distinct EPCs per run. The intended pallet EPC was present in the first run alongside other tags. The pre-test power of 30 dBm was restored.
