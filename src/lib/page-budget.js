/**
 * Guide length.
 *
 * The requested page count is a budget, not a promise. It tells the narration
 * layer how much written material to produce, and it tells the renderer where
 * to stop. Neither end pads: a brand whose live data supports nine pages
 * returns nine, and the deck says so on the page rather than inventing the
 * other five.
 *
 * Kept in one module because three callers need to agree on the bounds: the
 * HTTP handler, the SSE stream, and the narration prompt.
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

/**
 * How many written pillars a budget can absorb.
 *
 * Pillars are the only narrative element that scales cleanly, so the prompt
 * asks for more of them on a longer guide rather than asking for longer ones.
 * A pillar that cannot be evidenced is dropped by the sanitiser anyway, so
 * overshooting here costs a little token spend and never costs accuracy.
 */
export function pillarsForBudget(pages) {
  if (pages <= 6) return 3;
  if (pages <= 12) return 4;
  return 5;
}