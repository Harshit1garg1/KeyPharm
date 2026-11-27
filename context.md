# KeyPharm RFID PoC context

Updated 27 November 2026. Android **0.9.35**, version code **56**, package `be.keypharm.rfid.poc.dev`. GitHub branch `Harshit-POC` contains the connected PoC.

## Run locally

- Use Node 24 and run `node tools/workspace-server.mjs`. Open `http://127.0.0.1:8790/`.
- Connect the C72 through ADB and run `adb -s <serial> reverse tcp:8790 tcp:8790` so the handheld can reach the PC dashboard.
- To build the Dev APK, run `./tools/build-android.ps1 -Jdk '<JDK 17 path>' -Package be.keypharm.rfid.poc.dev -Label 'Keypharm RFID POC Dev'`. Use Android SDK platform and build tools 34, and place the licensed Chainway DeviceAPI AAR in `app/libs/`. Update in place with `adb install -r` and the existing `build/debug.keystore`.
- The SQLite workspace, account store, private live EPC fixture, vendor SDK, signing key, and generated APKs are local files. See [connected setup](docs/connected-poc.md) for prerequisites and [scope](docs/poc-and-pilot-scope.md) for the PoC/Pilot split.

## Demo workflow

- **Inbound and counts.** Import a receipt in the dashboard. The Operator selects the product and SKU in Stock Tasks, scans and confirms its EPC, and can register a pallet from the Stock Tasks toolbar. Operators capture stock counts on the handheld. Supervisors review discrepancies and maintain holds.
- **Manifest builder.** In Outbound, choose a pallet type and enter quantities by SKU. The pallet selector has its own row and quantities use compact fields. Capacity comes from available physically tagged cartons. Add additional pallets, download the CSV, or create an outbound session from it. Existing exact-EPC CSVs remain supported.
- **Outbound scanning.** The Supervisor records Verify. The Operator scans the pallet, then its cartons. Hold the physical trigger to start and release to finish, including in simulated outbound sessions. Simulations also support the on-screen hold button. A clean scan unlocks Continue. Dispatch updates the verified carton EPCs in stock.
- **Find tags.** Lookup identifies the scanned tag using synced stock and pallet inventory. Search can target a carton or pallet EPC and provides RSSI and proximity feedback. Carton results distinguish the product from its SKU.
- **Audit.** Dashboard Administrators can cancel a receipt and retire eligible pallets and cartons. Cancellation preserves received stock and evidence. Actions require a reason and write the actor and timestamp to Stock movements. Carton history identifies the EPC suffix.
- **Dashboard.** Overview shows on-hand pallets and cartons. Sign-in lasts 12 hours, and the sign-in page offers light and dark themes. Administrator Settings contains reader power and configured locations.

## Verification

- `node --test tests/*.test.mjs`
- With Playwright installed, run `py -3.13 tests/browser_smoke.py` and `py -3.13 tests/connected_smoke.py`.
- On the C72, open a verified simulated outbound session. Hold and release the physical trigger for both pallet and carton scans. Repeat with a real session and physical EPCs to verify reader behavior.

The code is a local PoC. Production hosting, authentication, and Pilot validation follow the project brief.
