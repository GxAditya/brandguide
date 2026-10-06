# How each approval criterion is met

Every criterion on the bounty, with the code and the evidence.

---

### 1. Fetch does the core extraction work

**Every byte of the target site enters through TinyFish.** There is no direct
`fetch()` of the customer's website, no headless browser in the default path, and
no scraping library.

There are exactly two outbound sockets in the codebase:

- `src/tinyfish/client.js` → the target web, via TinyFish Search and Fetch
- `src/pipeline/llm-gemini.js` and `src/pipeline/llm-openai.js` → the *caller's
  chosen LLM endpoint*, and only when they send an `X-BrandKit-Llm-Key` header.
  They never touch a target site.

```bash
grep -rn "fetch(\|https\.get\|http\.request\|axios\|cheerio\|puppeteer\|playwright" src --include="*.js"
# -> src/pipeline/llm-openai.js, src/pipeline/llm-gemini.js
#    (the optional LLM endpoints, not a target site)
```

The TinyFish client does not appear in that list because it calls an injected
`fetchImpl` rather than the global `fetch`. It is the only path to a target site.

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
grep -rniE "\b(linear|gov\.uk|patagonia|asana|stripe)\b" src --include="*.js"   # comments and CLI help only
```

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

Spot-checkable against the live sites:

| | Linear | GOV.UK | Patagonia |
| --- | --- | --- | --- |
| primary | `#7070ff` = `--color-brand-bg` | `#1d70b8` = `--govuk-brand-colour` | `#66b87d` (inferred, labelled) |
| text | `#282a30` = `--color-text-primary` | `#0b0c0c` = `--govuk-text-colour` | `#222222` (inferred, labelled) |
| heading face | Inter Variable | GDS Transport | Ridgeway Sans |
| body contrast | 14.34:1 AAA | 19.59:1 AAA | 14.72:1 AAA |

### 3. Works for any site rather than a hardcoded few

Nothing in `src/` names a brand, a domain or a selector. The demo list in
`scripts/demo.mjs` is data, and the pipeline is identical for all three.

The three demo sites were chosen to break naive extractors:

- **Linear** — Next.js SPA, 49 build-hashed stylesheets, tokens in one late file
- **GOV.UK** — no framework, no `<h1>`, tokens behind a vendor prefix
  (`--govuk-brand-colour`), which only the colour-word rule can see
- **Patagonia** — typefaces reachable only through `var(--pata-font-serif)`,
  plus a copy-paste bug in its own CSS

Domain resolution is generic: Search candidates are scored on URL parts, hosted
profile platforms are rejected, and query strings are stripped before crawling.
If the top candidate cannot be read, the next one is tried.

```bash
for n in linear notion stripe patagonia "GOV.UK"; do node src/cli.js $n --depth quick; done
```

### 4. Output is structured and reusable by other tools

`GET /api/v1/schema` publishes JSON Schema for all four payloads. The published
guide schema **enforces provenance** — a logo object is invalid unless
`verifiedBy` is `tinyfish-fetch`, so an unverified asset cannot be represented.

`node scripts/demo.mjs` validates each real extraction against that schema, and
all three pass.

Seven export formats, all generated from the same token tree:

`json` · `markdown` · `css` (`:root` custom properties) · `tailwind` (theme
block) · `styledictionary` (v3 shape) · `figma` (Variables collection with
hex-preserving descriptions) · `svg` (single-file swatch sheet)

### 5. Goes beyond summarising a homepage

- Reads **up to 10 pages**, selected by generic path-intent scoring
  (`about` `careers` `customers` `pricing` `press` `blog`), staying on-domain and
  skipping auth, legal and transactional paths.
- Reads **every stylesheet**, not just the homepage's.
- Resolves `--var` alias chains and reports the **token graph** — which tokens
  are literals, which point at another, and which many others depend on.
- Builds a **contrast matrix** over real foreground/background pairs and grades
  it against WCAG 2.1.
- Runs **sentence-level voice analysis**: reading grade, pronoun address,
  contraction rate, hedging, jargon density, formality, plus per-page consistency
  and outlier detection.
- Separates **boilerplate from distinctive copy** and returns repeated straplines
  as such.

---

## Scoring: four endpoints

Each runs a different pipeline and returns a different artifact. None wraps
another.

| Endpoint | What it does that the others do not |
| --- | --- |
| `/api/v1/brand-guide` | Composes every extractor into one guide; per-section confidence |
| `/api/v1/identity` | Resolves the token graph through `var()` aliases, derives the type scale from observed sizes, grades nine real contrast pairs, emits four import formats |
| `/api/v1/voice` | Crawls deliberately for prose, measures 30+ linguistic features per page, generates do/don't rules that quote real sentences, detects voice outliers |
| `/api/v1/compare` | Resolves 2-5 brands through TinyFish Search, runs all through the same pipeline, diffs on CIEDE2000 palette distance, font overlap, tone-vector cosine distance and vocabulary overlap |

None calls TinyFish for show. The UI renders the live call log with real
latencies, so the traffic is auditable.

---

## Tests

```
118 tests, no network
```

Including all **34 CIEDE2000 reference pairs** from the Sharma et al. paper to
four decimal places, WCAG reference contrast ratios, and regression tests named
after the real bug they prevent — the destructive at-rule unwrapper, translucent
colours collapsing onto black, frequency outranking a declared token, the vendor
prefix that hid GOV.UK's brand blue, the profile-platform domain resolution, and
the tag-boundary sentence artefact.