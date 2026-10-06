/**
 * Web app manifest reading. A manifest is usually the most honest statement of a
 * brand's own colour intent: it names theme_color and ships the icon set. Fetch
 * returns JSON documents as raw text, so this is one more call rather than a
 * special case.
 */


export async function fetchManifest(client, manifestUrl, baseUrl) {
  if (!manifestUrl) return null;

  const { results } = await client.fetchContent([manifestUrl], {
    format: 'json',
    perUrlTimeoutMs: 30_000,
    purpose: 'Read the site web app manifest for the declared brand theme colour and icon set.',
    label: `manifest · ${hostOf(baseUrl)}`,
  });

  const page = results[0];
  if (!page) return null;

  const manifest = typeof page.text === 'string' ? safeJson(page.text) : page.text;
  if (!manifest || typeof manifest !== 'object') return null;

  const abs = (src) => {
    if (!src) return null;
    try {
      return new URL(src, manifestUrl).toString();
    } catch {
      return null;
    }
  };

  const icons = (manifest.icons || [])
    .map((icon) => ({
      url: abs(icon.src),
      sizes: icon.sizes || null,
      type: icon.type || null,
      purpose: icon.purpose || null,
    }))
    .filter((icon) => icon.url);

  const maskable = icons.find((i) => (i.purpose || '').includes('maskable')) || null;

  return {
    url: manifestUrl,
    name: manifest.name || manifest.short_name || null,
    shortName: manifest.short_name || null,
    description: manifest.description || null,
    themeColor: manifest.theme_color || null,
    backgroundColor: manifest.background_color || null,
    display: manifest.display || null,
    icons,
    maskableIcon: maskable,
    source: manifestUrl,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}