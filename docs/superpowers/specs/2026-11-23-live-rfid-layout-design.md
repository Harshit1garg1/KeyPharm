# Live RFID workflow and layout proposal

23 November 2026. The work is isolated on `codex/live-rfid-layout`, based on the merged `main`.

## Confirmed decisions

Keep Keypharm's CSV import. Run a separate converter for Chainway UHF XLS exports. The latest export holds 28 unique tag EPCs and has no pallet or carton assignments. Treat them as test labels. Partition them in workbook order into two disjoint groups of 14. For each group, designate its first EPC as the pallet tag and its other 13 as carton tags. Use neutral test references and a test SKU. Keep the original export and generated manifests outside Git.

Use the existing native Chainway reader for live capture. The main path uses C72 hardware, and simulation remains a clearly marked demonstration path. Operators present the designated pallet tag, then hold and release the physical trigger to scan the carton set. Verify a clean match, a deliberate missing tag, and a tag from the fallback group as an unexpected read before claiming physical acceptance.

## Layout proposal

Use KeyPharm's official logo, brand green and teal accents on light surfaces. Use a compact session header, one active operator step and a scan panel with a visible progress measure and distinct states. Prioritize expected, matched, missing and extra counts. Put setup, review and history in stable sections with larger touch targets. Show role and hardware readiness before the operator reaches the trigger step. Keep all current record content accessible. The web dashboard remains a read-only records view.

```text
Sessions                        Role
Pallet / current step           Reader ready
[ Check pallet | Scan cartons | Review ]
Expected      Matched      Missing      Extra
[ Seen EPC progress ]
Hold trigger to scan                 Continue
Previous and current runs
Setup, evidence and logs
```

## POC gaps to address alongside the layout

1. Make the existing manifest, physical verification, hardware status, comparison, sign-off, export and dashboard entry points visible in the operator flow.
2. Implement named local identities for evidence. Add search and selected-session export to handheld history.
3. Improve CSV errors to report every invalid row. Keep the current five-column provisional manifest and one-pallet scan scope. Revisions after a saved attempt must retain the earlier manifest and all associated evidence.

The approved POC also describes planned-versus-completed tests, durable local storage, backup, and acceptance across different locations, mixes and shielding. This pass should record where the installed app still falls short. A multi-pallet session model and storage migration are separate work after confirming how operators plan tests and how much history the C72 must retain. Pilot rules and integrations remain future work.

## Verification

- Generate and validate both live CSVs with Keypharm's existing parser. Each has 13 carton EPCs and a separate pallet EPC. No EPC appears in both groups.
- On the C72, verify reader readiness and press/release with physically isolated tags. Capture clean, missing and extra runs.
- Check handheld layout in the empty, ready, reading and result states at C72 width. Test roles, search and evidence export and compare existing dashboard access with the updated handheld flow.
