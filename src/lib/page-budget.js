/**
 * Guide length. The requested page count is a budget, not a promise: it tells the
 * narration layer how much to write and the renderer where to stop, and neither end
 * pads. In one module because the HTTP handler, the SSE stream and the narration
 * prompt must agree on the bounds.
 */

export const MIN_PAGES = 4;
export const MAX_PAGES = 24;
export const DEFAULT_PAGES = 14;

/** Coerce anything a request can carry into a usable page budget. */
export function clampPages(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGES;
  return Math.max(MIN_PAGES, Math.min(MAX_PAGES, n));
}

/** Pillars scale cleanly, so a longer guide asks for more of them rather than longer ones. */
export function pillarsForBudget(pages) {
  if (pages <= 6) return 3;
  if (pages <= 12) return 4;
  return 5;
}