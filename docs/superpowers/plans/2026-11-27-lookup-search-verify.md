# Verify, Search and Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Rename "Physical check" to "Verify" and "LookUp" to "Search", and add a tag Lookup tab.

**Architecture:** One pure function in `model.mjs` describes an EPC. The handheld reuses the timed pallet
capture (`utilityScan`) for the new `identify` view. Native code is unchanged.

**Spec:** `docs/superpowers/specs/2026-11-27-lookup-search-verify-design.md`

## Global Constraints

- Version 0.9.25, versionCode 46.
- Lookup power 10 dBm by default, new setting `identifyPower`. Stored strings and existing setting keys unchanged.
- Sign with the key whose SHA-256 starts `fd7b153a` (same as the 0.9.24 release).

## Review Focus

- Stray tags in range: strongest RSSI is shown.
- Unknown EPC: "Not in records", EPC visible.
- No read: message shown, no stale result.
- SKU-matched manifest (no carton EPCs): carton found through confirmed run matches only.
- Standalone mode without stock: manifest data still shown.

---

### Task 1: `describeTag`

- [x] Failing tests in `tests/model.test.mjs`: pallet tag, manifest carton, stock carton, SKU-mode confirmed
      match, unconfirmed run match (not listed), unknown.
- [x] `describeTag(epc, sessions, stock = []) -> {kind:'pallet'|'carton'|'unknown', title, rows:[label,value][]}`
      in `app/src/main/assets/model.mjs`.
- [x] `node --test tests/model.test.mjs` passes.

### Task 2: Lookup tab

- [x] Failing browser check `tests/identify_smoke.py`: 10 dBm requested, strongest tag shown, unknown tag, no
      read, nothing stored.
- [x] `handheld.mjs`: `identify` view in tabs, back, tab command, trigger routing, re-render lists and reset.
- [x] `style.css`: four tab columns and `.tag-result` list.
- [x] Check passes.

### Task 3: Wording

- [x] `handheld.mjs`, `workspace-dashboard.mjs`, `workspace-store.mjs` messages, matching test strings.
- [x] `node --test tests/model.test.mjs tests/workspace.test.mjs` passes.

### Task 4: Release

- [x] Version bump, README, context.md, connected-poc.md.
- [x] `tools/build-android.ps1`, verify signer and version, commit on `Harshit-Dev` (no push).
