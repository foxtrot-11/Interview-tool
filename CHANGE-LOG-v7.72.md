# CHANGE-LOG v7.72 — Casting Sandbox: one-tap promote/demote, rows reordered TOP/BOTTOM/VERS

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched. No dependency change.
**Baseline:** v7.71
**Rollback tag on promote:** `beta-v56`
**Suite:** 804 total, 0 failed (verify.js 640; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

---

## 1. Bump button

After v7.71 turned the zones into horizontal rows, moving somebody between a role's main row and
its alternates row required dragging while scrolling the row **sideways** and the page
**vertically** at the same time. Awkward with a mouse, effectively broken on a phone.

Every filled tile now carries a 28px arrow at its top-left:

- **↑** on a tile in an alternates row → promotes it to that role's main row
- **↓** on a tile in a main row → demotes it to that role's alternates row

It always **appends** to the next free slot rather than inserting, so nobody already placed gets
displaced or renumbered above them.

Two deliberate design points:

- Direction is derived from **where the tile actually is** (`SB_ALT_REV[cur] || SB_ALT[cur]`), not
  from a flag that could go stale after a re-render.
- The move goes through the existing `sbMove()`, which already handles removal from the old zone,
  index bookkeeping and the re-render. This is a shortcut over the one movement code path, not a
  second one.

**Role is never crossed.** A VERS alternate can only ever land in VERS.

### Verified headlessly against the real extracted functions (13 checks)

`sbMove`, `sbBump` and `sbZoneLabel` were lifted out of `index.html` and run directly:

| Check | Result |
|---|---|
| Promote appends to the end of the main row | ok |
| Promoted person leaves the alternates row | ok |
| Demote appends to that role's alternates row | ok |
| Demoted person leaves the main row | ok |
| VERS demotes to VERS alternates, never another role | ok |
| Round trip restores the original role | ok |
| No id can appear in two zones | ok |
| Bumping an unknown id is a no-op, not a crash | ok |

## 2. The tile's top-left was already occupied

`.sb-slotnum` — the `T1` / `B2` / `ALT` position label — sat exactly where the button needed to go.
On a **filled** slot the label now drops to `top:40px` with a chip background so it stays readable
over the headshot. Empty slots are untouched (their label is centred by a separate rule).

Measured in a browser: **5px** clearance between label and button, all four tile buttons
independently hit-testable, no two overlapping, empty-slot label still centred, 28px touch target.

The first attempt used `top:36px` and measured only **1px** of clearance — non-overlapping but
visually cramped. Caught by measuring, not by assertion.

## 3. Row order → TOP, BOTTOM, VERS

Both the primary and the alternates rows.

**This was not just a cosmetic swap.** The alternate numbering at Port used its own hardcoded
`['ab','av','at']`, entirely independent of display order. Reordering the rows alone would have made
the subitem numbers written to Monday **disagree with what's on screen**.

`SB_MAIN` is now the single source of zone order, and `SB_ALT_ORDER` derives from it:

```js
const SB_MAIN=[['t','TOP'],['b','BOTTOM'],['v','VERS']];
const SB_ALT_ORDER=SB_MAIN.map(([z])=>SB_ALT[z]);   // ['at','ab','av']
```

`verify.js` asserts the derivation **and** that the stale literal is gone — that pairing is the
actual guarantee against future drift.

### ⚠️ Behavioural change worth knowing

Because alternates are numbered in display order, **an alternate's subitem number at Port changes
with this release**: TOP alternates are now numbered before BOTTOM and VERS. Primary cast numbering
is unaffected (it was always per-row).

---

## Tests

One pre-existing assertion was legitimately invalidated and replaced rather than deleted: the
hardcoded `['ab','av','at']` port-order assert now checks the derivation plus a `lacks()` on the old
literal. 12 new asserts cover the bump path, the reorder and the label reposition. `verify.js` is at
640.
