/**
 * Identity extraction: the plain facts a brand guide opens with.
 * Name, what it says it is, what it is called, what category it sits in.
 */

/** Websites whose nav carries the company name in a predictable place. */
const NAME_FROM_TITLE = (title) => {
  if (!title) return null;
  const cleaned = title
    .split(/\s+[|–—·:]\s+|\s+-\s+/)[0]
    .replace(/\s*\|\s*$/, '')
    .trim();
  if (!cleaned || cleaned.length > 48) return null;
  if (/^(home|welcome|coming soon|page not found|404|redirecting|official)\b/i.test(cleaned)) return null;
  return cleaned;
};

const NAME_FROM_OG_SITE = (value) => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 1 && trimmed.length <= 48 ? trimmed : null;
};

/**
 * First meaningful heading on the page, which is often the brand name.
 *
 * A heading that *ends with* the brand token is a phrase about the brand, not
 * the brand: "Popular on GOV.UK" and "Welcome to GOV.UK" both qualify, and
 * neither is a name.
 */
const NAME_FROM_H1 = (html, host) => {
  if (!html) return null;
  const label = host ? host.replace(/^www\d?\./, '').split('.')[0] : null;

  const matches = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  for (const match of matches) {
    const text = decodeText(STRIP(match[2]));
    if (!text || text.length < 2 || text.length > 48) continue;
    if (/^(welcome|home|sign in|log in|search|menu|404|page not found)$/i.test(text)) continue;

    const words = text.split(/\s+/);
    if (words.length > 6) continue; // a sentence, not a name

    if (label && words.length > 1 && words[words.length - 1].toLowerCase() === label.toLowerCase()) {
      continue;
    }
    return text;
  }
  return null;
};

/**
 * The brand's own capitalisation of its name, taken from its own copy.
 *
 * gov.uk has no h1 and titles itself "Welcome to GOV.UK", so every structural
 * source either fails or returns something wrong. Its own headings do say
 * "Popular on GOV.UK" — the name is right there, correctly capitalised. Matching
 * the domain against the page text recovers it without any brand-specific rule.
 */
function NAME_FROM_PAGE_TEXT(html, host) {
  if (!html || !host) return null;
  const text = STRIP(html).slice(0, 60_000);

  const bare = host.replace(/^www\d?\./, '');
  const label = bare.split('.')[0];

  // The full host first, then the first label: "GOV.UK" before "GOV".
  for (const needle of [bare, label]) {
    if (!needle || needle.length < 2) continue;
    const match = text.match(new RegExp(`(^|[^\\w.-])${escapeRegExp(needle)}(?![\\w-])`, 'i'));
    if (match) return match[0].trim();
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} input
 * @param {object} input.head parsed head
 * @param {object|null} input.manifest
 * @param {object[]} input.pages
 * @param {object} input.resolution { url, resolvedBy }
 */
export function extractIdentity({ head = {}, manifest = null, pages = [], resolution = {} }) {
  const host = safeHost(resolution.url);

  // The homepage heading is a better name source than the domain: gov.uk titles
  // itself "Welcome to GOV.UK", which reads as a name only once the leading word
  // is dropped, and the page's own <h1> says "GOV.UK" outright.
  const homepage = pages.find((p) => p.ok) || null;

  const candidates = [
    { value: manifest?.shortName || manifest?.name || null, source: 'web app manifest', weight: 34 },
    { value: NAME_FROM_OG_SITE(head.ogSiteName), source: 'og:site_name', weight: 30 },
    // The site's own writing of its own domain beats a headline that merely
    // mentions it, and beats a 26-word og:title that is really a page title.
    { value: NAME_FROM_PAGE_TEXT(homepage?.html, host), source: 'the domain, as the site writes it', weight: 28 },
    { value: NAME_FROM_TITLE(head.ogTitle), source: 'og:title', weight: 26 },
    { value: NAME_FROM_H1(homepage?.html, host), source: 'a page heading', weight: 22 },
    { value: NAME_FROM_TITLE(head.title), source: 'title tag', weight: 16 },
    { value: host ? host.replace(/^www\./, '') : null, source: 'domain name', weight: 4 },
  ].filter((c) => c.value);

  const ranked = candidates.sort((a, b) => b.weight - a.weight);

  // A name longer than five words is a headline, not a name. Prefer the next
  // candidate down rather than printing "Patagonia Outdoor Clothing & Gear".
  const primary = ranked.find((c) => cleanName(c.value).split(/\s+/).length <= 5) || ranked[0];
  const name = cleanName(primary.value);

  const legalName = findLegalName(pages, name);

  return {
    name,
    legalName,
    domain: host,
    url: resolution.url,
    resolvedBy: resolution.resolvedBy || 'direct',
    nameCandidates: candidates.map((c) => ({ value: c.value, source: c.source })),
    tagline: head.ogDescription || head.description || null,
    description: head.description || head.ogDescription || null,
    locale: head.ogLocale || head.language || null,
    social: {
      site: head.twitterSite || null,
      creator: head.twitterCreator || null,
      shareImage: head.ogImage || null,
    },
    generator: head.generator || null,
    themeColor: head.themeColor || manifest?.themeColor || null,
    contact: findContact(pages),
    source: {
      method: 'name from the site\'s own metadata (web app manifest, og:site_name, title tag) with the domain as a fallback',
      basis: primary?.source || 'unknown',
      pagesConsulted: pages.filter((p) => p.ok).length,
    },
  };
}

function findLegalName(pages, fallback) {
  const corpus = pages
    .filter((p) => p.ok && /(about|legal|terms|privacy|contact|imprint)/i.test(p.url))
    .map((p) => stripTags(p.html))
    .join(' ');
  if (!corpus) return null;

  const m = corpus.match(
    /\b([A-Z][A-Za-z0-9&.\- ]{1,40}?(?:Inc|LLC|Ltd|Limited|GmbH|PLC|Corp|Corporation|B\.V\.|Pte\.? Ltd)\.?(?:\s|,|$))/,
  );
  return m ? m[1].trim() : null;
}

function findContact(pages) {
  const emails = new Set();
  const linkedin = new Set();
  for (const page of pages) {
    if (!page.ok) continue;
    for (const m of (page.html || '').matchAll(/mailto:([^"'?>\s]+)/gi)) {
      const email = decodeURIComponent(m[1]).trim();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) emails.add(email);
    }
    for (const link of page.links || []) {
      if (/linkedin\.com\/company\//i.test(link)) linkedin.add(link.split('?')[0]);
      if (/twitter\.com\//i.test(link) || /x\.com\//i.test(link)) {
        const handle = link.match(/\/(?:twitter|x)\.com\/(@?[A-Za-z0-9_]+)/i);
        if (handle && !/^(i|home|search|share|intent)$/i.test(handle[1])) {
          emails.size; // no-op guard
        }
      }
    }
  }
  return {
    emails: [...emails].slice(0, 3),
    linkedin: [...linkedin].slice(0, 2),
  };
}

function cleanName(value) {
  if (!value) return 'Unknown';
  return String(value)
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\s+(inc|llc|ltd|limited|gmbh|plc|corp|corporation)\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown';
}

/** Casing is preserved: "GOV.UK" and "IBM" are their own names. */
function decodeText(value) {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STRIP = (html) => String(html || '').replace(/<[^>]+>/g, ' ');

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}