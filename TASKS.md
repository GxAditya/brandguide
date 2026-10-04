# TASKS — BrandKit

Derived from `PRD.md`. Ordered by dependency. Tick as you go.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundation

- [x] **T0.1** Spike TinyFish against `linear.app` to prove the read path
  - [x] `Fetch` `format:"html"` → confirm `<head>`/`<style>` stripped
  - [x] `Fetch` `include_selectors:["head"]` → confirm head returned verbatim
  - [x] `Fetch` a `.css` URL → confirm raw CSS returned as text
  - [x] `Search` → confirm name→domain resolution shape
  - [x] Confirm no direct HTTP is needed anywhere
- [x] **T0.2** Scaffold `brandguide/` — `package.json` (`"type":"module"`, zero
      deps), `.env.example`, `.gitignore`, dir layout
- [x] **T0.3** `src/tinyfish/client.js` — typed wrapper over
      `POST api.fetch.tinyfish.ai` + `GET api.search.tinyfish.ai`
  - [x] `X-API-Key` auth, 150 s client timeout
  - [x] 10-URL batching, `chunk()`
  - [x] 429 / 503 retry with exponential backoff + jitter
  - [x] per-URL error collection, never throws on partial failure
  - [x] request timing capture for the provenance panel
- [x] **T0.4** `src/tinyfish/errors.js` — map TinyFish error codes to friendly text
- [x] **T0.5** `test/` — Node built-in test runner wired up, `node --test`

## Phase 1 — Input resolution

- [x] **T1.1** `src/resolve/input.js` — accept URL *or* company name
  - [x] URL detection: scheme-less, bare host, path, subdomain, `@` handle
  - [x] punycode / IDN safety, strip tracking params
  - [x] refuse private IPs, localhost, non-http schemes
- [x] **T1.2** `src/resolve/domain.js` — `Search` a name, rank candidates
  - [x] score by official-domain signals (`about`, `company`, `contact`, og)
  - [x] return top-N with the reasoning attached
- [x] **T1.3** `src/resolve/canonical.js` — follow `final_url` redirects, verify reachability

## Phase 2 — Crawl & corpus

- [x] **T2.1** `src/crawl/head.js` — `Fetch(include_selectors:["head"])`
  - [x] og:*, twitter:*, theme-color, description, canonical
  - [x] stylesheet URLs (cap 12), icon links, apple-touch-icon, manifest
- [x] **T2.2** `src/crawl/css.js` — `Fetch` each stylesheet, keep raw text (cap 2 MB each)
- [x] **T2.3** `src/crawl/manifest.js` — `Fetch` webmanifest → `theme_color`, icons
- [x] **T2.4** `src/crawl/pages.js` — link-following page selection
  - [x] score candidate links by path intent: `about` `careers` `blog` `press`
        `pricing` `manifesto` `customers` `docs`
  - [x] never crawl off-domain, never crawl auth/cart/checkout
  - [x] cap at N, de-dup by path shape
- [x] **T2.5** `src/crawl/assets.js` — verify a candidate asset really exists via `Fetch`
- [x] **T2.6** Concurrency helper — run independent `Fetch` stages in parallel

## Phase 3 — Extractors

- [x] **T3.1** `src/extract/color.js`
  - [x] CSS custom properties, alias-resolved
  - [x] `theme-color` meta, manifest `theme_color`
  - [x] weighted hex/rgb/hsl frequency from CSS
  - [x] filter: near-duplicates, greys, <3% frequency noise
  - [x] name colours via nearest named CSS colour
  - [x] assign semantic roles: primary/secondary/accent/bg/surface/text/muted/border
  - [x] sRGB ⇄ HSL, WCAG relative luminance + contrast ratio
- [x] **T3.2** `src/extract/typography.js`
  - [x] `@font-face` family/weight/style/src
  - [x] `font-family` declarations, frequency-weighted
  - [x] Google Fonts / Bunny / Fontsource `<link>` detection
  - [x] classify: custom webfont vs system stack vs serif vs sans vs mono vs display
  - [x] resolve fallback stacks, drop framework noise (`-apple-system` unless dominant)
  - [x] derive type scale from `clamp()`/`rem` rules
- [x] **T3.3** `src/extract/logo.js`
  - [x] candidates from `<link rel=icon|apple-touch-icon>`, og:image, manifest icons
  - [x] score SVG > PNG-512 > PNG-180 > favicon.ico
  - [x] prefer SVG, prefer large `sizes=`, prefer same-origin
  - [x] **verify each through `Fetch`**; drop anything that returns no content
  - [x] classify mark-only vs lockup by aspect ratio
- [x] **T3.4** `src/extract/identity.js` — name, tagline, description, industry
- [x] **T3.5** `src/extract/voice.js` — sentence-level linguistics (see T4.3 detail)
- [x] **T3.6** `src/extract/messaging.js`
  - [x] h1/h2/h3 harvest across pages
  - [x] TF-IDF keyword salience
  - [x] boilerplate vs distinctive copy split (nav/footer/legal)
  - [x] tagline candidates from og:title / h1 / title
- [x] **T3.7** Every extracted value carries `source: { url, method }`

## Phase 4 — Endpoints

- [x] **T4.1** `POST /api/v1/brand-guide` — compose all extractors into the kit
- [x] **T4.2** `POST /api/v1/identity` — deep CSS forensics, token graph, contrast matrix
- [x] **T4.3** `POST /api/v1/voice` — deep copy crawl + tone vector + do/don't
- [x] **T4.4** `POST /api/v1/compare` — multi-brand diff, CIEDE2000 + cosine distance
- [x] **T4.5** `GET /api/v1/schema` — JSON Schema
- [x] **T4.6** `GET /api/v1/health`
- [x] **T4.7** Shared request pipeline with per-stage timing streamed to the UI

## Phase 5 — Output formats

- [x] **T5.1** `src/export/markdown.js` — deck-ready doc with swatch tables
- [x] **T5.2** `src/export/css.js` — `:root` custom properties + type ramp
- [x] **T5.3** `src/export/tailwind.js` — `theme.extend` block
- [x] **T5.4** `src/export/styledictionary.js` — Style Dictionary v3 shape
- [x] **T5.5** `src/export/figma.js` — Figma Variables collection JSON
- [x] **T5.6** `src/export/svg.js` — swatch sheet, single file, downloadable

## Phase 6 — Server

- [x] **T6.1** `src/server/http.js` — zero-dep router, JSON body limit, CORS
- [x] **T6.2** Wire the four endpoints + supporting routes
- [x] **T6.3** Static file serving for the UI
- [x] **T6.4** Error envelope `{ error: { code, message, detail } }`
- [x] **T6.5** Never log `TINYFISH_API_KEY`

## Phase 7 — UI

- [x] **T7.1** Layout + design system (no framework, no build)
- [x] **T7.2** Input form: URL or company name, depth selector
- [x] **T7.3** **Live pipeline log** — each TinyFish call appears as it lands
- [x] **T7.4** **Render the guide in the brand's own colours + fonts**
- [x] **T7.5** Sections: logo lockup · palette w/ contrast · type specimen ·
      tone meter · pillars · provenance · confidence
- [x] **T7.6** Export buttons (json / md / css / tailwind / figma / svg)
- [x] **T7.7** Compare view (2–5 brands, side by side)
- [x] **T7.8** Empty / error / loading states that are actually designed
- [x] **T7.9** Responsive

## Phase 7c — Product surface

The prototype became a product surface. Two outputs instead of four, and
everything that would not survive a real user removed.

- [x] **T7c.1** Guide and Compare only. Identity and Voice stay on the API; the
      guide already carries their measurements
- [x] **T7c.2** Activity panel and API/Schema/Status nav removed
- [x] **T7c.3** Sources read moved into a modal that closes when the run does
- [x] **T7c.4** Composer in the stage, options in the rail, endpoint renamed to
      output
- [x] **T7c.5** Document header: name, domain, confidence, pages, stylesheets,
      timestamp
- [x] **T7c.6** Benchmark view as a signal matrix, plus distinctiveness and
      owned vocabulary
- [x] **T7c.7** Exports render in the browser from the guide in memory, via the
      same renderers the API serves
- [x] **T7c.8** `GET /api/v1/brand-guide` so an export can be linked
- [x] **T7c.9** Focus trap, Escape to cancel, and reduced-motion handling on
      every new surface

## Phase 7b — Paged deck

The single scrolling sheet became a paged document. Replaces T7.4 and T7.5.

- [x] **T7b.1** `public/deck.js` + `deck.css`: landscape 1200x900 canvas scaled
      to fit, so a page is identical on any screen and prints one page per sheet
- [x] **T7b.2** Page anatomy from the reference deck: three-column running
      header, rule, then content. Sections open on full-bleed plate pages
- [x] **T7b.3** Header column 3 carries the source domain and extraction date.
      Not the template author's attribution, which is never reproduced
- [x] **T7b.4** Two output modes. Deterministic: exactly seven measured pages,
      and no written page among them. LLM: the full document, length driven by
      the `pages` budget
- [x] **T7b.5** Cover is unnumbered and carries no plate
- [x] **T7b.6** The cover uses `logos.lockup`, the horizontal logo, not
      `logos.primary`, which is usually the app icon. Casing is the brand's own
- [x] **T7b.7** Header column 3 carries no text. It is neither the template
      author's attribution nor extraction provenance; only the topic number,
      page number and section remain
- [x] **T7b.8** Page number reads `Page: 4`
- [x] **T7b.9** Geometry pinned to the reference by pixel measurement: side
      margin 75px, header rule at y=172, split copy column at x=436, cover
      lockup at x=437, two distinct label geometries on the weights and
      scaling pages
- [x] **T7b.10** The document is always light. Paper and ink are fixed, never
      taken from the brand: a guide that adopts a dark brand's background
      becomes a screenshot of that brand's site and prints as black pages
- [x] **T7b.11** No contents and no contents-style navigation in deterministic
      mode; both appear only when a narration layer produced the full document
- [x] **T7b.12** Swatches named by declared role, then by the brand's own CSS
      token name, rather than by nearest CSS colour name
- [x] **T7b.13** Chrome recoloured to a Cappuccin Mocha rose system, green
      removed from status colours included
- [x] **T7b.14** Print stylesheet: every page prints, not just the one on screen.
      Verified at 7 pages measured and 15 pages narrated
- [x] **T7b.15** Deck helpers exported and unit tested: the seven-page contract,
      lockup selection, swatch naming, variable-axis weight stops, tint maths,
      page clamping
- [x] **T7b.16** Logos keep their colour. SVG source is read through TinyFish
      Fetch and returned sanitised as `logos.*.svg`, then inlined rather than
      loaded as an image, so `fill="currentColor"` resolves against the page
      instead of rendering a `currentColor` mark flat black
- [x] **T7b.17** `svgTone` reads the mark's own fills and gradient stops and
      reports `light` / `dark` / `inherit`, so a white mark is shown on a dark
      plate and a dark one on a light plate. Right asset, wrong surface is the
      same class of bug as the greyscale one
- [x] **T7b.18** The Logotype page typesets the name in the brand's heading face
      rather than showing the lockup, which would repeat the mark from the
      previous page. Matches the reference deck

## Phase 8 — Verification

- [x] **T8.1** Unit tests: colour maths, HSL, contrast, CIEDE2000, tokenizer, router
- [x] **T8.2** Fixture tests: canned HTML/CSS/JSON → expected extraction
- [x] **T8.3** Live smoke script over 3+ real brands, no hardcoding
- [x] **T8.4** Schema self-validates its own output
- [x] **T8.5** Confirm app works with `LLM_API_KEY` unset
- [x] **T8.6** Confirm no target-site HTTP outside TinyFish (`grep fetch` audit)
- [x] **T8.7** Gemini provider (`GEMINI_API_KEY`, `GEMINI_MODEL`), selectable from
  `.env` alongside any OpenAI-compatible endpoint
- [x] **T8.8** Full-document fixes: a written introduction page, the wordmark
  confined to the logotype page, and `print-color-adjust` so palette swatches
  survive the print pipeline

## Phase 9 — Submission

- [x] **T9.1** `README.md` — what it does, how to run, how TinyFish is used
- [x] **T9.2** `docs/TINYFISH.md` — the required "how TinyFish is used" note
- [x] **T9.3** Demo script + recorded output for 3 brands
- [x] **T9.4** LinkedIn post draft, tagging @TinyFish
- [x] **T9.5** Discord `#showcase` post draft
- [x] **T9.6** Repo link + notes

---

## Status log

| Date | Note |
| --- | --- |
| — | Spike confirmed: `include_selectors:["head"]` is the key that keeps 100% of reads inside TinyFish Fetch. |
| — | Confirmed `Fetch` returns raw CSS for a stylesheet URL, so brand tokens are readable through the same channel. |
| — | Found that `Fetch` cannot verify images by content, but its error code can: `empty_content` means the asset exists, `page_not_found` means it does not. |
| — | Removed a destructive at-rule "unwrapper" that was silently eating large parts of every stylesheet. |
| — | Found translucent tokens collapsing onto solid black (`--header-border: #00000014`) and started excluding sub-60% alpha. |
| — | Found frequency outranking declared tokens, and added tiering: `--color-brand-bg` beats a hex seen 40 times. |
| — | Found vendor-prefixed tokens (`--govuk-brand-colour`) invisible to the namespace list, and added the trailing-colour-word rule. |
| — | Found `font-family: object-fit\: cover` in Patagonia's live CSS, and icon fonts being reported as typefaces. |
| — | Found `var(--pata-font-serif)` stacks resolving to nothing; typefaces were only reachable through custom properties. |
| — | Found batched stylesheet fetches tripping the rate limit and silently losing the `@font-face` rules. Capped concurrency at two. |
| — | Found Search returning a LinkedIn profile ahead of the official site; added profile-platform rejection and per-part URL scoring. |
| — | Found GOV.UK resolving to the name "Gov" because it has no `<h1>`; recovered the name from how the site writes its own domain. |
| — | 109 tests green, including all 34 CIEDE2000 reference pairs to 4 decimal places. |
| — | Demo runs clean on Linear, GOV.UK and Patagonia; all three validate against the published schema. |
| — | Guide rebuilt as a paged deck. 155 tests green, including the seven-page deterministic contract, lockup selection, the page budget, SVG sanitisation and tone detection, and the two helpers that decide how a swatch is named and how a variable axis becomes weight stops. |
| — | Found `logos.primary` is SVG-first, so for Tailwind it returned the dark rounded-square app icon rather than the actual logo, which then rendered invisible on a dark cover. Added a separately ranked `logos.lockup` for cover surfaces. |
| — | Found the deck forced `text-transform: uppercase` on the cover name, rendering `tailwindcss` as `TAILWIND CSS`. Casing is part of the identity, so it now uses the brand's own. |
| — | Found the deck adopted the brand's background as its paper, so a dark brand produced a book of black pages. The document is now always light; the brand colours only reach swatches, plates and specimens. |
| — | Found the Logomark page showed the whole lockup, repeating the mark already shown on the Logotype page. A logotype is the wordmark alone, so that page typesets the name again. |
| — | Found logos rendered greyscale while the brand uses colour on its own site. Not a filter: an `<img>` cannot inherit from the page, and `fill="currentColor"` resolves to black across that boundary, so a cyan mark arrives black. SVG source is now read and sanitised server-side, then inlined. |
| — | Found the deck read the source's colours nowhere, so a white mark on a white page was one wrong asset away from invisible. `svgTone` measures the mark's own fills and gradient stops and picks the plate to match. |
| — | Found `.layout` being a `flex: 1` grid, so `align-content: stretch` inflated its rows and left a dead band under the rail once stacked. Pre-existing, and it affected the old sheet too. |
| — | Found every component with its own `display` silently ignoring the `hidden` attribute, so the empty status box was rendering on load. Fixed for the two components that needed it rather than with a global `!important` that also broke the deck's print styles. |
| — | Found Linear declaring `font-weight: 100 900`, which read as two weights and printed every specimen row labelled "Thin". A declared range is now sampled at the stops a guide actually documents. |
| — | Found the three specimen paragraphs still carrying default `<p>` margins, which pushed the fourth weight row off the bottom of the page. |
| — | Found the palette value block rendering as one interleaved stack instead of the reference's two side-by-side columns, and twice the height for no gain. |

---

## Deviations from the original plan

1. **No at-rule unwrapping in the CSS reader.** Originally planned; removed after
   it proved lossy and unnecessary, since every extractor regex already matches
   at any nesting depth.
2. **Batch concurrency capped at two.** Not in the original plan. Added after
   firing all stylesheet batches at once lost a third of them to the rate limit,
   taking the `@font-face` rules with them.
3. **Asset verification by error code, not content.** The original plan assumed
   Fetch could read an image's bytes. It cannot; it reads text. Existence is now
   proven by `empty_content` vs `page_not_found`.
4. **Candidate fallback on resolution.** If the top domain from Search cannot be
   read, the next candidate is tried instead of failing the run.
5. **Shipped without the LLM layer enabled.** It works and is documented, but the
   deterministic core is the default and is what the demo proves.