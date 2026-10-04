/**
 * Messaging extraction.
 *
 * What the brand says it is for, and how it says it. Built from headings and
 * repeated vocabulary across the pages that were actually read — not from the
 * homepage tagline alone, which is the thing this whole project exists to avoid.
 */

import { htmlToText, splitSentences } from './voice.js';

const H_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const LIST_RE = /<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;

const STRIP_TAGS = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const BOILERPLATE_HINTS = /^(home|menu|search|sign in|log ?in|sign ?up|contact|about|blog|news|privacy|terms|cookie|skip to|next|previous|close|open|toggle)/i;

/**
 * @param {object[]} pages cleaned page objects from the crawler
 * @param {object} head parsed head
 * @returns {object} messaging section
 */
export function extractMessaging(pages = [], head = {}) {
  const headings = [];
  const paragraphs = [];

  for (const page of pages) {
    if (!page.ok) continue;
    const { url, html, title } = page;

    for (const m of html.matchAll(H_RE)) {
      const level = Number(m[1]);
      const text = decode(STRIP_TAGS(m[2]));
      if (!isUsefulHeading(text)) continue;
      headings.push({ text, level, url, isTitle: level === 1 });
      if (level === 1 && !title) page.title = text;
    }

    for (const m of html.matchAll(LIST_RE)) {
      const text = decode(STRIP_TAGS(m[2]));
      const sentences = splitSentences(text);
      if (sentences.length) paragraphs.push({ text: sentences[0], url });
      else if (text.length > 40 && text.length < 300) paragraphs.push({ text, url });
    }
  }

  const uniqueHeadings = dedupeBy(headings, (h) => h.text.toLowerCase());
  const topLevel = uniqueHeadings.filter((h) => h.level <= 3);

  const taglines = collectTaglineCandidates(head, uniqueHeadings);

  const keywords = salience(topLevel.map((h) => h.text));

  const pillars = derivePillars(keywords, topLevel, pages);
  const boilerplate = findBoilerplate(uniqueHeadings);

  return {
    positioning: buildPositioningStatement(head, taglines, pages),
    taglines,
    pillars,
    keywords: keywords.slice(0, 20),
    headlines: topLevel
      .sort((a, b) => a.level - b.level)
      .slice(0, 14)
      .map((h) => ({ text: h.text, level: h.level, source: h.url })),
    boilerplate,
    claims: collectClaims(paragraphs),
    source: {
      method: `headings and body copy harvested from ${pages.filter((p) => p.ok).length} fetched page(s), ranked by term salience`,
      pagesRead: pages.filter((p) => p.ok).map((p) => ({ url: p.url, sentences: splitSentences(htmlToText(p.html)).length })),
    },
  };
}

/**
 * Tagline candidates, each with the reason it is a candidate. A real brand
 * guide needs options, and the marketer picks.
 */
function collectTaglineCandidates(head, headings) {
  const out = [];
  const seen = new Set();

  const push = (text, kind, source, reason) => {
    const clean = decode(String(text || '').trim()).replace(/\s+/g, ' ');
    if (!clean || clean.length < 8 || clean.length > 140) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: clean, kind, source, reason, length: clean.length });
  };

  push(head.ogDescription, 'og:description', 'head metadata', 'the description the brand chose for social sharing');
  push(head.description, 'meta description', 'head metadata', 'the description in the document head');
  push(head.ogTitle, 'og:title', 'head metadata', 'the social title');

  for (const h of headings.filter((x) => x.level === 1).slice(0, 4)) {
    push(h.text, 'h1', h.url, 'primary page headline');
  }
  for (const h of headings.filter((x) => x.level === 2).slice(0, 8)) {
    push(h.text, 'h2', h.url, 'section headline');
  }
  push(head.title, 'title tag', 'head metadata', 'the browser tab title');

  // Shortest, most declarative headlines are usually the closest thing to a
  // tagline, so put them near the front.
  return out
    .map((c) => ({ ...c, score: taglineScore(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function taglineScore(candidate) {
  const words = candidate.text.split(/\s+/).length;
  let score = 10;
  score -= Math.abs(words - 7) * 1.2; // sweet spot around 5-9 words
  if (/[.!?]$/.test(candidate.text)) score -= 2;
  if (candidate.kind === 'h1') score += 3;
  if (candidate.kind === 'og:description') score += 1;
  if (/\b(free|today|now|fastest|best|leading|all-in-one)\b/i.test(candidate.text)) score += 1;
  return Number(score.toFixed(2));
}

/**
 * TF salience over headings. IDF is approximated from how many pages a term
 * appears on, so a word on every page ranks lower than one that characterises
 * a specific page.
 */
export function salience(texts) {
  const STOP = new Set(
    ('a an the and or but if then than that this these those for with without from into over under about ' +
      'your you our we us they their it its is are was were be been being do does did have has had will ' +
      'can could should would may might must not no yes all any some more most less least new every each ' +
      'how what why when where who which while as by at of to in on up out so such only own same too very ' +
      'just now here there also get got make made use used using help helps like love best great good better ' +
      'one two three first second next last other another via per plus vs')
      .split(' '),
  );

  const docFreq = new Map();
  const termFreq = new Map();
  let docCount = 0;

  for (const text of texts) {
    docCount += 1;
    const seenInDoc = new Set();
    for (const term of tokenise(text)) {
      if (STOP.has(term) || term.length < 3 || /^\d+$/.test(term)) continue;
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      if (!seenInDoc.has(term)) {
        seenInDoc.add(term);
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }
  }

  const scored = [...termFreq.entries()].map(([term, tf]) => {
    const df = docFreq.get(term) || 1;
    const idf = Math.log(1 + docCount / df);
    return {
      term,
      weight: Number((tf * idf).toFixed(3)),
      pages: df,
      mentions: tf,
    };
  });

  return scored.sort((a, b) => b.weight - a.weight);
}

/**
 * Conservative stemming, used only to group near-synonyms into one pillar.
 *
 * An earlier version stripped `/s|es|ing|ers?|ed$/`, which turned "services"
 * into "servic" and "housing" into "hous". A pillar called "Servic" is worse
 * than no pillar at all, so only a trailing plural is removed.
 */
function stem(word) {
  if (word.length <= 3) return word;
  if (/(ss|us|is|ous|ics)$/.test(word)) return word; // analysis, address, status
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Group the top terms into a few pillars a marketer would recognise. */
function derivePillars(keywords, headings, pages) {
  const top = keywords.slice(0, 30).map((k) => k.term);
  const stop = new Set([
    'home', 'contact', 'menu', 'search', 'privacy', 'terms', 'cookies',
    'skip', 'main', 'content', 'page', 'pages', 'service', 'services',
  ]);

  const groups = new Map();
  for (const term of top) {
    if (stop.has(term)) continue;
    const key = stem(term);
    if (key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(term);
  }

  const ordered = [...groups.entries()]
    .map(([key, variants]) => ({ key, variants, weight: maxWeight(keywords, variants) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  return ordered.map((group, index) => {
    const supporting = headings.filter((h) => group.variants.some((v) => h.text.toLowerCase().includes(v)));
    return {
      name: titleCase(group.key),
      theme: group.key,
      terms: group.variants,
      weight: group.weight,
      support: supporting.slice(0, 3).map((h) => ({ text: h.text, source: h.url })),
      prevalence:
        pages.length === 0
          ? null
          : Number(
              (
                pages.filter((p) =>
                  group.variants.some((v) => (p.html || '').toLowerCase().includes(v)),
                ).length / pages.length
              ).toFixed(2),
            ),
      rank: index + 1,
    };
  });
}

function maxWeight(keywords, variants) {
  return Number(
    Math.max(...variants.map((v) => keywords.find((k) => k.term === v)?.weight || 0)).toFixed(3),
  );
}

/** A one-sentence positioning statement assembled from what the site states. */
function buildPositioningStatement(head, taglines, pages) {
  const audience = inferAudience(pages);
  const category = inferCategory(head, pages);

  const primary = taglines[0]?.text;
  if (!primary) return null;

  const parts = [];
  parts.push(`${category ? `${category} that ` : ''}${lowerFirst(primary)}`);
  if (audience) parts[parts.length - 1] += `, for ${audience}`;

  return {
    text: parts.join(''),
    basis: 'assembled from the brand\'s own og:description and primary headline',
    source: taglines[0].source,
  };
}

function inferAudience(pages) {
  const corpus = pages.map((p) => htmlToText(p.html || '')).join(' ').toLowerCase();
  const AUDIENCES = [
    ['developers', /\bdevelopers?\b|\bengineers?\b/],
    ['teams', /\bteams?\b/],
    ['marketing teams', /\bmarketing\b/],
    ['designers', /\bdesigners?\b/],
    ['businesses', /\bbusiness(es)?\b|\bcompanies\b/],
    ['startups', /\bstart-?ups?\b/],
    ['enterprise buyers', /\benterprise\b/],
    ['creators', /\bcreators?\b|\binfluencers?\b/],
    ['consumers', /\bconsumers?\b|\bcustomers?\b/],
  ];
  let best = null;
  for (const [name, re] of AUDIENCES) {
    const hits = (corpus.match(new RegExp(re.source, 'g')) || []).length;
    if (hits >= 3 && (!best || hits > best.hits)) best = { name, hits };
  }
  return best?.name || null;
}

function inferCategory(head, pages) {
  const corpus = `${head.ogDescription || ''} ${head.description || ''} ${pages.map((p) => p.title || '').join(' ')}`;
  const CATEGORIES = [
    ['Developer platform', /\b(api|sdk|developer|platform|framework|tooling)\b/i],
    ['Analytics', /\b(analytics|dashboard|insights|reporting|metrics)\b/i],
    ['Design tool', /\b(design|prototype|figma|canvas|creative)\b/i],
    ['SaaS product', /\b(platform|software|app|workspace)\b/i],
    ['Commerce', /\b(shop|store|checkout|commerce|selling)\b/i],
    ['Media', /\b(content|publish|newsletter|publication)\b/i],
  ];
  for (const [name, re] of CATEGORIES) if (re.test(corpus)) return name;
  return null;
}

/** Marketing claims with a number in them — the kind a deck needs. */
function collectClaims(paragraphs) {
  const seen = new Set();
  const out = [];
  for (const p of paragraphs) {
    const text = p.text?.trim();
    if (!text || text.length < 25 || text.length > 220) continue;
    const key = text.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/\d|\b(faster|free|secure|fast|easy|simple|secure|unlimited|included|guaranteed)\b/i.test(text)) continue;
    out.push({ text, source: p.url });
    if (out.length >= 10) break;
  }
  return out;
}

/** Nav and legal headings, which are not messaging and should not be quoted. */
function findBoilerplate(headings) {
  const out = [];
  for (const h of headings) {
    const text = h.text.trim();
    const words = text.split(/\s+/);
    if (words.length <= 3 || BOILERPLATE_HINTS.test(text) || /^(©|©|\d{4})/.test(text)) {
      out.push({ text, level: h.level, source: h.url, why: 'navigation or boilerplate, excluded from messaging' });
    }
    if (out.length >= 8) break;
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function tokenise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-']+|[-']+$/g, ''))
    .filter(Boolean);
}

function isUsefulHeading(text) {
  if (!text || text.length < 4 || text.length > 220) return false;
  if (BOILERPLATE_HINTS.test(text)) return false;
  if (/^\W*$/.test(text)) return false;
  const words = text.split(/\s+/);
  return words.length >= 1 && words.length <= 24;
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function decode(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}