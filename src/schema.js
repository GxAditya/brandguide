/**
 * JSON Schema for the brand guide object, plus a small validator covering the
 * subset of JSON Schema this document actually uses.
 *
 * A module rather than a served endpoint: the demo run validates a real
 * extraction against it, which catches a payload drifting from its own contract
 * rather than publishing the contract and hoping a caller reads it.
 */

export const BRAND_GUIDE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://brandkit.dev/schema/brand-guide-1.0.0.json',
  title: 'BrandKit brand guide',
  description:
    'A structured, evidence-backed brand guide extracted from a live website through TinyFish Search and Fetch.',
  type: 'object',
  required: ['schemaVersion', 'generatedAt', 'input', 'identity', 'logos', 'colors', 'typography', 'voice', 'messaging', 'confidence', 'provenance'],
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    generatedAt: { type: 'string', format: 'date-time' },

    input: {
      type: 'object',
      required: ['given', 'kind', 'resolvedUrl', 'resolvedBy'],
      properties: {
        given: { type: 'string', description: 'Exactly what the caller passed in.' },
        kind: { enum: ['url', 'name'] },
        resolvedUrl: { type: 'string', format: 'uri' },
        resolvedBy: { enum: ['direct', 'search', 'failed'] },
        reasoning: { type: ['string', 'null'] },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              host: { type: 'string' },
              reasoning: { type: 'string' },
              title: { type: ['string', 'null'] },
            },
          },
        },
      },
    },

    identity: {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: { type: 'string' },
        legalName: { type: ['string', 'null'] },
        domain: { type: ['string', 'null'] },
        url: { type: 'string', format: 'uri' },
        tagline: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        source: { type: 'object' },
      },
    },

    logos: {
      type: 'object',
      required: ['source'],
      properties: {
        primary: {
          type: ['object', 'null'],
          required: ['url', 'format', 'verifiedBy'],
          properties: {
            url: { type: 'string', format: 'uri' },
            format: { enum: ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp', 'gif'] },
            type: { type: 'string' },
            firstParty: { type: 'boolean' },
            verifiedBy: { const: 'tinyfish-fetch' },
            reason: { type: 'string' },
            // Sanitised SVG source, present only when it was readable. Lets a
            // consumer re-render the mark with its colours intact instead of
            // loading it as an image, where `currentColor` cannot resolve.
            svg: { type: ['string', 'null'] },
            svgTone: { type: ['string', 'null'], enum: ['light', 'dark', 'inherit', 'unknown', null] },
          },
        },
        // The mark plus wordmark, when that is a different asset from the mark. A cover
        // or a logotype page needs this, not the app icon.
        lockup: {
          type: ['object', 'null'],
          required: ['url', 'format', 'verifiedBy'],
          properties: {
            url: { type: 'string', format: 'uri' },
            format: { enum: ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp', 'gif'] },
            type: { type: 'string' },
            firstParty: { type: 'boolean' },
            verifiedBy: { const: 'tinyfish-fetch' },
            reason: { type: 'string' },
            svg: { type: ['string', 'null'] },
            svgTone: { type: ['string', 'null'], enum: ['light', 'dark', 'inherit', 'unknown', null] },
          },
        },
        alternates: { type: 'array', items: { type: 'object' } },
        rejected: { type: 'array', items: { type: 'object' } },
        source: {
          type: 'object',
          required: ['method'],
          properties: { method: { type: 'string' } },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },

    colors: {
      type: 'object',
      required: ['tokens', 'roles', 'contrast'],
      properties: {
        tokens: {
          type: 'array',
          items: {
            type: 'object',
            required: ['hex', 'rgb', 'hsl', 'name'],
            properties: {
              hex: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
              rgb: { type: 'string' },
              hsl: { type: 'string' },
              name: { type: 'string' },
              role: { type: ['string', 'null'] },
              tier: { enum: ['declaredRole', 'bareRole', 'paletteEntry', 'component'] },
              declared: { type: 'boolean' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              evidence: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        roles: {
          type: 'object',
          required: ['primary', 'background', 'text'],
          properties: {
            primary: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
            background: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
            text: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
            surface: { type: 'string' },
            muted: { type: 'string' },
            border: { type: 'string' },
            onPrimary: { type: 'string' },
            inferred: { type: 'array', items: { type: 'string' } },
            shared: { type: 'array', items: { type: 'string' } },
            darkSurface: { type: 'boolean' },
            declaredThemeColor: { type: ['string', 'null'] },
          },
        },
        neutralRamp: { type: 'object', additionalProperties: { type: 'string' } },
        contrast: {
          type: 'array',
          items: {
            type: 'object',
            required: ['foreground', 'background', 'ratio'],
            properties: {
              use: { type: 'string' },
              foreground: { type: 'string' },
              background: { type: 'string' },
              ratio: { type: 'number', minimum: 1, maximum: 21 },
              label: { type: 'string' },
            },
          },
        },
        source: { type: 'object' },
      },
    },

    typography: {
      type: 'object',
      required: ['families', 'pairing'],
      properties: {
        families: {
          type: 'array',
          items: {
            type: 'object',
            required: ['family', 'kind', 'declaredIn'],
            properties: {
              family: { type: 'string' },
              kind: { enum: ['serif', 'sans', 'mono', 'display', 'system'] },
              role: { type: ['string', 'null'] },
              weights: { type: 'array', items: { type: 'string' } },
              declaredIn: { type: 'string' },
              isWebfont: { type: 'boolean' },
              confidence: { type: 'number' },
              source: { type: 'object' },
            },
          },
        },
        pairing: {
          type: 'object',
          properties: {
            heading: { type: ['string', 'null'] },
            body: { type: ['string', 'null'] },
            mono: { type: ['string', 'null'] },
            rationale: { type: 'string' },
          },
        },
        scale: { type: 'array', items: { type: 'object' } },
        detail: { type: 'object' },
        source: { type: 'object' },
      },
    },

    voice: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        vector: { type: ['object', 'null'] },
        descriptors: { type: 'array', items: { type: 'object' } },
        do: {
          type: 'array',
          items: {
            type: 'object',
            required: ['instruction', 'because'],
            properties: {
              instruction: { type: 'string' },
              because: { type: 'string' },
              evidence: { type: ['string', 'null'] },
              source: { type: ['string', 'null'] },
            },
          },
        },
        dont: { type: 'array', items: { type: 'object' } },
        consistency: { type: 'object' },
        signalSentences: { type: 'array', items: { type: 'object' } },
      },
    },

    messaging: {
      type: 'object',
      required: ['pillars'],
      properties: {
        positioning: { type: ['object', 'null'] },
        pillars: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'terms'],
            properties: {
              name: { type: 'string' },
              terms: { type: 'array', items: { type: 'string' } },
              weight: { type: 'number' },
              prevalence: { type: ['number', 'null'] },
              support: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        taglines: { type: 'array', items: { type: 'object' } },
        headlines: { type: 'array', items: { type: 'object' } },
        keywords: { type: 'array', items: { type: 'object' } },
        claims: { type: 'array', items: { type: 'object' } },
      },
    },

    narrative: {
      type: ['object', 'null'],
      description: 'Optional LLM-written interpretation. Never contains colour, type or logo values.',
      properties: {
        toneSummary: { type: ['string', 'null'] },
        positioning: { type: ['string', 'null'] },
        pillars: { type: 'array', items: { type: 'object' } },
        doNext: { type: 'array', items: { type: 'string' } },
        watchOuts: { type: 'array', items: { type: 'string' } },
      },
    },

    confidence: {
      type: 'object',
      required: ['overall', 'bySection', 'basis'],
      properties: {
        overall: { type: 'number', minimum: 0, maximum: 1 },
        grade: { enum: ['high', 'moderate', 'low'] },
        bySection: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['score', 'grade'],
            properties: {
              score: { type: 'number', minimum: 0, maximum: 1 },
              grade: { enum: ['high', 'moderate', 'low'] },
            },
          },
        },
        basis: { type: 'string' },
      },
    },

    provenance: {
      type: 'object',
      required: ['tinyfish', 'pagesRead', 'methods'],
      properties: {
        tinyfish: {
          type: 'object',
          required: ['calls', 'totalCalls'],
          properties: {
            surfacesUsed: { type: 'array', items: { enum: ['fetch', 'search'] } },
            calls: {
              type: 'array',
              items: {
                type: 'object',
                required: ['surface', 'durationMs'],
                properties: {
                  id: { type: 'string' },
                  surface: { enum: ['fetch', 'search'] },
                  label: { type: 'string' },
                  durationMs: { type: 'number' },
                  okUrls: { type: ['number', 'null'] },
                  errorCount: { type: ['number', 'null'] },
                  format: { type: ['string', 'null'] },
                  includeSelectors: { type: ['array', 'null'] },
                },
              },
            },
            totalCalls: { type: 'number' },
            totalMs: { type: 'number' },
          },
        },
        pagesRead: { type: 'array', items: { type: 'object' } },
        stylesheetsRead: { type: 'array', items: { type: 'object' } },
        methods: { type: 'array', items: { type: 'string' } },
      },
    },

    // What the caller asked the guide to be. A budget, not a guarantee: a brand
    // whose live data supports fewer pages returns fewer, and the deck reports
    // the shortfall rather than padding the difference.
    deck: {
      type: 'object',
      required: ['requestedPages'],
      properties: {
        requestedPages: { type: 'integer', minimum: 4, maximum: 24 },
        defaultPages: { type: 'integer' },
      },
    },

    warnings: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Validate an instance against the subset of JSON Schema this document uses:
 * type, enum, const, pattern, numeric bounds, required, properties and items.
 */
export function validate(instance, schema = BRAND_GUIDE_SCHEMA, path = '$') {
  const errors = [];

  if (schema.type && !matchesType(instance, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(instance)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
  }

  if (schema.pattern && typeof instance === 'string' && !new RegExp(schema.pattern).test(instance)) {
    errors.push(`${path}: "${instance}" does not match ${schema.pattern}`);
  }

  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) errors.push(`${path}: ${instance} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && instance > schema.maximum) errors.push(`${path}: ${instance} > maximum ${schema.maximum}`);
  }

  if (schema.type === 'object' || (schema.properties && instance && typeof instance === 'object')) {
    for (const key of schema.required || []) {
      if (instance == null || !(key in instance)) errors.push(`${path}.${key}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (instance && key in instance) errors.push(...validate(instance[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, value] of Object.entries(instance || {})) {
        if (!(key in (schema.properties || {}))) {
          errors.push(...validate(value, schema.additionalProperties, `${path}.${key}`));
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(instance)) {
    if (schema.minItems && instance.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) instance.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

function matchesType(value, type) {
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => {
    switch (t) {
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: return true;
    }
  });
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}