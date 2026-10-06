/**
 * Where the keys live: this browser, and nowhere else.
 *
 * BrandKit's server holds no credentials, so the browser is the only place one can
 * exist. They are kept in localStorage, sent as headers on each request, and never
 * written anywhere else — no cookie, no analytics, no sync. Clearing them here
 * forgets them for good.
 *
 * Storage can be refused: Safari private mode and a few embedded webviews throw on
 * localStorage rather than returning null. Rather than fail every run, the module
 * falls back to memory for the session and says so through `isPersistent()`, which
 * the settings panel states plainly instead of pretending the save will outlive
 * the tab.
 */

const STORAGE_KEY = 'brandkit.creds.v1';

/** What the panel offers, in the order it offers them. */
export const PROVIDERS = [
  { value: '', label: 'None — measured pages only' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'openai', label: 'Any OpenAI-compatible server' },
];

const EMPTY = { tinyfishKey: '', llm: { provider: '', key: '', base: '', model: '' } };

/** Survives a storage refusal for the length of the session, and nothing longer. */
let memory = { ...EMPTY };
let persistent = true;

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Trim, and drop anything past the length the server will accept anyway. */
function text(value, max = 512) {
  const str = typeof value === 'string' ? value.trim() : '';
  return str.length > max ? str.slice(0, max) : str;
}

/** Never let a stored blob decide the shape; unknown fields are dropped here. */
function normalise(raw) {
  const llm = raw?.llm && typeof raw.llm === 'object' ? raw.llm : {};
  const provider = text(llm.provider, 32).toLowerCase();

  return {
    tinyfishKey: text(raw?.tinyfishKey),
    llm: {
      provider: PROVIDERS.some((p) => p.value === provider) ? provider : '',
      key: text(llm.key),
      base: text(llm.base, 2048),
      model: text(llm.model, 128),
    },
  };
}

export function loadCreds() {
  const local = store();
  if (!local) {
    persistent = false;
    return { ...memory };
  }

  try {
    const raw = local.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    memory = normalise(JSON.parse(raw));
  } catch {
    // A corrupt entry is not worth an exception: the user is simply not set up yet.
    memory = { ...EMPTY };
  }

  persistent = true;
  return { ...memory };
}

export function saveCreds(creds) {
  memory = normalise(creds);

  const local = store();
  if (!local) {
    persistent = false;
    return false;
  }

  try {
    local.setItem(STORAGE_KEY, JSON.stringify(memory));
    persistent = true;
  } catch {
    persistent = false;
  }
  return persistent;
}

export function clearCreds() {
  memory = { ...EMPTY };

  try {
    store()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to remove if storage was never available */
  }
}

export function isPersistent() {
  return persistent;
}

export function hasTinyfishKey() {
  return Boolean(loadCreds().tinyfishKey);
}

/** True only when the key is there *and* the fields its provider needs are too. */
export function hasLlmKey() {
  const { llm } = loadCreds();
  if (!llm.key) return false;
  return llm.provider === 'openai' ? Boolean(llm.base && llm.model) : true;
}

/**
 * The headers every call carries. Empty fields are omitted rather than sent blank,
 * so the server sees an absent credential instead of an empty one — the two mean
 * different things once it is resolving a provider.
 */
export function authHeaders() {
  const { tinyfishKey, llm } = loadCreds();
  const headers = {};

  if (tinyfishKey) headers['x-brandkit-tinyfish-key'] = tinyfishKey;
  if (llm.key) {
    headers['x-brandkit-llm-key'] = llm.key;
    if (llm.provider) headers['x-brandkit-llm-provider'] = llm.provider;
    if (llm.base) headers['x-brandkit-llm-base'] = llm.base;
    if (llm.model) headers['x-brandkit-llm-model'] = llm.model;
  }

  return headers;
}

/** Never the key itself: a mask long enough to tell two keys apart, short enough to be useless. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}${'•'.repeat(Math.min(16, key.length - 7))}${key.slice(-4)}`;
}