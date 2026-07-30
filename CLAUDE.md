# CLAUDE.md — Carnal Media Model Dashboard ("MODEL INTERVIEW v2")

Context file for AI assistants working in this repo.
Production (`main`): **v7.75.1** (promoted 2026-07-30).
Staging (`staging`): **v7.75.2**, awaiting the owner's review.

---

## 0. STOP — permission boundary. Read this before touching git.

**You may push to `staging`. You may not push to `main`. Ever.**

Not "after the tests pass". Not "after the marker greps clean". Not "it's a small fix". Not "the
user said push". `main` auto-deploys to production, which a small team uses for live work.
**Promotion to production is the owner's decision, and the owner makes it after loading staging in
a browser themselves.**

Your job ends at: push to staging → report what you changed and the numbers you measured → hand
over a test checklist → **stop and wait.**

The owner promotes with:

```bash
ALLOW_MAIN_PUSH=1 git push origin staging:main
```

That override exists for the owner. **You never use it, and you never suggest running it as
something you'd do.** `.githooks/pre-push` blocks pushes to `main` without it, and
`git push --no-verify` bypasses that hook — so the hook is a guardrail, not permission logic. The
rule above is the actual constraint.

Also yours-only: `git tag` / tag pushes for `beta-vNN`, any `--force`, and rollbacks.

### 0.1 Why this rule exists (do not rationalize around it)

*(Resolved: the CSS was fixed, a human verified staging, and v7.70 went to production properly on
2026-07-29 as `af77e9d` — 786 CSS rules parsing, confirmed in a browser. The rule below stands
regardless.)*

On 2026-07-29, v7.70 shipped a **broken stylesheet to production while a coworker was mid-task.**
Two CSS comment edits left prose sitting after the closing `*/`. The CSS parser read that prose as
a selector and discarded every rule after it: the app rendered completely unstyled, hidden modals
visible, views stacked on each other.

It reached production because the assistant:

1. Ran a `<script>` parse check that **never looked at the CSS**, and
2. Treated `curl … | grep -o "v7.70:"` as verification. **That grep only proves the file
   uploaded.** It says nothing about whether the app works.
3. Promoted `staging:main` on the strength of that grep — in the same session it had written
   "verify.js is substring-only, it cannot catch a layout bug" into this very file.

Every automated check was green while the app was unusable. That is the whole point: **green
checks are necessary and not sufficient.** A human's eyes on staging are the only gate that
actually holds.

### 0.2 What "verified" means

| Not verification | Verification |
|---|---|
| `curl \| grep "vN.NN:"` | A human loaded staging and said it's good |
| Full suite green | Browser-measured evidence (`document.styleSheets[…].cssRules.length`, computed styles of changed elements) |
| `node tools/preflight.js` passing | For layout/CSS/scroll work: before-and-after numbers, in a real browser |

For any CSS, sticky-positioning, scroll or containment change, report actual measurements — rule
counts, computed styles, `elementFromPoint` results — not "it should work".

### 0.3 Before any push

```bash
node tools/preflight.js
```

Must exit 0. Runs the JS parse check, **CSS integrity** (orphaned/unterminated comments, brace
balance, prose-in-stylesheet, rule-count sanity), `<div>` balance, `server.js --check`, the
version-marker/CHANGE-LOG pairing, and all six suites. The pre-push hook runs it too, so a broken
build can't reach even staging.

One-time per clone: `git config core.hooksPath .githooks`

**Keep this file current as part of every release** — version line, the suite table in §3, the
rollback-tag example, and any new §7 gotcha. It has drifted before (it sat at v7.67 while `main`
was on v7.68.1), and a stale context file actively misleads the next assistant.

---

## 1. What this is

A single-page web tool for managing ~950 adult-performer records, backed by monday.com.
Used by a small internal team for intake, screening, interviews, photo management, casting,
duplicate review, and (as of v7.67, with a write path since v7.68) name QA.

**It is not a typical SPA.** Nearly the entire client is one file:

| Path | What |
|---|---|
| `public/index.html` | ~570 KB. **All** markup, CSS, and JS inline. This is the app. |
| `server.js` | CommonJS Express server. Auth gate + hardened monday.com GraphQL proxy + file/photo endpoints. |
| `tools/preflight.js` | **Run before every push.** The release checklist as code — see §0.3. Must exit 0. |
| `.githooks/pre-push` | Blocks pushes to `main` without `ALLOW_MAIN_PUSH=1`; runs preflight. Enable: `git config core.hooksPath .githooks` |
| `tools/*.js` | Test suite (6 files, 897 assertions). Plain Node, no framework. |
| `CHANGE-LOG-v*.md` | Per-release write-ups (v7.67, v7.69–v7.75.2). Longer-form companions to the in-file changelog comment block. |
| `package.json` / `package-lock.json` | Deps. Render runs `npm install`. |
| `render.yaml` | Render service config. |
| `public/logo-carnal.png` | Logo. |

Repo: `github.com/foxtrot-11/Interview-tool` (note: **not** `-app`).
Local clone: `~/AI/interview-tool`.

---

## 2. Environments

| | Production | Staging |
|---|---|---|
| URL | `https://interview-tool-nwn0.onrender.com` | `https://interview-tool-staging.onrender.com` |
| Render service | `Interview-tool` | `Interview-tool-staging` |
| Branch | `main` | `staging` |
| monday board | `3636652411` (real) | `18419204393` (duplicate copy, 946 real items) |

Both auto-deploy on push. **Render free tier**: 0.1 CPU, spins down after inactivity
(~50 s cold start). That slowness is real and has caused multiple false "bug" diagnoses —
budget for it before blaming code.

`buildCommand: npm install` (not `npm ci`, so a lockfile slightly out of sync won't fail
the build). `startCommand: node server.js`.

### Environment variables (set in the Render dashboard, never committed)

| Var | Purpose |
|---|---|
| `MONDAY_TOKEN` | monday API token. Service account **inbox@carnalmedia.com** ("Monday Automatization & Integration"), the same account the Cloudflare Workers use. |
| `APP_PASSWORD` | Shared passphrase gate. Being replaced with Google auth — a dev owns that migration. |
| `MAIN_BOARD_ID` | Overrides the model board (staging points at the test copy). |
| `BATCH_BOARD_ID` | Evernote batch-import board. |
| `CONTENT_TRACKER_BOARD_ID` | v7.67. Name QA target. Unset ⇒ production Content Tracker. |
| `XPOZ_API_KEY` | Optional. Twitter/X scraping only; unset ⇒ that feature 503s cleanly and everything else works. |

**The password is not in the code.** `server.js` reads only `process.env.APP_PASSWORD`.
Changing it is a dashboard edit, not a release.

---

## 3. Release process (follow this exactly)

> **Steps 1–6 are yours. Step 7 stops at staging. The owner does step 8.** See §0.

**Fast path — this replaces steps 2/3/4/5 below and cannot be half-done:**

```bash
node tools/preflight.js
```

The prose version is kept for reference, but `preflight.js` is the thing that must pass. It exists
because this checklist was skimmed and shipped a broken stylesheet (§0.1).

Every release, without exception:

1. **Clean workspace per version** — copy the previous version's tree, never edit in place.
2. **Parse check every `<script>` block** in `index.html`:
   ```bash
   node -e "const fs=require('fs');const s=fs.readFileSync('public/index.html','utf8');const b=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];let bad=0;b.forEach(x=>{try{new Function(x[1])}catch(e){bad++;console.log(e.message)}});console.log(b.length+' blocks, '+bad+' errors')"
   ```
3. **`node --check server.js`** if the server changed.
4. **Full suite** — must stay green. Update asserts your change legitimately invalidates:
   ```bash
   for t in tools/*.js; do echo -n "$t: "; node "$t" | tail -1; done
   ```
5. **Version marker** — add a `vN.NN:` entry to the changelog comment block in
   `index.html`. This doubles as the deploy verification grep target.
6. **Package and VERIFY the zip by extracting it.** Do not trust that `zip` picked up
   what you listed — it has silently produced a one-file archive here before.
7. **Push to staging. Then STOP.** Report the change, the measurements, and a test checklist.
   ~~"promote to main → tag"~~ — **this line used to read "Deploy staging → verify → promote to
   main → tag" and that phrasing is what got read as authorization.** It is not. Steps 8+ are the
   owner's, performed after the owner has looked at staging in a browser. See §0.
8. *(owner only)* Load staging, confirm it works, then
   `ALLOW_MAIN_PUSH=1 git push origin staging:main`, then tag `beta-vNN`.

### Current suite

| File | Assertions | Covers |
|---|---|---|
| `verify.js` | 672 | Substring checks + **CSS structural integrity** (§2b) against client source |
| `scrape-logic.test.js` | 53 | Bluesky/Twitter URL + media parsing (real functions extracted from `server.js`) |
| `nameqa-logic.test.js` | 82 | Name-matching engine, run against **real** Content Tracker strings |
| `server-guard.test.js` | 38 | GraphQL allow-list guard, credential hygiene, SDK-loading rules |
| `sandbox-logic.test.js` | 20 | Casting sandbox planning + note normalization |
| `dedup-logic.test.js` | 32 | Duplicate grouping + `isEmptyVal`/`hasVal` against real monday value shapes |
| **Total** | **897** | |

**`verify.js` is substring matching — it cannot see a layout bug, and a substring assert can pass
on text that is in the wrong place.** Both v7.70 failures prove it: the sticky row was pinned
inside an 80px box (every assert green, feature useless), and the CSS comment break left the
asserted text present but outside its comment (every assert green, app unstyled). Anything
touching CSS, sticky positioning, scroll or containment must be exercised in a real browser and
reported with numbers.

`tools/` also holds `backfill-medthumbs.js` and `backfill-extra-medthumbs.js`. **These are not
tests** — they're one-off scripts that exit non-zero without env/args, so `for t in tools/*.js`
looks like two failures. Iterate `tools/*.test.js tools/verify.js` instead.

### Deploy commands

*No `#` comments inside these blocks — the operator's zsh lacks `interactive_comments` and they
error on paste (§7.8).*

**Staging — assistant may run this:**

```bash
cd ~/AI/interview-tool && git checkout staging && git pull && node tools/preflight.js && \
git add -A && git commit -m "vN.NN: ..." && git push origin staging && git show --stat HEAD
```

**Then confirm the deploy LANDED — this is not verification:**

```bash
curl -s https://interview-tool-staging.onrender.com/ | grep -o "vN.NN:" && echo MARKER-PRESENT
```

That prints `MARKER-PRESENT`, deliberately **not** `STAGING-OK`. It proves the file uploaded and
nothing more. It was previously labelled `STAGING-OK`, which is how a broken stylesheet got waved
through to production (§0.1). Staging is OK when a **human says so**.

**Promote — OWNER ONLY. The assistant does not run this and does not offer to:**

```bash
ALLOW_MAIN_PUSH=1 git push origin staging:main
```
```bash
git tag -a beta-vNN -m "production vN.NN" && git push origin beta-vNN
```

**Always** end the commit step with `git show --stat HEAD` and confirm the expected file
count. A commit silently containing fewer files than intended has burned a full deploy
cycle here (see §7). `git add -A` also sweeps up untracked strays — check the list.

**Rollback:** `ALLOW_MAIN_PUSH=1 git push --force origin <good-sha>:main`, then confirm production
serves the expected marker and that `document.styleSheets` rule count is healthy in a browser.

**Rollback tags:** `beta-vNN` where `NN = minor − 16`. v7.60 → `beta-v44`; v7.67 → `beta-v51`;
v7.69 → `beta-v53`; v7.70 → `beta-v54`; **v7.72.1 → `beta-v56` ← current production (`326c895`).**

⚠️ **`beta-v56` may not exist yet.** v7.71 / v7.72 / v7.72.1 were promoted together as `326c895`;
if no tag was pushed, production has no rollback marker. Create it with
`git tag -a beta-v56 -m "production v7.72.1" 326c895 && git push origin beta-v56` (owner only).
Known-good fallbacks: `beta-v53` (v7.69). **`beta-v54` points at the BROKEN v7.70 build** — see below.

⚠️ **`beta-v54` may still point at the BROKEN v7.70 commit (`f9bd0a1`), not the shipped one
(`af77e9d`).** The tag was created before the CSS fix and needs force-moving; check before
trusting it as a rollback target:

```bash
git ls-remote --tags origin | grep beta-v54
```

If it shows `f9bd0a1`, that commit is the unstyled build from §0.1 — **do not roll back to it.**
Fix with `git tag -f -a beta-v54 -m "production v7.70" af77e9d && git push -f origin beta-v54`
(owner only). The known-good fallback either way is `beta-v53` (v7.69).

**Step 5 is not optional.** v7.68 and v7.68.1 both shipped with no `vN.NN:` entry in the
`index.html` changelog block, which left `grep -o "v7.68:"` with nothing to match — the deploy
verification step silently had no target. Both were backfilled in v7.69. Also write the
matching `CHANGE-LOG-vN.NN.md`.

---

## 4. Architecture

### Server (`server.js`, CommonJS)

`/api` is **not** a passthrough. `validateGraphQL()` parses every request's AST and enforces:

- `ALLOWED_QUERY_ROOTS` = `boards`, `items`, `assets`
- `ALLOWED_MUTATION_ROOTS` = `change_multiple_column_values`, `change_simple_column_value`,
  `create_item`, `create_subitem`, `create_update`, `delete_item`
- `ALLOWED_BOARD_IDS` — every `board_id` argument and `boards(ids:)` selection, resolving
  variables
- Rejects fragments, batching, subscriptions, multi-operation documents

Plus `requireAuth` (`X-App-Auth` header, timing-safe compare) and a 500 req/min limiter.
**Keep this. Do not "simplify" it away.**

Endpoints: `/api` `/auth-check` `/config` `/health` `/upload` `/move-asset`
`/rearrange-photos` `/replace-headshot-fast` `/asset-bytes` `/proxy-image`
`/scrape-images` `/robots.txt`.

`/config` publishes per-environment board IDs to the client — that's how staging retargets
boards with zero code change. Add new boards to this pattern rather than hardcoding.

### Client (`public/index.html`)

- **`kanbanItems[]` is the shared store.** Loaded once by `loadKanban()`; every grid, the
  kanban, and the sandbox render from it. `modelById(id)` gives O(1) lookup via the
  `_kbById` Map (rebuilt on load, self-healing on miss).
- **Background photo-job queue** — `bgJobs[]`, `pumpBgJobs()`, strictly one job at a time
  globally. Kinds: `save`, `recrop`, `changehead`, `removephotos`, `regenthumb`. Each job
  snapshots its `boardId` at enqueue. Floating widget bottom-right; cancellable while
  queued. `BG_BATCH_THROTTLE_MS = 1200` paces *batch* jobs only.
- **`gql()` vs `gqlRetry()`** — idempotent `change_*` writes use `gqlRetry`.
  `create_item` / `create_subitem` / `delete_item` deliberately use plain `gql`: retrying a
  non-idempotent write could double-create.
- **Escaping** — `escapeHtml()` on every interpolated name/label/URL. Maintain this.
- **Storage** — `localStorage` holds only view preference + unsaved-edit drafts.
  `APP_PW` lives in `sessionStorage`. No credentials in `localStorage`.
- **Never use `localStorage` for anything sensitive**, and note artifacts/canvas previews
  don't support it at all.
- **`#form-area` is the only scrolling element.** `html,body{height:100%;overflow:hidden}`, so
  `window.scrollY` is **always 0** and `window.scrollTo()` is a **no-op**. Any scroll
  save/restore must read and write `document.getElementById('form-area').scrollTop`. This bit
  once already: the sandbox's v7.42 scroll restore used `window.scrollY`/`window.scrollTo` and
  therefore never worked at all until v7.70. Helpers: `faEl()`, `gridRememberScroll()`,
  `gridRestoreScroll()`, `faToggleTopBtn()`, `faScrollTop()`.
- **Sticky rows use the `.tb-sticky` class (v7.70)** — All Models / 2 / 3 / 4 / 5a, Kanban,
  Duplicates, Name QA. **Never put it on bare `.am-toolbar`**: the Casting Sandbox reuses that
  class inside `.sb-side`, which is already sticky with its own `overflow-y:auto`. Two traps,
  both documented at the CSS rule: a sticky element is confined to its **containing block** (so
  the row must be a direct child of the tall `*-view` wrapper, not of `.am-toolbar`), and sticky
  `top:0` pins to the scrollport's **content** box — 24px down, past `#form-area`'s padding —
  which leaves a strip that tiles scroll through. Hence `top:-24px` + `padding-top:32px` +
  `margin-top:-24px`. **v7.72.1 removed that coupling: `#form-area` has NO padding-top, so a plain `top:0` is the visible top.**
- **Layout, for anything sticky:** `body` → `header` (z 100) → `.selector-bar` (z 90) →
  `.main` (z 1) → `.sidebar` + `#form-area` (the scroll box, `padding:24px 32px`). Every
  `*-view` is a direct child of `#form-area` and is only ever `display:none`'d, never
  destroyed — so input values inside a hidden view survive. `renderAllModels()` does blow away
  `#am-grid.innerHTML` on every call, so restore scroll *after* it returns.
- **Sticky z-index band inside `#form-area`:** 80 filter/tag popovers · 70 `.shoot-picker` ·
  60 `.sticky-status-bar` (editors only) · 50 `.iv-notes-sticky` · **45 `.tb-sticky`** ·
  40 `.am-tile.picker-open` · 20 `.grid-save-bar`. The save bar is *also* sticky to the top and is
  a **later sibling** than the toolbar, so it needs `top:var(--tb-sticky-h)` to avoid hiding
  underneath — that variable is published by `tbSyncStickyOffset()` from the row's measured
  height minus `#form-area`'s computed padding-top. Fixed overlays sit far above this band:
  `.to-top-btn` 8500, `.kb-modal`/`#bgjobs` 9000, modals 9400–9750, `#toast` 9999,
  `#lightbox` 99999.

---

## 5. monday.com reference

### Boards

| Board | ID |
|---|---|
| Model DB (production) | `3636652411` |
| Model DB (staging test copy) | `18419204393` |
| Evernote batch import | `18416230588` |
| Casting Priority Stack | `8533133380` |
| └ its subitem board | `8533133826` |
| Sandbox save-states | `18420711215` |
| Content Tracker | `1818869745` |
| Content Tracker (test) | `18423979173` |

Content Tracker test board history: `18421082922` was the id originally documented here, but it turned out
to be an empty placeholder (4 stock columns, 5 dummy items) — not an actual duplicate, unlike the Model DB
test copy. On 2026-07-27, replaced with a real `duplicate_board` copy (`duplicate_board_with_pulses`) of the
production Content Tracker board — same column ids (including `character_s__1__bottom_` /
`character_s__2__top_`), 828 real items. `CONTENT_TRACKER_BOARD_ID` on the staging Render service must point
at `18423979173`, not the old id. Per the existing open item below, this copy's real performer names should
be deleted once Name QA testing is done, same as the Model DB copy.

### Model DB columns

| Purpose | ID |
|---|---|
| MODEL STATUS | `label` — write shape `{label:{index:N}}` |
| Headshot (file) | `files_mkncw5nm` |
| Extra pictures (file) | `file_mkp1n4bt` |
| Shoot tags (dropdown) | `dropdown_mkyj8js9` |
| Role (dropdown) | `dropdown_mknbe0p0` |
| Bluesky link | `dup__of_facebook` |
| Twitter/X link | `lien_internet` |
| Legal Name | `text_mknceqty` — **private; never treat as a stage-name alias** |

**Dropdown labels carry no creation timestamp.** `settings_str` is
`{limit_select, labels:[{id, name}], deactivated_labels:[]}` — there is no `created_at`. monday
hands ids out incrementally, so **descending label id is the only available "newest first"
signal** (used by `gridTagOptions()` since v7.69). It breaks only if an id is deleted and reused.
Note the key is `name`, not `label`, hence the `l.name||l.label` fallback everywhere.
As of 2026-07-29 `dropdown_mkyj8js9` has 16 active labels, ids 1–16, newest being 16 `test9`.

**Status indices** (these are *not* the same as the UI's tab `data-mode` values):

```
0 RETIRED    2 approved   3 REJECTED   5 applicant   6 "00 - DELETE"
7 interview  8 screen     9 review    10 potential  11 EVERNOTE   12 DUPLICATE
```

"Delete Model" in the editor sets index **6** — it moves the item to the DELETE group and
out of every view. It is **not** a hard delete and is reversible in monday.

**Per-site name aliases** (all legitimate alternate spellings, all count as correct):
`bfs_name`, `texte_mkn8y1ce`, `fsb_name`, `gct_name`, `gbs_name`, `msb_name`, `sbs_name`,
`texte__1`, `ttp_name`, `tct_name`, `bbk_name`, `bbs_name`.

### Casting subitem columns

| Field | ID |
|---|---|
| Pay | `text_mm522jb4` |
| Dates Booked | `long_text_mm35h07x` |
| Beginning Airport | `text_mm5exz7q` |
| End Airport | `text_mm5f30a9` |
| Flight Status | `status_mknc15zw` |
| Flight Options | `long_text_mm5e3mnj` |
| Flight Final Info | `long_text_mm5e6ctf` |

### Content Tracker columns

| Field | ID |
|---|---|
| Character(s) 1 (bottom) | `character_s__1__bottom_` (free text) |
| Character(s) 2 (top) | `character_s__2__top_` (free text) |
| CHARACTER 1 / 2 links | `board_relation_mkp7rk50`, `board_relation_mkp7d6q5` — **empty in practice** |

---

## 6. External automations (not in this repo — but they will bite you)

A separate Cloudflare Worker (`carnal-automations`, repo `~/Code/carnal-automations`)
runs the company's monday automations. Documented on monday board `18420756667`.

The one that matters here: **Content Tracker → Team Boards Field Sync.** It fires on
**any** Content Tracker column change and re-pushes 11 fields — including Char1/Char2 —
to Video / Photo / Writeup / Post, matched by **exact item name**. *CT always wins.*

Consequences:

- **Fix names in Content Tracker only.** Anything written directly to the four team boards
  gets reverted the next time that CT row changes.
- Each CT write triggers a webhook that writes 11 fields × 4 boards. A bulk QA run is a
  very different load profile from a human editing one row — batch and throttle.
- Prev/Next Bumper fields are **deliberately excluded** from the sync; syncing them once
  wiped real data. Don't re-add them.
- The durable root-cause fix (not yet done) is to make that Worker source Char1/Char2 from
  CT's `board_relation` instead of free text. It already reads `linked_items` elsewhere.

---

## 7. Hard-won gotchas

Each of these cost real debugging time. Read before diagnosing anything.

-1. **A misplaced CSS comment terminator silently destroys the whole stylesheet.** Text left after
   a closing `*/` (or before the next rule) is parsed as a **selector**, and the parser then
   swallows every rule that follows it. Symptom: the app renders with no styling at all, hidden
   modals visible, views stacked. It is NOT a JS error and produces no console error. This shipped
   to production as v7.70 (§0.1). `node tools/preflight.js` now catches it — orphaned/unterminated
   comments, brace balance, prose-in-stylesheet, and a rule-count floor. **When editing CSS
   comments, re-run preflight**, and remember the `<script>` parse check does not read CSS at all.
0. **`content-visibility:auto` silently clips absolutely-positioned children.** `.am-tile`
   carries it for grid perf across ~950 tiles, and it applies **implicit paint containment** —
   which clips popovers to the tile's box **no matter what `overflow` says**. This defeated
   `.am-tile.picker-open{overflow:visible}` for several releases: the shoot-tag list and picker
   were built, inserted, and then painted away, leaving only their top sliver visible. Fixed in
   v7.69 by adding `content-visibility:visible` to the open tile only.
   **If a popover inside a tile "isn't rendering," check containment before the JS.** The tell:
   `document.elementFromPoint()` over the popover returns the *tile*, not the popover row.
   `getComputedStyle` is misleading here — it reports `overflow:visible` while the clip is still
   in force.
1. **Writes only land on the production board.** Staging rejects writes to its own item
   IDs, so photo/status/tag jobs go red/Retry there. That is *expected*, not a bug.
2. **monday has no per-file delete.** Removing a photo means `/rearrange-photos` clears
   both photo columns and re-uploads the keepers — so kept photos get **new asset IDs**
   and med-thumb pairings are cleared. Recrop/change-headshot/remove-photos all share this.
3. **`board_relation` columns read as `null`/`[]` through the plain API.** Use the
   `linked_items` fragment. (Unverified whether CT's Character links are genuinely empty or
   just reading empty — worth confirming before relying on them.)
4. **Pagination**: use `boards(ids:[...]){items_page(cursor:"…")}`. Top-level
   `next_items_page` is *not* in the allow-list and isn't needed.
5. **`git assume-unchanged` was set on `package.json` and `package-lock.json`**, silently
   dropping them from every commit for weeks. If a file "won't commit," run:
   ```bash
   git ls-files -v | grep '^[a-z]'
   ```
   Lowercase flag = ignored. Clear with `git update-index --no-assume-unchanged <file>`.
6. **Xpoz SDK (`@xpoz/xpoz`) quirks** — all discovered the hard way:
   - Its CJS build `require()`s an **ESM-only** package ⇒ **must** load with dynamic
     `import()`, or it throws `ERR_REQUIRE_ESM` on Node 18/20 (works on 22+, which masks it
     in dev).
   - `timeoutMs` only bounds the SDK's *polling loop*, **not** the transport call — a
     hung backend hangs forever. Wrap every SDK call in a wall-clock `Promise.race`.
   - Queries become **async jobs polled every 5 s**; the vendor's own default timeout is
     **300 s**. Short budgets abort work that was still progressing.
   - `media_urls` is typed `string[]` but arrives as a **delimiter-joined string**.
   - `mcp.xpoz.ai` is intermittently 502 — retry once on fast transport failures.
7. **`pbs.twimg.com` serves a downscaled image** unless you append `?format=jpg&name=large`
   (measured 121 KB vs 245 KB for the same asset).
8. **The operator's shell is zsh without `interactive_comments`** — don't put `#` comments
   inside copy-paste command blocks; they error.

---

## 8. Feature map (where things live in `index.html`)

- **Tabs** — `data-mode` + `setMode(mode)`. Modes: `new`, `all`, `0`,`1`,`2`,`3`,`4`,`5a`,`5r`,
  `kanban`, `dup`, `nameqa`, `batch`, `sb`. Status modes are chosen via the nav dropdown
  (`#nav-status-menu`); the editor has its *own* separate `status-dd-*` control — the two
  collided once, so keep the names distinct.
- **Photo pipeline** — recrop (`openRecrop` / `openRecropLocal`), rotate, re-choose,
  remove-photos, thumbnail backfill. All route through the background job queue.
- **Casting Sandbox** — drag cast into BOTTOM/VERS/TOP + alternates, per-person shoot notes
  (pay, dates, both airports), save/share arrangements, port to Casting Priority Stack.
- **Duplicate Review Engine** (`dup`) — the UX template for audit tools: flag → preview →
  human approves → apply with per-row feedback.
- **Name QA** (`nameqa`, v7.67) — see §9.
- **Grid navigation** (v7.70) — every grid toolbar's controls row is pinned via `.tb-sticky`;
  Back-to-grid restores `#form-area.scrollTop` per `gridScope`; `.form-area` scrollbar is 12px
  and there's a fixed `#to-top-btn`. Shoot-tag *order* in the tile picker is newest-created
  first (`gridTagOptions()`, v7.69) — descending monday label id, the only recency signal
  monday exposes.

---

## 9. Name QA (v7.67 scan, v7.68 write path) — current state

Audits Content Tracker's two free-text character fields against the Model DB.
**Human-triggered. Since v7.68 it CAN write — one row at a time, never in bulk.**

Engine functions are pure and unit-tested (`tools/nameqa-logic.test.js`):
`nqNormalize`, `nqSplitSegments`, `nqSegmentParts`, `nqIsIgnorable`, `nqIsMalformed`,
`nqLev`, `nqSimilarity`, `nqSuggest`, `nqCategorize`, `nqScanValue`.

Two design decisions that came from real data — **do not "simplify" either**:

1. **Parenthesis handling.** A segment is clean if the whole string, the text *before*
   parens, **or** the text *inside* parens matches an accepted spelling. In this data the
   parenthetical is usually the real model name (`Father Snow (Adam Snow)`), but sometimes
   it's a position marker (`Legrand Wolf (bottom)`). Checking all three avoids deciding
   which — the original spec stripped parentheticals and would have false-flagged the
   entire msb/cbs/ttp series.
2. **Damerau-Levenshtein, not plain Levenshtein.** Transposition is the commonest typo and
   plain Levenshtein scores it as two edits. `Sean Xaiver` → `Sean Xavier` is 0.82 plain
   (ambiguous) vs 0.91 Damerau (clearly a typo).

Categories are **triage only** and never affect what gets written: likely typo (≥0.90),
ambiguous (0.75–0.90), marked `(new)`, malformed (unbalanced brackets), no match (<0.75,
no suggestion offered).

**Nothing is reconstructed.** Per the owner's explicit direction there is no auto-rejoining
and no auto-fixing. Each flagged token offers ≤3 ranked candidates as click-to-insert chips
plus a free-text box holding the entire field value.

### Write path (v7.68) — what shipped

- **Per-row `Send to Monday`. There is deliberately no bulk-apply button** — the owner's
  explicit constraint. Do not add one.
- **A suggestion always resolves to a real Model DB profile id**, so the write-back and the
  shared audit log both know exactly which profile a value was verified against. Hand-typed
  values are tagged `MANUAL` and kept distinct from a verified match.
- **Candidate thumbnails** (v7.68): `nqBuildIndex` also pulls each model's headshot, med-thumb
  preferred (same precedence as `gridImgAsset()`), because "is this the same Alex Smith?" is a
  visual check. The candidate index is **not** deduped by normalized name — two models can share
  a spelling and both must surface. The separate `byNorm` fast lookup keeps first-wins.
- v7.68.1: the manual-entry checkbox is always clickable; the "only for rows with no matching
  profile" text is a steer, not a hard block.
- Writes go to **Content Tracker only** (§6) — anything written straight to the four team boards
  is reverted by the sync Worker.

### Still open

- Dismissal persistence — without it every audit re-shows the same legitimately-unlisted
  names. Consider the sandbox save-states board as the storage precedent.
- Throttling on a bulk run was never exercised, because bulk was never built. If that changes,
  re-read §6 first: each CT write fans out to 11 fields × 4 boards via the sync Worker.

---

## 10. Open items

- [ ] **Verify `package.json` `engines`.** Should be `>=20.18.1` (undici in the Xpoz tree
      requires it). The bump may never have reached the repo — it was written during the
      `assume-unchanged` window (§7.5).
- [ ] **Twitter/X scraping is paused mid-debug.** v7.66 raised the budgets to match the
      vendor's async-job model but was never verified end-to-end. No successful real fetch
      has happened yet. If Xpoz's MCP endpoint stays flaky, a REST-native vendor
      (TwitterAPI.io / GetXAPI) drops the MCP dependency entirely and every parsing helper
      (`normalizeMediaUrls`, `isTwitterImageUrl`, `twimgSized`) carries over unchanged.
- [ ] Google auth migration (owned by a dev, replacing `APP_PASSWORD`).
- [ ] Name QA dismissal persistence (§9 "Still open").
- [ ] P3 cleanup from `CODE-REVIEW-handoff.md`: strip ~157 `v7.NN:` archaeology comments,
      de-duplicate the in-file changelog vs the `CHANGE-LOG-*.md` files, rename the editor
      status control to `editor-status-*`, centralize the ~46 hardcoded photo column-ID
      literals.
- [ ] Delete the staging Model DB copy's real performer PII when testing is done.
- [ ] Delete the Content Tracker staging test copy (`18423979173`, created 2026-07-27 for Name QA
      testing) once done — it's a real-data duplicate of the production board, same PII concern.
- [ ] `.DS_Store` and stray untracked scripts (`audit_tags.js`, `tools/backfill-*.js`)
      should be gitignored or committed deliberately.

---

## 11. Working style expected here

- Diagnose against the **real code** before proposing a fix; don't pattern-match.
- Flag scope creep, risk, and better alternatives *before* writing code. Disagree when
  warranted.
- Lead with the simplest solution that works.
- One focused release at a time, each independently testable and promotable.
- Prefer client-only changes; call it out explicitly when `server.js` changes.
- Never hardcode credentials. Never connect to live systems for testing.
- State assumptions explicitly instead of silently guessing.
