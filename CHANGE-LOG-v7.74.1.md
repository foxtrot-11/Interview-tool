# CHANGE-LOG v7.74.1 — Name QA: the proposed value is visible without clicking

**Type:** client only (`public/index.html`) + `tools/nameqa-logic.test.js`. `server.js` untouched.
**Baseline:** v7.74
**Rollback tag on promote:** `beta-v58`
**Suite:** 873 total, 0 failed (verify.js 664; nameqa-logic 66; server-guard 38; scrape 53; dedup 32; sandbox 20)

## Why v7.74 read as "still broken"

The v7.74 composite fix was correct, but **invisible**. It changed what happens *on click*, and the
FULL FIELD VALUE box just echoed `was:` until a chip was clicked — so the screen looked identical
before and after the fix.

Confirmed from the report screenshot: both candidate chips were outline-styled (a clicked chip gets
`.nq-picked`, a solid fill) and Send to Monday was greyed. Nothing had been clicked.

## Fix

The box is now **pre-filled with the top suggestion already applied**:

```
Current: Boy Jace (Jace Jaxon)
  → Jace Jaxson 91%
  → Ace Jaxon 90%

FULL FIELD VALUE — PREVIEW, click a name above to confirm
[ Boy Jace (Jace Jaxson) ]
was: Boy Jace (Jace Jaxon)
```

The label switches to amber while it's a preview.

### It is a preview only

- `resolutionType` stays `null`, so `nqCanSend()` returns **false** and Send to Monday stays
  **disabled** until a candidate is explicitly clicked.
- Nothing can be written from un-clicked text, so the standing rule — *a value only ever comes from
  a real Model DB profile* — is untouched.
- Rows with **no** candidates aren't pre-filled; there's nothing to propose.
- Typing in the box clears the preview flag, because it's then the human's value, not a proposal.

## The pre-fill would have introduced a bug

`nqUseSuggestion` computed the substitution from the **box**. Once the box is pre-filled it no longer
contains `r.probe` — so clicking a **second** candidate would find nothing to replace and silently
do nothing.

The substitution is now factored into `nqApplyPick()` and always resolves from `r.original`. That
makes it deterministic: whichever chip you click, you get the original with that one part swapped,
and switching between candidates never compounds edits.

## Verified against the real functions (18 checks)

| Check | Result |
|---|---|
| Box pre-filled with the top suggestion applied | ok |
| Row flagged as preview, **not** resolved | ok |
| **Send disabled** until a chip is clicked | ok |
| First chip → value confirmed, profile id recorded, Send enabled | ok |
| **Second chip applies correctly from the original** | ok |
| Switching chips back and forth stays clean | ok |
| Typing clears the preview flag; hand-typed text alone still not sendable | ok |
| A row with no candidates keeps its original | ok |
| `matched` without a profile id still cannot be sent | ok |

9 of these are now permanent in `nameqa-logic.test.js` (57 → 66), including the second-chip
regression guard and the `nqCanSend` gating.

## Note

`nqApplyPick(original, token, probe, name)` is now the single substitution path, shared by the
pre-fill and the chip click. If a third caller ever needs it, use that rather than re-deriving from
the box — the box is display state and may hold a preview or a hand edit.
