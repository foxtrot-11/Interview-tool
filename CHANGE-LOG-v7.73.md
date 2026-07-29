# CHANGE-LOG v7.73 — Duplicates: pair two records by hand

**Type:** client only (`public/index.html`) + `tools/verify.js`. `server.js` untouched. No dependency change.
**Baseline:** v7.72.1
**Rollback tag on promote:** `beta-v57`
**Suite:** 828 total, 0 failed (verify.js 664; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

## Why

Detection groups by exact normalized name (`dupNameKey`). A genuine duplicate whose two records are
spelled differently is therefore **invisible** to the tool — while being obvious to a human looking
at the two headshots.

A **Pair two records by hand** panel at the top of the DUPLICATES tab takes two slots. Each opens a
searchable list of every model (thumbnail, name, id, date — from the shared `kanbanItems` store, so
no extra fetch). Once both are chosen the pair renders as a normal duplicate group, with the same
cards, the same field-by-field preview, and the same merge / keep-one actions.

## The reuse is the point

`computePlan()` already took a **group object** rather than a detected pair, reading only
`items[].{id,name,created_at,board}` and `keeperId`. So a synthesised group needs **no changes** to
the planner, the preview, the photo merge, the verifier or the audit log.

- The group-card markup was factored out of `renderDupGroups` into `dupGroupCardHtml()`, so both
  paths render identically.
- The manual group lives in `dupGroups` — that's how `getDupGroup`, `previewMerge`, `executeMerge`,
  `loadGroupDetails` and `selectKeeper` find it — but is skipped by the filtered list and rendered
  into its own always-visible mount.
- It is re-inserted after a Refresh, so an in-progress review isn't silently discarded.

## Safety — the actual design problem

`executeMerge` **deletes** the source record, and its last automated check was that both names
normalize identically. A hand-picked pair fails that *by definition* — differing names are the
entire reason the feature exists.

So for a manual group **only**, that check is replaced by two human gates. **Neither involves
typing**, per your constraint: these names have genuinely odd spellings, and a typo-prone confirm
box is worse than none.

**Gate 1** — a checkbox: *"These two records are the same person. I've compared the photos above."*
Unticked by default.

**Gate 2** — a modal asking you to **click the name of the record that will SURVIVE**, offering only
the two names that already exist on the records. Clicking the other one is **refused**, with an
explanation that it's the record being deleted and a pointer to change the ◉ keeper instead.

That second gate is a comprehension check, not an OK button — and it satisfies "I only want to copy
something that exists": the confirmation is a selection from real data, never a typed string.

Both gates apply to **Keep one · delete other** as well.

The override is written into the Monday deletion comment as `[HAND-PAIRED OVERRIDE]` with both
original names, so the audit trail shows a human forced it rather than the matcher having agreed.

## The existing path is untouched — and now actually tested

Detected groups still hit the name guard exactly as before.

While wiring this up I found that guard — **the single most important check in the app** — had
**no test at all**. v7.73 adds one that counts its occurrences across *both* destructive paths and
fails if either is removed. Verified by deleting one:

```
✗ name safety-stop present in BOTH destructive paths (merge + keep-one)
    found 1, expected 2
```

## Scope limit

Manual pairing is **main-board only**, because `kanbanItems` is the main board. Detected duplicates
can still span the Evernote batch board, since those carry their own per-item `board` id.

## Verified against the real extracted functions (18 checks)

`getDupGroup`, `dupManualSync`, `dupManualClear`, `dupManualSetConfirmed` and
`dupManualConfirmPick` lifted out of `index.html` and run directly:

| Check | Result |
|---|---|
| Pair builds from two **different** names | ok |
| Same-person gate starts **unticked** | ok |
| Both records present, oldest first, each carrying a board id | ok |
| **Nothing executes without confirmation** — routes to the modal | ok |
| **Clicking the doomed record does NOT merge** | ok |
| Clicking the survivor proceeds, and records the override | ok |
| Keep-one is gated identically | ok |
| A record cannot be paired with itself | ok |
| Clear removes both the group and the slots | ok |

## Note

`dupManualConfirmOpen` reads the keeper from `_plan.keeperId` when a preview has been run, falling
back to `group.keeperId`. If you change the ◉ keeper after previewing, `selectKeeper` already nulls
`_plan`, so the modal can never confirm against a stale plan.
