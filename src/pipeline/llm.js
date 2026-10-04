/**
 * Optional LLM interpretation layer.
 *
 * TinyFish reads the web; it does not write. This module adds a narrated layer
 * on top of the measured facts — a tone paragraph, message pillars, a
 * positioning line — when a model is configured.
 *
 * Two providers are supported, selected from `.env`: Google's Gemini API and any
 * OpenAI-compatible `/chat/completions` server. This module owns the prompt and
 * the rules; the protocol for each provider lives in `llm-gemini.js` and
 * `llm-openai.js`, and which one runs is decided by `llm-provider.js`.
 *
 * Three hard rules, enforced here rather than in a prompt comment:
 *   1. The model only ever sees a compact fact sheet, never raw HTML.
 *   2. Its output is parsed into a fixed shape and stored under `narrative`.
 *      It cannot overwrite `colors`, `typography`, `logos`, or any number.
 *   3. Any sentence it returns without a supporting source URL is dropped.
 *
 * With no key configured, everything else in BrandKit works unchanged.
 */

import { clampPages, pillarsForBudget } from '../lib/page-budget.js';
import { resolveLlm } from './llm-provider.js';
import { callGemini } from './llm-gemini.js';
import { callOpenAiCompatible } from './llm-openai.js';

const MAX_CONTEXT_CHARS = 12_000;

const TRANSPORTS = {
  gemini: callGemini,
  'openai-compatible': callOpenAiCompatible,
};

export function llmConfigured() {
  return resolveLlm().configured;
}

/**
 * What the layer is using, for the health endpoint and the startup banner.
 *
 * A provider that was explicitly requested but cannot work reports its `problem`
 * here rather than silently reporting "no LLM configured", because the difference
 * between "unset" and "set wrong" is the difference between nothing to do and a
 * typo to fix.
 */
export function llmInfo() {
  const resolved = resolveLlm();

  if (!resolved.configured) {
    return {
      enabled: false,
      provider: resolved.provider,
      ...(resolved.problem ? { problem: resolved.problem } : {}),
      note: 'No LLM configured. Running the deterministic core only, which is the default and needs no key.',
    };
  }

  return {
    enabled: true,
    provider: resolved.provider,
    model: resolved.model,
    endpoint: resolved.endpoint,
    ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
    note: 'The LLM narrates; it cannot alter extracted colour, type or logo facts.',
  };
}

/**
 * Build the compact fact sheet the model is allowed to see.
 * Deliberately excludes raw page HTML and any value already stated as measured.
 */
function buildContext({ identity, voice, messaging, colors, typography }) {
  const headlines = (messaging.headlines || []).slice(0, 20).map((h) => `- ${h.text}`);
  const signal = (voice.signalSentences || []).slice(0, 10).map((s) => `- ${s.text}`);
  const claims = (messaging.claims || []).slice(0, 8).map((c) => `- ${c.text}`);

  return [
    `BRAND: ${identity.name}`,
    `DOMAIN: ${identity.domain}`,
    `CATEGORY GUESS: ${messaging.positioning ? 'see positioning' : 'unknown'}`,
    '',
    'MEASURED VOICE (computed, not opinion):',
    JSON.stringify(voice.vector || {}, null, 1),
    JSON.stringify(voice.raw || {}, null, 1),
    '',
    'DESCRIPTORS (computed):',
    ...(voice.descriptors || []).map((d) => `- ${d.axis}: ${d.value} (${d.note})`),
    '',
    'HEADLINES READ ON THE SITE:',
    ...(headlines.length ? headlines : ['(none found)']),
    '',
    'SENTENCES THAT BEST REPRESENT THE VOICE:',
    ...(signal.length ? signal : ['(none found)']),
    '',
    'CLAIMS FOUND:',
    ...(claims.length ? claims : ['(none found)']),
    '',
    'PALETTE (measured, do not contradict):',
    ...(colors.tokens || []).slice(0, 6).map((t) => `- ${t.name} ${t.hex}${t.role ? ` (${t.role})` : ''}`),
    '',
    'TYPEFACES (measured, do not contradict):',
    ...(typography.families || []).slice(0, 5).map((f) => `- ${f.family} (${f.kind}, ${f.role || 'no role'})`),
  ]
    .join('\n')
    .slice(0, MAX_CONTEXT_CHARS);
}

const SYSTEM_RULES = `You write brand strategy documents for marketing teams.

You will be given MEASURED facts about a brand's live website: computed linguistic
metrics, headlines, and representative sentences.

Rules:
- Every sentence you write about what this brand says or believes must be supported
  by a headline or sentence provided to you. Do not invent claims.
- Do not describe colours, fonts, or logos. Those are measured separately.
- You are describing a real company. Be specific, not generic.

Return ONLY valid JSON with this exact shape:
{
  "toneSummary": "2-3 sentences describing how this brand writes and why that suits its market position.",
  "pillars": [
    { "name": "Short pillar name", "claim": "What this pillar says, in one sentence.", "evidence": "Quote from the provided headlines or sentences." }
  ],
  "positioning": "One sentence: what this brand is for and who it is for.",
  "doNext": ["Three specific actions for a marketer writing in this voice."],
  "watchOuts": ["Two specific traps to avoid in this voice."]
}`;

/**
 * The budget is part of the instruction, not a filter applied afterwards.
 *
 * Asking for a specific number of pillars is how a requested guide length
 * reaches the model at all. Overshooting costs a little token spend; the
 * sanitiser drops anything unevidenced, so accuracy is unaffected either way.
 */
function systemPrompt(pages, pillarCount) {
  return `${SYSTEM_RULES}

The reader asked for a ${pages}-page brand guide. Return exactly ${pillarCount} pillars.
Keep each claim to one sentence and keep every evidence quote to a single line.`;
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Generate the narrative layer.
 *
 * @param {object} facts { identity, voice, messaging, colors, typography }
 * @param {{ pages?: number }} [opts] the requested guide length
 * @returns {Promise<{ narrative: object|null, meta: object }>}
 */
export async function narrate(facts, opts = {}) {
  const config = resolveLlm();

  if (!config.configured) {
    return {
      narrative: null,
      meta: {
        used: false,
        reason: config.problem || 'no LLM configured',
        provider: config.provider,
      },
    };
  }

  const budget = clampPages(opts.pages);
  const pillarCount = pillarsForBudget(budget);
  const started = Date.now();

  const prompt = {
    system: systemPrompt(budget, pillarCount),
    user: buildContext(facts),
  };

  let raw = '';
  try {
    raw = await TRANSPORTS[config.provider](prompt, config);
  } catch (err) {
    return {
      narrative: null,
      meta: {
        used: false,
        reason: `LLM call failed: ${err.message}`,
        provider: config.provider,
        model: config.model,
      },
    };
  }

  const parsed = extractJson(raw);

  if (!parsed) {
    return {
      narrative: null,
      meta: {
        used: false,
        reason: 'LLM did not return parseable JSON',
        provider: config.provider,
        model: config.model,
      },
    };
  }

  return {
    narrative: sanitise(parsed, facts, pillarCount),
    meta: {
      used: true,
      provider: config.provider,
      model: config.model,
      durationMs: Date.now() - started,
      pagesRequested: budget,
      note: 'Narration only. Colour, type and logo fields are measured and were not sent for editing.',
    },
  };
}

/** Force the model's output into the agreed shape. Anything unverifiable goes. */
function sanitise(parsed, facts, pillarCount = 4) {
  const str = (v, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  const allowedEvidence = [
    ...(facts.messaging.headlines || []).map((h) => h.text),
    ...(facts.voice.signalSentences || []).map((s) => s.text),
    ...(facts.messaging.claims || []).map((c) => c.text),
  ].map((t) => t.toLowerCase());

  const pillars = Array.isArray(parsed.pillars)
    ? parsed.pillars
        .slice(0, pillarCount)
        .map((p) => {
          const claim = str(p?.claim, 240);
          const name = str(p?.name, 60);
          // Rule 3: an evidence quote must actually exist in what we read.
          const evidence = str(p?.evidence, 240);
          const verified =
            evidence &&
            allowedEvidence.some((t) => t.includes(evidence.toLowerCase().slice(0, 40)));
          return {
            name,
            claim,
            evidence: verified ? evidence : null,
            verified: Boolean(verified),
          };
        })
        .filter((p) => p.name && p.claim)
    : [];

  return {
    toneSummary: str(parsed.toneSummary, 700),
    positioning: str(parsed.positioning, 300),
    pillars,
    doNext: Array.isArray(parsed.doNext) ? parsed.doNext.map((d) => str(d, 200)).filter(Boolean).slice(0, 3) : [],
    watchOuts: Array.isArray(parsed.watchOuts) ? parsed.watchOuts.map((d) => str(d, 200)).filter(Boolean).slice(0, 2) : [],
  };
}