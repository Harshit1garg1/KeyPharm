# POC demo design for review

> **Design record from 20 November 2026.** The app shipped close to this design, with three changes: pallets are UHF-tagged, an on-screen Start/Stop button joins the trigger, and the KeyPharm brand colours replace the tokens below. Current behaviour: [README](../README.md) and [context.md](../context.md).

Approved for POC implementation on 20 November 2026. See the README for the implemented workflow and current verification status.

## Intended outcome

Demonstrate the final workflow's look and feel while producing honest, independent scan evidence. Build only the POC. Keep Pilot requirements documented separately. The source and user additions are mapped in [poc-and-pilot-scope.md](poc-and-pilot-scope.md); unanswered decisions are in [questionaire.md](questionaire.md).

## Approaches

1. **Recommended: local Android handheld application plus read-only web dashboard.** Android uses the Chainway SDK for UHF capture. Local persistence supports offline sessions. The dashboard fetches committed records while the handheld app is online.
2. **Browser-only interaction demo.** Fastest way to review screens and rules, but real C72 RFID cannot be claimed without a verified bridge. Use this only as a clearly labelled simulation if SDK access delays device work.

The handheld hosts a small read endpoint on a trusted demo network. Sharing defaults to committed sample simulation records and logs while the app is running and reachable. The Test lead can explicitly include all committed records, subject to the access and retention choices in Q-12. Local CSV and readable summary exports remain available offline.

## Small implementation boundary

- Handheld: local role identity, test setup, manifest selection/import, physical verification, pallet identification, reader setup, scan/review/rescan, test closure, history and evidence export.
- Dashboard: fetch records while the handheld app is online, list/search sessions, open run detail and read logs. Proposed offline display shows the last fetched data and its refresh time. All dashboard actions are read-only.
- Separate real reader capture from simulated capture at one narrow input boundary. Both use the same comparison rules. Keep manifest mapping separate from those rules because the format is unconfirmed.
- Keep role permissions in one explicit table. Keep record shapes and comparison logic small. Avoid plugin systems, generic workflow engines, microservices and future Pilot scaffolding.
- Save session, planned tests, pallet identity, versioned manifest, immutable runs/observations, exception events, profile snapshots, label allocation and audit events. Corrections link forward; they never overwrite saved run evidence.
- Local identities are a POC role demonstration, not production authentication. Enforce permissions in application actions as well as visible controls. Shared credentials, default passwords and fake secure-login claims add no value.

## Handheld sequence

1. Select local identity and show its role. Reviewer has read access only. Supervisor can verify/sign off but cannot override a failed carton check.
2. Create/open session and planned test. Administrator imports/selects a sample or real manifest. Show its origin and any provisional validation rules.
3. Show row-level problems and mapping gaps before allowing a scan. Record physical verifier, time and label assignment confirmation. Track cumulative label allocation.
4. Confirm approved reader/profile and scan method before any RFID capture, including pallet identification. Real scanning requires real readiness; simulation is visibly labelled throughout.
5. Identify the pallet using its mapped tag. Retain the identity confirmation separately from carton observations. Block unknown or ambiguous pallet identity.
6. Hold the physical trigger to collect. Show Reading, elapsed time, matched/expected, missing and extra counts. Keep Continue disabled. Duplicate sightings do not inflate counts.
7. Release the trigger to end capture and freeze the result. Show first-pass, previous and current results with missing and unexpected EPCs. Continue enables only for a clean completed run. Record interruptions as failed evidence.
8. Choose a reason and start a new run to rescan. Previous evidence stays visible. The new run must read the complete expected set itself.
9. Continue confirms the clean test result. Save evidence is independently available for failures. Session closure reviews coverage, missing-test reasons, results and sign-off; it is not an outbound shipment release.
10. Export local evidence and a readable summary. The dashboard fetches committed records and logs only while the running handheld app is reachable.

## Example to verify scan semantics

Expected cartons are A, B and C. First pass sees A, B and unexpected X. C is missing and Continue is disabled. Rescan sees B and C. A is missing and Continue stays disabled. A third run sees all three and zero extras. Release the trigger to enable Continue. First-pass completeness remains 2/3 and retains evidence of X.

These letters explain set behavior only; they are not valid sample EPC values or an encoding proposal.

## Layout direction

Warehouse staff scan with the physical trigger, often while wearing gloves. Use a compact status header, pallet/test reference, hold/release guidance, four count labels, EPC differences and previous/current comparison. Place Continue within easy reach. Secondary metadata expands on demand. Use text labels for reader and result states.

Dashboard: a records table with search/filter controls, session detail, run sequence and log view. At handheld widths, present the same record information in a readable vertical list. Avoid marketing sections, decorative metrics and invented performance claims.

Proposed tokens: paper `#FFFFFF`, workspace `#EEF2F5`, ink `#182B3A`, action `#155A78`, match `#236743`, attention `#A33A28`. Use platform sans-serif on Android and a system sans-serif on web. All colors/fonts use named tokens. Keep controls at least 48 logical pixels, visible keyboard focus and responsive text. No decorative motion is needed.

The demo uses the scan panel and previous/current comparison on the handheld. The dashboard shows a searchable session list, evidence detail and logs.

## Build and verification order

1. Confirm device facts, SDK path, manifest substitute and pallet rules. Record answers in the questionnaire.
2. Add local role identities and session/test setup. Verify restricted actions cannot be called through another role.
3. Add validated sample manifest, pallet identification and pure per-run comparison. Test duplicates, malformed/empty manifests, missing/extra tags, independent rescans and strict Continue behavior.
4. Integrate the available SDK candidate and a labelled simulator. Verify that the C72 starts on trigger press, stops on release, ignores repeated key events while held, and preserves an interrupted run if capture loses the reader.
5. Add persistence, closure/sign-off and complete export. Verify restart recovery and reconcile exported counts/evidence with the handheld.
6. Add the read-only dashboard. Verify it fetches committed records and logs when the app is reachable, stops receiving updates when the app goes offline, and refreshes on reconnect. Compare fetched values with the source record and local export.

## Limits before real POC acceptance

USB testing on the C72 EEA with Android 13 verified initialization, SDK inventory start/stop, UHF observations and readback of ETSI/30 dBm. Antenna polarization was unavailable from the tested SDK path. Physical trigger press/release and matching a known set of pallet/carton tags still need hands-on verification. Manifest format and treatment of pallet labels and reserves in the label cap remain open.

The POC uses the provisional CSV contract and counts allocations by category. The installed demo workflow and dashboard endpoint were tested using simulated session records.
