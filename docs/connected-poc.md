# KeyPharm connected PoC

The PC hosts the dashboard and SQLite database. The C72 stores a separate connected-demo cache, so upgrading does not repurpose the earlier local trial records. The service is local and the stock is demonstration data.

## Start the local demo

From the project folder, run `node tools/workspace-server.mjs` with Node 24. Open `http://127.0.0.1:8790`. The first start creates the database, individual dashboard credentials, and a single `handheld` account in `build/connected-poc`. Use separate browser profiles for the Test lead, Supervisor, and Reviewer. Sign in once on the C72 as `handheld`, then choose the effective role from the Role menu. Finish the current action and sync before handing the device to the next role. The audit records the role used by that shared demo login. This is a presentation shortcut for the isolated workspace.

Build Android with `./tools/build-android.ps1 -Package be.keypharm.rfid.poc.dev -Label "Keypharm RFID POC Dev"` and use the existing Dev signing key for an in-place update. Run `adb -s <device> reverse tcp:8790 tcp:8790` before opening the connected app. This forwards the device's localhost connection to the PC. Reapply it after changing the debugging connection.

The local demo uses the password `testing123` for all demo usernames. The server listens on PC loopback only. For a hosted version, configure HTTPS, individual credentials, backups, and the C72 service endpoint before opening access.

## Presentation sequence

1. Open **Inventory** as Test lead. Start with 20 Juice, 15 Tiger Balm, and 35 Biotona cartons.
2. Under **Session controls**, open the prepared `KP-OUT-40` session. On a clean database, create it with **Simulation** and **Use Sample CSV**. On-hand stays at 70 until dispatch.
3. As Supervisor, record the physical check. For a simulated presentation, say that the check is simulated and enter that in the notes. For hardware, check the actual carton contents and tags at the pallet.
4. As Operator on the C72, open the session and run the pallet scan. In Simulation, choose **Missing and unexpected**. Show 40 observed, 39 matched, one missing, and one unexpected. Continue stays disabled.
5. Choose **Clean match** and run again. The app fills the rescan reason from the prior missing and unexpected EPCs. Continue confirms the clean result. The first result stays in the evidence. To rescan after a clean match, pick or enter a reason first.
6. On the PC, the Test lead or Reviewer opens the session in **Outbound sessions** and chooses **Approve dispatch** after verifying the evidence. The Test lead or Supervisor can then select several approved sessions and choose **Confirm dispatch**. Inventory now shows 6 Juice, 5 Tiger Balm, and 19 Biotona on hand. If any selected session fails validation, the whole batch rolls back.
7. Open the dispatched session to inspect its evidence and the approval and dispatch log entries.

To revisit a closed session before dispatch, the Test lead can choose **Open closed session**, then **Reopen session** to keep the CSV or **Change CSV** to replace it. Either action starts a new verification and keeps the previous scan evidence.

The C72 stays in portrait. Workflow milestones open a confirmation dialog with an animated tick. Sync and recovery messages use a small info-bubble. The dashboard uses the normal workspace sign-in, including when opening action dialogs.

For the physical demo, choose **C72 hardware** and the sample CSV. The optional ignored file `app/src/main/assets/private-live-sample.csv` supplies the 13 physical carton EPCs. They are distributed across the three demo products in CSV order. The pallet EPC identifies the handling unit only. The 57 remaining stock records use synthetic EPCs.

To rehearse offline, download a ready session first, temporarily stop the service, capture or rescan, then restart the service and use **Sync now**. The C72 keeps the local result and retries the same upload. If the server revision changed, the C72 retains the local evidence and shows **Needs review**.

## Checks

- `node --test tests/model.test.mjs tests/workspace.test.mjs`
- `py -3.13 tests/browser_smoke.py`
- `py -3.13 tests/connected_smoke.py`

The connected rehearsal uses an isolated test database, desktop browsers, and the handheld application code with simulated RFID input. Receiving, stock-count reconciliation, production ERP/WMS, and TransIP deployment are outside this outbound presentation slice. The Test lead can edit the shared test plan and request reader power from the dashboard. The Test lead applies that request on the C72, which reports the measured setting.
