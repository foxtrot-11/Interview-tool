# CHANGE-LOG v7.74 — Name QA: composite names and shared-surname scoring

**Type:** client only (`public/index.html`) + `tools/nameqa-logic.test.js`. `server.js` untouched.
**Baseline:** v7.73.1
**Rollback tag on promote:** `beta-v58`
**Suite:** 864 total, 0 failed (verify.js 664; nameqa-logic 57; server-guard 38; scrape 53; dedup 32; sandbox 20)

Two reported bugs in the matcher.

---

## 1. Composite names were being flattened

A Content Tracker value is often `CharacterName (PerformerName)` — e.g. `Boy Jace (Jace Jaxon)`.

`nqSegmentParts` returns `[whole, before-parens, inside-parens]`, and `nqScanValue` probes the
**last** one. So the match was already being made correctly against the parenthetical performer
name — that part was right.

But `nqUseSuggestion` replaced `r.token`, the **whole segment**. Picking `Jace Jaxson` therefore
produced:

```
Boy Jace (Jace Jaxon)   →   Jace Jaxson          ✗ character name destroyed
```

### Fix

The scan now records **which part it probed** and carries it onto the row; `nqUseSuggestion`
substitutes only that part:

```
Boy Jace (Jace Jaxon)   →   Boy Jace (Jace Jaxson)   ✓
Sean Xaiver             →   Sean Xavier              ✓ unchanged
```

A plain segment is unaffected because `probe` falls back to the whole token. Guarded: if the probe
is no longer present in the box (hand-edited in between), it falls back to replacing the whole token
rather than silently doing nothing.

---

## 2. A shared surname scored like a typo

Whole-string edit distance overstates similarity when two people share a surname, because the
matching half of the string swamps the differing half. From your live data:

| Comparison | Before | What it actually is |
|---|---|---|
| `Zander Woods` vs `Zander Woodz` | 92% | a real typo |
| `Zander Woods` vs `Lance Woods` | **75%** | **a different person** |

75% put a different person in the same confidence band as a genuine typo.

### Fix — a given-name gate

A personal name is *structured*: get the given name wrong and it's a different person, however well
the surname matches. So when both strings have 2+ tokens and their **first** tokens are clearly
different (below `NQ_GIVEN_GATE = 0.70`), the score is multiplied by that first-token similarity.

**Deliberately a gate, not a general reweighting.** Real typos land in given names too, and
penalising those would break the tool's main job. Measured:

| First tokens | Similarity | Gated? |
|---|---|---|
| `sean` / `sean` | 100% | no |
| `jace` / `jace` | 100% | no |
| `cyurs` / `cyrus` | 80% | **no** — a live transposition typo, comfortably clear |
| `zander` / `lance` | 50% | **yes** |

Result:

| Comparison | Before | After |
|---|---|---|
| `Zander Woods` vs `Zander Woodz` | 92% | **92%** unchanged |
| `Zander Woods` vs `Lance Woods` | 75% | **38%** |
| `Sean Xaiver` vs `Sean Xavier` | 91% | **91%** unchanged |
| `Cyurs Stark` vs `Cyrus Stark` | 91% | **91%** unchanged |
| `Jace Jaxon` vs `Jace Jaxson` | 91% | **91%** unchanged |

Single-token names are never gated — there's no given/surname structure to reason about.

### ⚠️ One consequence to be aware of

38% is **below** `nqSuggest`'s 0.75 inclusion floor, so a different-person surname match is now
**not offered at all**, rather than offered with a low score.

You said it "makes sense you are showing" Lance Woods, so this may not be what you want. If you'd
rather keep it visible with an honest low score, the floor needs lowering (say to 0.35) — a one-line
change, but it will also admit other weak matches across the board. Say the word either way.

---

## Tests

All **41** pre-existing Name QA assertions pass untouched — that was the main risk, since the
scorer is shared by every category. **16 new** (41 → 57), covering:

- the gate fires on a shared surname and **does not** fire on given-name typos
- the real typo now outranks the different-person match by a wide margin
- single-token names aren't gated
- the gated candidate is genuinely dropped from `nqSuggest`
- the probe is the parenthetical, and falls back to the whole token without parens
- the composite substitution keeps the character name
- an already-correct composite is left intact
- `nqScanValue` actually records `probe` on the flagged row — without that the fix can't reach the UI
