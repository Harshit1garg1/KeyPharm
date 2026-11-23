# Keypharm RFID PoC — Handheld Scan & Compare App

## Problem

Keypharm wants to know if RFID can confirm that every carton expected on an outbound pallet is actually there. The October test shows good read rates, but they were recorded by hand. There is no raw EPC data, and many "ghost" reads came from other tagged stock nearby. A raw tag count can't tell a complete pallet from a pallet plus neighbouring stock. Without per-carton evidence, the go/no-go decision for a pilot rests on numbers nobody can re-check.

## Evidence

- Test report (12 Oct 2026): 100% reads for Ginger, essential oil and two mixed pallets; about 95% for pomegranate juice; about 95% at storage levels 1–2. These are reported figures with no raw EPC export behind them.
- Test report: many unintended reads from other UHF labels in the warehouse; wrapper zone fine only when shielded.
- SOW v3: PoC must run offline on one handheld, max 500 labels, and explicitly test the missing-carton, extra-carton and neighbouring-tag cases.
- Missing and extra carton behaviour was never tested. **Assumption:** an expected-vs-observed comparison makes these visible. To be validated on PoC day.

## Users

- **Primary: TRC test lead / operator** walks around a test pallet with the Chainway C72, runs a scan, sees what's missing or extra, rescans, and exports the evidence at the end of the day.
- **Secondary: Keypharm verifier** confirms the physical pallet contents before the scan and signs off the session.
- **Not for:** warehouse staff doing real outbound shipments, supervisors approving releases, ERP/WMS. That is the Pilot.

## Hypothesis

We believe a **handheld app that compares the expected carton list with the unique EPCs actually read** will give Keypharm **trustworthy, re-checkable evidence of RFID completeness** for the **PoC test pallets**.
We'll know we're right when **every planned PoC test produces an exported result, and the app's missing/extra lists match what was physically done to the pallet.**

## Success Metrics

| Metric                    | Target                                                                                          | How measured                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing/extra detection   | 100% correct in the missing-carton, extra-carton and neighbouring-tag tests                     | Compare the app result with what the tester physically removed or added |
| Evidence captured         | Every planned test has at least one saved run, including first pass                             | Session export                                                          |
| No lost data              | 0 runs lost across app restart, reader drop or flat battery                                     | Force-close and battery tests on the device                             |
| Export agrees with screen | Export totals = on-screen totals for every run                                                  | Manual check in Excel at end of day                                     |
| Read performance          | **Measured, not targeted.** The app reports the %; Keypharm sets thresholds for the Pilot | Export                                                                  |

## Scope

**PoC principle:** it just has to work, on one C72, for one test day, offline. No security hardening, no scalability, no production polish.

**MVP: the app must let the tester:**

1. **Start a session.** Name, location, operator picked from a short list.
2. **Add a test to the session.** Typed pallet reference (pallets are not tagged), product, label type and position, storage level (ground / L1 / L2), wrapper/shielding note, scan method.
3. **Load the expected cartons from a CSV file** on the device, one pallet per file. The app refuses the file and shows the bad rows if an EPC is malformed or duplicated.
4. **Confirm physical verification:** verifier name plus a tick before scanning is allowed.
5. **Scan.** Big Start/Stop button and the trigger key, with a live count of **unique** cartons and a timer. The reader is fixed to ETSI; the actual settings used are saved with the run.
6. **See the result:** matched / missing / unexpected counts and lists, completeness %, and **Match / Incomplete / Hold**. Repeated reads of one tag count once; unknown tags are always shown as unexpected.
7. **Mark unexpected tags.** Investigated, removed from zone, neighbouring tag, or unresolved, with a short note.
8. **Rescan.** Pick a reason, and the rescan becomes a new run. The first-pass result is never overwritten, and first pass and final run are shown side by side.
9. **Survive problems.** If the reader drops or the app or battery dies mid-scan, the run is marked interrupted and its reads are kept. Everything saved survives a restart.
10. **Close the session.** Notes and a sign-off name. Open tests are marked skipped with a reason.
11. **Export the session** to a file on the device, ready to copy to a PC: CSV evidence (the spec's recommended columns) plus a short readable summary.
12. **Label counter.** Warns when the PoC passes 500 labels.

**Out of scope for PoC**

- Web app / online mode / sync. That's the next step, once the APK is online. The PoC only keeps IDs and file formats stable so it can be added later.
- Pilot Outbound mode, accept/hold release, supervisor overrides (FR-06, 25, 29, 30, 32; AT-13). That's the Pilot.
- Logins, roles, permissions, encryption, audit of settings changes. Not needed for one test team on one device.
- Photos (FR-27 photo part). A note field is enough.
- Admin screens beyond an operator list and a power setting. Profiles stay fixed.
- XLSX export, Dutch UI, advanced search/filters, KPI dashboards. CSV, English and a simple session list are enough.
- Automated wrapper/station triggering, label printing/encoding, ERP/WMS. Excluded by the SOW.
- Play Store release, scalability, multi-device. One sideloaded APK on one C72.

## Delivery Milestones

| # | Milestone             | Outcome                                                                                        | Status  | Plan |
| - | --------------------- | ---------------------------------------------------------------------------------------------- | ------- | ---- |
| 1 | Reader proven         | Our own app reads tags on the C72, ETSI locked, trigger works                                  | pending | —   |
| 2 | One pallet end-to-end | Load CSV → verify → scan → correct missing/extra result, offline                            | pending | —   |
| 3 | Rescans & exceptions  | Multiple runs per test, first pass kept, unexpected tags marked, interruption survives restart | pending | —   |
| 4 | Close & export        | Session closes with sign-off; export opens in Excel and matches the screen                     | pending | —   |
| 5 | Dress rehearsal       | Full PoC test list run on the C72 in airplane mode before the PoC day                          | pending | —   |

The Pilot (web middleware, online mode, outbound workflow) starts only if the PoC passes.

## Open Questions

- [ ] What do Keypharm's real EPCs look like (length/format)? Need 2–3 encoded sample labels. Blocks the CSV check rule.
- [ ] Who makes the manifest CSV, and will they use our columns: `pallet_ref, epc, carton_ref, sku, description`?
- [ ] Who supplies the planned test list for the day, and is it entered in the app or kept on paper?
- [ ] Does a test that ends Incomplete or Hold still count as valid PoC evidence once reviewed? (Assumed yes.)
- [ ] Is reader power fixed at 30 dBm, or may testers change it?
- [ ] PoC date. TBD — needs confirmation with Keypharm.

## Risks

| Risk                                                    | Likelihood | Impact | Mitigation                                                            |
| ------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------- |
| C72 firmware/SDK behaves differently from the demo      | Med        | High   | Milestone 1 first, on the real device                                 |
| EPC format unknown until late                           | Med        | Med    | Loose rule now (hex, sensible length); tighten when samples arrive    |
| Ghost reads make results look bad                       | High       | Med    | Show them as "unexpected", let the tester mark them; never hide them  |
| Data lost before export (device wiped, app reinstalled) | Low        | High   | Export after each test block; reinstall keeps data unless uninstalled |
| Manifest CSV from Excel has odd formatting              | High       | Low    | Accept comma or semicolon and any letter case; show exact bad rows    |

---

*Status: DRAFT. Requirements only. Implementation plan exists (`docs/superpowers/plans/2026-11-20-keypharm-offline-apk.md`) but is heavier than this PRD and will be trimmed to match it.*
