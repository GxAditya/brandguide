# How TinyFish is used

This is the short answer to "what does TinyFish actually do here".

**Every byte of the target site enters BrandKit through TinyFish.** There is no
direct `fetch()` of the customer's website, no headless browser in the default
path, and no scraping library. `src/tinyfish/client.js` is the only module in
the codebase that opens a socket.

Two surfaces are used, both free at any balance:

| Surface | Endpoint | What it does here |
| --- | --- | --- |
| **Search** | `GET api.search.tinyfish.ai` | Turns a company name into its official domain, and finds competitors for the benchmark endpoint |
| **Fetch** | `POST api.fetch.tinyfish.ai` | Reads pages, stylesheets, manifests and image assets |

Browser and Agent are deliberately unused. They are metered, and they are not
needed: Fetch already renders in a real browser, so it handles JavaScript-heavy
sites (Linear is a Next.js app and reads fine) without a second paid surface.

---

## The five places TinyFish is load-bearing

### 1. Name → domain, via Search

`linear` is not a URL. Search returns ranked results; BrandKit scores them on
generic signals and picks the company's own site. Hosted profiles are rejected
outright rather than merely demoted, because a LinkedIn page is a page *about*
a brand, not the brand, and it will usually refuse an anonymous crawler anyway.

```
search "linear official website"
  1  https://linear.app/                          ← chosen
  2  https://linear.app/ai
  4  https://www.linkedin.com/company/linearapp   ← rejected: profile host
  5  https://www.linear.eu/en/home/?srsltid=...   ← demoted: deep, localised
```

### 2. The document head, via Fetch with `include_selectors: ["head"]`

This is the single most important decision in the project.

By default, Fetch's `html` format returns **cleaned semantic HTML** with
`<head>`, `<style>` and `<link>` stripped. That is ideal for reading copy and
useless for reading a brand: no `og:image`, no `theme-color`, no stylesheet URLs.

Scoping the fetch to `include_selectors: ["head"]` returns the head **verbatim
instead**, bypassing the boilerplate removal. One call then yields every piece
of first-party metadata a site publishes about itself:

```html
<meta property="og:image" content="https://linear.app/api/og/main?title=Linear">
<meta name="theme-color" content="#08090a">
<link href="https://static.linear.app/web/_next/static/css/pcGZUK31.css" rel="stylesheet">  × 49
<link href="/static/favicon.svg?v=2" rel="icon" type="image/svg+xml">
<link href="https://linear.app/static/pwa.webmanifest?v=4" rel="manifest">
```

### 3. The stylesheets, via Fetch returning raw CSS

A CSS file is text, so Fetch returns it as text. That means the actual
declarations behind a brand are readable through the same channel as everything
else — no separate downloader, no user-agent spoofing.

For Linear, 49 stylesheets read through Fetch contain the whole design system:

```css
--color-brand-bg: #7070ff;   /* the brand purple   */
--color-bg-primary: #fff;    /* page background    */
--color-text-primary: #282a30; /* body text         */
@font-face{font-family:"Inter Variable";src:url(...);font-weight:100 900}
```

Reading them properly matters. Linear declares 49 stylesheets with opaque build
hashes; the brand tokens live in one late file. An extractor that reads only the
first few finds no palette at all.

### 4. The copy, via Fetch on several pages

A brand guide cannot be built from a homepage. Tone of voice lives in the
careers page, positioning in `/about`, proof in `/customers`. BrandKit
link-follows with generic path-intent scoring and reads the pages it finds,
never leaving the domain and never touching auth or checkout paths.

### 5. Asset existence, proven by Fetch's error codes

A logo URL scraped out of markup is a guess, and a guess becomes a dead link in
someone's deck. Before BrandKit returns an asset, it asks Fetch to read that URL
and interprets the result:

| Fetch result | Meaning for an image URL | Verdict |
| --- | --- | --- |
| `empty_content` | Browser resolved and rendered it; an image has no text to extract | **exists** |
| `page_not_found` | HTTP 404 | **rejected** |
| `invalid_url` | Host does not resolve | **rejected** |
| a document with text | It is a page, not an asset | accepted as a document |

For asset URLs the *absence* of extracted text is the proof of existence, and
the error code is what separates "there is an image here" from "there is
nothing here".

---

## What TinyFish deliberately does *not* do

- **It does not generate.** TinyFish Search and Fetch read the web; neither is a
  language model. BrandKit's deterministic core — colour maths, WCAG contrast,
  CIEDE2000, sentence-level linguistic measurement, the token graph — is
  computed locally. An LLM is optional (see below) and structurally cannot
  touch colour, type or logo values.
- **It is not padded.** Four endpoints run four different pipelines. None is a
  wrapper around another, and none calls TinyFish for show. The UI shows the
  live call log with real latencies so the traffic can be audited.

---

## Cost and rate limits

Search and Fetch are free at any balance, so the default path costs nothing.

Fetch accepts 10 URLs per request and roughly 150 URLs per minute per key. A
framework site declaring 49 stylesheets is five batched requests, run two at a
time with a short gap. Firing all five at once once tripped the rate limit, and
a third of the stylesheets came back missing — taking the `@font-face` rules
with them and emptying the brand's entire type system from the guide. The
client also honours `Retry-After` and retries with jittered backoff.

---

## The optional LLM layer

TinyFish is a retrieval layer, not a generation layer. If you configure a model,
BrandKit adds a `narrative` block: a tone paragraph, message pillars, and writing
guidance.

Two providers are supported. Both come from the caller's own request — a header,
per request — never from the server's environment, so one deployment serves many
people with different keys.

- **Gemini** — send `X-BrandKit-Llm-Key`, and optionally `X-BrandKit-Llm-Model`. A key
  with no provider selected means Gemini, which is why the shortest setup is one field.
  Google does not serve `/chat/completions` on its own domain, so this uses the
  Interactions API: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  with an `x-goog-api-key` header, `input`/`system_instruction` in the body, and the
  narrative requested as JSON by schema. A thinking level is sent explicitly because
  Gemini 3 reasons by default and those tokens come out of the same output budget as the
  reply.
- **Any OpenAI-compatible endpoint** — send `X-BrandKit-Llm-Preset` for a known provider
  plus `X-BrandKit-Llm-Key`, and the preset supplies the base URL and a live model. Or
  send the base URL, model and key yourself.

The free tiers are the reason there are **two** ladders. A failure means one of two very
different things, and treating them the same was a real bug:

- **Refused** (400, 404, 422) — an unsupported field, or a model id the provider has
  retired. The same call is retried shedding one optional field: `response_format` and
  the token cap for OpenAI, the schema and `thinking_level` for Gemini.
- **Unavailable** (429, 5xx) — a smaller body cannot help, and trying one would spend
  the caller's quota to prove it. The identical request is retried with backoff, and on
  Gemini the ladder moves to a **different model**.

Gemini's free tier is 20 requests a day *per model*, and measured on it the 3.8
flagship returned `503 high demand` for structured requests — the exact shape this app
sends — while `gemini-3.1-flash-lite` answered. So the default starts there, the ladder
walks down a fallback list, and a daily limit is reported with its reset time rather
than waited out or retried into the ground.

Preset model lists are snapshots. Providers retire ids constantly, and a retired one is
named in the error rather than surfacing as a bare status code.

Three rules are enforced in `src/pipeline/llm.js`, not just in the prompt:

1. The model sees a compact fact sheet of **measured** values, never raw HTML.
2. Its output is parsed into a fixed shape and stored under `narrative`. It is
   structurally incapable of overwriting `colors`, `typography` or `logos`,
   which are attached after generation.
3. Any sentence it returns without a supporting source URL is dropped.

With no key configured, everything else works identically. That is the default,
and it is how the demo runs. `test/llm.test.js` exercises the layer against a
mock provider: inert when unconfigured, degrading rather than failing when a
field is rejected, and dropping any pillar whose evidence it cannot find quoted
in the source copy.

---

## Reproducing it

```bash
TINYFISH_API_KEY=sk-tinyfish-... node scripts/demo.mjs
```

The demo script is the one place a key still comes from the environment: it has no
settings panel to read from, and passing one on the command line would put it in
the shell history of every demo run.

The script prints every TinyFish call with its latency as it happens, then
validates each guide against the published JSON Schema. Output lands in
`demo-output/`.