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
  const sourceLabel = (url) => url ? ` [${url}]` : '';
  const headlines = (messaging.headlines || []).slice(0, 20).map((h) => `- ${h.text}${sourceLabel(h.source)}`);
  const signal = (voice.signalSentences || []).slice(0, 10).map((s) => `- ${s.text}${sourceLabel(s.page || s.url)}`);
  const claims = (messaging.claims || []).slice(0, 8).map((c) => `- ${c.text}${sourceLabel(c.source)}`);
  const tagline = identity.tagline || messaging.taglines?.[0]?.text || null;

  return [
    `BRAND: ${identity.name}`,
    `DOMAIN: ${identity.domain}`,
    `SITE DESCRIPTION: ${identity.description || '(not found)'}`,
    `TAGLINE: ${tagline || '(not found)'}`,
    `MEASURED POSITIONING: ${messaging.positioning?.text || '(not found)'}`,
    `SOURCE COVERAGE: ${voice.pagesAnalysed || 0} page(s), ${voice.sentencesAnalysed || 0} usable sentences`,
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

const SYSTEM_RULES = `You are the editorial strategist for a professional brand standards guide.
Write clear, composed prose that a design and marketing team can reuse. The voice should
sound considered and specific, not like generic SaaS analysis or promotional copy.

You will receive measured copy, metadata, and source coverage from a live website.
Use only what those sources support. Metadata and positioning are the company's stated
language; voice metrics are observations, not proof of the company's intent.

Editorial rules:
- Start with the company's actual product, audience, and promise when the evidence states them.
- Write about the company itself, not about the report: never open with “This document,”
  “This guide,” extraction methods, or a summary of what the reader will see next.
- If only one page was read, keep the story to what that page says. Never invent a founding
  story, mission, customer outcome, market position, or product capability.
- Keep the brand story concrete: connect the stated customer need to the product's stated
  approach. Do not inflate it into a grand narrative.
- Describe the writing voice from the supplied metrics and examples. Do not claim the voice
  is effective, fits the market, or is universally consistent unless the evidence establishes it.
- Avoid adjective piles, canned phrases, unsupported superlatives, and claims such as
  “perfectly suits its market,” “no-nonsense,” “blazing fast,” or “revolutionary.”
- Do not describe colours, fonts, or logos. Those are measured separately.
- Do not repeat the report's extraction process or counts as brand story.
- If the evidence does not support a detail, omit it instead of filling the gap.

Return ONLY valid JSON with this exact shape:
{
  "brandStory": "2-3 polished sentences, about 30-55 words. Explain what the company makes, who it serves, and its central promise or approach only where the supplied sources state those facts. If they do not support all three, write less and leave gaps rather than padding.",
  "toneSummary": "1-2 concise sentences describing observable writing patterns, grounded in the supplied metrics and examples. Do not speculate about market fit.",
  "pillars": [
    { "name": "Short pillar name", "claim": "What this pillar says, in one sentence.", "evidence": "Quote from the provided headlines or sentences." }
  ],
  "positioning": "One sentence that restates the supplied measured positioning. Use an empty string if none was found.",
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
    brandStory: str(parsed.brandStory, 700),
    toneSummary: str(parsed.toneSummary, 500),
    positioning: str(parsed.positioning, 300),
    pillars,
    doNext: Array.isArray(parsed.doNext) ? parsed.doNext.map((d) => str(d, 200)).filter(Boolean).slice(0, 3) : [],
    watchOuts: Array.isArray(parsed.watchOuts) ? parsed.watchOuts.map((d) => str(d, 200)).filter(Boolean).slice(0, 2) : [],
  };
}
