# CHANGE-LOG v7.69 — All Models tag editing (the picker was being painted away)

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched. No dependency change.
**Baseline:** v7.68.1
**Rollback tag on promote:** `beta-v53`
**Suite:** 740 total, 0 failed (verify.js 576; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

Two reported bugs on the All Models grid, which turned out to be **one** root cause plus one
genuine feature gap:

1. Clicking a tile's `N tags` badge showed the "Shoot tags" heading but never the model's tags.
2. The `+` tag picker looked like it offered nothing but a text box, so every tag had to be
   typed by hand.

---

## Root cause — and it is not in the tag code

`.am-tile` carries `content-visibility:auto` (index.html:313, added for perf across ~950 tiles).
**`content-visibility:auto` applies implicit paint containment**, and paint containment clips
absolutely-positioned descendants to the element's box **regardless of `overflow`**.

So this rule, whose entire stated purpose was to let the picker escape the tile's clip:

```css
.am-tile.picker-open{overflow:visible;z-index:40}   /* escape clip so the tag picker is visible */
```

**never did anything at all.** Both popovers were built correctly, inserted into the DOM
correctly, and then clipped out of existence. What survived was the top sliver of each — the
`Shoot tags` heading in one case, the search input in the other — which is exactly what got
reported.

**Verified, not inferred.** On a repro carrying the exact `.am-tile` / `.am-tile.picker-open`
rules, `document.elementFromPoint()` over the centre of a popover row returns the **tile**, not
the row. Adding `content-visibility:visible` to the open tile makes it return the row. Measured
twice, after a settle frame, with `getComputedStyle` confirming `overflow` really was `visible`
in the failing case.

Also confirmed the data layer was never involved: board `3636652411` column `dropdown_mkyj8js9`
("SHOOT Tags") has 16 active labels, and item reads return them correctly — e.g. Jay Stryker
reads `"TEST, CREW TRAINING 2026 #1"` from `{"ids":[2,13]}`.

### Fix

```css
.am-tile.picker-open{overflow:visible;z-index:40;content-visibility:visible}
```

Scoped to `.picker-open` — the **one** open tile — so the other ~950 tiles keep the perf win.

**This is why the full editor's SHOOT TAGS block always worked:** it lives in `#full-view`, not
inside a `content-visibility` tile, so nothing ever clipped it.

---

## Tag order — newest-created first

`gridTagOptions()` sorted alphabetically. It now sorts by **descending monday label id**.

**monday exposes no creation timestamp for dropdown labels.** `settings_str` carries only
`{id, name}`. Label ids are handed out incrementally, so a higher id was created later — that is
the recency proxy, and it is the only signal available. Correct on the current board (id 16
`test9` and id 15 `BFS 2026 #2` are the newest). It breaks only if a label id is ever deleted and
reused.

Recording true creation dates ourselves at create time was considered and **deliberately not
done** — it means new persistent state for a cosmetic ordering win.

Tags already on the model pin above a separator under **On this model**, so un-applying one stays
one click away; everything else follows under **All tags — newest first**. The read-only badge
popover reuses the same ordering, so the two popovers can never disagree.

Nothing about the write path, the edit buffer, or `create_labels_if_missing` changed.

---

## Tests

`verify.js` had one assertion that this change legitimately invalidates
(`grid tag options sorted alphabetically`). Replaced with five: the new sort, the applied/rest
partition, the shared ordering in the read-only popover, and — importantly — a guard on the
literal `.am-tile.picker-open{...content-visibility:visible}` rule, so nobody "tidies away" the
one property holding the popovers visible.

Separately validated the ordering against the **real** production `settings_str` (all 16 labels)
with 16 checks, including live records Jay Stryker `[2,13]` and Alex Gonz `[4,14]`: the
applied/rest partition is lossless, search still filters case-insensitively, `+ Create` only
appears for a genuinely new name, and an unsaved locally-created tag sorts to the top (it is the
newest).

---

## Note for whoever ships next

`v7.68` and `v7.68.1` shipped **without** in-file changelog entries — release step 5 was skipped
twice, so `curl … | grep -o "v7.68:"` had no deploy-verification target for either. Both entries
were backfilled in this release from their commit messages and code comments.
