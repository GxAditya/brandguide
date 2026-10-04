/**
 * Sentence-level voice analysis.
 *
 * Deterministic on purpose. Tone of voice is measurable from copy: sentence
 * length, reading grade, how often the brand says "you" versus "we", whether it
 * hedges, how much it contracts, whether it shouts. That is enough to describe
 * a voice without a model, and every number here can be checked against the
 * source page.
 *
 * If an LLM is configured, its narrative lands in a separate `narrative` field
 * and never overwrites these measurements.
 */

/** Feature dictionaries. Deliberately small and English-centric. */
const HEDGES = [
  'may', 'might', 'could', 'perhaps', 'possibly', 'we think', 'we believe',
  'appears', 'seems', 'somewhat', 'fairly', 'rather', 'generally', 'typically',
  'usually', 'often', 'helps', 'aims to', 'designed to', 'up to', 'best effort',
];
const POWER = [
  'fastest', 'best', 'leading', 'unmatched', 'powerful', 'instantly', 'effortless',
  'revolutionary', 'breakthrough', 'delightful', 'love', 'faster', 'simplest',
  'seamless', 'robust', 'powerful', 'scale', 'unlock', 'transform', 'ultimate',
  'definitive', 'remarkable', 'delightful', 'magic', 'supercharge', '10x',
];
const WARMTH = [
  'you', 'your', "you're", "you'll", 'we', 'our', 'together', 'hello', 'welcome',
  'thank', 'care', 'community', 'human', 'friendly', 'love', 'join', 'share',
  'everyone', 'real people', 'story',
];
const FORMALITY = [
  'therefore', 'furthermore', 'accordingly', 'hereby', 'aforementioned',
  'utilise', 'endeavour', 'regarding', 'notwithstanding', 'commence', 'terminate',
];
const CASUAL = [
  'lol', 'yeah', 'hey', 'gonna', 'wanna', 'kinda', 'sorta', 'awesome', 'super',
  'totally', 'literally', 'basically', 'pretty much', 'stuff', 'things',
  'guys', 'awesome', 'amazing', 'insane', 'mind-blowing', 'stuff',
];
const JARGON = [
  'kubernetes', 'microservices', 'serverless', 'api', 'sdk', 'cli', 'saas',
  'idp', 'sso', 'kubernetes-native', 'infrastructure', 'pipeline', 'workflow',
  'deployment', 'observability', 'orchestration', 'runtime', 'data lake',
];
const BOILERPLATE_MARKERS = [
  'cookie', 'privacy policy', 'terms of service', 'all rights reserved',
  'subscribe to our newsletter', 'follow us on', '©', 'inc.', 'llc',
  'accept all', 'manage preferences', 'sign up', 'get started for free',
];

const POSITIVE_FRAMING = /\b(free|no credit card|cancel anytime|included|unlimited|guarantee|love-it-or|try it)\b/i;

/**
 * Strip HTML down to readable sentences.
 * @param {string} html cleaned semantic HTML from TinyFish Fetch
 */
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split into sentences, dropping fragments, nav labels and list noise.
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (!text) return [];
  const candidates = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 28 && s.length <= 320)
    // A "sentence" with no verb or no spaces is a label, not prose.
    .filter((s) => /\s/.test(s) && /[a-z]/i.test(s))
    .filter((s) => (s.match(/[.!?…]/g) || []).length <= 2)
    .filter(isProse);

  const boilerplate = new Set();
  const out = [];
  for (const sentence of candidates) {
    const lower = sentence.toLowerCase();
    if (BOILERPLATE_MARKERS.some((m) => lower.includes(m))) {
      boilerplate.add(sentence);
      continue;
    }
    out.push(sentence);
  }

  return [...new Set(out)];
}

/**
 * Reject strings that a browser render stitched together rather than wrote.
 *
 * Linear's homepage carries a changelog feed. Stripping its tags produces
 * "andreas Feels like we could render sooner and load the rest in the
 * background." — a username welded to the start of a comment. Tag boundaries
 * always leave that trace: a capitalised word directly after a lowercase one,
 * with no punctuation between them.
 */
function isProse(sentence) {
  const trimmed = sentence.replace(/^["'“”‘’(\[*-]+/, '');

  // Real sentences open with a capital, a digit, or a quote.
  if (!/^[A-Z0-9"“”]/.test(trimmed)) return false;

  // A separator dot or slash is UI chrome between fields, not prose.
  if (/·|\s\|\s|\s\/\s/.test(sentence)) return false;

  // A timestamp welded into the text: "2 min ago", "Jun 25", "2024".
  if (/\b\d+\s?(sec|secs|min|mins|m|h|d|mo|hrs?|days?|weeks?|months?|yrs?|years?)\b\.?$/i.test(sentence)) return false;

  // Tag-boundary artefact: lowercase word immediately followed by a capitalised
  // one, with nothing between them. Allow "iPhone", "GitHub" and "eBay" by
  // requiring the lowercase word to be long enough to be a real word.
  if (/\b[a-z]{3,}[A-Z][a-z]{2,}/.test(sentence)) return false;

  return true;
}

/**
 * Measure one page's copy.
 *
 * @param {string} html
 * @param {string} [url]
 * @returns {object} voice measurement
 */
export function analyseCopy(html, url = null) {
  const text = htmlToText(html);
  const sentences = splitSentences(text);
  const words = text.split(/\s+/).filter(Boolean);
  const corpus = text.toLowerCase();

  if (!sentences.length) {
    return {
      url,
      ok: false,
      sentenceCount: 0,
      wordCount: words.length,
      metrics: null,
      signalSentences: [],
      boilerplate: [],
    };
  }

  const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const syllables = countSyllables(sentences);

  const counts = {
    you: (corpus.match(/\byou\b|\byour\b|\byou're\b|\byou'll\b|\byourself\b/g) || []).length,
    we: (corpus.match(/\bwe\b|\bour\b|\bwe're\b|\bwe'll\b|\bus\b|\bour's\b/g) || []).length,
    they: (corpus.match(/\bthey\b|\btheir\b|\bthem\b|\bcustomers?\b|\busers?\b|\bteams?\b|\bclients?\b/g) || []).length,
  };
  const totalPronouns = Math.max(1, counts.you + counts.we + counts.they);

  const contractions = (corpus.match(/\b\w+'(s|t|re|ll|ve|d|m)\b/g) || []).length;
  const hedges = countTerms(corpus, HEDGES);
  const power = countTerms(corpus, POWER);
  const warmth = countTerms(corpus, WARMTH);
  const formal = countTerms(corpus, FORMALITY);
  const casual = countTerms(corpus, CASUAL);
  const jargon = countTerms(corpus, JARGON);
  const exclamations = (text.match(/!/g) || []).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const questions = (text.match(/\?/g) || []).length;

  const wordsTotal = Math.max(1, words.length);
  const per1000 = (n) => Number(((n / wordsTotal) * 1000).toFixed(2));

  const hedgeRate = per1000(hedges);
  const powerRate = per1000(power);
  const scale = Math.max(1, formality(corpus));

  const metrics = {
    sentenceCount: sentences.length,
    wordCount: words.length,
    avgSentenceLength: Number(mean(lengths).toFixed(1)),
    medianSentenceLength: median(lengths),
    longestSentence: Math.max(...lengths),
    readingGrade: Number(fleschKincaidGrade(wordsTotal, syllables, sentences.length).toFixed(1)),
    // 0..1 normalised features. These are the comparable tone vector.
    // Every rate below is per 1000 words, so a 40-word page and a 4000-word
    // page are comparable — dividing raw counts by page length made short pages
    // read as maximally hedged.
    directness: round3(clamp01(1 - (mean(lengths) - 9) / 26)),
    formality: round3(clamp01(formal / (scale * 2 + 1))),
    enthusiasm: round3(clamp01(per1000(exclamations) / 2)),
    playfulness: round3(clamp01(casual / (scale + 1) + per1000(emoji) / 3)),
    warmth: round3(clamp01(counts.you / totalPronouns)),
    // 60 hedges per 1000 words is heavily hedged; 0 is flat assertion. The scale
    // has to be that wide because ordinary marketing copy already runs 20-40.
    assertiveness: round3(clamp01(1 - hedgeRate / 60)),
    confidence: round3(clamp01(powerRate / (powerRate + hedgeRate + 6))),
    technicality: round3(clamp01((jargon / scale) / 8)),
    contractionRate: Number((contractions / wordsTotal * 100).toFixed(3)),
    youRate: per1000(counts.you),
    weRate: per1000(counts.we),
    youToWeRatio: counts.we ? Number((counts.you / counts.we).toFixed(2)) : null,
    exclamationRate: per1000(exclamations),
    questionRate: per1000(questions),
    hedgeRate,
    powerWordRate: powerRate,
    jargonRate: per1000(jargon),
    avgSyllablesPerWord: Number((syllables / wordsTotal).toFixed(2)),
  };

  return {
    url,
    ok: true,
    ...metrics,
    metrics,
    pronouns: counts,
    signalSentences: pickSignalSentences(sentences, metrics, counts, url),
    boilerplate: [],
    raw: { text: text.slice(0, 4000) },
  };
}

/**
 * Merge per-page measurements into one brand voice profile.
 *
 * @param {object[]} pageAnalyses
 */
export function mergeVoice(pageAnalyses) {
  const usable = pageAnalyses.filter((p) => p.ok && p.sentenceCount >= 3);
  if (!usable.length) {
    return {
      ok: false,
      vector: null,
      pagesAnalysed: 0,
      sentencesAnalysed: 0,
      summary: 'Not enough prose was found to characterise the voice.',
      do: [],
      dont: [],
      boilerplate: [],
    };
  }

  const weight = usable.reduce((sum, p) => sum + p.sentenceCount, 0);
  const avg = (key) =>
    Number(
      (usable.reduce((sum, p) => sum + (p.metrics[key] ?? 0) * p.sentenceCount, 0) / weight).toFixed(3),
    );

  const vector = {
    directness: avg('directness'),
    formality: avg('formality'),
    enthusiasm: avg('enthusiasm'),
    playfulness: avg('playfulness'),
    warmth: avg('warmth'),
    assertiveness: avg('assertiveness'),
    confidence: avg('confidence'),
    technicality: avg('technicality'),
  };

  const consistency = pageConsistency(usable, vector);

  return {
    ok: true,
    vector,
    raw: {
      avgSentenceLength: avg('avgSentenceLength'),
      readingGrade: avg('readingGrade'),
      youToWeRatio: weightedRatio(usable, 'youToWeRatio'),
      contractionRate: avg('contractionRate'),
      exclamationRate: avg('exclamationRate'),
      hedgeRate: avg('hedgeRate'),
      jargonRate: avg('jargonRate'),
    },
    pagesAnalysed: usable.length,
    sentencesAnalysed: usable.reduce((s, p) => s + p.sentenceCount, 0),
    wordsAnalysed: usable.reduce((s, p) => s + p.wordCount, 0),
    consistency: {
      score: Number(consistency.score.toFixed(2)),
      grade: consistency.grade,
      spread: consistency.spread,
      note:
        consistency.grade === 'consistent'
          ? 'Marketing pages speak in one voice.'
          : consistency.grade === 'varied'
            ? 'Voice shifts noticeably between pages, which is normal between a careers page and a product page.'
            : 'Voice shifts sharply between pages.',
    },
    descriptors: describeVoice(vector),
    do: buildDoList(usable, vector),
    dont: buildDontList(usable, vector),
    signalSentences: usable.flatMap((p) => p.signalSentences.slice(0, 4).map((s) => ({ ...s, page: s.page || p.url }))),
    boilerplate: dedupeStrings(usable.flatMap((p) => p.boilerplate)).slice(0, 5),
    perPage: usable.map((p) => ({
      url: p.url,
      sentences: p.sentenceCount,
      avgSentenceLength: p.metrics.avgSentenceLength,
      readingGrade: p.metrics.readingGrade,
      warmth: p.metrics.warmth,
      assertiveness: p.metrics.assertiveness,
    })),
  };
}

/** Plain-language labels, so a marketer reads this without a stats degree. */
export function describeVoice(v) {
  const out = [];
  const band = (value, low, high) => (value < low ? 0 : value > high ? 2 : 1);

  const formal = band(v.formality, 0.2, 0.6);
  out.push({
    axis: 'Register',
    value: ['casual', 'conversational', 'formal'][formal],
    note: formal === 0 ? 'writes the way it talks' : formal === 2 ? 'keeps a formal register' : 'conversational but composed',
  });

  const play = band(v.playfulness, 0.2, 0.6);
  out.push({
    axis: 'Playfulness',
    value: ['restrained', 'light', 'loose'][play],
    note: play === 0 ? 'no jokes, no filler' : play === 2 ? 'frequent asides and casual asides' : 'occasional levity',
  });

  const warm = band(v.warmth, 0.33, 0.6);
  out.push({
    axis: 'Audience address',
    value: ['you-first', 'balanced', 'we-first'][warm],
    note: warm === 0 ? 'talks to the reader directly' : warm === 2 ? 'talks about itself more than the reader' : 'mix of "we" and "you"',
  });

  const assert_ = band(v.assertiveness, 0.6, 0.9);
  out.push({
    axis: 'Certainty',
    value: ['hedged', 'measured', 'decisive'][assert_],
    note: assert_ === 0 ? 'hedges its claims' : assert_ === 2 ? 'makes claims without qualifiers' : 'qualifies when needed',
  });

  const direct = band(v.directness, 0.35, 0.65);
  out.push({
    axis: 'Sentence length',
    value: ['long-form', 'mixed', 'punchy'][direct],
    note: direct === 0 ? 'long, layered sentences' : direct === 2 ? 'short and clipped' : 'mixes sentence lengths',
  });

  const tech = band(v.technicality, 0.15, 0.5);
  out.push({
    axis: 'Vocabulary',
    value: ['plain', 'domain-aware', 'jargon-heavy'][tech],
    note: tech === 0 ? 'plain language' : tech === 2 ? 'assumes domain knowledge' : 'uses product terms without assuming expertise',
  });

  return out;
}

/** Concrete, evidence-backed guidance built from the actual numbers. */
function buildDoList(pages, vector) {
  const doItems = [];
  const avgLen = weightedMean(pages, 'avgSentenceLength');

  doItems.push({
    instruction: `Keep the average sentence near ${Math.round(avgLen)} words`,
    because: `that is what this brand's own marketing copy averages across ${pages.length} page${pages.length === 1 ? '' : 's'}`,
    evidence: pages[0].signalSentences[0]?.text || null,
    source: pages[0].url,
  });

  if (vector.warmth > 0.4) {
    const example = pages.flatMap((p) => p.signalSentences).find((s) => /\byou(r)?\b/i.test(s.text));
    doItems.push({
      instruction: 'Address the reader as "you"',
      because: `${Math.round(vector.warmth * 100)}% of the brand's pronouns are second person`,
      evidence: example?.text || null,
      source: example?.page || pages[0].url,
    });
  } else {
    const example = pages.flatMap((p) => p.signalSentences).find((s) => /\b(we|our)\b/i.test(s.text));
    doItems.push({
      instruction: 'Lead with "we" and speak about the company first',
      because: `only ${Math.round(vector.warmth * 100)}% of pronouns are second person — the brand talks about itself before the reader`,
      evidence: example?.text || null,
      source: example?.page || pages[0].url,
    });
  }

  if (vector.assertiveness > 0.7) {
    doItems.push({
      instruction: 'State benefits without hedges',
      because: `hedging appears at ${pages[0].metrics.hedgeRate} times per 1000 words`,
      evidence: null,
      source: pages[0].url,
    });
  }

  const powerExample = pages
    .flatMap((p) => p.signalSentences)
    .find((s) => POWER.some((p) => s.text.toLowerCase().includes(p)));
  if (powerExample) {
    doItems.push({
      instruction: 'Use concrete superlatives where they are true',
      because: 'the brand reaches for claims like this rather than hedging',
      evidence: powerExample.text,
      source: powerExample.page,
    });
  }

  return doItems.slice(0, 5);
}

function buildDontList(pages, vector) {
  const dontItems = [];

  if (vector.formality > 0.5) {
    dontItems.push({
      instruction: 'Avoid slang and contractions',
      because: `the brand's own copy stays formal — only ${(pages[0].metrics.contractionRate * 100).toFixed(2)}% of words are contractions`,
      example: "Don't write things like 'we're stoked'",
      source: pages[0].url,
    });
  } else {
    dontItems.push({
      instruction: 'Avoid boardroom language',
      because: 'the brand writes conversationally, not institutionally',
      example: 'Rather than "utilise our comprehensive solutions", write "use our tools"',
      source: pages[0].url,
    });
  }

  if (vector.technicality < 0.25) {
    dontItems.push({
      instruction: 'Do not lead with internal jargon',
      because: `jargon appears at only ${pages[0].metrics.jargonRate} per 1000 words`,
      example: 'Explain the mechanism after the benefit, not before',
      source: pages[0].url,
    });
  }

  if (vector.playfulness < 0.25) {
    dontItems.push({
      instruction: 'Keep humour out of the copy',
      because: 'the brand registers no casual markers or emoji in its marketing pages',
      example: 'No "ship it", no 🚀',
      source: pages[0].url,
    });
  }

  if (vector.enthusiasm < 0.2) {
    dontItems.push({
      instruction: 'Avoid exclamation marks',
      because: `the brand uses them at ${pages[0].metrics.exclamationRate} per 1000 words — close to none`,
      example: 'End on a full stop.',
      source: pages[0].url,
    });
  }

  return dontItems.slice(0, 5);
}

/** Quotes that best exemplify the voice, for human review. */
function pickSignalSentences(sentences, metrics, pronouns, url) {
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const words = sentence.split(/\s+/).filter(Boolean).length;
    let score = 0;

    // Length near the brand's own average is maximally characteristic.
    score += Math.max(0, 10 - Math.abs(words - metrics.avgSentenceLength));
    if (pronouns.you > 0 && /\b(you|your)\b/.test(lower)) score += 3;
    if (POWER.some((p) => lower.includes(p))) score += 2;
    if (HEDGES.some((h) => lower.includes(h))) score += 1;
    if (/\b(we|our|us)\b/.test(lower)) score += 2;
    if (POSITIVE_FRAMING.test(lower)) score += 2;
    // Skip sentences that are mostly a number or a nav label.
    if (/\d{4,}/.test(sentence)) score -= 3;
    // `page` travels with the quote so guidance can cite where it came from.
    return { text: sentence, words, score, page: url };
  });

  const seen = new Set();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((s) => {
      const key = s.text.slice(0, 40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

// --- numeric helpers -------------------------------------------------------

function countTerms(corpus, terms) {
  let n = 0;
  for (const term of terms) {
    if (term.includes(' ')) {
      n += (corpus.match(new RegExp(escapeRe(term), 'g')) || []).length;
    } else {
      n += (corpus.match(new RegExp(`\\b${escapeRe(term)}\\b`, 'g')) || []).length;
    }
  }
  return n;
}

function formality(corpus) {
  // Rough denominator so ratios stay stable on short pages.
  return Math.max(1, corpus.split(/\s+/).length / 250);
}

function countSyllables(sentences) {
  let total = 0;
  for (const sentence of sentences) {
    for (const word of sentence.toLowerCase().match(/[a-z']+/g) || []) {
      total += syllablesInWord(word);
    }
  }
  return total;
}

function syllablesInWord(word) {
  const w = word.replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  return Math.max(1, (stripped.match(/[aeiouy]{1,2}/g) || []).length);
}

function fleschKincaidGrade(words, syllables, sentences) {
  if (!words || !sentences) return 0;
  const wps = words / sentences;
  const spw = syllables / words;
  return 0.39 * wps + 11.8 * spw - 15.59;
}

function pageConsistency(pages, vector) {
  const axes = Object.keys(vector);
  let total = 0;
  const spread = {};
  for (const axis of axes) {
    const values = pages.map((p) => p.metrics[axis] ?? 0);
    const sd = Math.sqrt(mean(values.map((v) => (v - mean(values)) ** 2)));
    spread[axis] = Number(sd.toFixed(3));
    total += sd;
  }
  const score = Math.max(0, 1 - total / axes.length);
  return {
    score,
    grade: score > 0.8 ? 'consistent' : score > 0.55 ? 'varied' : 'erratic',
    spread,
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedMean(pages, key) {
  const total = pages.reduce((s, p) => s + p.sentenceCount, 0) || 1;
  return pages.reduce((s, p) => s + (p.metrics[key] ?? 0) * p.sentenceCount, 0) / total;
}

function weightedRatio(pages, key) {
  const values = pages.map((p) => p[key]).filter((v) => typeof v === 'number');
  return values.length ? Number(mean(values).toFixed(2)) : null;
}

function dedupeStrings(list) {
  return [...new Set(list)];
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round3(n) {
  return Number(clamp01(n).toFixed(3));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}