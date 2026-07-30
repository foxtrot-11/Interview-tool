# CHANGE-LOG v7.75.1 — Name QA: a sent row now looks like history

**Type:** client only (`public/index.html`) + `tools/nameqa-logic.test.js`. CSS and labels, no logic change to the write path.
**Baseline:** v7.75
**Rollback tag on promote:** `beta-v59`
**Suite:** 893 total, 0 failed (verify.js 668; nameqa-logic 82; server-guard 38; scrape 53; dedup 32; sandbox 20)

## Reported as a suspected bug — it wasn't one

After fixing two names in one field, the already-sent row still showed the pre-fix value
(`lucky Cruz, Jake Matthews, Cyrus Stark`) while the rebased row showed the corrected one. That
reads exactly like the v7.75 revert bug returning.

**It was correct.** A sent row is deliberately frozen — it holds the value *that* send wrote, because
it is the audit record of that write.

Verified against monday. Staging CT item `12642778427` ended as:

> `lucky Cruz, Jake Mathews, Cyrus Stark`

Both fixes present. And the log shows the propagation working as designed:

```
14:25:33  Original: lucky Cruz, Jake Matthews, Cyurs Stark
          Changed:  lucky Cruz, Jake Matthews, Cyrus Stark    ← Cyurs fixed

14:25:56  Original: lucky Cruz, Jake Matthews, Cyrus Stark    ← REBASED, carries the first fix
          Changed:  lucky Cruz, Jake Mathews,  Cyrus Stark    ← Jake fixed, Cyrus preserved
```

The second send's `Original` already contains the first fix. Compare yesterday, where it still read
the unfixed value and clobbered it.

## But the interface was still wrong

Two rows showing different values for the same field, with no explanation, is bad regardless of being
technically correct. So:

**A sent row is now visually unmistakable** — italic value, dashed box, muted green matching the
`✓ Sent` marker, instead of the live field's solid box. Its label reads:

> *Value written by this send at 14:25:33 UTC — history*

rather than *Full field value*. Opacity raised `.6` → `.78`: these rows **are** the audit trail and
the old value was too dim to read comfortably.

**Precision instead of a blanket caveat.** `nqPropagateSend` now also marks an already-sent row on the
same item+column as `superseded` when a later send changes that field. Only those rows get:

> 🕓 The field has changed since this send. The value below is what **this** send wrote — not what the
> field says now.

A sent row with nothing after it stays unannotated, because nothing about it is stale.

## Verified by replaying the reported sequence

Cyurs sent first, then Jake — against the real functions:

| Check | Result |
|---|---|
| The pending row rebases onto what was written | ok |
| …and then proposes **both** fixes | ok |
| The first send is **not** flagged until something follows it | ok |
| The earlier sent row is then flagged `superseded` | ok |
| Its frozen value is never rewritten | ok |
| The final write carries both fixes | ok |
| Neither row can be re-sent | ok |

8 now permanent in `nameqa-logic.test.js` (74 → 82).

## Note

Nothing in the write path changed — `nqCanSend`, `nqApplyPick` and `nqPropagateSend`'s rebasing
behave exactly as in v7.75. This release only changes what a sent row *looks like* and adds the
`superseded` flag.
