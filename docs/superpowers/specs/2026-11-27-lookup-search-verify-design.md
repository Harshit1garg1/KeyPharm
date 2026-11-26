# Verify wording, Search rename and tag Lookup (0.9.25)

## Intent

The handheld calls the Supervisor step "Physical check" and calls the tag finder "LookUp". The owner wants
"Verify" and "Search", plus a real Lookup: scan a tag and see what it is.

## Decisions

- Displayed text only is renamed. Stored values (`Physical verification` log action, `lookupPower` setting,
  `physical` dashboard action, `lookup` view and beep kind) stay, so existing records and sync keep working.
- The web dashboard gets the same wording as the handheld.
- New bottom tab **Lookup** (internal name `identify`). One short read, strongest RSSI wins.
- Lookup reads at 10 dBm, fixed. Reader power is restored afterwards.
- Lookup shows records already on the handheld: synced stock and session manifests. Standalone mode has
  manifests only. An unmatched tag shows its EPC and "Not in records".
- Lookup writes nothing: no session, run or log entry.

## Approaches

1. Strongest tag only (picked): one clear answer, stray warehouse tags mostly ignored.
2. List all tags read: better for a stack, busier screen.

## Non-goals

No new admin power setting. No server data change. Pallets that exist only in pallet inventory are not sent to
the handheld today, so Lookup reports them as not in records.
