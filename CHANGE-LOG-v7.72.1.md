# CHANGE-LOG v7.72.1 — bugfix: the pinned toolbar was clipping the title row

**Type:** client only (`public/index.html`) + `tools/verify.js`. CSS only, no JS change. `server.js` untouched.
**Baseline:** v7.72
**Rollback tag on promote:** `beta-v56`
**Suite:** 812 total, 0 failed (verify.js 648; nameqa-logic 41; server-guard 38; scrape 53; sandbox 20; dedup 12)

## Reported

On All Models the title row was cut in half — "All Models", the "945 of 945 models" count and the
Refresh button all partly hidden behind the pinned controls row.

## Cause — my own workaround from v7.70

A sticky element's `top:0` pins to the **scrollport's content box**, and `#form-area` had
`padding:24px 32px`. So every sticky row pinned 24px *below* the visible top, leaving a 24px strip
that grid tiles scrolled through in plain view (42 sampled x-positions had a tile in it).

v7.70 covered that strip like this:

```css
.tb-sticky{ top:-24px; padding-top:32px; margin-top:-24px; }
```

Pin 24px higher, add 24px of padding to fill the gap with the row's opaque background, and cancel
that extra padding in normal flow with a negative margin. The *content* ended up exactly where it
was before — which is what I measured, and why it looked correct.

But the row's **box** now started 24px higher, and it has an opaque background, so it painted
straight over the bottom of whatever sat above it.

**I had an assert for this** — "at rest it still sits below the title row" — from an earlier
variant, and dropped it when I switched approaches. That's the process failure, not just the CSS one.

## Fix — remove the cause instead of the symptom

`#form-area`'s padding-**top** moves onto a `::before` spacer:

```css
.form-area{padding:0 32px 24px; overflow-y:auto; height:100%}
.form-area::before{content:''; display:block; height:24px}
```

With `padding-top:0` the content box top **is** the visible top, so a plain `top:0` pins flush — no
strip, no negative margins, nothing overlapping. The 24px of breathing room becomes ordinary
scrolling content, so it scrolls away instead of being a permanent dead band.

`.tb-sticky` simplifies to `top:0` / `margin:0 -32px 10px` / `padding:8px 32px`.

The **horizontal** negative margins stay and are load-bearing: they cover the scroll container's
left/right gutters so tiles don't show through the sides as they pass underneath.

## Knock-on, checked deliberately

`.sticky-status-bar` (`top:0`) and `.iv-notes-sticky` (`top:50px`) in the editors now pin 24px
higher too — flush rather than inset. Their 50px relationship to each other is unchanged.

Measured: status bar at offset **0**, notes bar at **50**, **12px** gap, no overlap, both still
hit-testable including the Back-to-grid button.

## Measurements for the fix

| Check | Result |
|---|---|
| Title / count / Refresh overlapped by the row | **no** |
| All three hit-testable | yes |
| Row pinned flush (offset 0) at scrollTop 600 / 4000 / 8640 | yes |
| Tiles bleeding above the pinned row | **0** |
| Row spans the full scroll-box width | yes |
| Save bar lands on the row's bottom | exact (39 / 39) |
| Breathing room at rest | 24px, and it scrolls away |

`verify.js` asserts the new padding model **and** `lacks()` both retired hacks, so neither can come
back quietly.

## Note for whoever touches this next

`#form-area` now has **no** `padding-top`. Anything sticky inside it can use a plain `top:0` and get
the visible top. If padding-top is ever reintroduced, every sticky `top` in the container needs
revisiting — that coupling is exactly what caused this bug.
