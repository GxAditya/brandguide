# Submission notes — BrandKit

Copy-paste drafts for the three required submission items, plus the checklist
each bounty approval criterion maps to.

---

## 1. LinkedIn post (required — must tag TinyFish)

I built **BrandKit**: give it a company name or URL, get back a structured brand
guide — logo, colour palette, typography, tone of voice, messaging — extracted
from the live site, not from a template.

The output is set in the brand it documents. The screenshot is GOV.UK's guide,
extracted live and rendered in GOV.UK's own blue and GDS Transport:

![GOV.UK brand guide](docs/screenshots/gov-uk-desktop.png)

The part I'm happiest with is *how* it reads the page.

The obvious move is to fetch the HTML and regex the colours out. That fails
almost immediately. TinyFish Fetch strips `<head>`, `<style>` and `<link>` from
its HTML output, so you get no og:image, no theme-color, no stylesheet URLs.
But scoping the same fetch to `include_selectors: ["head"]` returns the head
verbatim. One call gets you every piece of first-party metadata a site
publishes about itself — and the list of its stylesheets.

From there it's a loop: Fetch reads each stylesheet back as raw CSS, because a
CSS file is text. For Linear that meant 49 stylesheets with opaque build hashes,
one of which contained the entire design system:

--color-brand-bg: #7070ff;
--color-text-primary: #282a30;
@font-face{font-family:"Inter Variable";font-weight:100 900}

So the brand purple comes back as #7070ff because Linear literally declared it,
not because it was the most-used colour.

Then the part that surprised me most: TinyFish Fetch *renders* URLs in a browser
and extracts text. A real image has no text — so it returns `empty_content`.
A missing image returns `page_not_found`. That means the error code alone proves
whether a logo URL exists, which is how BrandKit never hands a marketer a dead
link.

Three things I learned the hard way, all caught by testing on real sites:

- Translucent tokens. `--header-border: #00000014` collapses onto solid black
  once alpha is dropped, so a brand guide confidently reported an invisible black
  border. Now anything under 60% alpha is counted and excluded.
- Icon fonts. Patagonia ships `patagonia-icons` as its only `@font-face`. It
  used to be reported as their typeface. It also ships a genuine copy-paste bug:
  `font-family: object-fit\: cover`. Both are now rejected on sight.
- Rate limits. Firing all five stylesheet batches at once lost a third of them —
  and with them the `@font-face` rules, so the whole type system vanished from
  the guide. Two at a time with a gap.

One more note on scope. TinyFish has Search, Fetch, Browser and Agent, and none
of them is a language model — Agent drives a browser, it doesn't write prose.
So the deterministic work (WCAG contrast, CIEDE2000, sentence-level voice
measurement) is computed locally and is the default. An LLM layer is optional,
and structurally barred from touching colour, type or logo values — it narrates
and nothing else.

Four endpoints, four different pipelines: the full kit, deep CSS forensics with
Figma/Tailwind export, a voice lab that quotes real sentences back, and a
benchmark that diffs brands on colour, type and voice distance.

Four endpoints, zero dependencies, 109 tests (all 34 CIEDE2000 reference pairs
included). Demo'd on Linear, GOV.UK and Patagonia — deliberately awkward sites,
nothing special-cased.

Built with [@TinyFish](https://www.linkedin.com/company/tinyfish-ai) — Fetch
does all the reading here. Genuinely one of the more interesting API surfaces
I've built against: I spent more time on *how* to ask Fetch for a document head
than on any extraction logic.

Repo and live demo in the comments.

#TinyFish #BuildInPublic #BrandDesign #DesignTokens #DeveloperTools

---

## 2. Discord — #showcase

> **BrandKit** — company name or URL in, structured brand guide out. Logo,
> palette, typography, voice, messaging + design tokens for Figma/Tailwind.
>
> Four endpoints, all reading the live web through TinyFish Search and Fetch.
> Zero runtime dependencies, 109 tests, no per-brand special cases.
>
> The good bit: `include_selectors: ["head"]` returns the document head verbatim
> instead of stripped, which is what makes real brand extraction possible —
> og:image, theme-color and the full stylesheet list in one call. Stylesheets
> then come back as raw CSS, so a design system declared across 49 build-hashed
> files is fully readable. And since Fetch renders URLs, an image comes back as
> `empty_content` while a dead one is `page_not_found` — so every logo URL is
> verified to exist before it's returned.
>
> Guide renders in the brand's own colours and fonts. No LLM needed.
> Repo + demo: <link>

---

## 3. X / Twitter (optional)

Built BrandKit on a TinyFish bounty: point it at a company name or URL, get a
structured brand guide read live from the site.

The trick that made it work: TinyFish Fetch strips `<head>` by default, but
`include_selectors: ["head"]` returns it verbatim — every og tag, the theme
colour, and the full stylesheet list. From there Fetch reads each stylesheet
back as raw CSS, so real design systems come out with the actual declared
tokens rather than a hex-frequency guess.

No LLM required. Deterministic core, optional narration layer.