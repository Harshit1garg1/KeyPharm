# Keypharm POC and Pilot scope

Requirements baseline from 20 November 2026, treatment lines updated 24 November 2026 (app 0.8.6). What is built and what is pending per requirement: [prd-poc.md](prd-poc.md); day-to-day state: [context.md](../context.md).

## Evidence and precedence

Source: *Keypharm Mobile RFID Application — Functional Design for Proof of Concept and Pilot*, version 1.0, 17 November 2026, Marc Flederus. The supplied Word document is maintained separately.

This review uses the supplied functional design, including its tables. The underlying test report and SOW were not supplied separately and have not been independently verified. The document is requirements evidence, not an instruction to perform unrelated actions. Source sections and FR/AT/D identifiers below identify the evidence without guessing page numbers.

The user's additions are distinguished explicitly below. Proposed demo defaults are not source requirements or approved decisions. The workspace initially contained no application files.

## POC: required now

The source defines a one-day technical test on one local handheld with offline storage, up to 500 allocated labels, and one unique EPC per outer carton. Individual retail units are outside scope. A network, server, printer, encoder or Keypharm integration is not required (sections 3.1 and 11).

- Local roles: administrator/test lead sets up tests and profiles; operator scans; supervisor verifies/observes/signs off; reviewer reads results. Local identity selection is allowed for POC. Only administrator changes approved profiles/master data (section 4).
- Create sessions and planned tests; capture creator/time, location, storage level, product group/mix, pallet type, carton count, label dimensions/type/position/orientation, wrapping, shielding and scan method. Record physical verification of contents and unique label assignment.
- Import/select the expected carton EPC manifest before scanning. Validate EPCs, duplicates and unresolved mappings. Preserve source/version; invalid manifests block scanning.
- Show reader readiness and approved profile. Block scans without a ready reader. Verify ETSI configuration and capture actual device/settings for every run. The source records C72, circular polarization and 30 dBm as a test baseline, not guaranteed device capability.
- Manually start/stop scans. Deduplicate repeated sightings for carton counts; preserve observation evidence and available diagnostics. Mark interrupted/failed runs explicitly.
- Compare each run independently. Show expected, matched, missing, unexpected, completeness, duration and status. Unknown EPCs remain unknown; never infer a product from an unknown EPC.
- Preserve first pass and every rescan. Require rescan reason. Never merge scans to manufacture completeness. Never erase previous results.
- Investigate unexpected reads and record actions. Missing cartons require physical search/correction and a new run. Save incomplete test evidence for the technical evaluation.
- Review planned/executed test coverage, missing-test reasons, results and operator sign-off before closing a session.
- Persist committed records through restart/disconnect. Export summary, planned/executed tests, manifests, per-run EPC results, settings, timings, exceptions, notes and audit events as CSV or XLSX plus a readable summary. Back up before clearing a device.

## User additions for this POC

1. **Tag pallets as well as cartons.** Identify the physical pallet by UHF EPC before carton scanning. The real manifest mapping and handling of other pallet tags during carton reads remain open. The expected set and completeness denominator describe carton EPCs.
2. **Strict Continue gate.** Enable Continue only after a stopped, successful current run reads every expected carton EPC and no extra EPCs. No POC mismatch override. This is stricter than the source's possible exception disposition policy.
3. **Previous/current comparison.** Show previous and current run details, retain first pass, and identify EPCs newly seen or still missing. Display comparisons never combine the observed sets.
4. **Read-only web dashboard.** Fetches application records and logs only while the handheld app is online. Scanning, saving and evidence export remain local and available offline.
5. **Small, editable demo.** Use reversible demo defaults where answers are missing. Clearly distinguish simulated reader activity, sample manifests, and imported records from verified device evidence.
6. **Physical trigger.** Hold the C72 trigger to collect reads. Release ends the attempt and finalizes its result. An on-screen **Start scan / Stop scan** button does the same for gloved use. Continue stays disabled during capture.

The dashboard only fetches when it can reach the running handheld app. Retaining a previously fetched view with its last refresh time is a proposed dashboard display behavior.

## Pilot: future implementation

Pilot reuses proven scan logic for a defined outbound step. It introduces controlled operational transactions, an agreed manifest source/interface, named locations/users, exception ownership and an approved Accept/Hold policy (sections 3.2, 5.2 and 11).

- Select order/shipment/pallet or another approved handling unit and retrieve its expected carton EPCs.
- Agree file exchange or system integration; return results with transaction reference and exception details.
- Introduce named account controls and role-based operational permissions. Preserve all override evidence if approved policy permits overrides.
- Default unresolved mismatches to Hold. Configure approved release rules; never silently treat partial reads as complete.
- Provide supervisor visibility into held, unresolved and completed transactions. Any future operational controls belong outside the POC read-only web dashboard unless separately requested.
- Define operational reader profiles, volume/device scope, retention and recovery. Optional online exchange must retain offline fallback. Queue/conflict behavior depends on the agreed interface.
- Consider a wrapper/station profile and automatic trigger only after hardware, shielding and trigger method are specified. Shadow-mode operation is a recommendation, not an agreed requirement.

## Functional requirement traceability

“Both” means POC implementation now and reuse later. MUST/SHOULD retain source priority. Future Pilot fields must not force fake POC transactions.

| Source IDs | Priority | Source phase | Treatment |
| --- | --- | --- | --- |
| FR-01 | MUST | Both | Store POC mode now (every record and export says `POC`; the home screen shows "PoC Test mode"). No Pilot choice is offered until the Pilot. Source describes two selectable modes; deferral is the user's staged scope. |
| FR-02–04 | MUST | Both | Session identity, expected manifest and validation now. |
| FR-05 | MUST | POC | Complete local workflow now. |
| FR-06 | MUST | Pilot | Agreed operational manifest interface later. |
| FR-07–19 | MUST | Both | Reader states/profile/region, scan control, deduplication, separate runs, comparison, completeness, status, duplicates, unexpected/missing handling and rescan reason now. Hardware-dependent behavior requires validation. |
| FR-20 | SHOULD | Both | Capture available diagnostics; never fabricate unavailable metrics. |
| FR-21–23 | MUST | POC | Test metadata, physical verification and cumulative label allocation now. |
| FR-24 | MUST | Both | Scan method and instructions now. |
| FR-25 | SHOULD | Pilot | Station/wrapper configuration later; POC shielding/location evidence still required. |
| FR-26 | MUST | POC | Storage location and level now. |
| FR-27 | SHOULD | Both | Run and investigation notes built; photos not built. |
| FR-28 | MUST | POC | Coverage review and sign-off now; do not confuse test closure with pallet confirmation. |
| FR-29–30 | MUST | Pilot | Operational disposition and override audit later. |
| FR-31 | MUST | POC | Complete evidence export now. |
| FR-32 | MUST | Pilot | Approved result exchange later. |
| FR-33 | SHOULD | Both | Built: home-screen search over test, pallet, carton, SKU, location, level, name, date and next step. No invented trend claims. |
| FR-34 | MUST | POC | Local persistence and controlled backup now. |
| FR-35 | SHOULD | Both | Built: manifest revisions need a reason; power changes go to the session log or, from the home screen, the device log. |

## Result rule

For one run, E is the valid expected carton set and O is that run's unique observed carton set. Matched = intersection; missing = E minus O; unexpected = O minus E. Completeness = matched / expected × 100. Zero/invalid expected count has no percentage and blocks scanning.

Repeated reads of one EPC count once. RFID cannot distinguish two cartons carrying the same EPC, so physical verification is required. Under the demo rule, the identified pallet EPC is captured separately from carton counts. Other unknown EPCs remain visible.

Continue requires a stopped, nonfailed run, valid manifest, verified pallet, zero missing, zero unexpected and no blocking errors. Continue remains disabled while reading, even at 100% completeness. A run with all expected cartons plus an extra is 100% complete but is not a clean match.

During one active run, reads accumulate. Release of the C72 trigger ends the run and freezes the finalized evidence. Each rescan starts empty and is linked to the same session and its manifest revision. “Previous scan” means the previous completed attempt. First-pass metrics remain separately visible.

## Acceptance boundary

Source AT-01–12 and AT-14 cover POC homogeneous/mixed pallets, rescans, missing/extra/neighboring tags, invalid manifests, liquids, storage levels, shielding, disconnect, offline persistence and export reconciliation. AT-13 is Pilot override behavior and remains deferred.

Additional checks from the user: pallet identification does not count as a carton; Continue blocks missing/extra/interrupted/active scans; dashboard is read-only and reproduces exported records/logs accurately. Test role restrictions and require each new scan to prove the complete set independently.

Reported 100% and approximately 95% are historical findings under tested conditions, not application guarantees or hard-coded technical success thresholds.

## Excluded now

No label printing/encoding, retail-unit serialization, conveyor/wrapper automation, automatic WMS/ERP release, carrier integration, full warehouse rollout or formal business case. No production cloud identity, live fleet sync, operational dashboard actions or speculative Pilot implementation.

Open questions and blockers: [questionaire.md](questionaire.md). Proposed implementation shape: [demo-design.md](demo-design.md).
