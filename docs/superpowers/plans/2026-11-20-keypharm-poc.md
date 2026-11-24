# Keypharm POC Implementation Plan

> **Adopted plan, historical (20 November 2026).** The app was built along this plan. Current state: [context.md](../../../context.md).

**Goal:** Run the offline pallet and carton workflow on the C72 and view its committed records and logs in a browser while the app is online.

**Architecture:** Package the handheld screens as local WebView assets. Keep comparison, manifest mapping and record transitions in JavaScript. Use a small native bridge for the Chainway SDK, physical trigger, Android exports and a read-only LAN endpoint. The browser dashboard uses the same endpoint origin.

**Spec:** [Approved demo design](../../demo-design.md).

- [x] Test CSV validation, isolated scan attempts, strict Continue, role controls, label cap, failed-session closure and export encoding. Implement the local model in `app/src/main/assets/model.mjs`.
- [x] Build session setup, verification, physical trigger capture, review, closure and history in `handheld.html` and `handheld.mjs`. Package the sample manifest and label simulation.
- [x] Implement the SDK adapter with serialized start/stop and an approved-region check. Verify initialization, start/stop, RF readback and UHF observations on the C72.
- [x] Serve committed snapshots and a static read-only dashboard while sharing is enabled. Verify snapshot retrieval, write rejection, loss of connection and reconnect. Reconcile the demo evidence files generated on the installed C72.
- [x] Build the APK, install it on the connected C72, and verify the handheld and browser layouts.
- [ ] Hands-on acceptance with physical trigger and known pallet/carton tags.
