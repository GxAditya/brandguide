/**
 * BrandKit UI controller: mounts the hero, runs a job, and composes the document.
 * A guide renders as a paged deck in the brand's own identity; a comparison renders
 * as a signal matrix.
 *
 * No framework, no build step, and no innerHTML with untrusted content: every string
 * that reaches the page goes through textContent or a parsed node.
 */

import { renderDeck } from '/deck.js';
import { renderCompare } from '/compare.js';
import { mountOrb } from '/orb.js';
import { mountGridReveal } from '/grid-reveal.js';
import { render as renderExport } from '/export/index.js';
import {
  PROVIDERS, authHeaders, clearCreds, hasLlmKey, hasTinyfishKey, isPersistent,
  loadCreds, saveCreds,
} from '/creds.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  mode: 'guide',
  running: false,
  guide: null,
  pages: 14,
  /** Cancels whichever fetch is in flight: the run stream or a comparison. */
  abort: null,

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

/** The hero and the stage composer share these values, so a change to one writes to all. */
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
 * Wire the controls, if they are on this page. The screenshot harness imports the
 * renderers directly and has no hero, so bootstrapping must be a no-op there rather
 * than throwing on a missing element.
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
  initSettings();
  syncLengthAvailability();
  setMode(state.mode, { quiet: true });
}

/* ── Settings ───────────────────────────────────────────────────────────── */

/**
 * The credential sheet.
 *
 * Keys are read into the fields on open, not on load, so a browser autofill or a
 * password manager cannot quietly overwrite a saved key before anyone looks at it.
 * Escape and the backdrop both close without saving, focus returns to the button
 * that opened it, and Tab is trapped inside while it is open — a dialog that leaks
 * focus to the page behind it is not really a dialog.
 */
/**
 * Open the sheet from anywhere that needs the key, which is why `open` is a
 * module-level handle rather than a closure: a run with no credentials has to be
 * able to summon it.
 */
let openSettings = () => {};

function initSettings() {
  const sheet = $('#settings');
  const backdrop = $('#settings-backdrop');
  const trigger = $('#settings-btn');
  const provider = $('#llm-provider');
  const error = $('#settings-error');
  if (!sheet || !backdrop || !trigger || !provider) return;

  for (const option of PROVIDERS) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    provider.append(node);
  }

  let restoreFocus = null;

  /** The narration fields follow the provider: OpenAI-compatible needs a base and a model. */
  const paintProvider = () => {
    const chosen = provider.value;
    const openAi = chosen === 'openai';
    const on = Boolean(chosen);

    for (const id of ['#llm-key-field', '#llm-base-field', '#llm-model-field']) {
      const field = $(id);
      if (field) field.hidden = !on || (id === '#llm-base-field' && !openAi) || (id === '#llm-model-field' && !openAi);
    }

    const help = $('#llm-key-help');
    if (help) {
      help.textContent = !on
        ? 'Pick a provider to narrate.'
        : openAi
          ? 'The key for that server.'
          : 'From aistudio.google.com/apikey.';
    }
  };

  const showError = (message) => {
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  };

  const open = () => {
    if (!sheet.hidden) return;

    const creds = loadCreds();
    $('#tinyfish-key').value = creds.tinyfishKey;
    $('#llm-key').value = creds.llm.key;
    $('#llm-base').value = creds.llm.base;
    $('#llm-model').value = creds.llm.model;
    provider.value = creds.llm.provider;
    paintProvider();
    showError('');
    paintStorageNote();

    // Fall back to the trigger when nothing meaningful was focused. A synthetic
    // click, or a pointer press on a non-focusable area, leaves the active element
    // as <body>, and returning focus there on close would drop the keyboard user
    // back at the top of the document instead of where they left.
    const active = document.activeElement;
    restoreFocus = active instanceof HTMLElement && active !== document.body ? active : trigger;

    backdrop.hidden = false;
    sheet.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // The key is the one field a first-time user has to fill in, so it is where
    // focus goes. A returning user with a key already saved starts at the top too,
    // which keeps the tab order identical between the two cases.
    $('#tinyfish-key').focus();
    $('#tinyfish-key').select();
  };

  const close = () => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    showError('');
    if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
    restoreFocus = null;
  };

  /** Save, then reflect the result in the navbar and in the length control. */
  const save = () => {
    const tinyfishKey = $('#tinyfish-key').value.trim();

    if (!tinyfishKey) {
      showError('A TinyFish API key is needed to read any site. Keys are free at agent.tinyfish.ai.');
      $('#tinyfish-key').focus();
      return;
    }

    const chosen = provider.value;
    const llmKey = $('#llm-key').value.trim();
    const base = $('#llm-base').value.trim();
    const model = $('#llm-model').value.trim();

    // An OpenAI-compatible server needs all three of base, model and key, and a
    // half-filled one fails at request time with a message from the pipeline. It is
    // better to say so here, while the fields are still on screen.
    if (chosen === 'openai' && llmKey && !(base && model)) {
      showError('An OpenAI-compatible server needs a base URL and a model as well as the key.');
      (base ? $('#llm-model') : $('#llm-base')).focus();
      return;
    }

    saveCreds({ tinyfishKey, llm: { provider: llmKey ? chosen : '', key: llmKey, base, model } });
    paintCredState();
    syncLengthAvailability();
    close();
  };

  const forget = () => {
    clearCreds();
    $('#tinyfish-key').value = '';
    $('#llm-key').value = '';
    $('#llm-base').value = '';
    $('#llm-model').value = '';
    provider.value = '';
    paintProvider();
    showError('');
    paintStorageNote();
    paintCredState();
    syncLengthAvailability();
    close();
  };

  // Published so a run that finds no key can open this rather than explain itself.
  openSettings = open;

  trigger.addEventListener('click', () => (sheet.hidden ? open() : close()));
  $('#settings-close')?.addEventListener('click', close);
  $('#settings-cancel')?.addEventListener('click', close);
  $('#settings-save')?.addEventListener('click', save);
  $('#settings-clear')?.addEventListener('click', forget);
  backdrop.addEventListener('click', close);
  provider.addEventListener('change', () => {
    paintProvider();
    showError('');
  });

  // Enter saves from any field, which is what a form does and what the markup
  // already promised with its own <form> element.
  $('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });

  document.addEventListener('keydown', (event) => {
    if (sheet.hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === 'Tab') trapTab(event, sheet, { trigger, close });
  });

  paintCredState();
}

/**
 * Keep Tab inside the sheet. Focus that escapes to the page behind a modal is the
 * one failure that makes a modal unusable with a keyboard, and there is nothing
 * else in the document to stop it.
 */
function trapTab(event, sheet, { trigger, close }) {
  const focusable = $$(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    sheet,
  ).filter((node) => node.offsetParent !== null);

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!sheet.contains(document.activeElement)) {
    // Focus was somewhere outside the sheet entirely, which happens if the dialog
    // opened underneath a click that also moved focus.
    event.preventDefault();
    (trigger || first).focus();
  }

  void close;
}

/** Storage can be refused outright, and a save that silently did not persist is worse than a warning. */
function paintStorageNote() {
  const note = $('#settings-storage');
  if (!note) return;
  // Read after a save: that is the call that learns whether storage worked.
  const persistent = isPersistent();
  note.dataset.warn = String(!persistent);
  note.textContent = persistent
    ? 'Keys are kept in this browser and sent with each request. The server holds none of them.'
    : 'This browser is not storing these keys, so they last only until you close the tab. Private browsing usually refuses storage.';
}

/** The navbar control states whether a key is saved, so the answer is not from memory. */
function paintCredState() {
  const trigger = $('#settings-btn');
  if (trigger) trigger.dataset.hasKey = String(hasTinyfishKey());
}

/** Controls that only mean something in one mode are hidden, never merely disabled. */
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

  // Switching tabs empties the document: a guide is not a comparison, and leaving
  // the wrong one on screen is worse than an empty box. It deliberately does not go
  // through resetToIdle — once a run has started the panel stays for the rest of the
  // session, and a run in flight owns the output, so it is left alone rather than
  // having its grid torn out from under it.
  if (!quiet && !state.running) clearOutput();
}

/**
 * Empty the output but leave the panel standing. Distinct from resetToIdle: changing
 * which kind of guide you want is not the same as going home.
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
 * Clear a finished run and put the hero back. Both canvas components are torn down
 * too: each owns a rAF loop, and a loop left running on a hidden element is a battery
 * cost with nothing on screen.
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
 * The length control is a budget for the optional narration layer. With no narration
 * the deck is the seven measured pages, and the control says so rather than offering
 * a length the product cannot honour.
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
 * The length control only means something when a narration key is saved, and the
 * browser is now the only place that can be known: the server holds no keys, so
 * there is nothing to ask it. Reading the local store also means the control is
 * right on the first paint rather than after a round trip.
 */
function syncLengthAvailability() {
  const slider = $('#pages');
  const field = $('#pages-field');
  const help = $('#pages-help');
  if (!slider || !field) return;

  const enabled = hasLlmKey();

  slider.disabled = !enabled;
  field.dataset.disabled = String(!enabled);

  if (help) {
    help.textContent = enabled
      ? 'How long the full document should be. The measured pages always appear; the written ones fill to this length.'
      : 'Seven pages are produced from measurement alone. Add a narration key in Settings to generate the full document, where this becomes the page count.';
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
 * A native select's popup is drawn by the OS and ignores the stylesheet, so the
 * select is kept only as a hidden value holder and the user touches a button plus a
 * listbox. Keyboard behaviour follows the listbox pattern: arrows move, Home and
 * End jump, Enter and Space commit, Escape closes and restores focus.
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
  const paint = () => {    const option = select.selectedOptions[0];
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
    write('depth', item.dataset.value);    paint();
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

  /* A pointer press anywhere else dismisses it, including on the trigger, which
     handles its own toggle on click. */
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

/** The button that started a run is the only control that can stop it, so it is never disabled. */
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

  // No key, no run. The server holds none, so this is the only place the
  // requirement can be caught — and catching it here opens the thing that fixes
  // it, instead of spending a round trip to be told the same thing.
  if (!hasTinyfishKey()) {
    openSettings();
    return;
  }

  if (state.mode === 'guide') return runGuide(input);
  return runCompare(input);
}

/**
 * Guide runs stream, so the dialog can show the read set as it grows.
 *
 * Read over `fetch` rather than `EventSource`, because the API key has to travel
 * as a header and EventSource cannot send one. That is the whole reason this is
 * not the three-line constructor it otherwise would be; the frames are still the
 * same wire format, just parsed here.
 */
function runGuide(input) {
  const params = new URLSearchParams({
    input,
    depth: read('depth') || 'standard',
    pages: String(state.pages),
  });

  startRun({ status: 'Starting the crawl' });

  const controller = new AbortController();
  state.abort = controller;

  readEventStream(`/api/v1/stream?${params}`, {
    signal: controller.signal,
    headers: authHeaders(),
    on: handleStreamEvent,
  }).catch((err) => {
    if (err?.name === 'AbortError') return;
    finish('error', err.message || 'The connection dropped before the run finished.', err.code);
  });
}

function handleStreamEvent(event, data) {
  if (event === 'stage') {
    noteStage(data);
    return;
  }

  if (event === 'done') {
    state.guide = data;
    renderGuide(data);

    const warnings = warningsToAlert(data);
    // The guide is handed to finish so it can hand the mark to the grid, which
    // is what decides when the panel stands down.
    finish(warnings ? 'warn' : null, warnings?.message, null, warnings?.detail, data);
    return;
  }

  if (event === 'error') finish('error', data.message, data.code);
}

/**
 * Read a `text/event-stream` response and hand each frame to `on`.
 *
 * A blank line ends a frame, `data:` lines accumulate into one payload, and a line
 * beginning with a colon is the server's keep-alive comment, which carries nothing.
 * Multi-line data is joined with newlines, as the format specifies.
 *
 * Aborting mid-stream rejects with an AbortError the caller ignores, which is what
 * makes Cancel work.
 */
async function readEventStream(url, { signal, headers, on }) {
  const response = await fetch(url, { headers, signal });

  if (!response.ok || !response.body) {
    // A refusal before the stream opens is an ordinary JSON error, not a frame.
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message || `The server refused the run (HTTP ${response.status}).`);
    error.code = payload?.error?.code || `HTTP_${response.status}`;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        const parsed = parseEventFrame(frame);
        if (parsed) on(parsed.event, parsed.data);
      }
    }
  } finally {
    // Cancel releases the connection on a stream the caller walked away from.
    reader.cancel().catch(() => {});
  }
}

function parseEventFrame(frame) {
  let event = 'message';
  const data = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }

  if (!data.length) return null;

  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    // A frame that is not JSON is a server bug, not something to fail a run over.
    return null;
  }
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
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
 * Move the hero between its two shapes: centred in the gradient when idle, docked
 * left as a panel while running. The end states are declared in CSS; the motion is
 * here because CSS cannot transition a change of layout position without animating
 * layout properties, which reflows on every frame.
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

/** Begin a run: morph the controls into the panel, mount the orb, start the reveal. */
function startRun({ status }) {
  state.running = true;

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

/** The orb in the panel, mounted per run and destroyed with it. */
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
 * The grid starts now and waits at its cap for as long as the crawl takes, so the
 * animation tracks the real work rather than an asset download. The canvas is the
 * output box itself, so the guide is uncovered in place.
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
 * Let the grid resolve and uncover whatever is underneath. A brand can have no
 * usable logo and a comparison has no single mark, so the grid is always resolved
 * rather than snapped away; with no image it settles to a flat grey field.
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
  // Aborting is enough for both transports: it drops the connection, which ends
  // the event stream as surely as closing it would.
  state.abort?.abort();
  state.abort = null;
  finish('info', 'Run cancelled. Nothing was saved.');
}

/**
 * Close out a run. With no resolved payload there is no document to show, so the
 * output box is taken away rather than left as an empty frame under an alert.
 */
function finish(kind, message, code, detail, resolved) {
  setBusy(false);
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
 * The button is never disabled, since it is the only control that can stop a live
 * run; it becomes the cancel affordance instead. `data-busy` is left unset because
 * its only consumer is the spinner, and a spinner on a button labelled Cancel
 * competes with the orb already reporting progress.
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

/* Alerts are transient rather than sitting above the output, where a note about the
   extraction would take up room in front of the document it was a note about.
   Errors persist until dismissed, because an error is usually the end of the run. */

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

/** Exported so the screenshot harness can replay saved output through the live path. */
export function renderGuide(guide, opts = {}) {
  const host = $('#output');
  host.replaceChildren();
  composeGuide(host, guide, opts);
  setContextTitle(guide.identity?.name || hostOf(guide.input?.resolvedUrl || ''));
}

/** Put the guide in the output box: the pages, and the toolbar above them. */
function composeGuide(host, guide, opts = {}) {
  const box = $('#outbox');
  box.hidden = false;
  box.dataset.mode = 'guide';

  // renderDeck owns its host: it empties it before drawing.
  state.deck = renderDeck(host, guide, { target: opts.target ?? state.pages });

  renderOutputBar(state.deck, guide);
}

/** Lives here rather than in deck.js: the export menu needs the whole guide, not the deck. */
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
  // Null-safe: the screenshot harness hosts only the chrome it needs.
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
 * Label and format differ deliberately: "Style Dictionary" is the tool's name, not
 * a file extension. PDF is not a renderer and is handled separately below.
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