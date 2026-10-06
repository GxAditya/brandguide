/**
 * `<head>` extraction.
 *
 * The single most important trick in this project: TinyFish Fetch's default HTML
 * output strips <head>, <style> and <link>. Scoping the fetch to
 * `include_selectors: ["head"]` returns the head verbatim instead, which gives us
 * og:*, twitter:*, theme-color, every stylesheet URL, icon links and the web app
 * manifest without a single direct HTTP request.
 */

const META_RE = /<meta\s+([^>]*?)\/?>/gi;
const LINK_RE = /<link\s+([^>]*?)\/?>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

export function decodeEntities(str) {
  if (!str || !str.includes('&')) return str || '';
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function safeCharCode(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}


export function parseHead(headHtml, baseUrl) {
  const metas = {};
  for (const m of headHtml.matchAll(META_RE)) {
    const attrs = parseAttrs(m[1]);
    const key = attrs.property || attrs.name || attrs.itemprop || attrs.httpEquiv;
    if (key) metas[key.toLowerCase()] = attrs.content ?? '';
  }

  const links = [];
  for (const m of headHtml.matchAll(LINK_RE)) links.push(parseAttrs(m[1]));

  const titleTag = headHtml.match(TITLE_RE);

  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
  };

  const stylesheets = dedupe(
    links
      .filter((l) => (l.rel || '').toLowerCase().split(/\s+/).includes('stylesheet'))
      .map((l) => abs(l.href))
      .filter(Boolean),
  );

  const iconLinks = links
    .filter((l) => /\b(icon|apple-touch-icon|mask-icon|fluid-icon)\b/i.test(l.rel || ''))
    .map((l) => ({
      url: abs(l.href),
      rel: l.rel,
      type: l.type || null,
      sizes: l.sizes || null,
    }))
    .filter((l) => l.url);

  const manifestLink = links.find((l) => (l.rel || '').toLowerCase() === 'manifest');

  const pick = (key) => (metas[key] ? decodeEntities(metas[key]) : null);

  return {
    title: titleTag ? decodeEntities(titleTag[1]).trim() : null,
    canonical: links.find((l) => (l.rel || '').toLowerCase() === 'canonical')?.href
      ? abs(links.find((l) => (l.rel || '').toLowerCase() === 'canonical').href)
      : null,
    description: pick('description') || pick('og:description'),
    ogTitle: pick('og:title'),
    ogDescription: pick('og:description'),
    ogImage: abs(pick('og:image')) || abs(pick('twitter:image')),
    ogSiteName: pick('og:site_name'),
    ogLocale: pick('og:locale'),
    twitterSite: pick('twitter:site'),
    twitterCreator: pick('twitter:creator'),
    generator: pick('generator'),
    keywords: pick('keywords'),
    author: pick('author'),
    themeColor: pick('theme-color') || null,
    language: pick('content-language') || pick('og:locale') || null,
    stylesheets,
    icons: iconLinks,
    manifestUrl: manifestLink ? abs(manifestLink.href) : null,
    metas,
  };
}

/**
 * Fetch and parse a page's <head> via TinyFish Fetch.
 */
export async function fetchHead(client, url) {
  const { results, errors } = await client.fetchContent([url], {
    format: 'html',
    includeSelectors: ['head'],
    perUrlTimeoutMs: 45_000,
    purpose: 'Read the document head to extract brand metadata: og tags, theme colour, logo icons and stylesheet URLs.',
    label: `head · ${hostOf(url)}`,
  });

  const page = results[0];
  if (!page) {
    const err = errors[0];
    const failure = new Error(
      `Could not read ${url}${err ? ` (${err.error})` : ''}. Try a different URL, or one with a public homepage.`,
    );
    failure.code = err?.error || 'HEAD_FETCH_FAILED';
    failure.url = url;
    throw failure;
  }

  return { url: page.final_url || url, head: parseHead(page.text || '', page.final_url || url) };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function dedupe(list) {
  return [...new Set(list)];
}