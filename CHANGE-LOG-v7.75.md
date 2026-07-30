# CHANGE-LOG v7.75 — Name QA: a second fix in the same field no longer reverts the first

**Type:** client only (`public/index.html`) + `tools/nameqa-logic.test.js`. `server.js` untouched.
**Baseline:** v7.74.1
**Rollback tag on promote:** `beta-v59`
**Suite:** 885 total, 0 failed (verify.js 668; nameqa-logic 74; server-guard 38; scrape 53; dedup 32; sandbox 20)

## Found in the live audit log, not by reasoning

One Content Tracker field can hold several bad names — `lucky Cruz, Jake Matthews, Cyurs Stark` —
and each produces its **own** flagged row. Every row snapshots the **whole field value at scan
time**, and a send writes that whole value back.

So sending the second row wrote a stale copy over the first row's fix and **silently reverted it.**

Proven twice on production. Item `10600078503`:

```
21:13:00  Original: lucky Cruz, Jake Matthews, Cyurs Stark
          Changed:  lucky Cruz, Jake Mathews,  Cyurs Stark    ← Jake fixed

21:13:03  Original: lucky Cruz, Jake Matthews, Cyurs Stark    ← STALE. Still double-t.
          Changed:  lucky Cruz, Jake Matthews, Cyrus Stark    ← Cyurs fixed, JAKE UNDONE
```

Same pattern on `10599953886` (Sean Xaiver / Apollo Adrii). Nothing warned. The owner only ended up
with correct data by re-scanning between sessions.

## Fix

`nqPropagateSend()` rebases every other **unsent** row targeting the same item+column onto the value
just written, then re-applies that row's own proposal on top.

Done **in memory, not by re-scanning** — a rescan is a full Content Tracker pass, and waiting for one
mid-batch was explicitly not acceptable.

Three cases, deliberately different:

| Row state | Behaviour |
|---|---|
| **matched** | re-applies its chosen profile against the new base |
| **preview** | re-applies its top suggestion against the new base |
| **manual** | hand-typed text is **never** overwritten — but flagged `staleManual` |

A manual row's text was written against the *old* field, so sending it as-is would clobber the fix.
It's preserved and blocked rather than silently rewritten.

If the row's own token is no longer present in the new value (two flagged rows overlapped) it's
marked `conflict`. **`nqCanSend` now refuses both `conflict` and `staleManual`**, so neither can
silently undo an earlier write. Those need a rescan, and guessing would risk data.

The UI explains every state inline — blue *"↻ Updated — another name in this field was fixed, so
this row now builds on that change"* when rebased cleanly, red warnings otherwise — plus a toast
reporting how many sibling rows moved. A value changing on screen is never unexplained.

## Verified by replaying the audit-log sequence

Against the real extracted functions:

| Check | Result |
|---|---|
| Both bad names flagged from one field | ok |
| Row 1's snapshot carries the unfixed name (reproduces the bug) | ok |
| Row 0 writes the Jake fix | ok |
| Row 1 rebases and fixes **both** | `lucky Cruz, Jake Mathews, Cyrus Stark` |
| The revert is gone | ok |
| A rebased preview **stays** a preview — Send still needs a chip click | ok |
| A `conflict` row is refused | ok |
| A `staleManual` row is refused | ok |
| A row on a **different** column of the same item is untouched | ok |

8 now permanent in `nameqa-logic.test.js` (66 → 74).

## Confirmed separately with the owner

**`Jake Mathews` with one `t` is the correct spelling.** The Model DB profile (id `10014964840`) is
right and the Content Tracker double-t was the error — so those production writes were correct, and
no data needs reverting.

⚠️ Note `tools/nameqa-logic.test.js`'s `CANON` fixture still lists `Jake Matthews`, which contradicts
production. Harmless — it's only a fixture and nothing reads it as truth — but **don't treat it as
authoritative** when checking a spelling.
