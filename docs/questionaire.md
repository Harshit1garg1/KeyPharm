# POC questionnaire

Updated 24 November 2026 (app 0.8.6). “Special” identifies a dependency for the named validation step. Demo work can use the documented substitutes.

## Answers already supplied

- USB debugging verified with ADB. The handset reports model `C72`, product `C72_EEA`, Android 13, build `C72.AD13.EEA.20250304.V1.12`.
- No real manifest is available yet.
- The earlier wireless attempt returned Windows socket permission error `10013`. USB provides device access; wireless ADB also works since 24 November 2026.
- Pallets and outer cartons both require tags. Identify the pallet before checking its cartons.
- Continue stays disabled until the current scan contains all expected carton EPCs and no extra carton EPCs.
- Previous and current scans must remain visible. Rescans must not combine their EPC sets.
- The read-only dashboard fetches application records and logs only while the handheld app is online.
- This stage is a small, editable POC. Pilot implementation comes later.

## Special questions: real-device or acceptance blockers

### Q-01 — C72 integration — SPECIAL: blocks verified RFID capture

**Partly resolved.** USB and SDK initialization are verified. 24 Nov: trigger press/repeat/release verified with injected key events; an on-screen Start/Stop button does the same; a live run read 13 of 13 cartons; every run stores reader profile version `C72-ETSI-1`. Antenna polarization is not exposed by the SDK and is recorded as "Not reported". The installed app used `DeviceAPI_ver20251103_release.aar`, read back module firmware `E710_V7.1.9`, ETSI and 30 dBm, and received UHF observations during a controlled SDK start/stop. Verify physical trigger events, known pallet/carton matching and antenna polarization at the test site.

Source: specification D-01/D-02, FR-07–09 and section 13. Owner: reader supplier / TRC.

Demo substitute: a clearly labelled simulated reader with missing, extra, duplicate and disconnect scenarios. Never present simulated data as hardware evidence. Device access can resolve some details; it does not establish SDK compatibility by itself.

### Q-02 — Manifest contract — SPECIAL: blocks production-compatible import

**Open for query.** Can Keypharm provide a real example and confirm file type, headers, delimiter, encoding, EPC encoding/length, pallet identity field, carton/SKU mapping and expected count? How are revisions supplied?

Source: D-03/D-04, FR-03/04/16. Owner: Keypharm IT / label supplier.

Demo substitute: a documented sample CSV with one row per carton and explicit pallet reference and pallet EPC. This is an application import proposal, not a known C72 file format. Retain row errors, duplicates and revision history. Replace the mapping after approval.

### Q-03 — Pallet identity — SPECIAL: blocks verified pallet identification

**Resolved for the PoC (0.7, 23 Nov).** Pallet identity uses UHF EPC only. One CSV may list several pallets; the pallet scan locks the one whose tags read with the strongest signal, then the one with more tags read, and logs the lock with its RSSI. Tags of the other pallets show as **Belongs to pallet X**. The real mapping to carton EPCs still belongs to Q-02.

Source: user addition; specification section 8 has a pallet reference but specifies EPC identity for cartons.

Demo substitute: one unique pallet EPC per sample manifest. Use a separate identification step. Do not count that EPC as a carton. Block ambiguous identification. Retain other unknown EPCs visibly; do not invent automatic identification of environmental tags.

### Q-04 — Preserving failed tests — accepted for POC

May an operator finish documenting an unsuccessful POC test while Continue remains disabled for pallet confirmation? Who signs off test coverage and physical carton verification?

Source: FR-22/28/31 and user strict Continue rule.

Accepted behavior: Save evidence remains available for incomplete, extra-tag or interrupted runs. Continue confirms only a stopped clean match. Session closure records reviewed failures and missing-test reasons. Use the local POC roles for verification and sign-off. Specific staff assignments can be filled in at test time.

## Questions with reversible demo defaults

| ID | Question and owner | Answer and demo behavior | Basis |
| --- | --- | --- | --- |
| Q-05 | Which local users and roles should appear? Keypharm test lead. | Named local administrator, operator, supervisor and reviewer. Lightweight offline identity selection, clearly not secure production login. Supervisor observes/signs off in POC; no mismatch override. | Section 4; user asks to start with role-based accounts. |
| Q-06 | How will handheld records reach the dashboard? Keypharm IT. | Confirmed: fetch only while the handheld app is online. Local capture and evidence export remain available offline. Endpoint and hosting are implementation details. | User answer; FR-05/31/34. |
| Q-07 | Should an unexpected tag always require a clean rescan, including investigated neighboring tags? Test lead. | Strict rule: any unexpected EPC in a saved run blocks Continue. Investigation adds an event; it never erases evidence or unlocks that run. | User strict rule; FR-17 and section 9. |
| Q-08 | What starts and ends a scan? Test lead / supplier. | Confirmed: hold the physical C72 trigger to scan and release it to end the run, or tap **Start scan** / **Stop scan** (glove-friendly, added 23 Nov). Continue stays disabled during capture. Each retry starts empty and requires a rescan reason (pick from the design's five or type one, 0.8.6). Verify physical events on the device. | User answer; FR-10/12/19/24. |
| Q-09 | Which test matrix, products, locations, storage levels, label positions and shielding conditions are required? Keypharm Operations / TRC. | Editable local test metadata and planned tests. Include missing/extra/neighboring tags, homogeneous/mixed pallets, liquids, storage levels and shielding evidence without claiming guaranteed read rates. | FR-21/24/26/28; AT-01–10. |
| Q-10 | Do pallet tags consume the same 500-label allocation? How are reserves, replacements and reused tags counted? Test lead. | Open for query. Proposed demo accounting tracks cartons, pallets, candidate labels and reserves separately and applies a cumulative 500-label limit. | FR-23 plus user pallet tags. |
| Q-11 | What ETSI settings/profile are approved for this exact reader and location? Reader supplier / test lead. | Show documented 30 dBm/circular baseline as unverified until checked. Do not apply guessed RF parameters or treat recorded baseline as regulatory authorization. | FR-08/09; section 9.1. |
| Q-12 | Required export format, retention, backup, device handover, and dashboard access/privacy? Keypharm IT / Quality. | Local CSV evidence plus readable summary; preserve immutable runs and explicit manual backup. Use synthetic data until retention and dashboard access are agreed. | FR-31/34; D-12. |
| Q-13 | English only, or English and Dutch? Are photos needed for this POC? Keypharm test lead. | English interface and notes first. Photos and Dutch remain optional, not mandatory POC commitments. 24 Nov: neither is built; reopen if Keypharm asks. | Section 13; FR-27 SHOULD. |

The user accepted the proposed POC behavior for Q-04, Q-05, Q-07, Q-09, Q-11, Q-12 and Q-13 on 20 November 2026. Q-11 acceptance covers displaying the baseline pending RF verification. Q-12 acceptance covers the demo export and backup approach.

## Changes recorded 24 November 2026

- Reader power (Q-11): the Test lead may set 5–30 dBm from the home screen or a hardware session; ETSI stays read-only. Home-screen changes go to a device log, session changes to that session's log, and every run records the power used.
- Q-12: dashboard sharing now includes all committed records by default; the Test lead can limit it to samples. The home screen lists sessions changed since their last export. Retention and access rules remain open.
- Q-07 stays strict. A held run is labelled **Hold: unexpected reads**.
- Still open: Q-02 (manifest contract and EPC format), Q-10 (label accounting), Q-12 retention, PoC date.

## Pilot questions: deferred, not POC blockers

- D-05/D-06: outbound object, manifest owner and approved file/API/WMS/ERP exchange.
- D-07/D-08: wrapper hardware/trigger, shielding design and distance to neighboring stock. Shielding observations still belong in POC tests.
- D-09/D-10: operational release policy, exception owner, supervisor authority and override evidence.
- D-11/D-12: pilot critical packaging sample, retention, backup, handover and support.
- Pilot scale, devices, named account security, optional offline queue and conflict handling.

## How to maintain this file

Append questions when discovered. Record answer, owner, date and changed behavior. Preserve previous decisions when requirements change. Mark a question resolved only after an answer or verified evidence exists.
