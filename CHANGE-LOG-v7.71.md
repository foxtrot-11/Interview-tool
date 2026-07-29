# CHANGE-LOG v7.71 — Casting Sandbox: rows instead of columns, and save-in-place

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched. No dependency change.
**Baseline:** v7.70
**Rollback tag on promote:** `beta-v55`
**Suite:** 790 total, 0 failed (verify.js 626; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

Two changes, both inside the Casting Sandbox — same view, tested in one place.

---

## 1. Rows instead of columns

BOTTOM / VERS / TOP were three vertical columns (`.sb-cols`, a 3-up grid of
`minmax(320px,1fr)`). Slots are a fixed 142px wide inside a *wrapping* flex zone, so at ~320px of
column width they wrapped 2-per-row and a shoot with 8 people ran well below the fold — one column
of 8 measured **~792px tall**, and there were three of them side by side.

Each zone is now **one horizontal row, a single slot high, scrolling sideways**:

```
.sb-rows (flex column)
  └ .sb-rowwrap
      ├ .sb-rowhead            ← full-width label + count
      └ .sb-zone.sb-rowzone    ← flex-wrap:nowrap; overflow-x:auto
```

Vertical cost per zone is now **fixed regardless of headcount**.

The three ALTERNATES rows moved out of their parent columns into one **collapsible block below all
three primary rows**. Previously alternates sat *inside* each column, which pushed the primary cast
of VERS and TOP even further down. Collapse state persists in `localStorage` — a view preference,
never data.

### Measured in a real browser

Against a fixture carrying the app's actual `.sb-slot` / `.sb-zone` / `.sb-tile` rules at the real
available width (1063px — `#form-area` minus the 380px sticky sidebar):

| Check | Result |
|---|---|
| Zone height | **206px** (one 180px slot + padding), not wrapped |
| Slots on one line, full row | **1 distinct y-position** across all 8 |
| Horizontal overflow | 1212px content in 1061px → scrolls |
| Last slot after scrolling | reachable and **hit-testable** |
| Three primary rows | **792px** vs an 837px viewport → primary cast now fits on screen |
| Collapsing alternates | saves **712px** (1504 → 792) |
| Alternates position | below every primary row |

### The drag-and-drop needed zero changes

Drop targets are identified purely by `data-zone` + `data-index`. There is no geometry, no
`clientY` comparison, no insert-before maths and no `getBoundingClientRect` anywhere in the DnD
path — which is exactly why rotating the layout is safe. Verified after the change that slots still
carry both data attributes and tiles are still `draggable`.

The horizontal row scrollbar is styled at 10px for the same reason the vertical one was widened in
v7.70: the 4px default cannot be grabbed.

---

## 2. Save in place

`sbSaveState()` unconditionally called `create_item`, and `sbLoadSave()` **threw the loaded id
away**. So editing a saved arrangement meant *save a second copy, then delete the old one*.

The open save is now tracked (`sbCurrentSaveId` / `sbCurrentSaveName`). Step 3 shows
**Update "<name>"** alongside **Save as new**, and the open save's chip is highlighted so there is
no ambiguity about what Update overwrites.

Two deliberate asymmetries:

- **Update** uses `change_multiple_column_values` on the existing item — the same create-or-update
  shape `dupIgnorePersist` already uses against this very board and column — and is `gqlRetry`-safe,
  because overwriting a column with a fixed value is idempotent.
- **Save as new** stays on plain `gql`. `create_item` is **not** idempotent and a retry could
  double-create. This matches the existing rule in CLAUDE.md §4.

Save-as-new then **adopts** the new item as the open save, so a further edit updates it rather than
producing a third copy — the exact papercut this release removes.

Overwriting prompts for confirmation, because it replaces a shared record for every coworker with
no recovery.

### Where the tracked id is cleared

A stale id would silently overwrite the wrong arrangement, so every exit is covered:

- shoot-tag change (`sbTagChanged`)
- brand-new tag (`sbNewTag`)
- a `#sb=` share link (the `sbPending` branch in `renderSandbox`) — someone else's layout is not one of our saves
- deletion of the open save itself (`sbDoDeleteSave`)

---

## Tests

Two pre-existing assertions were legitimately invalidated and updated rather than deleted:

- `Save state button wired` → now asserts the `sbSaveState()` back-compat shim plus both new buttons.
- `each column renders its own ALTERNATES header` → alternates are no longer per-column; now asserts
  they are still labelled per role.

19 new asserts cover the row CSS, the collapsible block, the render shape, and every branch of the
save/update path. `verify.js` is at 626.

**These are substring checks and cannot see layout.** The row geometry above was verified by
measurement in a browser, not by assertion — that distinction is what v7.70 taught.

---

## Note

`SANDBOX_SAVES_BOARD_ID` is shared with the duplicates engine: `dupLoadIgnore` / `dupIgnorePersist`
store the `__DUP_IGNORE__` item on the same board, in the same column that
`sbEnsureSavesCol()` discovers. The payload schema and the column-pick heuristic were **not**
changed here, so "Not a duplicate" is unaffected.
