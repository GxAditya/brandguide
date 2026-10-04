/**
 * BrandKit UI controller.
 *
 * What this file is responsible for, and nothing else:
 *
 *   1. Mount the hero: the ASCII cloud field, the search bar, the mode tabs.
 *   2. Run a job. Guide runs stream, so the dialog can show what is being read
 *      while it is being read. Compare runs post, because there is no stream
 *      for it, and the dialog says so rather than pretending to know more than
 *      the server does.
 *   3. Show the read set while it matters. Sources are genuinely interesting
 *      mid-run and dead weight afterwards, so they live in a dialog that
 *      closes itself.
 *   4. Compose the document. The guide is a paged deck set in the brand's own
 *      identity; a comparison is a signal matrix and a distinctiveness read.
 *
 * The hero and the run options are two renderings of one set of values, so they
 * are wired through a small mirror layer rather than being two copies of the
 * state. Either can be removed without the other losing its values.
 *
 * No framework, no build step, and no innerHTML with untrusted content: every
 * string that reaches the page goes through textContent or a parsed node.
 */

import { renderDeck } from '/deck.js';
import { renderCompare } from '/compare.js';
import { mountOrb } from '/orb.js';
import { mountGridReveal } from '/grid-reveal.js';
import { render as renderExport } from '/export/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  mode: 'guide',
  running: false,
  guide: null,
  pages: 14,
  llmAvailable: false,
  events: null,
  abort: null,
  startedAt: 0,

  /** 'idle' until a run starts, then 'running' for the rest of the session. */
  view: 'idle',
  orb: null,
  reveal: null,
  /** The deck's page controller, once a guide has been rendered. */
  deck: null,
};

const RUN_LABELS = {
  guide: 'Extract guide',
  compare: 'Run comparison',
};

const HERO_NOTE = {
  guide: 'A bare name is resolved through search. A domain is opened directly.',
  compare: 'Up to four competitors. Each is resolved and read the same way as the first.',
};

/* ── The mirrored controls ───────────────────────────────────────────────── */

/**
 * The same value, expressed in more than one place.
 *
 * The hero carries the input and the depth. The rail and the stage composer
 * carry them too, because those surfaces still exist and are still bound. Any
 * change to one writes to all of them, so there is never a second source of
 * truth to reconcile.
 */
const FIELDS = {
  input: ['#input', '#input-stage'],
  competitors: ['#competitors', '#competitors-rail'],
  depth: ['#depth', '#depth-rail'],
};

const FORMS = ['#hero-composer', '#composer'];

function nodes(field) {
  return FIELDS[field].map((sel) => $(sel)).filter(Boolean);
}

function read(field) {
  return nodes(field)[0]?.value ?? '';
}

function write(field, value) {
  for (const node of nodes(field)) {
    if (node.value !== value) node.value = value;
  }
}

/** Both run buttons, whichever surfaces are on the page. */
function runButtons() {
  return $$('#run-btn, #run-btn-stage');
}

function setButtonLabel(text) {
  for (const button of runButtons()) {
    const label = button.querySelector('.btn-label');
    if (label) label.textContent = text;
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

/**
 * Wire the controls, if they are on this page.
 *
 * The renderers below are imported directly by the screenshot harness, which
 * has no hero and no form, so bootstrapping has to be a no-op there rather than
 * throwing on a missing element and taking every renderer down with it.
 */
function boot() {
  const hero = $('#hero-composer');
  if (!hero && !$('#composer')) return;

  for (const form of FORMS) $(form)?.addEventListener('submit', onSubmit);

  for (const field of Object.keys(FIELDS)) {
    for (const node of nodes(field)) {
      node.addEventListener('input', () => {
        write(field, node.value);
        if (field === 'input' || field === 'competitors') clearCompareError();
      });
    }
  }

  $('#new-run')?.addEventListener('click', resetToIdle);

  for (const radio of $$('input[name="mode"]')) {
    radio.addEventListener('change', () => setMode(radio.value));
  }

  for (const tab of $$('[data-mode]')) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  }

  for (const chip of $$('[data-example]')) {
    chip.addEventListener('click', () => {
      write('input', chip.dataset.example);
      $('#input')?.focus();
    });
  }

  initPageCount();
  initDepthMenu();
  syncLengthAvailability();
  setMode(state.mode, { quiet: true });
}

/**
 * Switch the output mode.
 *
 * Every control that only means something in one mode is hidden rather than
 * disabled, so nothing on screen ever offers a knob that cannot turn anything.
 */
function setMode(mode, { quiet = false } = {}) {
  if (!RUN_LABELS[mode]) return;
  state.mode = mode;

  const compare = mode === 'compare';

  for (const tab of $$('[data-mode]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
  }
  for (const radio of $$('input[name="mode"]')) {
    radio.checked = radio.value === mode;
  }

  const compareField = $('#compare-field');
  if (compareField) compareField.hidden = !compare;

  const split = $('#pill-split');
  if (split) split.hidden = !compare;

  for (const field of [$('#pages-field'), $('#depth-field')]) {
    if (field) field.hidden = compare;
  }

  // While a run is live the button says Cancel, whatever the mode says. Switching
  // tabs must not relabel it into something that looks like it starts a new run.
  setButtonLabel(state.running ? 'Cancel' : RUN_LABELS[mode]);

  const input = $('#input');
  if (input) {
    input.placeholder = 'linear';
    input.setAttribute('aria-label', compare ? 'Brand to compare' : 'Company name or website');
  }

  const note = $('#hero-note');
  if (note) note.textContent = HERO_NOTE[mode];

  clearCompareError();

  // Switching tabs empties the document, because a guide is not a comparison and
  // leaving the wrong one on screen is worse than an empty box.
  //
  // It deliberately does not go through resetToIdle. Once a run has started the
  // panel stays for the rest of the session, and changing which kind of guide you
  // are after is not going home. A run in flight owns the output, so it is left
  // alone rather than having its grid torn out from under it.
  if (!quiet && !state.running) clearOutput();
}

/**
 * Empty the output section.
 *
 * Separate from resetToIdle because the two are not the same event. Changing your
 * mind about which kind of guide you want should clear the document and leave the
 * panel standing; going home should clear it and bring the panel down too.
 */
function clearOutput() {
  $('#output').replaceChildren();
  $('#outbox-bar').replaceChildren();
  $('#outbox').hidden = true;
  state.deck = null;

  state.reveal?.destroy();
  state.reveal = null;
  hideCanvas();
}

/**
 * Clear a finished run and put the hero back to how it started.
 *
 * The view is explicit state rather than a `:has()` guess, so it has to be reset
 * by hand here. Anything still holding a canvas is torn down too: both of them
 * own a rAF loop, and a loop left running on a hidden element is a battery cost
 * with nothing on screen.
 */
function resetToIdle() {
  state.guide = null;
  clearAlerts();
  $('#appbar-context').hidden = true;
  clearCompareError();

  clearOutput();

  state.orb?.destroy();
  state.orb = null;
  $('#run-status').hidden = true;

  setView('idle');
}

/* ── Guide length ────────────────────────────────────────────────────────── */

/**
 * The length control is a budget for the optional narration layer.
 *
 * With no narration the deck is the seven measured pages and the control says
 * so, rather than offering a length the product cannot honour. Changing it
 * recomposes the deck in place, which costs nothing because every fact is
 * already extracted. No re-crawl.
 */
function initPageCount() {
  const slider = $('#pages');
  const readout = $('#pages-value');
  if (!slider || !readout) return;

  const paint = () => {
    readout.textContent = `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`;
  };

  slider.addEventListener('input', () => {
    state.pages = Number(slider.value);
    paint();
    if (state.guide) rerenderGuide();
  });

  paint();
}

/**
 * Ask the server whether a narration layer is configured.
 *
 * The health endpoint reports whether all three LLM variables are set, which is
 * the same condition the narration layer itself checks. There is no other way
 * for the browser to know: the key never leaves the server.
 */
async function syncLengthAvailability() {
  const slider = $('#pages');
  const field = $('#pages-field');
  const help = $('#pages-help');
  if (!slider || !field) return;

  let enabled = false;
  try {
    const body = await fetch('/api/v1/health').then((r) => r.json());
    enabled = Boolean(body.llm?.enabled);
  } catch {
    enabled = false;
  }

  state.llmAvailable = enabled;
  slider.disabled = !enabled;
  field.dataset.disabled = String(!enabled);

  if (help) {
    help.textContent = enabled
      ? 'How long the full document should be. The measured pages always appear; the written ones fill to this length.'
      : 'Seven pages are produced from measurement alone. Set GEMINI_API_KEY, or LLM_API_KEY with LLM_BASE_URL and LLM_MODEL, to generate the full document, where this becomes the page count.';
  }
}

function rerenderGuide() {
  if (!state.guide) return;
  const host = $('#output');
  const scrollTop = window.scrollY;
  host.replaceChildren();
  composeGuide(host, state.guide);
  window.scrollTo({ top: scrollTop });
}

/* ── The depth menu ──────────────────────────────────────────────────────── */

/**
 * The depth control is a listbox, not a <select>.
 *
 * A native select cannot be styled: the popup is drawn by the OS, so it ignores
 * every token in the stylesheet and arrives in whatever the platform's idea of
 * a dropdown is. The native select is therefore kept as the value holder, hidden
 * and out of the tab order, so the form, the value mirror and the submit all
 * still read a real control. What the user touches is a button and a listbox.
 *
 * Keyboard behaviour follows the listbox pattern: arrows move, Home and End
 * jump, Enter and Space commit, Escape closes and returns focus, and Tab closes
 * without changing anything.
 */
function initDepthMenu() {
  const wrap = $('#depth-control');
  const trigger = $('#depth-trigger');
  const menu = $('#depth-list');
  const select = $('#depth');
  if (!wrap || !trigger || !menu || !select) return;

  const items = () => $$('.pill-menu-option', menu);
  const readout = trigger.querySelector('.pill-select-value');
  let open = false;

  /* The label always follows the value, whichever surface changed it. */
  const paint = () => {
    const option = select.selectedOptions[0];
    readout.textContent = option?.textContent ?? '';
    for (const item of items()) {
      item.setAttribute('aria-selected', String(item.dataset.value === select.value));
    }
  };

  const setOpen = (next) => {
    open = next;
    menu.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
  };

  const focusItem = (index) => {
    const list = items();
    const item = list[Math.max(0, Math.min(list.length - 1, index))];
    item?.focus();
  };

  const step = (delta) => {
    const list = items();
    const current = list.findIndex((item) => item === document.activeElement);
    focusItem(current < 0 ? 0 : current + delta);
  };

  const commit = (item) => {
    if (!item) return;
    // write() so the rail's own select follows, then repaint from the value.
    write('depth', item.dataset.value);
    paint();
    setOpen(false);
    trigger.focus();
  };

  trigger.addEventListener('click', () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const current = items().findIndex((item) => item.getAttribute('aria-selected') === 'true');
    focusItem(current < 0 ? 0 : current);
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('.pill-menu-option');
    if (item) commit(item);
  });

  const onKeyDown = (event) => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); step(1); break;
      case 'ArrowUp': event.preventDefault(); step(-1); break;
      case 'Home': event.preventDefault(); focusItem(0); break;
      case 'End': event.preventDefault(); focusItem(items().length - 1); break;
      case 'Enter':
      case ' ': event.preventDefault(); commit(document.activeElement.closest?.('.pill-menu-option')); break;
      case 'Escape': event.preventDefault(); setOpen(false); trigger.focus(); break;
      case 'Tab': setOpen(false); break;
      default: break;
    }
  };

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      step(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  menu.addEventListener('keydown', onKeyDown);

  /* A pointer press anywhere else dismisses it, including on the trigger,
     which handles its own toggle on click. */
  document.addEventListener('pointerdown', (event) => {
    if (open && !wrap.contains(event.target)) setOpen(false);
  });

  /* The rail's select is a second surface for the same value. */
  for (const node of nodes('depth')) {
    node.addEventListener('change', paint);
  }

  paint();
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

/**
 * The primary button is the run control and the cancel control.
 *
 * There is no dialog any more, so a run needs an escape hatch and the button
 * that started it is the only thing on screen that can stop it. Pressing it
 * again while a run is live cancels, rather than being inert.
 */
async function onSubmit(event) {
  event?.preventDefault();

  if (state.running) {
    cancelRun();
    return;
  }

  const input = read('input').trim();
  if (!input) {
    showCompareError('Enter a company name or a website first.');
    $('#input')?.focus();
    return;
  }

  clearCompareError();

  if (state.mode === 'guide') return runGuide(input);
  return runCompare(input);
}

/** Guide runs stream, so the dialog can show the read set as it grows. */
function runGuide(input) {
  const params = new URLSearchParams({
    input,
    depth: read('depth') || 'standard',
    pages: String(state.pages),
  });

  startRun({ status: 'Starting the crawl' });

  const events = new EventSource(`/api/v1/stream?${params}`);
  state.events = events;

  events.addEventListener('stage', (event) => {
    noteStage(JSON.parse(event.data));
  });

  events.addEventListener('done', (event) => {
    const guide = JSON.parse(event.data);
    state.guide = guide;
    renderGuide(guide);

    const warnings = warningsToAlert(guide);
    // The guide is handed to finish so it can hand the mark to the grid, which
    // is what decides when the panel stands down.
    finish(warnings ? 'warn' : null, warnings?.message, null, warnings?.detail, guide);
  });

  events.addEventListener('error', (event) => {
    // The browser fires a generic `error` on a network drop too, so only treat
    // it as a failure when the server sent a structured error frame.
    if (event.data) {
      const payload = JSON.parse(event.data);
      finish('error', payload.message, payload.code);
    } else {
      finish('error', 'The connection to the server dropped before the run finished.', 'STREAM_CLOSED');
    }
  });

  events.onerror = () => {
    // onerror after `done` is only the stream closing.
    if (state.running) {
      events.close();
      setBusy(false);
    }
  };
}

/** Compare posts one document and renders it as a matrix. */
async function runCompare(input) {
  const competitors = read('competitors')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  if (!competitors.length) {
    showCompareError('Name at least one brand to compare against.');
    $('#competitors')?.focus();
    return;
  }

  const controller = new AbortController();
  state.abort = controller;

  const names = [input, ...competitors];

  startRun({
    status: `Resolving ${names.length} brands to their domains`,
  });

  try {
    const response = await fetch('/api/v1/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ input, competitors }),
    });

    const payload = await response.json();

    if (!response.ok) {
      finish('error', payload.error?.message || 'The comparison failed.', payload.error?.code);
      return;
    }

    noteStage({ stage: 'read', status: 'done' });
    noteStage({ stage: 'crawl', status: 'done', pages: payload.provenance?.resolvedVia?.length || names.length });
    noteStage({ stage: 'assets', status: 'done' });

    renderCompare(payload);

    const warnings = warningsToAlert(payload);
    // Handed over for the same reason as the guide: it tells finish there is a
    // document, so the panel stands down instead of the stage going empty.
    finish(warnings ? 'warn' : null, warnings?.message, null, warnings?.detail, payload);
  } catch (err) {
    if (err.name === 'AbortError') return;
    finish('error', err.message || 'Could not reach the server.', 'NETWORK_ERROR');
  }
}

/* ── The panel morph ─────────────────────────────────────────────────────── */

/**
 * Move the hero between its two shapes.
 *
 * idle     centred in the full-height gradient
 * running  docked left as a panel, with the orb beneath the controls
 *
 * There is no third shape. Once a run has started the panel stays for the rest of
 * the session, so the controls a second run needs are already in place beside the
 * document the first one produced. The only way back is resetToIdle, which is
 * what New run and a reload both amount to.
 *
 * The end states are declared in CSS. The motion between them is here, because
 * CSS cannot transition a change of layout position without animating layout
 * properties, which forces a reflow on every frame of the transition.
 *
 * Reduced motion skips the whole thing and lets the class change land.
 */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function setView(next) {
  const hero = $('.hero-inner');
  if (!hero || state.view === next) return;

  const first = reduceMotion.matches ? null : hero.getBoundingClientRect();
  state.view = next;
  document.body.dataset.view = next;

  if (!first) return;

  // Read after the class change, so this is where the element now is.
  const last = hero.getBoundingClientRect();

  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / last.width;
  const sy = first.height / last.height;

  // Nothing to invert when the box did not actually move.
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005) return;

  hero.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: 'none' },
    ],
    { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

/**
 * Begin a run: morph the controls into the panel, mount the orb, start the
 * grid reveal.
 *
 * The panel forms first and both animations start on the same frame, so the orb
 * and the grid are already moving by the time the morph lands. Nothing else is
 * shown: no step rail, no timer, no call log. The whole state says one thing.
 */
function startRun({ status }) {
  state.running = true;
  state.startedAt = performance.now();

  setBusy(true);
  clearAlerts();

  const comparing = state.mode === 'compare';

  // The output box is emptied either way and the grid goes on top of it. A
  // comparison gets the grid too: the wait is the same length and the animation
  // is the same one, so withholding it would make the second tab feel like a
  // different product.
  $('#output').replaceChildren();
  $('#outbox-bar').replaceChildren();
  state.deck = null;

  const box = $('#outbox');
  box.hidden = false;
  box.dataset.mode = comparing ? 'compare' : 'guide';

  $('#run-status-label').textContent = comparing ? 'Comparing\u2026' : 'Fetching\u2026';
  $('#run-live').textContent = status;

  setView('running');
  mountRunOrb();
  startReveal();
}

/**
 * The orb in the panel.
 *
 * Mounted per run and destroyed with it. It owns a rAF loop, and a canvas left
 * animating inside a hidden panel is a battery cost with nothing on screen.
 */
function mountRunOrb() {
  const canvas = $('#run-orb');
  if (!canvas) return;

  state.orb?.destroy();
  state.orb = mountOrb(canvas, {
    state: 'idle',
    // The accent rather than the component's own orange, so the panel reads as
    // part of this product.
    color: getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim() || '#f5bde6',
    size: 168,
    dots: 11,
  });

  $('#run-status').hidden = false;
}

/**
 * The grid reveal.
 *
 * It starts now, not when its image arrives, and waits at its cap for as long as
 * the crawl takes. That inversion is the point: the animation tracks the real
 * work rather than an asset download, which is what makes it read as "your
 * output is being built" rather than "a file is loading".
 *
 * The canvas is the output box, not a card beside it: same width, same 4:3 box
 * as a rendered page. It sits over the deck, so the guide is uncovered in place
 * rather than arriving somewhere else on screen.
 */
function startReveal() {
  const canvas = $('#reveal-canvas');
  if (!canvas) return;

  state.reveal?.destroy();
  state.reveal = mountGridReveal(canvas, {
    // No source yet. The mark is only known once the extraction has run, and it
    // is handed over by resolveReveal().
    aspect: 4 / 3,
    dark: true,
    estimate: 9000,
  });

  showCanvas();
  state.reveal.start();
}

function showCanvas() {
  const canvas = $('#reveal-canvas');
  if (canvas) canvas.dataset.on = 'true';
}

/** Take the grid off the box, so whatever is underneath is what you see. */
function hideCanvas() {
  const canvas = $('#reveal-canvas');
  if (canvas) delete canvas.dataset.on;
}

/**
 * Let the grid resolve, and uncover whatever is underneath.
 *
 * `logos` is the guide's mark, and there may not be one: a brand can have no
 * usable logo, and a comparison has no single mark at all because it is comparing
 * several. Neither is a reason to skip the animation, so the grid is always
 * resolved rather than snapped away. With no image it resolves to a flat field,
 * which is the component's own grey-cells fallback.
 *
 * The asset, when there is one, is chosen the way deck.js chooses it for the
 * cover, lockup first, so the mark that lands in the grid is the mark the guide
 * opens with rather than a different one.
 *
 * An inlined SVG is preferred over a remote URL, because a blob URL never taints
 * the canvas: the grid keeps the mark's own colours instead of falling back to
 * grey cells. Almost nothing in the wild ships one, though — the extractor
 * stores URLs — so the grey path is the normal one, not the exception.
 */
function resolveReveal(logos) {
  const asset = logos?.lockup || logos?.primary || null;
  const svg = asset?.svg || null;
  const src = svg ? null : (asset?.url || null);

  state.reveal?.destroy();

  state.reveal = mountGridReveal($('#reveal-canvas'), {
    svg,
    src,
    // The frame holds 4:3 for as long as the grid is on it, in both modes, so
    // this is the shape the grid is actually standing in.
    aspect: 4 / 3,
    dark: true,
    onComplete: () => {
      setTimeout(() => {
        if (state.view === 'idle') return;
        hideCanvas();
      }, 650);
    },
  });

  showCanvas();
  state.reveal.start();
  state.reveal.complete();
}

function cancelRun() {
  if (!state.running) return;
  state.events?.close();
  state.events = null;
  state.abort?.abort();
  state.abort = null;
  finish('info', 'Run cancelled. Nothing was saved.');
}

/**
 * Close out a run.
 *
 * `resolved` is the payload when there is one. Its absence means there is no
 * document to show, so the output box is taken away rather than left as an empty
 * frame with an alert floating over it.
 *
 * The panel stays either way. It only comes down in resetToIdle.
 */
function finish(kind, message, code, detail, resolved) {
  setBusy(false);
  state.events?.close();
  state.events = null;
  state.abort = null;

  // The orb has done its job either way: a failed run still had to be waited on.
  $('#run-status').hidden = true;
  state.orb?.destroy();
  state.orb = null;

  if (!resolved) {
    state.reveal?.destroy();
    state.reveal = null;
    $('#outbox').hidden = true;
  } else {
    // Guide mode hands over its mark. A comparison has no single mark, so the
    // grid resolves to a plain field and uncovers the benchmark instead. Same
    // component and the same timing either way; the grid is what decides when
    // the panel's output appears, so the handover is a transition, not a cut.
    resolveReveal(resolved.logos);
  }

  if (!kind && !message) {
    clearAlerts();
    return;
  }
  showAlert(kind || 'info', { message, code, detail });
}

/**
 * Mark the run live or not, and relabel the primary button to match.
 *
 * The button is never disabled. While the panel is up it is the only control on
 * screen that can stop the run, so making it inert would take away the only
 * escape; instead it becomes the cancel affordance.
 *
 * `data-busy` is deliberately not set. Its one consumer is the button spinner,
 * and a spinner on a button labelled Cancel reads as a second progress signal
 * next to the orb that is already saying the same thing.
 */
function setBusy(busy) {
  state.running = busy;
  for (const button of runButtons()) button.disabled = false;
  setButtonLabel(busy ? 'Cancel' : RUN_LABELS[state.mode]);
}

/**
 * Which orb state each pipeline stage maps to.
 *
 *   idle        the panel is up and nothing has come back yet
 *   listening   waiting on a response, which is the resolve stage
 *   thinking    reading and processing, which is every stage after it
 *
 * The orb blends between states, so a stage change crossfades rather than cuts.
 */
const ORB_STATE = {
  idle: 'idle',
  resolve: 'listening',
  read: 'thinking',
  crawl: 'thinking',
  assets: 'thinking',
};

function noteStage(stage) {
  state.orb?.setState(ORB_STATE[stage.stage] || 'thinking');
}

/* ── Alerts ──────────────────────────────────────────────────────────────── */

/*
 * Alerts float.
 *
 * They used to sit in a strip above the output, which meant a note about the
 * extraction was taking up room in front of the document it was a note about, and
 * pushing it down the page every time it appeared. Now they are transient: they
 * come in over the corner, hold long enough to be read or acted on, and go.
 *
 * Errors stay until dismissed, because an error is usually the end of the run and
 * the reason for it should still be there afterwards.
 */

const TOAST_MS = { info: 5000, warn: 8000, error: 0 };

function clearAlerts() {
  for (const toast of $$('.toast', $('#alert-slot'))) {
    clearTimeout(Number(toast.dataset.timer) || 0);
    toast.remove();
  }
}

function showAlert(kind, alert) {
  clearAlerts();
  if (!alert) return;

  const node = el('div', `alert toast`);
  node.dataset.kind = kind;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.append(svgAlertIcon(), el('div', 'alert-body'));

  const body = node.lastElementChild;
  body.append(el('p', '', alert.message));
  if (alert.detail) body.append(el('p', '', alert.detail));
  if (alert.code) {
    const line = el('p');
    line.append(document.createTextNode('Code '), el('code', '', alert.code));
    body.append(line);
  }

  const close = el('button', 'toast-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(svgUse('#i-close'));
  close.addEventListener('click', clearAlerts);
  node.append(close);

  $('#alert-slot').append(node);

  // 0 means it stays. Started after the node is in the DOM so the entry
  // transition has something to transition from.
  const ttl = TOAST_MS[kind] ?? TOAST_MS.info;
  if (ttl > 0) node.dataset.timer = String(setTimeout(clearAlerts, ttl));
}

function svgAlertIcon() {
  const icon = el('span', 'alert-icon');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-alert');
  svg.append(use);
  icon.append(svg);
  return icon;
}

function warningsToAlert(payload) {
  const warnings = payload.warnings || [];
  if (!warnings.length) return null;
  return {
    message: `Completed with ${warnings.length === 1 ? 'one note' : `${warnings.length} notes`}.`,
    detail: warnings.join(' '),
  };
}

function showCompareError(message) {
  for (const [id, target] of [['#compare-error', $('#compare-error')], ['#composer-error', $('#composer-error')]]) {
    if (!target) continue;
    target.textContent = message;
    target.hidden = !message;
    if (message) target.dataset.for = id;
  }
}

function clearCompareError() {
  showCompareError('');
}

/* ── Guide document ──────────────────────────────────────────────────────── */

/**
 * Render a guide into the page. Exported so the screenshot harness can replay
 * saved output through the exact path a live run takes.
 *
 * @param {object} guide extracted guide
 * @param {{ target?: number }} [opts]
 */
export function renderGuide(guide, opts = {}) {
  const host = $('#output');
  host.replaceChildren();
  composeGuide(host, guide, opts);
  setContextTitle(guide.identity?.name || hostOf(guide.input?.resolvedUrl || ''));
}

/**
 * Put the guide in the output box: the pages, and the toolbar above them.
 *
 * Nothing else goes in. The brand, its confidence, how many pages were read and
 * when it was generated are all still true, and none of them are the guide. The
 * output section is the document and the controls that act on it.
 */
function composeGuide(host, guide, opts = {}) {
  const box = $('#outbox');
  box.hidden = false;
  box.dataset.mode = 'guide';

  // renderDeck owns its host: it empties it before drawing.
  state.deck = renderDeck(host, guide, { target: opts.target ?? state.pages });

  renderOutputBar(state.deck, guide);
}

/**
 * The toolbar above the output: turn the pages, jump to one by name, export.
 *
 * Built here rather than in deck.js because it mixes the deck's own navigation
 * with the export menu, and exporting needs the whole guide rather than the deck.
 */
function renderOutputBar(deck, guide) {
  const bar = $('#outbox-bar');
  bar.replaceChildren();
  if (!deck) return;

  let index = 0;

  /* Turn the pages. Arrows only: the Page menu already says where you are. */

  const turn = el('div', 'outbox-turn');

  const prev = el('button', 'outbox-btn');
  prev.type = 'button';
  prev.dataset.deckPrev = '';
  prev.setAttribute('aria-label', 'Previous page');
  prev.append(svgUse('#i-prev'));

  const next = el('button', 'outbox-btn');
  next.type = 'button';
  next.dataset.deckNext = '';
  next.setAttribute('aria-label', 'Next page');
  next.append(svgUse('#i-next'));

  turn.append(prev, next);

  /* Every page reachable by name, not only by counting. */

  const jumpWrap = el('div', 'outbox-jump');
  const jumpLabel = el('label', 'outbox-jump-label', 'Page');
  const jumpId = `outbox-page-${Math.abs(hashText(guide.identity?.name || 'guide'))}`;
  jumpLabel.htmlFor = jumpId;

  const jump = el('select', 'outbox-select');
  jump.id = jumpId;
  deck.outline.forEach((entry, i) => {
    const option = el('option', '', entry.label);
    option.value = String(i);
    jump.append(option);
  });

  jumpWrap.append(jumpLabel, jump);

  /* Export. One button and one menu, rather than seven chips on show. */

  const exportWrap = el('div', 'outbox-export');

  const exportButton = el('button', 'outbox-btn outbox-btn-export');
  exportButton.type = 'button';
  exportButton.setAttribute('aria-haspopup', 'true');
  exportButton.setAttribute('aria-expanded', 'false');

  // el() sets textContent, so an icon has to be appended rather than passed in
  // as the third argument, or it arrives as "[object SVGSVGElement]".
  const caret = el('span', 'outbox-caret');
  caret.append(svgUse('#i-caret'));

  exportButton.append(svgUse('#i-download'), el('span', '', 'Export'), caret);

  const exportMenu = el('div', 'outbox-menu');
  exportMenu.setAttribute('role', 'menu');
  exportMenu.hidden = true;

  for (const [text, format] of EXPORT_FORMATS) {
    const item = el('button', 'outbox-menu-item', text);
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      closeMenu();

      // PDF goes out through the browser's own print pipeline rather than a
      // renderer here, because writing a PDF that embeds fonts and lays out text
      // needs a library and this project has no dependencies.
      //
      // That costs nothing in fidelity: deck.css already declares an 1200x900
      // page box and breaks after every guide page, hidden ones included, so the
      // print output is the deck as a sequence of landscape sheets. Choosing
      // "Save as PDF" as the destination is the only step left, and it is the
      // one the reader has to take anyway.
      if (format === 'pdf') {
        window.print();
        return;
      }

      try {
        const out = renderExport(format, guide);
        download(out.filename, out.contentType, out.body);
      } catch (err) {
        showAlert('error', {
          message: `The ${text} export failed to render.`,
          detail: err.message,
          code: 'EXPORT_FAILED',
        });
      }
    });
    exportMenu.append(item);
  }

  exportWrap.append(exportButton, exportMenu);
  bar.append(turn, jumpWrap, exportWrap);

  /* Wiring -------------------------------------------------------------- */

  const openMenu = (next) => {
    exportMenu.hidden = !next;
    exportButton.setAttribute('aria-expanded', String(next));
  };
  const closeMenu = () => openMenu(false);

  exportButton.addEventListener('click', () => openMenu(exportMenu.hidden));

  // A press anywhere else dismisses it. The button handles its own toggle on
  // click, so it is excluded rather than double-toggled.
  document.addEventListener('pointerdown', (event) => {
    if (exportMenu.hidden || exportWrap.contains(event.target)) return;
    closeMenu();
  });

  exportButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(true);
      exportMenu.querySelector('.outbox-menu-item')?.focus();
    } else if (event.key === 'Escape' && !exportMenu.hidden) {
      event.preventDefault();
      closeMenu();
    }
  });

  exportMenu.addEventListener('keydown', (event) => {
    const items = [...exportMenu.querySelectorAll('.outbox-menu-item')];
    const at = items.indexOf(document.activeElement);

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); items[Math.min(items.length - 1, at + 1)]?.focus(); break;
      case 'ArrowUp': event.preventDefault(); items[Math.max(0, at - 1)]?.focus(); break;
      case 'Home': event.preventDefault(); items[0]?.focus(); break;
      case 'End': event.preventDefault(); items[items.length - 1]?.focus(); break;
      case 'Escape': event.preventDefault(); closeMenu(); exportButton.focus(); break;
      case 'Tab': closeMenu(); break;
      default: break;
    }
  });

  const go = (target) => {
    const at = deck.show(target);
    index = at.index;
    jump.value = String(index);
    prev.disabled = at.index === 0;
    next.disabled = at.index === deck.total - 1;
  };

  prev.addEventListener('click', () => go(index - 1));
  next.addEventListener('click', () => go(index + 1));
  jump.addEventListener('change', () => go(Number(jump.value)));

  // The deck opens on page one, so the only page genuinely unavailable is the
  // last one, and only when there is more than one page at all.
  prev.disabled = true;
  next.disabled = deck.total < 2;
}

/** Stable enough for a DOM id, and short. */
function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

function setContextTitle(text) {
  // Null-safe on purpose: renderGuide is exported and also runs in the
  // screenshot harness, which hosts only the parts of the chrome it needs.
  const slot = $('#appbar-context');
  const label = $('#context-name');
  if (!slot || !label) return;

  if (!text) {
    slot.hidden = true;
    return;
  }
  label.textContent = text;
  slot.hidden = false;
}

/* ── Export ──────────────────────────────────────────────────────────────── */

/**
 * What the guide can be taken away as.
 *
 * One list, used by the export menu. The label is what the person reads and the
 * format is what the renderer takes, and they are deliberately not always the
 * same string: "Style Dictionary" is the tool's name, not the file extension.
 *
 * PDF is not a renderer like the others and is handled separately below.
 */
const EXPORT_FORMATS = [
  ['JSON', 'json'],
  ['Markdown', 'markdown'],
  ['CSS', 'css'],
  ['Tailwind', 'tailwind'],
  ['Style Dictionary', 'styledictionary'],
  ['Figma variables', 'figma'],
  ['Palette SVG', 'svg'],
  ['PDF', 'pdf'],
];

function download(filename, contentType, body) {
  const url = URL.createObjectURL(new Blob([body], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgUse(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

function hostOf(url) {
  if (!url) return '';
  const text = String(url);
  if (!text.includes('://')) return text.replace(/^www\./, '').replace(/\/.*$/, '');
  try {
    return new URL(text).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

boot();