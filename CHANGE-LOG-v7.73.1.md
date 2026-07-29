# CHANGE-LOG v7.73.1 — bugfix: blank conflict lines in a merged record's General Notes

**Type:** client only (`public/index.html`) + `tools/dedup-logic.test.js`. `server.js` untouched.
**Baseline:** v7.73
**Rollback tag on promote:** `beta-v57`
**Suite:** 848 total, 0 failed (verify.js 664; nameqa-logic 41; server-guard 38; scrape 53; dedup 32; sandbox 20)

## Found on a real merge

After hand-pairing TEST2 / TEST3 on staging, the keeper's General Notes contained:

```
[DUPLICATE INFO — Other Studios Notes:  (from id 12414377237)]
```

A logged conflict with no value.

## Root cause

**monday keeps metadata after a field is cleared.** A `long_text` that once held content comes back
as `{"text":"","changed_at":"…"}` — not a bare `{}`.

`isEmptyVal()` only recognised `{}`, `{"ids":[]}` and `{"labels":[]}`. So a cleared field counted as
*having* a value (`hasVal` ORs text against value), passed the `if(!hasVal(sc)) return` gate, and
then rendered as an empty string in the conflict line.

Confirmed against the live board: `long_text_mm252r65` ("Other Studios Notes") is a `long_text`, and
the keeper's own value was `"TESTTEST"` — so it took the conflict branch rather than the fill branch.

## Fix

In `isEmptyVal` itself, not at the log site. After parsing, bookkeeping keys
(`changed_at`, `changed_at_ms`, `is_valid`, `isValid`) are ignored and emptiness is judged on the
**content** keys. That also correctly catches:

| Shape | Now reads as |
|---|---|
| `{"text":"","changed_at":"…"}` | empty (the bug) |
| `{"changed_at":"…"}` | empty |
| `{"date":null}` | empty — cleared date |
| `{"url":"","text":""}` | empty — cleared link |
| `{"files":[]}` | empty |

### Zero is still a value

The emptiness test is `String(val).trim()===''`, **not** a falsy check. Status `index:0` and the
number `0` therefore survive. A falsy check here would have started silently dropping real data —
a far worse bug than the one being fixed, and the reason this is tested explicitly.

## Belt and braces

One extra line in `computePlan`: skip when the source column's *rendered* text is blank. Whatever a
future exotic value shape looks like, it can't put an empty `[DUPLICATE INFO — …:  ]` line in the
notes again.

## Tests

`isEmptyVal` and `hasVal` are now unit-tested in `dedup-logic.test.js` — **12 → 32 assertions** —
against the real monday value shapes, including the exact `{"text":"","changed_at":…}` that caused
this and the `index:0` / number-`0` cases that must not regress.

## Scope

**No change to what gets written to a keeper.** This only stops a useless audit line being appended
to General Notes. Fills, conflicts, photo merging, deletion and the audit trail are otherwise
identical.
