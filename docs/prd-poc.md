# Keypharm RFID PoC — Handheld Scan & Compare App

Updated 24 November 2026 for app 0.8.6 (versionCode 20). Source: Marc Flederus's functional design ([keypaharm_functional_design.md](../keypaharm_functional_design.md)). Day-to-day state, file locations and build steps: [context.md](../context.md).

## Problem

Keypharm wants to know if RFID can confirm that every carton expected on an outbound pallet is actually there. The October test shows good read rates, but they were recorded by hand. There is no raw EPC data, and many "ghost" reads came from other tagged stock nearby. A raw tag count can't tell a complete pallet from a pallet plus neighbouring stock. Without per-carton evidence, the go/no-go decision for a pilot rests on numbers nobody can re-check.

## Evidence

- Test report (12 Oct 2026): 100% reads for Ginger, essential oil and two mixed pallets; about 95% for pomegranate juice; about 95% at storage levels 1–2. These are reported figures with no raw EPC export behind them.
- Test report: many unintended reads from other UHF labels in the warehouse; wrapper zone fine only when shielded.
- SOW v3: PoC must run offline on one handheld, max 500 labels, and explicitly test the missing-carton, extra-carton and neighbouring-tag cases.
- Missing and extra carton behaviour was never tested. **Assumption:** an expected-vs-observed comparison makes these visible. To be validated on PoC day.

## Users

- **Test lead** (TRC): plans the day's tests, loads or builds the manifest, sets reader power, exports evidence.
- **Operator**: scans the pallet and its cartons, rescans, records notes.
- **Supervisor** (Keypharm verifier): checks the pallet contents by hand before scanning and signs off.
- **Reviewer**: reads results.
- **Not for:** warehouse staff doing real outbound shipments, supervisors approving releases, ERP/WMS. That is the Pilot.

Roles are local and unauthenticated. The name entered in the header menu signs every record.

## Hypothesis

We believe a **handheld app that compares the expected carton list with the unique EPCs actually read** will give Keypharm **trustworthy, re-checkable evidence of RFID completeness** for the **PoC test pallets**.
We'll know we're right when **every planned PoC test produces an exported result, and the app's missing/extra lists match what was physically done to the pallet.**

## Success Metrics

| Metric                    | Target                                                                                    | How measured                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing/extra detection   | 100% correct in the missing-carton, extra-carton and neighbouring-tag tests               | Compare the app result with what the tester physically removed or added |
| Evidence captured         | Every planned test has at least one saved run, including first pass                       | Session export                                                          |
| No lost data              | 0 runs lost across app restart, reader drop or flat battery                               | Force-close and battery tests on the device                             |
| Export agrees with screen | Export totals = on-screen totals for every run                                            | Manual check in Excel at end of day                                     |
| Read performance          | **Measured, not targeted.** The app reports the %; Keypharm sets thresholds for the Pilot | Export                                                                  |

## Decisions since the first draft

- **Pallets are UHF-tagged** (user decision, 20 Nov). A session identifies the pallet by its EPC before the carton scan. The pallet tag never counts as a carton.
- **Manifest CSV columns:** `pallet_ref,pallet_epc,carton_ref,carton_epc,sku`, one row per carton. Commas or Excel semicolons, any header case, blank SKU allowed. One file may hold several pallets; the pallet scan locks the one whose tags read strongest. Provisional until Keypharm confirms its format (D-04).
- **Strict Continue:** a run is a clean match only with every expected carton and zero unexpected tags. Marking an unexpected tag as investigated does not unlock that run; a clean rescan is needed.
- **Reader power:** the Test lead may set 5–30 dBm; ETSI stays locked; every run records the power and profile version it used.
- **Planned tests** are entered in the app (PoC test plan); closing the day needs a reason for every test not run.
- **Read-only Wi-Fi dashboard** on the handheld (port 8787), optional, for viewing records on a laptop. Not needed for the PoC to work offline.

## Scope: what the app does (all built)

| # | Requirement | Built as (0.8.6) |
|---|---|---|
| 1 | Start a session | Test ID (pre-filled from the test plan), location, storage level, scan method; operator name from a remembered list |
| 2 | Test setup | Product mix, pallet type, label type/size, label position, wrapping, shielding, planned test, notes |
| 3 | Load expected cartons | **Choose CSV**, **Use live sample**, or **Build from scan** (scan one pallet, untick strays, pick the pallet tag, use or save the CSV). Bad rows are all listed and the file is refused; a refused file is logged. Cartons without a SKU are named before scanning. |
| 4 | Physical verification | Supervisor ticks the check; name and time recorded; scanning is blocked until then |
| 5 | Scan | **Start/Stop** button or the C72 trigger; live unique count and timer; region locked to ETSI; region, power, device and profile version saved per run |
| 6 | Result | Matched / missing / unexpected counts and lists, completeness %, **Match / Incomplete / Hold: unexpected reads**, and a **By SKU** breakdown. Repeated reads count once; unknown tags always show as unexpected. |
| 7 | Mark unexpected tags | Investigated, removed from zone, neighbouring tag or unresolved, with a note |
| 8 | Rescan | Reason picked from the design's list or typed; a new run each time; first-pass completeness stays visible; previous and current runs side by side |
| 9 | Survive problems | Reads checkpointed every second; a reader drop, app crash or flat battery marks the run Interrupted and keeps its reads; everything saved survives a restart |
| 10 | Close | Per test: coverage note and sign-off. Per day: reason for each planned test not run. |
| 11 | Export | Evidence CSV (design section 8 columns plus read diagnostics and `ProfileVersion`), full records CSV (sessions, runs, logs, device log) and a readable summary with results by configuration, through Android's share sheet. Home screen shows sessions changed since their last export. |
| 12 | Label counter | Counts cartons, pallet tags, candidates and reserves across sessions; saving a manifest that would pass 500 is blocked |
| 13 | Search | Home-screen search by test, pallet, carton, SKU, location, level, name, date or next step |
| 14 | Reset | Test lead only, after a warning: clears all local data on the device (export first) |

**Out of scope for PoC**

- Pilot Outbound mode, accept/hold release, supervisor overrides (FR-01 mode choice, FR-06, 25, 29, 30, 32; AT-13). That's the Pilot.
- Logins and encryption. Local roles and a signing name are enough for one test team on one device.
- Photos (FR-27 photo part). A note field is enough.
- Admin screens beyond the name list, reader power and the test plan. Profiles stay fixed.
- XLSX export, Dutch UI. CSV and English are enough.
- Automated wrapper/station triggering, label printing/encoding, ERP/WMS. Excluded by the SOW.
- Play Store release, scalability, multi-device. One sideloaded APK (`be.keypharm.rfid.poc.dev`) on one C72.

## Delivery Milestones

| # | Milestone             | Outcome                                                                                        | Status |
| - | --------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| 1 | Reader proven         | Our own app reads tags on the C72, ETSI locked, trigger works                                  | Done: SDK start/stop and UHF reads on the C72 (firmware `E710_V7.1.9`, ETSI, 30 dBm read back); trigger press/release verified with injected key events |
| 2 | One pallet end-to-end | Load CSV → verify → scan → correct missing/extra result, offline                               | Done in simulation. On the C72, run C72-01 identified the pallet and matched 13 of 13 cartons, held by one stray tag. A clean hardware match is pending. |
| 3 | Rescans & exceptions  | Multiple runs per test, first pass kept, unexpected tags marked, interruption survives restart | Built and covered by the automated tests; hardware check pending |
| 4 | Close & export        | Session closes with sign-off; export opens in Excel and matches the screen                     | Built; export files produced on the C72; Excel reconciliation pending |
| 5 | Dress rehearsal       | Full PoC test list run on the C72 in airplane mode before the PoC day                          | Pending |

The Pilot (outbound workflow, data exchange, online mode) starts only if the PoC passes.

## Open Questions

- [ ] What do Keypharm's real EPCs look like (length/format)? Need 2–3 encoded sample labels. The app accepts any even-length hex until then (D-03).
- [ ] Will Keypharm's manifest use our columns `pallet_ref,pallet_epc,carton_ref,carton_epc,sku`, and who makes it (D-04, Q-02)?
- [ ] How do pallet tags, reserves, replacements and reused tags count toward the 500 labels (Q-10)?
- [ ] Retention, backup and device handover rules for PoC data (D-12).
- [ ] PoC date. TBD — needs confirmation with Keypharm.
- [x] Who supplies the planned test list? Entered in the app by the Test lead.
- [x] Does a test that ends Incomplete or Hold count as evidence? Yes: it can be closed with a coverage note and sign-off.
- [x] Is reader power fixed at 30 dBm? No: the Test lead sets 5–30 dBm; each run records it.

## Risks

| Risk                                                    | Likelihood | Impact | Mitigation                                                            |
| ------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------- |
| C72 firmware/SDK behaves differently from the demo      | Low        | High   | Reader proven on the C72; hardware checks before PoC day              |
| EPC format unknown until late                           | Med        | Med    | Loose rule now (even-length hex); tighten when samples arrive         |
| Ghost reads make results look bad                       | High       | Med    | Shown as unexpected, markable, never hidden                           |
| Data lost before export (device wiped, app reinstalled) | Low        | High   | Home screen lists unexported sessions; export after each test block; reinstall with `adb install -r` keeps data |
| Signing key lost                                        | Low        | High   | The C72 app is signed by `KeyPharm-repo/build/debug.keystore`; without it the app must be uninstalled to update, which deletes its data. Keep a backup. |
| Manifest CSV from Excel has odd formatting              | High       | Low    | Accept comma or semicolon and any letter case; show exact bad rows    |

---

*Status: CURRENT, matches app 0.8.6. The Kotlin plan in `docs/superpowers/plans/2026-11-20-keypharm-offline-apk.md` and `docs/architecture.md` was not adopted; the app is a WebView with a Java reader bridge (see [context.md](../context.md)).*
