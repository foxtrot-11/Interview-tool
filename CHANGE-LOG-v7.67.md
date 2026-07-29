# CHANGE-LOG v7.67 — NAME QA tab (read-only audit, phase 1)

**Type:** `server.js` + client + one new test file. No dependency change.
**Baseline:** v7.66
**Rollback tag on promote:** `beta-v51`
**Suite:** 731 total, 0 failed (verify.js 572; nameqa-logic 36 **new**; server-guard 38; scrape 53; sandbox 20; dedup 12)

A **NAME QA** tab (next to DUPLICATES) that audits Content Tracker's two free-text
character fields against the Model DB. **Human-triggered only** — nothing runs on a
schedule, and this release has **no write path at all**. Applying corrections is phase 2.

---

## How it decides what's wrong

**Accepted spellings** = each model's primary name **plus** the 12 per-site alias columns
(`bfs_name`, `fsb_name`, `gct_name`, …). All are treated as correct. Built on demand, so
normal app boot is unaffected.

**Segmenting** — splits on `,` `&` `/` `+` `and`, preserving delimiters.

**Parentheses — the important fix.** A segment is clean if the **whole string**, the text
**before** the parens, *or* the text **inside** the parens matches an accepted spelling.

The original spec had this backwards: it stripped parentheticals and matched the outer
text. But in your live data the parenthetical is usually the real model name —
`Father Snow (Adam Snow)`, `Apprentice McNeill (Marcus McNeill)`, `Coach Knox (Killian
Knox)` — so the old rule would have flagged the entire msb/cbs/ttp series as unknown
names. Checking all three parts means the tool never has to decide which side "means" the
model, and it still handles `Legrand Wolf (bottom)` correctly.

**Damerau-Levenshtein, not plain Levenshtein.** A transposition is the most common human
typo, and plain Levenshtein counts it as two edits. Real case from your board:
`Sean Xaiver` → `Sean Xavier` scores **0.82** plain (lands in "ambiguous") but **0.91**
with Damerau (correctly "likely typo"). `Cyurs Stark` is the same shape.

## Categories (triage only — they never affect what gets written)

| Category | Rule |
|---|---|
| Likely typo | ≥ 0.90 |
| Ambiguous | 0.75 – 0.90 — could be a different person |
| Marked (new) | value ends in `(new)` |
| Malformed | unbalanced brackets, e.g. `Master Stryker (Master Stryker (Jay Stryker), Patriarch Smith` |
| No match | < 0.75 — **no suggestion offered**, deliberately |

Values like `LEAVE BLANK`, `n/a`, `-` are ignored, not flagged.

## Nothing is reconstructed

Per your direction there is no auto-rejoining and no auto-fixing. Each flagged token
shows up to 3 ranked candidates as click-to-insert chips, plus a **free-text box holding
the entire field value** — so when the tool guesses wrong you just type over it. The stray
comma case (`Grayson Cole, Vincent, O'Reilly, …`) surfaces as two unmatched tokens for a
human rather than being silently "repaired".

## Server

`CONTENT_TRACKER_BOARD_ID` added to `ALLOWED_BOARD_IDS`, env-overridable and published via
`/config`, so staging can point at the test board with no code change. Verified: override
works, CT reads clear the guard, a non-allow-listed board still 403s.

## Tests

New `tools/nameqa-logic.test.js` — 36 assertions run against **real strings sampled from
Content Tracker**, including every messy pattern found there (role-in-parens, `[alumni]`,
`(new)`, ALL CAPS, stray commas, unbalanced parens, `LEAVE BLANK`).

## Deploy note

Depth selector defaults to ~500 rows so the first scan is quick on the free tier. Content
Tracker goes back to 2022, so "Everything" will be slow.

## Still open

- Dismissals don't persist between scans yet. If the ambiguous/no-match buckets turn out
  large, that becomes worth adding before phase 2 — otherwise every audit re-shows the
  same legitimately-unlisted names.
- Phase 2 = the Apply button, writing **only** to Content Tracker (the sync Worker
  propagates to the 4 team boards; writing to them directly gets reverted).
