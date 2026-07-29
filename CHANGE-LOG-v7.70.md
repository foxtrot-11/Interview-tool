# CHANGE-LOG v7.70 — grid navigation: pinned controls, scroll memory, a grabbable scrollbar

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched. No dependency change.
**Baseline:** v7.69
**Rollback tag on promote:** `beta-v54`
**Suite:** 763 total, 0 failed (verify.js 599; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

Three reported annoyances on the grids, all resting on one structural fact about this app.

---

## The fact behind all three

**`#form-area` is the only scrolling element.** `html,body{height:100%;overflow:hidden}`, so
`window.scrollY` is permanently `0` and `window.scrollTo()` is a silent no-op.

That is not a theoretical footnote. The Casting Sandbox's "return to where you were"
(`sbReturnScroll`, shipped in v7.42) read `window.scrollY` and wrote `window.scrollTo` — so it had
**never worked once**. Both ends now use `#form-area.scrollTop`.

---

## 1. Sticky controls row

Applied to All Models / 2 / 3 / 4 / 5-APPROVED, Kanban, Duplicates and Name QA through an opt-in
`.tb-sticky` class.

**Deliberately not applied to bare `.am-toolbar`.** The Casting Sandbox reuses that class inside
`.sb-side`, which is *already* `position:sticky` with its own `overflow-y:auto` — nesting a sticky
in there pins it to the wrong scroll box.

Two things here were measured, not reasoned about, and both were wrong on the first attempt:

### (a) A sticky element is confined to its containing block

The controls row was nested inside `.am-toolbar`, an ~80px-tall flex box. A sticky child can only
travel within its parent's box, so the row unpinned again after ~80px of scroll — verified by
measuring its offset at `scrollTop` 500 / 2000 / 8000 / 20000: it sat at a constant **-1161px**,
i.e. long gone.

The controls row and the port row are now **direct children of `#am-view`**, which spans the whole
grid; the title row keeps its own `.am-toolbar-titleonly` wrapper. Kanban / Duplicates / Name QA
rows were already direct children of their views, so only All Models needed restructuring.

**Do not move the row back inside `.am-toolbar`.** `verify.js` asserts the split.

### (b) `top:0` does not mean "the top you can see"

A sticky `top:0` pins to the scrollport's **content** box — 24px down, because `#form-area` has
`padding:24px 32px`. That leaves a 24px strip above the toolbar which grid tiles scroll through in
plain view. Measured: sampling across the row's width, **42 x-positions had a tile in that strip.**

Fix, and the arithmetic matters:

| Property | Value | Why |
|---|---|---|
| `top` | `-24px` | pins flush to the *visible* top |
| `padding-top` | `32px` (8 + 24) | opaque background covers the strip |
| `margin-top` | `-24px` | cancels the extra padding in normal flow |

Net result: at-rest layout is bit-for-bit identical to before (input offset 55px, verified equal),
and the pinned controls land at the same 32px offset the naive version produced. **No JS, no
`stuck` class toggling, nothing that can jitter or feed back on its own measurement.** Mobile
repeats it against `#form-area`'s 18px padding.

### `.grid-save-bar`

Also sticky at the top, and a *later* sibling than the toolbar — so it would slide underneath the
pinned row. Its offset now tracks `--tb-sticky-h`, published by `tbSyncStickyOffset()` from the
row's **measured** height (the row wraps to two lines on narrow windows, so a constant drifts)
minus `#form-area`'s computed `padding-top`. Verified landing exactly at the pinned row's bottom —
no gap, no overlap.

---

## 2. Scroll memory on back-from-model

Opening a model captured nothing, so Back-to-grid always dumped you at the top of ~950 tiles.

- Captured **before** `hide('am-view')` — a hidden element reports `scrollTop` 0.
- Restored after `renderAllModels()`, which rebuilds `#am-grid.innerHTML` wholesale. The restore
  waits two `requestAnimationFrame`s for layout, then **clamps to the live `scrollHeight`**,
  because the grid can be shorter than it was.
- Keyed by `gridScope`, so 5-APPROVED and All Models can't restore onto each other.

**Filters, search and sort already survived** the round trip — the view is only `display:none`'d,
never destroyed, and `amFilters` / `gridScope` are module-level. Scroll was the only missing piece.

Per the owner's choice this restores on **back-from-model only**, not on tab switch.

---

## 3. Scrollbar and back-to-top

`.form-area::-webkit-scrollbar` was **4px** — below what a pointer can reliably grab, which is
exactly why the mouse wheel was the only practical way back to the top. Now 12px with a track, an
inset thumb (`background-clip:content-box`) and a hover state. `scrollbar-width` /
`scrollbar-color` added for Firefox, which ignores the `::-webkit-` pseudo-elements entirely.

Plus a fixed back-to-top button, appearing past 400px. `position:fixed` so nothing inside the
scroll box can clip it, at `z-index:8500` — deliberately **below** the 9000+ modal band so it can
never float over a dialog.

---

## Verification

Substring asserts can't catch a sticky-containing-block bug, so the layout was exercised in a real
browser against a 300-tile fixture carrying the app's actual `#form-area` / `.am-toolbar` /
`.grid-save-bar` / `.am-tile` rules. That is what caught **both** (a) and (b) — the first
implementation passed every assertion in `verify.js` while being visibly broken.

Checks run: `window.scrollY` stays 0 while `#form-area` scrolls · row pinned at 4 scroll depths ·
row spans the full width with the gutters covered · the search box is hit-testable while pinned ·
save bar clears the row exactly · at-rest layout unchanged · tile bleed 42 → 0 · back-to-top
threshold both sides of 400px · capture-before-hide · restore-after-rebuild · clamp against a
shortened grid.

## Note

`#form-area`'s padding and the `.tb-sticky` offsets are coupled. If `.form-area{padding:...}` ever
changes, `top` / `margin-top` / `padding-top` on `.tb-sticky` must move with it. The *save-bar*
offset needs no attention — it reads the padding from live computed style.
