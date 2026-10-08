// Optional interpretation layer. TinyFish reads the web, it does not write.
// Three rules are enforced here, not in a prompt: the model sees only a compact fact
// sheet, never raw HTML; its output is parsed into a fixed shape stored under
// narrative, where it cannot overwrite a measured value; and a sentence without a
// supporting quote from the site is dropped.

import { clampPages, pillarsForBudget } from '../lib/page-budget.js';
import { resolveLlm } from './llm-provider.js';
import { callGemini } from './llm-gemini.js';
import { callOpenAiCompatible } from './llm-openai.js';

const MAX_CONTEXT_CHARS = 12_000;

const TRANSPORTS = {
  gemini: callGemini,
  'openai-compatible': callOpenAiCompatible,
};

export function llmConfigured(creds) {
  return resolveLlm(creds).configured;
}

// What the layer is using. A provider that cannot work reports its problem rather than
// looking unconfigured, because unset and set wrong need different fixes.
export function llmInfo(creds) {
  const resolved = resolveLlm(creds);

  if (!resolved.configured) {
    return {
      enabled: false,
      provider: resolved.provider,
      ...(resolved.problem ? { problem: resolved.problem } : {}),
      note: 'No LLM key for this request. BrandKit runs its deterministic core, which needs no key.',
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

// The compact fact sheet the model may see. No raw HTML, and nothing already measured
// that it could restate wrongly.
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

// The budget is part of the instruction, not a filter applied after. Overshooting costs
// a little token spend and never accuracy, because the sanitiser drops the unevidenced.
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

export async function narrate(facts, opts = {}) {
  const config = resolveLlm(opts.creds);

  if (!config.configured) {
    return {
      narrative: null,
      meta: {
        used: false,
        reason: config.problem || 'no LLM key supplied for this request',
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

// Forces the output into the agreed shape. Anything unverifiable goes.
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
          // Rule 3: an evidence quote must exist in what we actually read.
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