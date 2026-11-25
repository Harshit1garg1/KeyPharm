# KeyPharm platform PoC review

Reviewed against the 24 November 2026 KeyPharm RFID Platform Development Brief v1.0. The original mobile functional design still governs independent manifests, carton identity and scan evidence. This review describes the local demonstration build.

| Brief section | What runs in the PoC | Remaining gap or agreed choice |
| --- | --- | --- |
| Main demonstration, pp. 1 and 10 | Receive `KP-IN-40` in two confirmations, inspect a received carton, count Storage, create `KP-RECEIVED-40` from those identities, scan on the C72, approve, and dispatch. | Keep the agreed three products and 70 opening cartons. The brief's larger sample history remains a separate fixture target. |
| Workspace and user experience, p. 2 | One Node/SQLite workspace, dashboard and connected C72. Inbound, stock, counts, outbound, evidence, devices and reports use the current KeyPharm layout. | Device inventory and unified exception ownership/filtering are partial. The handheld supports live and simulated stock counts. The dashboard accepts imported EPC reads and handles review. |
| Roles, p. 2 | Operator captures reads, confirms receipts and transfers stock. Supervisor verifies pallets, reviews counts, holds and releases cartons. Administrator manages imports, tag mappings, sessions and reset. Reviewer reads records and can approve dispatch under the agreed demo role flow. Administrator or Supervisor dispatches. | The brief describes Viewer as read-only. Reviewer dispatch approval is a demo decision. Tenant administration and cross-tenant isolation remain unverified. |
| Data model and stock rules, p. 3 | EPC identifies one mapped carton. Location and physical reads are distinct. Receipt, transfer, hold, correction and dispatch are transactional. Movements retain actor, source, time, reason when required, and before/after values. | Inventory shows On hand and Dispatched per prior direction. The brief's reservation rules need a decision. The server still rejects repeat stock deductions. Batch, expiry, and multi-site reference data remain open. |
| Inbound receiving, p. 4 | Create a receipt through CSV preview in EPC or SKU mode. Register identities, compare unique reads, confirm known cartons, and preserve partial receipts and unknown EPC evidence. `KP-IN-40` covers 38+2. | Supplier/production origin, real mappings, cancellation policy, and linked receipt correction and variance cases need further validation. |
| Count workflow, p. 5 | Freeze location snapshot. Record independent runs, review discrepancies, and record a Supervisor-approved location correction with reason and before/after data. Stale snapshots reject review. | Native handheld count capture is connected. Failed uploads can be retried while the app remains open. Count scopes currently use the location. |
| Manifest and scanning, p. 6 | Existing independent CSV and revision checks, C72 pallet and carton flow, Hold on 39 expected plus one extra, clean rescan, approval and explicit dispatch. Imports and reopens preserve earlier evidence. | The 40-carton connected journey uses simulation. An isolated missing-carton run is labelled Incomplete and blocks dispatch. |
| Dashboard and operational reporting, p. 7 | Overview links to on-hand stock, open receipts and counts pending review. Inventory filters by location and opens carton history. Reports export stock, receipt, count, movements and pallet evidence. Devices shows actual C72 workspace contact when available. | Date-filtered trends, common filter parity across cards and exports, and a unified exception queue remain partial. C72 workspace contact represents sync traffic. |
| Data exchange and integration, p. 9 | Receipt template and preview, shipment CSV validation, EPC mapping, and CSV reports work locally. Reports show ERP/WMS as Not configured. | Production exchange contracts, product and inventory-reference imports, acknowledgements, and deployment await KeyPharm input. |

## Acceptance evidence

| Test | Local result |
| --- | --- |
| AT01 | Server role checks exercised. Cross-tenant isolation remains open for the single-workspace build. |
| AT02 | Existing sessions survive database reopen. Stock workflow records persist in SQLite and survive browser reload. |
| AT03–04 | Deduplication and read frequency verified. Unknown EPCs stay outside stock. Conflicting tag mappings and duplicate manifest EPCs are rejected. |
| AT05 | 38+2 completes one receipt. Replaying the same command preserves inventory counts. |
| AT06 | Count evidence stays independent. A stale snapshot cannot apply a correction. Reading fewer cartons leaves stock unchanged. |
| AT07–08 | The 39+1 Hold and exact 40 Match remain separate. Empty manifests and stale revisions are rejected. |
| AT09 | Approving verification leaves stock on hand. Dispatch deducts once. Reservation checks remain open. |
| AT10 | The outbound flow preserves offline evidence across restart and sync. Inbound and count simulations require a connected C72, with business confirmation on the dashboard. |
| AT11 | Receipt, stock, count, and outbound records share the same database and reset with the sample. Shared date and export filter parity remains open. |
| AT12 | The demo identifies simulated and imported reads and reports the ERP/WMS integration as unconfigured. Live C72 rehearsal is a separate check. |
| AT13–14 | Permissions, stale revisions, idempotent receipt commands, atomic batch dispatch and movement audit are tested. Concurrent field rollout remains a separate check. |
| AT15 | Automated test runs from 70 opening cartons through receipt and count of the same 40 EPCs, outbound Hold, Match, and dispatch back to 70 on hand. Browser test covers receipt, count, history and C72 handoff. |

## Local data exchange

- `GET /api/stock-workflows` provides receipts, count snapshots, locations and recent movements. `GET /api/carton-history?epc=…` returns the recorded movements for one carton.
- `POST /api/stock-action` uses the authenticated role, workspace generation, operation ID and record revision where applicable. CSV preview validates without changing stock. Scan actions store observations. Separate confirmation actions change stock.
- The dashboard supplies the receipt template and exports for stock, receipts, counts, movements and outbound evidence. Text fields are quoted and protected from spreadsheet formula interpretation. EPCs remain text.
