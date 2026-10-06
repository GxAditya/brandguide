# BrandKit

Give it a company name or URL. Get back a structured brand guide: logo, colour
palette, typography, tone of voice, key messaging, plus the design tokens to
drop straight into Figma or Tailwind.

The guide renders as a **paged document set in the brand's own colours and
typefaces**, laid out the way a real guidelines PDF is, with a running header
carrying the source domain and extraction date on every page.

Everything is read from the **live site** through TinyFish Search and Fetch.
Nothing is stored, nothing is hardcoded per brand, and the output is a
versioned JSON object with a published schema.

```
POST /api/v1/brand-guide   { "input": "linear" }
```

| | |
| --- | --- |
| Runtime dependencies | **zero** |
| Setup | `npm start`, then paste your key into **Settings** |
| Cost | Search and Fetch are free; the LLM layer is optional and off by default |
| Screenshots | [`docs/screenshots/`](docs/screenshots) |

![The GOV.UK brand guide, extracted live and set in GOV.UK's own identity](docs/screenshots/gov-uk-desktop.png)

The guide above is GOV.UK's, extracted live and rendered in GOV.UK's own
colours and typeface. That is the point of the whole thing: a brand guide set in
anything other than the brand is a screenshot, not a guide.

---

## Quick start

```bash
git clone <this repo> && cd brandguide
npm start                     # http://localhost:3000
```

Then open **Settings** in the header and paste a TinyFish key. There is nothing to
install and nothing to configure on disk: `node_modules` does not exist because
`package.json` has no dependencies.

### Bring your own key

**The server holds no credentials.** A deployment is a public URL and nothing else.
Each caller sends their own key with their own request, so two people using the
same instance spend their own quota and there is nothing stored to leak or rotate.

| Header | Required? | Purpose |
| --- | --- | --- |
| `X-BrandKit-Tinyfish-Key` | **yes** | Search and Fetch. Nothing works without it. |
| `X-BrandKit-Llm-Key` | no | Narration key. Omitted means measured pages only. |
| `X-BrandKit-Llm-Provider` | no | `gemini` or `openai`. A bare key means Gemini. |
| `X-BrandKit-Llm-Base` | no | Base URL for an OpenAI-compatible server. |
| `X-BrandKit-Llm-Model` | no | Model id. Defaults to the current Gemini flagship. |

```bash
curl -X POST http://localhost:3000/api/v1/brand-guide \
  -H 'content-type: application/json' \
  -H 'x-brandkit-tinyfish-key: sk-tinyfish-...' \
  -d '{"input":"linear"}'
```

Headers rather than a request body, because the live progress endpoint is a `GET`
and an `EventSource` cannot carry one. Not the query string either: a secret in a
URL lands in proxy logs and browser history.

The CLI takes the same keys as flags, so a shell history never holds one:

```bash
node src/cli.js guide linear --key sk-tinyfish-...
node src/cli.js guide linear --key sk-... --llm-key AIza...   # narrate with Gemini
```

`LLM_PROVIDER` is `gemini` or `openai`; without it a complete OpenAI-compatible
trio wins over a bare Gemini key.

**Google Gemini** is the shortest configuration — one key field, since a key with
no provider selected means Gemini:

```bash
# Settings → Narration model → Google Gemini
key:    AIza...
model:  gemini-3.8-flash   # optional; this is the default
```

Gemini is called on its own API, not the OpenAI shape, because Google does not
serve `/chat/completions` on its own domain. The request goes to
`POST https://generativelanguage.googleapis.com/v1beta/interactions` with an
`x-goog-api-key` header, and the narrative is requested as JSON by schema rather
than by asking nicely in the prompt.

Gemini 3 reasons before it answers, and those tokens come out of the same output
budget as the reply, so a thinking level (`minimal`, `low`, `medium`, `high`) is
sent explicitly and defaults to `low`. Leave it alone unless you want a slower,
deeper read. Current model ids are listed in
[Google's model docs](https://ai.google.dev/gemini-api/docs/models); an
unrecognised id is reported by name rather than as a bare 404.

**You can also drop in any OpenAI-compatible provider:**

| Provider | Server base URL | Example model |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-flash-1.5` |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| xAI | `https://api.x.ai/v1` | `grok-2-latest` |
| Cerebras | `https://api.cerebras.ai/v1` | `llama3.1-8b` |
| Gemini (compatibility surface) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` |
| Ollama (local, no key) | `http://localhost:11434/v1` | `llama3.2` |

The call is a standard Chat Completions request. `response_format: json_object`
and `max_tokens` are sent first and then dropped if the provider rejects them,
so a server that implements only part of the OpenAI shape still works. That
fallback is covered by `test/llm.test.js` against a mock provider.

Then:

```bash
curl -s localhost:3000/api/v1/brand-guide \
  -H 'Content-Type: application/json' -d '{"input":"linear"}' | head -40

node src/cli.js patagonia --format markdown -o patagonia.md
node scripts/demo.mjs          # three brands, full evidence written to disk
```

---

## What it produces

### 1. `POST /api/v1/brand-guide` — the kit

The complete brand guide in one object.

```jsonc
{
  "identity":   { "name": "tailwindcss", "domain": "tailwindcss.com" },
  "logos":      { "primary": { … }, "lockup": { … }, "source": { … } },
  "colors":     { "roles": { "background": "#0f172a", "text": "#ffffff" }, "contrast": [ … ] },
  "typography": { "pairing": { "heading": "Inter Variable" }, "scale": [ … ] },
  "voice":      { "vector": { … }, "do": [ … ], "dont": [ … ] },
  "messaging":  { "pillars": [ … ], "taglines": [ … ] },
  "confidence": { "overall": 0.79, "bySection": { … } },
  "deck":       { "requestedPages": 14 },
  "provenance": { "tinyfish": { "calls": [ … ] }, "pagesRead": [ … ] }
}
```

`logos.primary` and `logos.lockup` are deliberately different picks. `primary` is
the best *mark* (SVG first, so it holds up small). `lockup` is the best
*horizontal logo* (wide declared size, then a logo-ish filename, then the social
card). A cover wants the second; a swatch or favicon-sized surface wants the
first. `lockup` is `null` when the two are the same file.

Where the source was readable, the asset also carries `svg`: the **sanitised SVG
markup**, plus `svgTone` (`light`, `dark`, `inherit`, `unknown`). The deck inlines
that source instead of pointing an `<img>` at the URL, because an image cannot
inherit from the page and `fill="currentColor"` — how most design systems ship a
single logo that works on both backgrounds — resolves to black when it does. A
cyan mark then arrives greyscale, which is a bug in the renderer, not the asset.
`svgTone` is what decides whether the mark is shown on a dark plate or a light
one, so a white logo is never placed on a white page.

#### The document is always light

The paper and ink are fixed and never taken from the brand. A guide that adopts
a dark brand's background stops being a document and becomes a screenshot of that
brand's site, and prints as a book of black pages. The brand changes the type the
document is set in and the colour of every swatch, plate and specimen on it.

#### Guide length

`pages` (4 to 24, default 14) sets how long the **full document** should be. It
only applies when a narration layer is configured.

**Deterministic (no LLM key), the default.** Seven pages, and only seven:

| Page | What it is |
| --- | --- |
| Cover | The brand's own logo lockup and name |
| Logomark | The verified logo asset, in its real colours, on a plate chosen to suit it |
| Logotype | The name set in the brand's own heading face, as the reference deck does |
| Color palette | Swatch columns with RGB, CMYK and four tint steps |
| Typeface | The heading face at specimen size |
| Weights | Regular through Bold, with a full alphabet per weight |
| Type scaling | The sizes the site actually uses, labelled from its own tokens |

Every one of those is a **measurement**. None of it is written, because a brand
cannot be summarised from a hex value. The prose on those pages describes the
extraction, not the brand: "this asset was fetched back and confirmed" is true,
"this symbolises our commitment to precision" would be invention.

**LLM configured.** The full document, including the pages that need writing:
about the brand, positioning, values, tone, application. `pages` becomes the
length of that document. The model is structurally barred from colour, type and
logo values, so it can only fill pages, never alter measurements.

A page is emitted only if it can be filled truthfully. Nothing is padded to hit a
number, and a shortfall is stated on the page rather than hidden.

```bash
curl -s localhost:3000/api/v1/brand-guide \
  -H 'Content-Type: application/json' -d '{"input":"linear","pages":22}'
```

### 2. `POST /api/v1/identity` — visual forensics

Deeper into the CSS than the kit. Resolves `--var` alias chains to terminal
values, walks the token graph, builds a WCAG contrast matrix over real
foreground/background pairs, and derives the type scale from the sizes actually
present.

Returns tokens in the shape tools want: `:root` CSS, a Tailwind theme block,
Style Dictionary v3, and a Figma Variables collection.

```bash
curl -s localhost:3000/api/v1/identity \
  -H 'Content-Type: application/json' -d '{"input":"linear","format":"css"}'
```

### 3. `POST /api/v1/voice` — voice and messaging lab

Deeper into the copy than the kit. Crawls deliberately for prose — about,
careers, blog, press, pricing — then runs sentence-level measurement: mean
sentence length, reading grade, you/we ratio, contraction rate, hedging,
intensifiers, jargon density, formality.

Returns a tone vector, per-page consistency, and do/don't guidance where
**every rule quotes a real sentence from the site** with its source URL.

```bash
curl -s localhost:3000/api/v1/voice \
  -H 'Content-Type: application/json' -d '{"input":"patagonia"}'
```

### 4. `POST /api/v1/compare` — brand benchmark

Two to five live brands through the same pipeline, then diffed: CIEDE2000
palette distance, font overlap, cosine distance between tone vectors, and
vocabulary overlap. Returns which parts of the brand are genuinely its own.

```bash
curl -s localhost:3000/api/v1/compare \
  -H 'Content-Type: application/json' \
  -H 'X-BrandKit-Tinyfish-Key: sk-tinyfish-...' \
  -d '{"input":"linear","competitors":["notion","asana"]}'
```

`GET /api/v1/brand-guide?input=linear&format=markdown` does the same over GET,
so a guide can be linked to or bookmarked.

Plus `GET /api/v1/schema` (JSON Schema), `GET /api/v1/health`, and
`GET /api/v1/stream` (SSE, so the UI can show each source as it is read).

`GET /api/v1/health` is liveness only: it makes no upstream call and never touches
a key, so it is safe to point a platform's health check at. Whether your key works
is answered by the run that used it.

Every endpoint accepts `?format=`: `json`, `markdown`, `css`, `tailwind`,
`styledictionary`, `figma`, `svg`.

---

## How it stays accurate

A brand guide is only worth anything if the numbers are true. Six rules:

1. **Ground truth over inference.** If `<meta name="theme-color">` says
   `#08090a`, that is the declared colour. Not a guess from a frequency count.
2. **Declared intent beats frequency.** `--color-brand-bg` outranks a hex that
   appears 40 times in a stylesheet. On a Tailwind site white is used more than
   any brand colour, so "used most" is not "the brand colour".
3. **Verify, never assume.** A logo URL is returned only after TinyFish Fetch
   confirms it resolves. `page_not_found` means it is dropped.
4. **The LLM cannot invent.** Interpretation output is a separate `narrative`
   block, parsed into a fixed shape, structurally unable to overwrite an
   extracted fact.
5. **Show the receipts.** Every value carries a source. The UI shows the pages it
   read in a modal during the run, and the response body carries every TinyFish
   call with its latency.
6. **Admit weakness.** Confidence is per section and derived from how many
   independent sources agreed. Anything inferred is labelled `inferred` in the
   output and in the UI.

---

## Demo results

Three deliberately awkward sites. Nothing about them is special-cased anywhere.

| Brand | Why it is here | Confidence | Stylesheets | Typefaces found |
| --- | --- | --- | --- | --- |
| **Linear** | JS-heavy SPA, Tailwind v4 tokens hidden in 49 build-hashed files | 0.74 | 49 | Inter Variable, Berkeley Mono |
| **GOV.UK** | Hand-rolled CSS, no framework, no `<h1>`, tokens behind a vendor prefix | 0.77 | 2 | GDS Transport |
| **Patagonia** | Image-led retail, typefaces only reachable through `var()` | 0.79 | 6 | Ridgeway Sans, Copernicus |

Also verified on three brands that appear nowhere in the code, so the resolver
and extractors are demonstrably not tuned to the demo set:

| | Resolved | Primary | Body contrast | Heading face |
| --- | --- | --- | --- | --- |
| **Vercel** | `vercel.com` | `#dd0031` | 16.83:1 AAA | GeistSans |
| **Notion** | `notion.com` | `#1313ba` | 21:1 AAA | NotionInter |
| **Stripe** | `stripe.com` | `#0d1738` | 14.84:1 AAA | sohne-var (Söhne) |

Extracted values, all checkable against the live sites:

- **Linear** — primary `#7070ff` from `--color-brand-bg`, body `#282a30`,
  link `#7070ff`, body copy 14.34:1 (AAA)
- **GOV.UK** — primary `#1d70b8` from `--govuk-brand-colour`, background
  `#ffffff`, text `#0b0c0c`, GDS Transport
- **Vercel** — `#dd0031`, its actual brand colour, with GeistSans and Geist Mono
- **Stripe** — `sohne-var`, Söhne, Stripe's real custom typeface
- **Patagonia** — Ridgeway Sans and Copernicus, both resolved through
  `--pata-font-sans` and `--pata-font-serif`

```bash
node scripts/demo.mjs
```

writes every export format to `demo-output/` and validates each guide against
the published schema.

![Linear's brand guide, in Linear's identity](docs/screenshots/linear-desktop.png)

---

## How TinyFish is used

**The whole read layer.** Search resolves names to domains; Fetch reads the
document head (via `include_selectors: ["head"]`, which returns it verbatim
instead of stripped), reads every stylesheet back as raw CSS, reads the copy
across several pages, and verifies each candidate logo URL exists by
interpreting its error code.

Full detail, including why Browser and Agent are deliberately unused, is in
**[docs/TINYFISH.md](docs/TINYFISH.md)**.

---

## On the LLM question

TinyFish has four surfaces — Search, Fetch, Browser, Agent — and **none of them
is a language model**. Agent automates a browser; it does not write prose. So
BrandKit separates the two jobs:

- **Deterministic core, always on, no model.** Colours, WCAG contrast,
  CIEDE2000, token graphs and sentence-level linguistic measurement are computed
  locally from fetched bytes. Reproducible, auditable, free.
- **Optional LLM, narrates only.** Add a key in Settings, or send
  `X-BrandKit-Llm-Key` for Gemini or any OpenAI-compatible endpoint. It upgrades the
  *narrative* — tone paragraph, message pillars, writing guidance — and is
  structurally barred from touching colour, type or logo values.

**With no LLM key the app is fully functional.** That is the default, and it is
how the demo runs.

---

## Layout

```
src/
  tinyfish/       client.js — the only module that opens a socket
  resolve/        input classification, name → domain ranking
  crawl/          head, stylesheets, manifest, pages, asset verification
  extract/        colour, typography, logo, identity, voice, messaging
  lib/            colour maths (WCAG, CIEDE2000), CSS reader, token serialisers,
                  page budget
  pipeline/       the four endpoints and the optional LLM layer
  export/         markdown, CSS, Tailwind, Style Dictionary, Figma, SVG
  server/         zero-dependency HTTP server and SSE
public/           the UI. app.css is the tool's chrome, deck.js and deck.css
                  compose the paged guide set in the extracted brand's own
                  colours and typefaces, compare.js is the benchmark view
scripts/          demo.mjs, screenshot.mjs
test/             155 tests, no network required
```

```bash
npm test          # 155 tests, no network
npm start         # server
node scripts/demo.mjs
```

### The UI

Two outputs, chosen in the rail: **Guide** and **Compare**. The deep Identity
and Voice endpoints stay fully available over the API but are not surfaced in
the UI, where the paged guide already carries the same measurements in a form a
marketer can use.

Composer at the top of the stage, options in the left rail, document below. A
run takes real seconds, so the sources read appear in a modal that closes itself
when the pipeline does. No permanent telemetry panel is shipped: the same facts
are one line in the document header, and the full per-call provenance is in the
response body.

Exports render in the browser from the guide already in memory, using the same
renderers the API serves. Linking at the API with `?format=` would re-crawl the
site to produce bytes the client already holds.

---

## Notes

- The server stores no keys at all. They arrive per request in headers, are used
  for that request, and are never logged or returned. The server logs the request
  path and the error code on failure, never the headers and never the body.
- Generated guides are ephemeral. Nothing is persisted.
- Re-running refreshes: brand sites change.
- Screenshots in `docs/screenshots/` were produced by `scripts/screenshot.mjs`
  from saved demo output, through the same render path the live UI uses.