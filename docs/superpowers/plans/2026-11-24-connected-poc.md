# Local connected PoC

Build on the C72 application and dark dashboard. Use a single local Node server with SQLite. Keep the C72 barcode/RFID logic and offline records. Run the demo before reviewing any Git or TransIP publication.

1. Seed 70 cartons with product-specific SKU names. Use the optional local hardware CSV, preserving its pallet tag separately. Check unique EPCs and inventory totals.
2. Add named demo roles, session creation/import, physical verification, reservation, and explicit dispatch. Enforce stock transitions and immutable completed evidence on the server. Test duplicate dispatch, Hold, and stale revisions.
3. Connect the dashboard and C72 to that data. Cache tasks, queue work offline and retain conflicts for review. Simplify the handheld manifest picker. Check handoff, outage, reconnect, and persistence.
4. Build a signed APK and rehearse the role flow. Distinguish C72 live scans from the simulator and document any physical checks pending.

The first presentation slice covers the agreed outbound flow. The brief's receiving, count reconciliation, ERP/WMS, and production hosting are follow-on work. The demo uses individual accounts and one isolated workspace. Only a Supervisor can confirm dispatch. Packing reserves stock; confirmed dispatch deducts it once.
