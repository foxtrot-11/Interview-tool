# CHANGE-LOG v7.75.2 — Name QA leaked into every other tab

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched.
**Baseline:** v7.75.1
**Rollback tag on promote:** `beta-v59`
**Suite:** 897 total, 0 failed (verify.js 672; nameqa-logic 82; server-guard 38; scrape 53; dedup 32; sandbox 20)

## Reported

After using Name QA, the Name QA list kept appearing at the bottom of every other view — and the
Casting Sandbox "wouldn't load" when its tab was clicked.

## Two symptoms, one cause

**`#nameqa-view` was never hidden anywhere in `setMode`.**

Every other board-level view is hidden either in `setMode`'s preamble (`kanban-view`, `am-view`,
`sb-view`) or per-branch (`dup-view`). `nameqa-view` was in **neither** — a gap present since v7.67
when the tab was added, and invisible until someone opened Name QA and then switched tabs.

**The sandbox was never broken.** `#sb-view` sits *after* `#nameqa-view` in the DOM, so with 557
flagged rows still rendered above it, the sandbox was simply pushed hundreds of pixels below the
fold.

Found by walking `setMode` programmatically and diffing the `*-view` ids in the markup against every
`hide()` call — **not** by reading it. The bug is an *absence*, and there's nothing to read:

```
views in the DOM: full-view, interview-view, new-model-view, dup-view,
                  kanban-view, am-view, nameqa-view, sb-view
hidden for EVERY mode (preamble): kanban-view, am-view, sb-view

views NEVER hidden anywhere in setMode: nameqa-view
```

The same pass found a second gap: the `nameqa` branch never hid `#dup-view`, so
Duplicates → Name QA left Duplicates on screen too.

## Fix

All board-level views are now hidden in the **preamble**, before any branch runs, so a branch can't
forget one. Each branch's `show()` runs afterwards, so ordering is safe.

## Second fix — the same underlying annoyance

Switching tabs now resets `#form-area.scrollTop` to 0. The scroll position survived a view swap, so
leaving a long list dropped you into the next tab's blank space — which is a large part of why the
sandbox looked like it had failed even once it *was* being shown.

**This is not the v7.70 back-from-model restore.** That runs in `backToApprovedGrid()`, which never
goes through `setMode`, so `gridRestoreScroll()` is untouched.

## Guarded properly

`verify.js` now walks `setMode`, discovers every `*-view` in the markup (excluding the three editor
views managed by the candidate flow), and fails if any is:

- never hidden at all, or
- only hidden *inside a branch* rather than up front — a latent version of the same bug

Proved by deleting the `nameqa-view` hide:

```
✗ every board-level view is hidden somewhere in setMode
    NEVER hidden: nameqa-view — it will render underneath other tabs
✗ board-level views are hidden up front, before any mode branch
    only hidden inside a branch: nameqa-view
```

**That check would have caught this in v7.67**, and will catch the next tab someone adds.

## Note

This is the second bug this week that no substring assertion could see (the first was the v7.70
paint-containment clip). Both needed the code walked or measured rather than grepped. Worth
remembering when adding coverage: `verify.js` is good at "is this string present" and blind to
"is this behaviour complete".
