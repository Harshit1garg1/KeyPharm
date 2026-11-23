**THE RFID COMPANY**

Keypharm Mobile RFID Application

Functional Design for Proof of Concept and Pilot

A detailed description of the handheld workflow, EPC comparison, exception handling and operational records required to support RFID outbound completeness.

| **Document control** | **Value** |
| --- | --- |
| Client | Keypharm NV |
| Document type | Functional design |
| Version | 1.0 |
| Date | 17 November 2026 |
| Author | Marc Flederus |
| Source basis | Keypharm RFID test report and Phase 1 SOW, version 3 |

|  |
| --- |
| **Purpose**  This document defines what the mobile RFID application must do to run the Keypharm PoC and to carry the proven workflow into a controlled pilot. It turns the recorded test results into software behavior, data rules and acceptance checks. |

## Document map

| **Section** | **Contents** |
| --- | --- |
| 1–3 | Purpose, source evidence, boundaries and proposed solution |
| 4–6 | Users, process flows and screen behavior |
| 7–10 | Functional requirements, data model, reader behavior and result logic |
| 11–14 | Pilot configuration, reporting, quality requirements and acceptance scenarios |
| 15–16 | Assumptions, decisions and glossary |

# 1 Executive summary

Keypharm needs a handheld application that can compare the cartons expected on a pallet with the unique UHF EPCs actually read during a controlled scan. The application must preserve a separate record for each scan run, show missing and unexpected EPCs immediately, and support a deliberate rescan without hiding the first result.

The PoC should run locally on the mobile reader with no network, server, printer or Keypharm-system connection. Before a session, the operator loads or selects a test manifest containing the expected EPCs. During the scan, the app collects reads, removes repeated sightings of the same EPC from the carton count, and compares the unique observed EPC set to the expected set.

The test report indicates strong read performance for the tested cartons and pallet builds: 100% was recorded for Biotona Ginger, essential oil and two mixed pallets; pomegranate juice was reported at about 95%. Reads at the pallet wrapper were described as excellent when the reading location was shielded. The test also recorded many unintended reads from other UHF labels in the warehouse. The app therefore needs explicit expected-list comparison and visibility of out-of-pallet reads; a raw tag count alone is not sufficient.

|  |
| --- |
| **Functional direction**  Build one core workflow with two operating profiles: PoC for test sessions and evidence capture, and Pilot for controlled outbound transactions. Keep the same scan and comparison logic in both profiles. The Pilot may add WMS or ERP exchange after the interface and operating policy are agreed. |

## Intended outcomes

* Confirm whether all expected unique carton EPCs are read using a documented scan method.
* Identify missing, unexpected, duplicate, invalid or potentially neighboring EPCs before a pallet is accepted.
* Record first-pass and rescan outcomes independently so retesting does not overstate initial performance.
* Provide a traceable record of each test or outbound check, including reader setup, product mix, location and operator.
* Use observed read performance to improve the next test of pomegranate juice, higher pallet levels and the shielded wrapper zone.

# 2 Evidence and design implications

The design below uses the test report and the Phase 1 SOW as its evidence base. Reported figures are treated as findings for the tested conditions, not as guaranteed performance. Requirements that extend beyond those tests are identified as pilot design provisions or decisions for confirmation.

| **Evidence in the test report or SOW** | **Application implication** |
| --- | --- |
| Chainway C72; ETSI; circular polarization; 30 dBm recorded. | Provide a validated reader profile and capture device and RF configuration for every run. Apply only region-compliant settings. |
| White paper RFID label, 90 × 30 mm; long carton side, upper right. | Capture label type and placement for each test configuration. Do not assume every future SKU uses this label. |
| Single-item scan times around 17 seconds; one walk around the pallet reportedly read all articles. | Support a clear manual start/stop scan and record scan duration. Show a consistent scan instruction. |
| 100% reported for tested Ginger, essential oil and mixed pallet cases; about 95% for pomegranate juice. | Calculate completeness from expected and unique observed EPCs per run; show first-pass and final result. |
| Wrapper read area needed shielding; performance described as excellent once shielded. | Allow a named location / reader profile and log shielding status. Revalidate the actual station implementation. |
| Many ghost reads from other UHF labels in the warehouse; spectrum analyzer found no external interference source. | Distinguish reader-visible EPCs from expected EPCs. Classify non-manifest reads as unexpected or environmental; retain them for analysis. |
| Ground-floor inventory was 100%; levels 1 and 2 about 95%. | Support location and level metadata and separate result reporting by location. |
| Test workbook did not contain raw EPC exports or explicit outcomes for missing / extra carton tests. | Make raw and interpreted scan evidence first-class data; include explicit exception scenarios in PoC acceptance. |

|  |
| --- |
| **Evidence gap to close**  The recorded report cannot independently verify every EPC, the exact label consumption, or the application behavior for missing and extra cartons. The PoC app must capture those details so the pilot decision rests on repeatable evidence. |

# 3 Scope and solution boundary

## 3.1 PoC scope

* One mobile UHF reader with a local handheld application and offline storage.
* Up to 500 uniquely encoded labels across candidate labels, test cartons and reserves, as specified in the SOW.
* Carton-level identity: one unique EPC per outer carton. Individual retail units are not identified in this phase.
* Expected pallet content is entered or imported before scanning and physically checked by Keypharm staff.
* Test homogeneous, mixed and difficult product mixes; compare label positions and scan methods where time allows.
* Explicit tests for an expected carton that is absent, a carton that is not on the manifest, and nearby tags outside the pallet.
* No network, server, printer, encoder or Keypharm system integration is required for the one-day PoC.

## 3.2 Pilot scope

The pilot uses the same carton EPC comparison but applies it to a defined outbound step, such as checking a staged pallet before it is released for loading. The pilot must have named operational locations, users, manifest source, exception owner and release rule. It should support offline operation as a fallback, even if an approved order or shipment interface is added.

* Create or receive an outbound transaction, select the pallet or shipment, retrieve the expected carton EPCs, scan, resolve exceptions and record an accept / hold decision.
* Exchange expected manifests and completed results through an agreed file format or approved system interface. The interface is a pilot decision; it is not assumed to exist.
* Use configurable pilot thresholds and release rules. The app must not silently treat a partial read as a complete shipment.
* Provide supervisor visibility of held transactions, unresolved exceptions and completed checks.

## 3.3 Excluded unless separately approved

Label printing or encoding, item-level serialization, automated control of a conveyor or wrapper, automatic shipment release into ERP/WMS, carrier integration, a full warehouse rollout, and a formal business case are outside the Phase 1 PoC. A wrapper-station workflow may be configured only after the reader hardware, shielding and trigger method have been specified.

# 4 Users and permissions

| **Role** | **Main responsibilities** | **PoC** | **Pilot** |
| --- | --- | --- | --- |
| RFID test lead / administrator | Set up sessions, import manifests, manage test profiles, control reader settings, review data and export evidence. | Full test setup | Configure profiles and users |
| Operator | Select a test or shipment, scan the pallet, review exceptions, rescan and submit the outcome. | Run tests | Run outbound checks |
| Keypharm supervisor | Confirm physical pallet contents, resolve or approve exceptions, place transactions on hold or accept them under policy. | Observe / sign off | Resolve and release |
| Read-only reviewer | Review session results, trends and audit history; cannot change submitted scans. | Read results | Review transactions |

For the one-day PoC, role separation may be lightweight and users may be selected from a local list. For a pilot, named user accounts and role-based permissions are recommended. Any override must record who performed it, when, why and which result was overridden.

## Permission principles

* Only an administrator can change approved RF profiles or master data.
* An operator may start, stop and rescan, but cannot erase a previous scan run.
* A submitted or accepted transaction is read-only; correction uses a linked follow-up action.
* A supervisor may approve a defined exception only when the pilot operating policy permits it.

# 5 End-to-end process flows

## 5.1 PoC test-session flow

| **Step** | **Operator action** | **Application behavior / record** |
| --- | --- | --- |
| 1. Prepare | Create a session; enter test ID, location, product mix, label type and intended scan method. | Assign a unique session ID and retain who created it and when. |
| 2. Load expected set | Import or select the expected EPC list for the pallet; optionally associate SKU and carton reference. | Validate format, unique EPCs and expected carton count. Show errors before scanning. |
| 3. Physical check | Keypharm confirms the cartons and pallet contents; verify labels are attached. | Prompt for confirmation and record verifier, time, label position and any notes. |
| 4. Configure reader | Select the approved profile; confirm region, reader and scan mode. | Display device and profile. Prevent invalid region settings. |
| 5. First scan | Start reading and walk around the pallet or use the documented test position. Stop when the scan method is complete. | Record start/end, unique EPCs and available reader metadata. Freeze this run as First pass. |
| 6. Review | Compare expected EPCs against unique observed EPCs. | Show matched, missing and unexpected EPCs; show completeness and scan time. |
| 7. Correct / rescan | Adjust label position, shielding, pallet build or scan method as required; start a new run. | Create a linked run with its own result and reason; retain the first-pass result. |
| 8. Close session | Review completed tests and enter notes. | Save a session summary and export the evidence package locally. |

## 5.2 Pilot outbound flow

| **Step** | **Required outcome** |
| --- | --- |
| Select transaction | Operator selects or scans an order, shipment or pallet reference. The application displays destination / shipment context supplied by the chosen manifest source. |
| Load expected EPCs | The expected outer-carton EPCs are loaded and validated. The operator sees expected carton count and any manifest duplicates before scanning. |
| Scan pallet | Operator starts one scan run for the identified pallet. All reads are associated with that transaction and pallet. |
| Compare and decide | App compares unique observed EPCs with the expected set; it cannot mark the transaction complete if required cartons are missing or unresolved unexpected tags remain. |
| Resolve exception | Operator locates a missing carton, removes an unintended carton or requests supervisor disposition. A rescan is a new run. |
| Accept or hold | A complete match may be accepted. Any mismatch defaults to Hold until corrected or explicitly dispositioned under policy. |
| Record completion | Save user, time, device, reader profile, scan runs, result, action and any override. Export or send the outcome through the approved pilot interface. |

# 6 Mobile application screens

| **Screen** | **Purpose and required behavior** |
| --- | --- |
| Home / mode | Show PoC Test and Pilot Outbound modes; show current device, connectivity state and reader readiness. Prevent pilot transaction capture while in test mode, and vice versa. |
| Session / transaction list | List drafts, in-progress, held and completed records. Search by test ID, shipment, pallet, SKU or date. Highlight unsent pilot records if offline. |
| Create / open record | Create a PoC session or open an outbound transaction. Capture location, product mix, scan method and relevant references. |
| Manifest / expected EPCs | Import a file, select a prepared test manifest or receive pilot data. Display expected EPC count, duplicates, invalid values and mapping gaps. |
| Reader setup | Show reader connection, region, profile name, power and trigger mode. Expose only permitted adjustments; capture final settings into the scan record. |
| Scan screen | Large Start / Stop control, scan status, elapsed time, unique EPC count and reader health. Provide clear audible / visual feedback. Do not show raw repeated read counts as carton quantity. |
| Result screen | Show expected, matched, missing and unexpected unique EPC counts; completeness percentage; first-pass/rescan label; and a clear Match / Hold / Incomplete status. |
| Exception details | List EPC, classification, expected / observed state, associated SKU or carton if known, and the allowed resolution actions. |
| Session review / close | Show all runs in sequence, notes, photo attachment if enabled, deviations from planned matrix and a completion check before closing. |
| History / export | Search prior sessions; export a selected session or batch with summary, manifest, scan evidence, configuration and audit events. |
| Administration | Manage approved reader profiles, local locations, product / carton mappings, test templates, users and pilot exchange settings. |

## Interaction and accessibility

* The primary scan action must be reachable with gloves and usable while holding the reader.
* Use explicit text and icon states; do not rely on color alone to distinguish Match, Hold and Incomplete.
* Give a short beep or vibration on successful EPC acquisition where hardware supports it; provide an error tone for reader disconnect or scan failure.
* Show “reading” versus “comparison complete” as separate states. A high EPC count alone must never imply success.

# 7 Functional requirements

Priority: MUST is required for the PoC or pilot function described; SHOULD is recommended for a reliable pilot. “Both” means the requirement applies in both modes. P = PoC; L = Pilot.

| **ID** | **Function** | **Priority** | **Phase** | **Requirement** |
| --- | --- | --- | --- | --- |
| FR-01 | Mode separation | MUST | Both | The user shall select PoC Test or Pilot Outbound. Each record shall retain its mode and use the correct workflow and required fields. |
| FR-02 | Create record | MUST | Both | The app shall create a unique session / transaction ID and record creator, creation time, location and record status. |
| FR-03 | Expected EPC manifest | MUST | Both | The app shall load a list of expected unique EPCs for one pallet. Each expected EPC may be associated with a carton ID, SKU and description. |
| FR-04 | Manifest validation | MUST | Both | The app shall reject malformed EPCs, flag duplicate EPCs and show missing or ambiguous carton-to-SKU mappings before a scan starts. |
| FR-05 | Offline operation | MUST | PoC | The full session, scan, compare, review and export workflow shall run without a network connection. |
| FR-06 | Pilot import / interface | MUST | Pilot | The app shall receive a shipment or pallet manifest through an agreed file import or approved interface. Interface format and system owner remain to be confirmed. |
| FR-07 | Reader connection | MUST | Both | The app shall show connected / disconnected / unavailable reader states and block scan start when no reader is ready. |
| FR-08 | Reader profile | MUST | Both | The app shall select a named, approved reader profile and store the actual device and RF settings used for each scan run. |
| FR-09 | Region compliance | MUST | Both | The app shall use the ETSI profile for the test location and shall not permit a non-compliant regional configuration. |
| FR-10 | Scan control | MUST | Both | The operator shall manually start and stop a scan; the app shall record the time and duration of each run. |
| FR-11 | Unique EPC capture | MUST | Both | The app shall form a set of unique EPCs for comparison while retaining the run evidence needed to audit how each EPC was observed. |
| FR-12 | Run separation | MUST | Both | Each first pass and rescan shall be a separate run linked to the same session / transaction. A new run shall not overwrite earlier reads or metrics. |
| FR-13 | Expected versus observed | MUST | Both | The app shall classify expected EPCs as matched or missing and observed EPCs outside the expected list as unexpected. |
| FR-14 | Completeness calculation | MUST | Both | For each run, show matched expected unique EPCs divided by expected unique EPCs. If expected count is zero or invalid, do not calculate a percentage. |
| FR-15 | Match / hold status | MUST | Both | A run shall be Match only when all configured expected EPCs are present and there are no unresolved blocking exceptions. Otherwise show Incomplete or Hold. |
| FR-16 | Duplicate EPC control | MUST | Both | The app shall flag an EPC duplicated in the manifest or assigned to more than one carton. Duplicate reads of one EPC shall count as one carton identity. |
| FR-17 | Unexpected reads | MUST | Both | The app shall show every unique unexpected EPC and permit the operator to mark it as investigated, removed from the zone, or unresolved. It shall not silently discard the EPC. |
| FR-18 | Missing carton handling | MUST | Both | The app shall show each expected EPC not read and support a physical search, correction or new scan. The current run remains unchanged. |
| FR-19 | Rescan reason | MUST | Both | Before starting a rescan, the operator shall choose or enter a reason such as missed carton, label repositioned, pallet rebuilt, shielding adjusted or scan method changed. |
| FR-20 | Reader / tag diagnostics | SHOULD | Both | Where the reader SDK exposes it, retain read time, antenna / channel and signal metrics for diagnosis; the app shall not require unavailable fields. |
| FR-21 | Test setup metadata | MUST | PoC | Capture product group, pallet type, carton count, label type / dimensions, label position, orientation, wrapping, location and planned test ID. |
| FR-22 | Physical verification | MUST | PoC | Prompt the designated Keypharm verifier to confirm physical carton contents and unique label assignment before accepting the expected list. |
| FR-23 | Label limit | MUST | PoC | Track labels allocated to candidate tests and warn / block when the cumulative PoC allocation would exceed 500 labels. |
| FR-24 | Scan method | MUST | Both | Capture the scan method (for example walk-around, defined handheld position or configured station) and its instructions / profile. |
| FR-25 | Station / wrapper profile | SHOULD | Pilot | Support a named wrapper-zone profile and shielding note. Automatic wrapper triggering requires a separate reader and trigger specification. |
| FR-26 | Inventory location | MUST | PoC | Capture location and storage level for inventory scans so ground, level 1 and level 2 results can be compared separately. |
| FR-27 | Notes and evidence | SHOULD | Both | Allow notes and optional photo attachments for label position, pallet build, shielding or environmental observations. |
| FR-28 | Close session | MUST | PoC | Require test coverage review, missing-test reason, result review and operator sign-off before a session is closed. |
| FR-29 | Pilot release disposition | MUST | Pilot | Permit Accept only on a clean match or an authorized disposition. Default every unresolved mismatch to Hold. |
| FR-30 | Override audit | MUST | Pilot | For any authorized override, record user, time, reason, original status, selected disposition and supervisor approval where required. |
| FR-31 | Export evidence | MUST | PoC | Export session summary, planned and executed tests, manifests, per-run EPC results, settings, timings, exceptions, notes and audit trail as CSV or XLSX plus a human-readable summary. |
| FR-32 | Pilot result exchange | MUST | Pilot | Return completed status, missing / unexpected EPCs, completion time and transaction key through the agreed pilot exchange method. |
| FR-33 | History and search | SHOULD | Both | Search and filter by session / shipment, pallet, SKU, location, date, result, reader and operator. |
| FR-34 | Local data recovery | MUST | PoC | Retain committed records across app restart and reader disconnect. Provide a controlled export / backup mechanism before the handheld is cleared. |
| FR-35 | Configuration audit | SHOULD | Both | Record who changed a test template, manifest mapping or reader profile, when it changed and which version was used. |

# 8 Data model and record structure

The application should preserve both the operational decision and the evidence behind it. The core objects below are logical; they do not prescribe a specific database or reader SDK.

| **Object** | **Key fields** | **Purpose** |
| --- | --- | --- |
| Session / transaction | ID, mode, status, creator, created / closed times, location, device, notes | Top-level container for a PoC test session or pilot outbound check. |
| Pallet / handling unit | Pallet ID or local test reference, shipment / order reference, location / level, pallet type | Identifies the physical unit being checked. |
| Manifest line | Expected EPC, carton reference, SKU, description, expected quantity / mapping status | Defines which unique carton identities are required. |
| Scan run | Run ID, run number, first pass / rescan, start / stop times, method, profile, settings, operator | Immutable scan attempt tied to one pallet and manifest version. |
| Observed EPC | EPC, first seen time, last seen time, read count (if available), reader metadata, classification | Evidence for an EPC observed during a specific run. |
| Result / exception | Expected count, matched, missing, unexpected, invalid / duplicate, completeness, status, disposition | Explain whether the pallet matches and why it is held. |
| Audit event | Actor, time, action, before / after values, reason | Trace changes, corrections, approvals and overrides. |
| Attachment | File name, type, link to session / run, capture time, user | Optional supporting photos or notes. |

## Data rules

* EPC is the unique RFID identity at outer-carton level. The app does not infer or assign a product identity from an unknown EPC.
* The expected manifest is versioned per run. If an expected list changes, the app creates a new manifest revision and records why.
* Unique EPC count determines carton identity count. Repeated reads of the same EPC increase diagnostic read count but not the number of cartons.
* An EPC assigned to two physical cartons is a data-quality exception. RFID alone cannot distinguish two cartons sharing one EPC.
* Keep test records and pilot transactions logically separate; exports must state which mode generated them.

## Recommended export columns

SessionID, Mode, TransactionRef, PalletRef, TestID, RunID, RunType, RunStart, RunEnd, DurationSeconds, Location, StorageLevel, SKU, CartonRef, ExpectedEPC, ObservedEPC, Classification, ReaderModel, DeviceID, RegionProfile, PowerSetting, ScanMethod, LabelType, LabelPosition, ShieldingStatus, CompletenessPct, ResultStatus, ExceptionCode, Operator, Reviewer, Disposition, Notes.

# 9 Reader behavior and scan-result logic

## 9.1 Reader profile

The test report records a Chainway C72 configured for ETSI, circular polarization and 30 dBm. The app should offer a validated profile matching this test baseline. Profile settings must be captured with every run because a changed power, antenna mode or region can change the result. Reader-specific parameter availability must be verified against the selected device SDK and firmware.

| **Profile field** | **Requirement** |
| --- | --- |
| Reader model / device ID | Read from the device where possible; otherwise select from a managed list. |
| Regulatory region | ETSI for Keypharm’s test location. Lock to the approved regulatory domain. |
| RF power | Record the actual configured output; allow adjustment only within approved limits. |
| Antenna / polarization | Record the supported antenna mode; baseline test uses circular polarization. |
| Scan trigger and timeout | Manual start/stop for handheld PoC; pilot may add a station trigger after definition. |
| Profile version | Store a version or profile ID to make different runs comparable. |

## 9.2 Set comparison

| **Set** | **Definition** | **Result handling** |
| --- | --- | --- |
| E — Expected | Unique EPCs in the approved manifest for the pallet. | Baseline denominator for completeness. |
| O — Observed | Unique EPCs received during this scan run. | Deduplicate repeated sightings for identity comparison. |
| M — Matched | E ∩ O. | Expected EPCs that were observed. |
| Missing | E − O. | Blocking mismatch until found, corrected or dispositioned. |
| Unexpected | O − E. | Potential neighboring label, unmanifested carton or data error; retain and investigate. |

Completeness per run = count(M) ÷ count(E) × 100. The app shall show the counts alongside the percentage. It shall not merge O across runs. “Final after rescan” may be displayed as a separate operational summary, while first-pass completeness remains visible for performance analysis.

## 9.3 Outcome states

| **State** | **When to use** | **Can close?** |
| --- | --- | --- |
| Ready | Manifest validated and reader ready. | No scan result yet. |
| Scanning | Reader is actively collecting reads. | No. |
| Match | All expected unique EPCs are present and no blocking exceptions remain. | Yes; PoC can close run, pilot may accept. |
| Incomplete | One or more expected EPCs are missing. | No; rescan or disposition. |
| Unexpected reads | One or more EPCs outside the manifest are present. | No until investigated or policy allows disposition. |
| Invalid manifest | Duplicate, malformed or unresolved expected EPCs. | No scan may start. |
| Reader error | Reader disconnected, unsupported settings or scan failed. | Run marked failed; retain diagnostics. |

# 10 Exception catalog and handling

| **Exception** | **Detection** | **Operator response** | **Required record** |
| --- | --- | --- | --- |
| Expected carton not read | Expected EPC is absent from O at Stop. | Physically locate carton; check tag and placement; adjust build; rescan if needed. | Missing EPC, run, reason, action and linked rescan. |
| Unexpected / neighboring EPC | Observed EPC is not in E. | Check whether it is a stray carton, nearby stock tag or manifest error; clear zone or document disposition. | EPC, first seen, classification, investigation and resolution. |
| Duplicate EPC in manifest | Same EPC occurs more than once in E. | Correct manifest / physical label assignment before scanning. | Source row(s), correction and manifest version. |
| Duplicate EPC on cartons | Physical verification finds same EPC attached to multiple cartons. | Quarantine label assignment; replace or remap tag before testing. | Carton references, old/new EPC and verifier. |
| Pomegranate juice lower read rate | Run completeness below observed 100% baseline. | Check label orientation, wet/liquid adjacency, carton position and scan route; repeat controlled tests. | Label type/position, pallet pattern, misses and settings. |
| Inventory level read loss | Level 1 or 2 result below the ground-level baseline. | Repeat with fixed pallet position and scan route; compare angles and shielding. | Storage level, expected / observed, run and position. |
| Wrapper-zone ghost reads | Unexpected EPCs appear during wrapper scan. | Verify shield condition and zone boundaries; test nearby tagged goods at recorded distances. | Shielding state, reader settings, unexpected EPC set and outcome. |
| Reader disconnect / low battery | Device or reader reports failure, or scan is interrupted. | Stop safely; restore connection / power; rerun as a new attempt. | Error, time, device, partial run status and recovery. |
| Manifest import error | Invalid format, missing fields or duplicate identities. | Show row-level errors; allow corrected file to be imported as a new version. | File name, import time, error summary and manifest version. |
| Offline pilot sync conflict | A transaction has newer status upstream or duplicate submission. | Hold record for review; do not overwrite either version silently. | Local and server references, timestamps and resolution. |

# 11 PoC and pilot operating profiles

| **Capability** | **PoC profile** | **Pilot profile** |
| --- | --- | --- |
| Purpose | Prove technical readability and test label / pallet variables. | Control a defined outbound completeness step. |
| Data source | Preloaded or local CSV manifest; manual test metadata. | Approved shipment manifest from import or named system interface. |
| Connectivity | Fully offline; no server dependency. | Online exchange if approved; offline queue as resilience option. |
| Users | RFID specialist and Keypharm test staff. | Named warehouse operators and supervisors. |
| Workflow result | Evidence result for each planned test and run. | Accept / Hold disposition for one outbound transaction. |
| RF setup | C72 / ETSI / circular / 30 dBm baseline, verified at setup. | Controlled, versioned profiles per operational zone. |
| Scale control | Label allocation limited to 500 labels; one-day test scope. | Volume and device profile set by pilot design. |
| Outputs | Local test report export, EPC data and photos / notes. | Transaction result returned through agreed file or interface. |
| Success policy | Criteria set for each test; show actual percentages, do not guarantee 100%. | Configurable pilot release rule; unresolved mismatches default to Hold. |

## Recommended pilot transition

* Keep the same scan, deduplication, comparison, exception and audit components used in the PoC.
* Create a controlled mapping from shipment / pallet references to carton EPCs.
* Agree whether the pilot starts through CSV import / export or a direct WMS / ERP interface.
* Confirm a physical scan location and whether the wrapper is only a work area or a triggered station.
* Agree operational release authority, exception ownership and the threshold for acceptable performance.
* Pilot in shadow mode first if Keypharm wants to compare RFID result with the current barcode process before RFID controls release.

# 12 Reports and operational measures

| **Metric** | **Definition** | **Why it is needed** |
| --- | --- | --- |
| First-pass completeness | Matched expected EPCs ÷ expected EPCs for first run. | Shows actual initial scan performance without rescan benefit. |
| Final completeness | Matched expected EPCs in the selected completed run ÷ expected EPCs. | Shows the outcome after any corrective action; report separately. |
| Missing EPC count | Count of E − O per run. | Identifies cartons requiring search or correction. |
| Unexpected EPC count | Count of O − E per run. | Measures environmental read noise and manifest mismatches. |
| Repeatability | Variance across comparable runs for same configuration. | Shows whether the scan method is stable. |
| Scan duration | Stop time − start time for each run. | Supports workability assessment; report by case, not as an unsupported saving. |
| Exception resolution time | Time from exception to final disposition. | Measures operational burden in the pilot. |
| Coverage | Completed planned tests ÷ planned tests. | Shows whether the test plan was carried out. |
| Label / configuration result | Result by SKU, label type / position, pallet pattern and storage level. | Helps isolate pomegranate juice, upper-level and shielding cases. |

Every KPI display must include the run count and relevant configuration. Do not combine repeated scans, different products or inventory levels into a single headline without showing the underlying segments. The current test report’s approximate 95% values should remain marked as reported results until raw EPC data is captured.

# 13 Non-functional and device requirements

| **Area** | **Requirement** |
| --- | --- |
| Offline resilience | PoC features must not require Wi-Fi, cellular service, authentication server or cloud response. Local committed data survives app close and device restart. |
| Data integrity | Each scan run is immutable after save. Corrections create a linked event or new manifest revision; no evidence is silently overwritten. |
| Performance | The UI remains responsive while reads arrive. Reader events are buffered safely; scan stop must finalize or clearly flag incomplete capture. |
| Usability | Large touch targets, clear scan state, simple operator wording, audible or vibration feedback where supported, limited typing in the warehouse. |
| Security | Restrict settings and override actions by role in the pilot. Protect local records with the device’s supported lock / storage controls. |
| Auditability | Capture user, device, time, profile, action, record revision, exception and disposition. |
| Recovery | Handle app restart, battery interruption and reader disconnect without corrupting saved sessions. Expose unsynced / unexported data. |
| Compatibility | Confirm Android version, C72 firmware, SDK, supported memory, trigger behavior and export storage permissions before implementation. |
| Language | English functional copy for this specification; the deployed operator UI should be available in English and Dutch if Keypharm requires it. |
| Time and identifiers | Use a consistent timestamp format with timezone; generate non-colliding local IDs even when offline. |
| Data retention | PoC export and retention period to be agreed. Pilot retention, backup and deletion rules to follow Keypharm policy. |

# 14 Acceptance scenarios

These scenarios turn the report’s findings and SOW test matrix into executable app checks. Read-performance thresholds should be set by Keypharm and the test lead before the pilot; the app reports measured results and does not hard-code technical success.

| **ID** | **Scenario** | **Steps** | **Expected result** |
| --- | --- | --- | --- |
| AT-01 | Homogeneous pallet | Load a manifest of unique carton EPCs and scan the pallet. | Every EPC is classified; completeness and duration are shown; run is marked Match only for a complete set. |
| AT-02 | Mixed pallet | Scan a pallet with multiple SKUs and carton groups. | Expected and observed data are summarized by pallet and can be filtered by SKU; SKU does not replace EPC identity. |
| AT-03 | First pass and rescan | Run a scan, reposition a missed label and scan again. | Two linked runs remain visible; first-pass KPI is unchanged; final outcome points to the selected run. |
| AT-04 | Missing carton | Remove one expected carton and scan. | One missing EPC is shown; status is Incomplete / Hold; app cannot claim full match. |
| AT-05 | Unexpected carton | Add a tagged carton not on the expected list. | Unexpected EPC is shown and retained; transaction stays on Hold until resolved. |
| AT-06 | Neighboring tag | Place a tagged product outside the pallet near the reader zone. | Out-of-manifest EPC is captured and classified; distance / zone note can be recorded. |
| AT-07 | Duplicate manifest EPC | Import a file containing the same EPC twice. | Import reports row-level duplicate and does not permit a valid scan against ambiguous contents. |
| AT-08 | Pomegranate juice retest | Repeat a controlled product configuration using the recorded label setup. | Per-run result and missed EPCs are captured; comparison with the reported ~95% is possible. |
| AT-09 | Inventory levels | Scan comparable pallets at ground, level 1 and level 2. | Each level is a separate location/result segment; percentages are not blended. |
| AT-10 | Wrapper shielding | Scan the defined pallet at the wrapper with shielding documented. | Zone, shielding and profile are recorded; expected and unexpected EPCs are shown. |
| AT-11 | Reader loss | Disconnect reader during a run. | The run is marked interrupted, partial evidence retained, and a new run is required after reconnection. |
| AT-12 | Offline persistence | Complete and save a session in airplane mode; close and reopen the app. | Record, manifest and run results persist; local export remains available. |
| AT-13 | Pilot override | Attempt to accept a mismatch as an operator. | Operator is blocked; authorized supervisor disposition records actor, reason and original mismatch. |
| AT-14 | Export / reconciliation | Export one completed session and compare totals to app summary. | Manifest, run, EPC, exception, settings, timing and status data agree with the app record. |

# 15 Assumptions, decisions and open questions

The following points must be confirmed before implementation or pilot configuration. The choices affect reader integration, operating control and data exchange.

| **ID** | **Question / decision** | **Why it matters** | **Suggested owner** |
| --- | --- | --- | --- |
| D-01 | Which exact Chainway C72 model, Android version, firmware and RFID SDK are available? | Defines trigger, reader status, settings access and read metadata. | TRC / reader supplier |
| D-02 | Can the app receive unique EPCs and signal metrics from the device API? Which fields are available? | Determines the evidence detail available per run. | TRC / reader supplier |
| D-03 | What is the approved EPC encoding scheme and validation rule for Keypharm cartons? | Prevents incorrect parsing, duplicate IDs and SKU mapping. | Keypharm / label supplier |
| D-04 | What manifest format and column names will be used for PoC and pilot? | Required for reliable import and reconciliation. | Keypharm IT / TRC |
| D-05 | For the pilot, which object is checked: shipment, order, pallet, SSCC or another handling-unit ID? | Defines transaction selection and hierarchy. | Keypharm Operations |
| D-06 | Will pilot data exchange use CSV, API, WMS/ERP interface or a shadow-mode export? | Determines integration design and error handling. | Keypharm IT |
| D-07 | Is the wrapper check handheld-triggered, operator-started or automatically triggered by station equipment? | Automatic station operation requires a defined reader / sensor integration. | Keypharm Operations / TRC |
| D-08 | What is the shielding design and the permitted distance to neighboring tagged goods? | Needed to control the ghost reads recorded during tests. | Keypharm / TRC |
| D-09 | What pilot completeness threshold and disposition rules are acceptable? | The app should enforce a policy that Keypharm has approved. | Keypharm Operations / Quality |
| D-10 | Who may override a mismatch and what evidence is required? | Defines the release control and audit trail. | Keypharm Quality / Operations |
| D-11 | Which product / packaging cases are considered critical, including liquids or foil? | Sets the pilot sample and exception focus. | Keypharm Operations |
| D-12 | What record retention, backup and device handover rules apply? | Defines local data protection and pilot support. | Keypharm IT / Quality |

# 16 Glossary and source traceability

| **Term** | **Meaning in this design** |
| --- | --- |
| EPC | Electronic Product Code stored on an RFID tag; treated here as the unique identity for one outer carton. |
| Expected EPC | EPC present in the approved manifest for the pallet. |
| Observed EPC | Unique EPC received by the reader during a specific scan run. |
| Ghost / unintended read | A valid EPC received from a tag outside the target pallet or read zone. |
| First pass | The first scan run for a pallet before any corrective action. |
| Rescan | A separate scan run after a change or investigation; retained independently. |
| Manifest | The expected list of carton EPCs for a test pallet or pilot transaction. |
| PoC | One-day technical feasibility test, offline, capped at 500 labels. |
| Pilot | Controlled operational validation with defined users, locations, transaction source and disposition rules. |
| C72 | Chainway C72 mobile UHF RFID reader recorded in the test report. |

## Source traceability

| **Source** | **Used for** |
| --- | --- |
| Keypharm RFID test report, dated 12 October 2026 | Reader baseline, label dimensions and position, test environment, test outcomes, inventory level results, wrapper shielding and unintended read findings. |
| Keypharm Phase 1 RFID outbound PoC SOW and quotation, version 3, 15 September 2026 | PoC limits, offline/local application requirement, 500-label cap, expected EPC comparison, pallet scenarios, missing / extra / neighboring tag tests, reporting and role assumptions. |

|  |
| --- |
| **Document conclusion**  The mobile application should make every pallet decision explainable from its manifest, scan run, reader profile and exception history. That capability directly addresses the strongest finding from the test report: good carton readability under tested conditions, paired with a need to control and explain unintended reads in the warehouse. |
