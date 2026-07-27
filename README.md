# Interview Tool (Carnal Media — Model Tool)

Internal web app for managing model/talent candidates on top of monday.com. Staff review candidates, manage headshots, run "casting sandbox" arrangements, and pull reference photos from social profiles — all through a single-page front end backed by a small Express server that proxies monday's GraphQL API.

## What it does

- **Candidate review UI** — single-page app (`public/index.html`) backed by monday.com boards for candidate data, a batch/staging board, and a casting priority stack.
- **Casting workflow** — "Port-to-Casting" links models from the main tracker into a casting subitem board; a "Casting Sandbox" lets staff save/restore arrangement states (stored as JSON on a dedicated monday board).
- **Headshot management** — upload, reorder, and fast-replace headshots as monday board assets.
- **Photo scraping** — pull candidate reference photos from Bluesky profiles, Twitter/X profiles (via the Xpoz SDK), or a generic web page (og:image / `<img>` extraction).
- **Image proxy** — serves/relays image bytes so the front end never needs direct third-party or monday asset URLs.

## Architecture

- **Frontend:** single static file, `public/index.html` (no build step, no framework).
- **Backend:** `server.js`, a single Express app that:
  - Serves the static frontend (gzip via `compression`, long-cache for static assets, no-cache on `index.html` so deploys show up immediately).
  - Proxies GraphQL to monday.com at `/api`, attaching the server-side monday token — the browser never sees it.
  - Enforces a **GraphQL allow-list guard**: every `/api` request is parsed (real AST, not string matching) and rejected unless it's a plain query/mutation against a pre-approved set of operations and board IDs. This replaced an earlier "forward anything" proxy that was effectively a blank check against the monday token.
  - Enforces a **shared-password gate** (`APP_PASSWORD`) on every data endpoint, checked with a timing-safe comparison. This is explicitly interim hardening — a stepping stone toward per-user SSO, not a replacement for it.
  - Rate-limits by IP: a generous limit on data endpoints, a strict limit that only counts *failed* auth attempts (so it can't be used to lock out a legitimate user).
  - Guards outbound scraping against SSRF: every fetch to a user-supplied URL is re-validated on each redirect hop (http/https only, no loopback/private/link-local/CGNAT/cloud-metadata addresses).
  - Sends `X-Robots-Tag: noindex` and a blanket-disallow `robots.txt` — this app is not meant to be publicly discoverable.

## Tech stack

- Node.js (>=20.18.1), Express 4
- `graphql` — used purely to parse/validate outgoing queries against the allow-list, not to run a GraphQL server
- `multer` — in-memory upload handling for headshots (25 MB cap, image MIME types only)
- `express-rate-limit`, `compression`
- `@xpoz/xpoz` — Twitter/X scraping SDK (optional dependency; app runs fine without a key, that feature just 503s)
- Deployed on Render (see `render.yaml`) — free-tier web service, `npm install` / `node server.js`

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONDAY_TOKEN` | Yes | monday.com API token. Server refuses to start without it. |
| `APP_PASSWORD` | Yes (to serve data) | Shared passphrase gating all data endpoints. Data endpoints fail closed if unset. |
| `MAIN_BOARD_ID` | No | Overrides the production main tracker board ID (used for staging). |
| `BATCH_BOARD_ID` | No | Overrides the production batch board ID (used for staging). |
| `XPOZ_API_KEY` | No | Enables Twitter/X photo scraping. Bluesky and generic page scraping work without it. |
| `PORT` | No | Server port (defaults per hosting platform). |

None of these are committed anywhere in the repo — set them in Render's environment settings (or a local `.env` you don't commit) before running.

## Running locally

```bash
npm install
MONDAY_TOKEN=xxx APP_PASSWORD=xxx node server.js
```

Then open `http://localhost:<port>`.

## Project structure

```
server.js            Express server: auth, GraphQL proxy + allow-list, uploads, scraping, image proxy
public/index.html     Entire frontend (single file, no build step)
public/logo-carnal.png
render.yaml           Render deployment config
tools/                 Test/verification scripts (run with `node tools/<name>.js`)
  verify.js              Pre-deploy check: syntax + GraphQL literal validation on index.html
  dedup-logic.test.js    Extracts and tests the candidate-dedup helpers from index.html
  scrape-logic.test.js
  sandbox-logic.test.js
  server-guard.test.js
  backfill-medthumbs.js       One-off backfill scripts (not part of the running app)
  backfill-extra-medthumbs.js
```

There's no `npm test` script wired up yet — the `tools/*.test.js` files are run directly with `node tools/<file>.js` and are self-contained (they read and exercise the actual functions out of `index.html`/`server.js` rather than relying on a test framework).

## Branches

- `main` — production
- `staging` — points at a separate staging monday board via `MAIN_BOARD_ID`/`BATCH_BOARD_ID`; everything else (casting, sandbox) is shared across environments since those boards aren't duplicated per-environment.

## Notes for whoever picks this up

- The in-code version comments (`v7.6x` in `server.js`) are an informal running changelog left by the previous author — there's no corresponding git tag scheme, just commit messages.
- The `/api` allow-list (board IDs + operation names) is the main thing to update carefully if new monday boards or mutations are added — it's a security boundary, not incidental config.
- `MONDAY_TOKEN` and `APP_PASSWORD` must be set in Render's dashboard for both the production and staging services; they are not in this repo.
