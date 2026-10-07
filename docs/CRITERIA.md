# How each approval criterion is met

Every criterion on the bounty, with the code and the evidence.

This is the accuracy argument. The README covers what the product is and how to
run it; `TINYFISH.md` covers the read layer in depth. Nothing here repeats
either.

Where a claim in this file was wrong, it says so rather than quietly changing the
number, because "this used to claim four endpoints and there are two" is more
useful to a reviewer than a doc that silently lost a section.

---

### 1. Fetch does the core extraction work

**Every byte of the target site enters through TinyFish.** There is no direct
`fetch()` of the customer's website, no headless browser in the default path, and
no scraping library.

There are exactly two places the code opens a socket to the outside world:

- `src/tinyfish/client.js` → the target web, via TinyFish Search and Fetch
- `src/pipeline/llm-gemini.js` and `src/pipeline/llm-openai.js` → the *caller's
  chosen LLM endpoint*, and only when they send an `X-BrandKit-Llm-Key` header.
  They never touch a target site.

"Exactly two" is about targets, not files: three files open sockets, two of them
to the same class of destination.

```bash
grep -rnE "fetch\(|https\.get|http\.request|axios|cheerio|puppeteer|playwright" src --include="*.js"
# -> src/pipeline/llm-openai.js, src/pipeline/llm-gemini.js
#    (the optional LLM endpoints, not a target site)
```

Note the `=` form: `--include="*.js"` is a GNU grep extension that fails on BSD
grep, which is why this command is written as it is.

The TinyFish client does not appear in that list because it calls an injected
`fetchImpl` rather than the global `fetch`. It is the only path to a target site.
That distinction is worth stating plainly, because an auditor running the grep
above will not see the module that does all the reading.

The five load-bearing uses:

| What | TinyFish surface |
| --- | --- |
| Name → domain, competitor discovery | `Search` |
| og tags, theme-color, stylesheet URLs, icon links | `Fetch` + `include_selectors: ["head"]` |
| Brand tokens and `@font-face` rules | `Fetch` on each stylesheet, returned as raw CSS |
| Headings and copy across several pages | `Fetch` with `links` and `image_links` |
| Logo existence | `Fetch` on the asset URL, interpreted via its error code |

Browser and Agent are deliberately unused: they are metered, and Fetch already
renders in a real browser.

`src/resolve/domain.js` does contain a list of hosting and profile platforms
(`notion.site`, `vercel.app`, `linkedin.com`, …). Those are properties of the web
rather than brands: they tell the resolver that a hosted page is not a company's
own site. No demo brand appears anywhere in `src/`.

```bash
grep -rniE "\b(linear|gov\.uk|patagonia|asana|stripe)\b" src --include="*.js"
```

Every hit is a comment explaining a rule. One is worth naming because it could
read as an exception: `src/resolve/domain.js:30` lists `vercel.app` and
`notion.site` as generic hosting platforms to reject, which is a property of the
web rather than brand knowledge.

### 2. Extracted details are accurate to the live site

Six mechanisms, each covered by tests:

1. **Ground truth over inference** — `<meta name="theme-color">` and the web
   manifest are read and reported as declared, not guessed.
2. **Declared intent beats frequency** — `--color-brand-bg: #7070ff` outranks a
   hex seen 40 times. Tokens are tiered (`declaredRole` → `component`) before
   scoring, so a component's `--header-bg` can never win.
3. **Translucent overlays are excluded** — alpha below 0.6 is counted and
   discarded. Without this, `--header-border: #00000014` became a solid black
   border.
4. **Icon fonts and escaped class names are rejected** — Patagonia's
   `patagonia-icons` and its real-world `font-family: object-fit\: cover`.
5. **Verify, never assume** — a logo URL is returned only if Fetch proves it
   resolves.
6. **Confidence is measured** — per section, from how many independent sources
   agreed. Inferred values are labelled `inferred`.

Spot-checkable against the live sites, from the committed run in `demo-output/`:

| | Linear | GOV.UK | Patagonia |
| --- | --- | --- | --- |
| primary | `#7070ff` = `--color-brand-bg` | `#1d70b8` = `--govuk-brand-colour` | `#66b87d` (inferred, labelled) |
| text | `#282a30` = `--color-text-primary` | `#0b0c0c` = `--govuk-text-colour` | `#222222` (inferred, labelled) |
| heading face | Inter Variable | GDS Transport | Ridgeway Sans |
| body copy on the page | 14.34:1 AAA | 19.59:1 AAA | 15.91:1 AAA |

Patagonia's full contrast matrix is seven pairs, and four of them **fail**:
link text 2.41:1, accent on a card 2.23:1, button label 2.41:1, text against a
hairline panel 1.95:1. The guide reports those failures rather than hiding them.

### 3. Works for any site rather than a hardcoded few

Nothing in `src/` names a brand, a domain or a selector. The demo list in
`scripts/demo.mjs` is data, and the pipeline is identical for all three.

The three demo sites were chosen to break naive extractors:

- **Linear** — Next.js SPA, 49 build-hashed stylesheets, tokens in one late file
- **GOV.UK** — no framework, no `<h1>`, tokens behind a vendor prefix
  (`--govuk-brand-colour`), which only the colour-word rule can see
- **Patagonia** — typefaces reachable only through `var()` indirection rather
  than a direct `@font-face`, plus a copy-paste bug in its own CSS
  (`font-family: object-fit\: cover`)

Domain resolution is generic: Search candidates are scored on URL parts, hosted
profile platforms are rejected, and query strings are stripped before crawling.
If the top candidate cannot be read, the next one is tried.

Over HTTP, against a running server:

```bash
for n in linear notion stripe patagonia "GOV.UK"; do
  curl -s -X POST http://localhost:3000/api/v1/brand-guide \
    -H 'content-type: application/json' \
    -H "x-brandkit-tinyfish-key: $TINYFISH_API_KEY" \
    -d "{\"input\":\"$n\",\"depth\":\"quick\"}" >/dev/null
done
```

The committed `demo-output/compare.json` covers a fourth brand, **Notion**, which
appears nowhere in the code, at `#1313ba` with NotionInter. That is the evidence
the resolver is not tuned to the demo set.

### 4. Output is structured and reusable by other tools

JSON Schema for the guide lives in `src/schema.js` and is exported as
`BRAND_GUIDE_SCHEMA`. It **enforces provenance**: a logo object is invalid unless
`verifiedBy` is `tinyfish-fetch`, so an unverified asset cannot be represented.

`TINYFISH_API_KEY=... node scripts/demo.mjs` validates each real extraction
against that schema, and all three pass.

Seven export formats, all generated from the same token tree:

`json` · `markdown` · `css` (`:root` custom properties) · `tailwind` (theme
block) · `styledictionary` (v3 shape) · `figma` (Variables collection with
hex-preserving descriptions) · `svg` (single-file swatch sheet)

> There is no `GET /api/v1/schema` route. Earlier drafts of this file claimed one.
> The schema is a module export, not an endpoint; add a route if you want it
> served.

### 5. Goes beyond summarising a homepage

- Reads **up to 10 pages** at `--depth deep` (5 at `standard`, none at `quick`),
  selected by generic path-intent scoring (`about` `careers` `customers` `pricing`
  `press` `blog`), staying on-domain and skipping auth, legal and transactional
  paths.
- Reads **every stylesheet it can get through**, prioritised by URL signal rather
  than document order, up to 50 at `standard` and 60 at `deep`.
- Resolves `--var` alias chains and reports the **token graph** — which tokens
  are literals, which point at another, and which many others depend on.
- Builds a **contrast matrix** over real foreground/background pairs and grades
  it against WCAG 2.1, reporting the failures.
- Runs **sentence-level voice analysis**: reading grade, pronoun address,
  contraction rate, hedging, jargon density, formality, plus per-page consistency
  and outlier detection.
- Separates **boilerplate from distinctive copy** and returns repeated straplines
  as such.

> **One correction to the "quotes real sentences" claim.** The `voice.do` rules do
> quote the site's own sentences, each with a source URL, and any pillar whose
> evidence cannot be found is dropped. The `voice.dont` rules carry a
> hand-written `example` string showing the kind of sentence to avoid, plus the
> measured rate that triggered the rule and a source URL for the measurement. So
> the "why" is always measured, but not every "don't write this" is a verbatim
> quote (`src/extract/voice.js:396`).

---

## Scoring: two endpoints

Both run a different pipeline and return a different artifact.

| Endpoint | What it does |
| --- | --- |
| `POST /api/v1/brand-guide` | Composes every extractor into one guide; per-section confidence |
| `POST /api/v1/compare` | Resolves 2-5 brands through TinyFish Search, runs all through the same pipeline, diffs on CIEDE2000 palette distance, font overlap, tone-vector cosine distance and vocabulary overlap |

`GET /api/v1/brand-guide` does the same over GET so a guide can be linked to.
Supporting routes: `GET /api/v1/stream` (SSE progress), `GET /api/v1/health`,
`GET /api/v1` (the preset catalogue), `POST /api/v1/llm-check`.

> Earlier drafts of this file listed four endpoints, including
> `/api/v1/identity` and `/api/v1/voice`. Neither is registered in
> `src/server/index.js` and both answer `404`. The extraction they described is
> real and reachable: it runs inside these two pipelines, its results are in the
> guide, and the token serialisers are what produce the `?format=` exports.

None calls TinyFish for show. Every response carries the full per-call provenance
with real latencies, and the UI shows the sources it read during the run.

---

## Where each criterion is evidenced

| Criterion | Code | Test file |
| --- | --- | --- |
| 1. Fetch does the extraction | `src/tinyfish/client.js` | `test/units.test.js` (CSS reader, token graph) |
| 2. Accurate to the live site | `src/extract/*`, `src/lib/colour.js` | `test/extractors.test.js`, `test/units.test.js` |
| 3. Any site, not a hardcoded few | `src/resolve/*` | `test/units.test.js` (hosted profile, subdomain, bare homepage) |
| 4. Structured and reusable | `src/schema.js`, `src/export/index.js` | `test/units.test.js` (schema self-validation) |
| 5. Beyond a homepage summary | `src/crawl/pages.js`, `src/extract/voice.js` | `test/extractors.test.js`, `test/page-budget.test.js` |

The narration layer has its own pair: `test/llm.test.js` and
`test/llm-fallbacks.test.js`.

---

## Tests

```
215 tests, no network
```

Including all **34 CIEDE2000 reference pairs** from the Sharma et al. paper to
four decimal places, WCAG reference contrast ratios, and regression tests named
after the real bug they prevent — the destructive at-rule unwrapper, translucent
colours collapsing onto black, frequency outranking a declared token, the vendor
prefix that hid GOV.UK's brand blue, the profile-platform domain resolution, and
the tag-boundary sentence artefact.