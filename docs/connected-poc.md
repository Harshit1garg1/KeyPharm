# KeyPharm connected PoC

Version 0.9.24 (build 45). The PC hosts the dashboard and SQLite database. The C72 stores a separate connected-demo cache, so upgrading does not repurpose the earlier local trial records. The service is local and the stock is demonstration data.

## Start the local demo

From the project folder, run `node tools/workspace-server.mjs` with Node 24. Open `http://127.0.0.1:8790`. Use `testing` with password `testing123` on both the dashboard and C72. Sign in once per interface. The handheld supports Operator, Supervisor, and Administrator. The dashboard also supports Reviewer. The audit records the active role for this shared local demo login.

Build Android with `./tools/build-android.ps1 -Package be.keypharm.rfid.poc.dev -Label "Keypharm RFID POC Dev"` and use the existing Dev signing key for an in-place update. The first script build downloads and checks the pinned ZXing Core JAR for the camera scanner, then caches it under `build`. Run `adb -s <device> reverse tcp:8790 tcp:8790` before opening the connected app. This forwards the device's localhost connection to the PC. Reapply it after changing the debugging connection.

The server listens on PC loopback. Before hosting on TransIP, configure an HTTPS handheld endpoint with the deployment subpath. Configure the reverse proxy to strip the subpath and preserve the host, or add matching base-path handling to the server. Select a hosted database, backups, and individual credentials before opening access.

## Presentation sequence

For a factory transfer, the receipt CSV can include optional `batch_lot` and `units_per_carton` columns. Use a positive whole number for units per carton. If the same SKU arrives with different lots or carton quantities, use separate receipts. These details appear in the receipt preview and the selected carton’s inventory details after confirmation.

1. Open **Inventory** as Administrator. Start with 20 Physalis, 15 Tiger Balm, and 35 Biotona cartons. Load receipts under **Inbound → Import receipt**. An optional `product_identifier` column maps a barcode or supplier reference to the row's SKU. By default, the SKU is the Product Identifier.
2. As Operator, open **Stock tasks** on the C72 and select `KP-IN-40`. Leave **Demo barcode** checked to pick a demo Product Identifier, or clear it to scan the actual barcode. Tap **Scan barcode**. The built-in reader is tried first. If it cannot read a barcode, the app opens its camera scanner. A real barcode must match a Product Identifier on the receipt. Supply that code in the import’s `product_identifier` column. Use **Scan EPC** to read one RFID tag, or choose **Simulate EPC** for the sample receipt. The reader stops after the first valid EPC. Review the pending tag and tap **×** to discard it or **Confirm** to link the EPC to the scanned product and return to product selection. Receiving can assign an unlinked EPC to an outstanding carton and rejects EPCs assigned to another product or receipt. Repeat for the remaining cartons. Inventory shows 110 on hand after all 40 are received. To demonstrate the optional stock count, open a Storage count on the dashboard. As Operator, select that count in **Stock tasks** and use **Start count scan** and **Stop count scan**, or hold and release the trigger. For synthetic sample tags, use **Run simulation**. The Supervisor reviews the run on the dashboard. As Administrator, open the completed receipt and choose **Prepare outbound pallet** once its cartons are available. The C72 receives `KP-RECEIVED-40` with the same 40 carton identities.
3. As Supervisor, record the in-person physical check. For a simulated presentation, say that the check is simulated and enter that in the notes. For hardware, check the actual carton contents and tags at the pallet.
4. As Operator on the C72, open the session and run the pallet scan. In Simulation, choose **Missing and unexpected**. Show 40 observed, 39 matched, one missing, and one unexpected. Continue stays disabled.
5. Choose **Clean match** and run again. The app fills the rescan reason from the prior missing and unexpected EPCs. Continue confirms the clean result. The first result stays in the evidence. To rescan after a clean match, pick or enter a reason first.
6. On the PC, the Administrator can use **Dispatch** to approve and dispatch a verified session in one confirmation. The Reviewer uses **Approve dispatch** to record approval. A Supervisor can dispatch sessions with existing approval. The Administrator and Supervisor can also select eligible sessions and use **Confirm dispatch** for the batch. Inventory returns to 70 on hand. If validation fails, the whole batch rolls back.
7. Open the dispatched session to inspect its evidence and the approval and dispatch log entries.

To revisit a closed session before dispatch, the Administrator can choose **More actions**, then **Reopen session** to keep the CSV or **Change CSV** to replace it. Either action starts a new verification and keeps the previous scan evidence.

The C72 stays in portrait. Scan start plays a short tone at the Android media volume. Workflow milestones open a confirmation dialog with an animated tick. Short sync and recovery messages use Android’s native toast. The dashboard uses the normal workspace sign-in, including when opening action dialogs.

For the physical demo, choose **RFID handheld** and the sample CSV. The optional ignored file `app/src/main/assets/private-live-sample.csv` supplies the 13 physical carton EPCs. They are distributed across the three demo products in CSV order. The pallet EPC identifies the handling unit only. The 57 remaining stock records use synthetic EPCs.

To rehearse offline, download a ready session first, temporarily stop the service, capture or rescan, then restart the service and use **Sync now**. The C72 keeps the local result and retries the same upload. If the server revision changed, the C72 retains the local evidence and shows **Needs review**.

## Generate a manifest from inventory

In **Inventory → Pallets**, import one physical pallet per row with `pallet_ref,pallet_epc,sku,size,material`. In **Outbound → Build manifest**, choose an on-hand pallet and enter the carton quantities by product SKU. Use **Add another pallet** for more pallets. Supervisor records the in-person physical check on the handheld or dashboard. Administrator can also record it from the dashboard. Operators see Scan and Close only. Sync the handheld before going offline. The Operator scans the pallet tag and then its cartons. The handheld looks up each EPC in the cached inventory and compares SKU quantities. Dispatch deducts the EPCs accepted by verification.

Open **LookUp** in the bottom menu and select any session with a manifest. Reader diagnostics, the test plan, and evidence tools are under **Settings**. Select the pallet or one carton and start the reader. The indicator breathes and the beep speeds up as the reader reports a stronger signal for that EPC. The RSSI below it is a signal reading in dBm. The beep stops when the target has not been detected recently.

## Checks

- `node --test tests/model.test.mjs tests/workspace.test.mjs`
- `py -3.13 tests/browser_smoke.py`
- `py -3.13 tests/connected_smoke.py`

The connected rehearsal uses an isolated test database, desktop browsers, and the handheld application code with simulated RFID input. See the [brief comparison and acceptance evidence](platform-poc-review.md) for the remaining gaps. The Administrator can edit the shared test plan and request reader power from the dashboard. The handheld applies the recommendation when opening an active hardware session. Stock tasks use their own setting, which defaults to 10 dBm. Live count uploads require a connection. A failed upload can be retried while the app remains open.
