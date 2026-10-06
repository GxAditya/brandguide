/**
 * The comparison view: rows are signals (palette, type, voice, vocabulary) and
 * columns are brands. A benchmark is not a leaderboard, so there is no winner —
 * every cell shows the number and the reading that number produces, and anything
 * unmeasurable says so rather than rendering as zero.
 *
 * No framework, no build step, no innerHTML with untrusted content.
 */

const $ = (sel, root = document) => root.querySelector(sel);

export function renderCompare(payload) {
  const output = $('#output');
  output.replaceChildren();

  const bench = el('div', 'bench');
  const brands = payload.brands || [];
  const readable = brands.filter((brand) => brand.ok);
  const subject = readable[0] || brands[0] || null;

  bench.append(documentHead(payload, brands, readable));
  bench.append(signalMatrix(payload, readable));

  const rows = payload.comparison?.rows || [];
  if (rows.length) bench.append(distinctiveness(rows));
  if (payload.positioning) bench.append(positioning(payload.positioning));

  const resolved = payload.provenance?.resolvedVia || [];
  if (resolved.length) bench.append(resolutionCard(resolved));

  output.append(bench);
  setContextTitle(payload.subject || 'Comparison');
}

/* ── Document header ──────────────────────────────────────────────────────── */

function documentHead(payload, brands, readable) {
  const card = el('section', 'bench-card');

  const head = el('header', 'bench-head');
  const title = el('h3', '', 'Brand comparison');
  const note = el(
    'p',
    '',
    `${readable.length} of ${brands.length} ${brands.length === 1 ? 'brand' : 'brands'} read`
    + (brands.length > readable.length ? ', the rest could not be reached' : ''),
  );
  head.append(title, note);

  const body = el('div', 'bench-body bench-body-pad');
  body.append(el('p', 'bench-subject', payload.subject || ''));

  if (payload.comparison?.note) {
    const how = el('p', 'bench-how', payload.comparison.note);
    body.append(how);
  }

  card.append(head, body);
  return card;
}

/* ── The signal matrix ────────────────────────────────────────────────────── */

/** A brand column reads top to bottom as one profile, which is why signals are rows. */
function signalMatrix(payload, readable) {
  const card = el('section', 'bench-card');

  const head = el('header', 'bench-head');
  head.append(el('h3', '', 'Signal by signal'));

  const note = el('p', '', 'Each row is one measurement of the same thing on every brand');
  head.append(note);

  const table = el('table', 'matrix');

  // Column widths: the label column is fixed, the brand columns share the rest.
  const columns = readable.length;
  table.style.width = `${130 + columns * 190}px`;
  table.style.minWidth = '100%';

  /* Header row: one column per brand, with the domain it resolved to. */
  const thead = el('thead');  const headRow = el('tr');
  headRow.append(el('th', 'axis', 'Signal'));

  readable.forEach((brand, index) => {
    const cell = el('th');
    cell.setAttribute('scope', 'col');
    const wrap = el('div', 'matrix-brand');
    if (index === 0) wrap.classList.add('is-subject');
    wrap.append(el('b', '', brand.name || brand.domain));
    wrap.append(el('span', '', shortHost(brand.url) || brand.domain || 'unresolved'));
    cell.append(wrap);
    headRow.append(cell);
  });

  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');

  /* Palette. The subject column shows its own colours; the others show the distance
   from the subject, which is the number that carries meaning. */
  const paletteRow = el('tr');
  paletteRow.append(axisHeader('Palette'));
  const subjectPalette = readable[0]?.palette || [];
  readable.forEach((brand, index) => {
    const cell = el('td');
    if (index === 0) {
      cell.append(swatchRow(brand.palette || []));
      cell.append(el('span', 'cell-note', countLabel(
        brand.paletteCount ?? (brand.palette || []).length,
        'token',
      )));
    } else {
      const diff = payload.comparison?.rows?.find((row) => row.against === brand.name);
      cell.append(valueOrMissing(diff?.palette?.average, (v) => `${v} ΔE average`));
      cell.append(el('span', 'cell-note', diff?.palette?.reading || 'not compared'));
      if (diff?.palette?.closest?.to) {
        cell.append(el('span', 'cell-note', `closest is ${diff.palette.closest.to}`));
      }
    }
    paletteRow.append(cell);
  });
  tbody.append(paletteRow);

  /* Typeface. */
  const typeRow = el('tr');
  typeRow.append(axisHeader('Type'));
  readable.forEach((brand, index) => {
    const cell = el('td');
    const list = el('ul', 'type-list');
    for (const font of (brand.fonts || []).slice(0, 3)) {
      const item = el('li');
      item.append(document.createTextNode(font.family || ''));
      if (font.kind) item.append(el('em', '', font.kind));
      list.append(item);
    }
    if (!(brand.fonts || []).length) list.append(el('li', 'cell-unreadable', 'no family declared'));
    cell.append(list);

    if (index > 0) {
      const diff = payload.comparison?.rows?.find((row) => row.against === brand.name);
      cell.append(el('span', 'cell-note', diff?.fonts?.reading || 'not compared'));
    } else {
      cell.append(el('span', 'cell-note', countLabel(
        brand.fontsCount ?? (brand.fonts || []).length,
        'family',
        'families',
      )));
    }
    typeRow.append(cell);
  });
  tbody.append(typeRow);

  /* Voice. The subject column shows what was measured on its own copy; the others
   show the distance from the subject. */
  const voiceRow = el('tr');
  voiceRow.append(axisHeader('Voice'));
  readable.forEach((brand, index) => {
    const cell = el('td');

    if (index === 0) {
      if (brand.headline) cell.append(el('p', 'cell-quote', `“${brand.headline}”`));
      const stats = brand.voiceStats || {};
      cell.append(valueOrMissing(stats.avgSentenceLength, (v) => `mean ${v} words per sentence`));
      if (stats.readingGrade != null) {
        cell.append(el('span', 'cell-note', `reads at grade ${stats.readingGrade}`));
      }
    } else {
      const diff = payload.comparison?.rows?.find((row) => row.against === brand.name);
      cell.append(valueOrMissing(diff?.tone?.distance, (v) => `${v} cosine distance`));
      cell.append(el('span', 'cell-note', diff?.tone?.reading || 'not compared'));
      if (diff?.tone?.worstAxis) {
        cell.append(el('span', 'cell-note', `furthest on ${diff.tone.worstAxis}`));
      }
    }
    voiceRow.append(cell);
  });
  tbody.append(voiceRow);

  /* Vocabulary. */
  const termsRow = el('tr');
  termsRow.append(axisHeader('Vocabulary'));
  readable.forEach((brand, index) => {
    const cell = el('td');
    const terms = (brand.terms || []).slice(0, 8);
    if (!terms.length) {
      cell.append(el('span', 'cell-unreadable', 'no message vocabulary found'));
    } else {
      const wrap = el('div', 'terms');
      for (const term of terms) wrap.append(el('span', 'term', term));
      cell.append(wrap);
    }
    if (index > 0) {
      const diff = payload.comparison?.rows?.find((row) => row.against === brand.name);
      const shared = diff?.vocabulary?.shared || [];
      cell.append(el(
        'span',
        'cell-note',
        shared.length ? `shared: ${shared.join(', ')}` : 'no shared key terms',
      ));
    }
    termsRow.append(cell);
  });
  tbody.append(termsRow);

  table.append(tbody);

  card.append(head, table);
  return card;
}

function axisHeader(text) {
  const cell = el('th', 'axis', text);
  cell.setAttribute('scope', 'row');
  return cell;
}

/** "1 token" but "6 tokens": a count of one next to a plural reads as a bug. */
function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural} declared`;
}

function swatchRow(palette) {
  const wrap = el('div', 'swatches');
  if (!palette.length) {
    wrap.append(el('span', 'cell-unreadable', 'no colour tokens readable'));
    return wrap;
  }
  for (const token of palette.slice(0, 8)) {
    const chip = document.createElement('i');
    chip.style.background = token.hex;
    chip.title = `${token.hex}${token.name ? ` ${token.name}` : ''}`;
    wrap.append(chip);
  }
  return wrap;
}

/** A number, or an honest statement that there was not one to give. */
function valueOrMissing(value, format) {
  const node = el('span', 'cell-value');
  if (value == null) {
    node.classList.add('cell-unreadable');
    node.textContent = 'not measurable';
    return node;
  }
  node.textContent = format(value);
  return node;
}

/* ── Distinctiveness ──────────────────────────────────────────────────────── */

function distinctiveness(rows) {
  const card = el('section', 'bench-card');

  const head = el('header', 'bench-head');
  head.append(el('h3', '', 'How distinct the subject is'));

  const head_note = el('p', '');
  if (rows.length > 1) head_note.textContent = `Closest to ${rows[0].against}`;
  else head_note.textContent = 'One competitor in the set';
  head.append(head_note);

  const list = el('div', 'diff-list');

  for (const row of rows) {
    const item = el('div', 'diff-row');

    const who = el('div', 'diff-who');
    who.append(el('b', '', row.against));
    who.append(el('span', '', reading(row)));
    item.append(who);

    // A hairline with no track behind it. The numeral is the value; the line only
    // makes two rows comparable without reading them.
    const meter = el('div', 'diff-meter');
    const bar = document.createElement('i');
    bar.style.width = `${Math.max(2, row.distinctiveness.score)}%`;
    meter.append(bar);

    const score = el('div');
    score.append(el('div', 'diff-score', String(row.distinctiveness.score)));
    score.append(el('span', 'diff-band', row.distinctiveness.band || 'unscored'));

    item.append(meter, score);
    list.append(item);
  }

  card.append(head, list);
  return card;
}

/** Joined with commas: each reading is a clause, so a full stop reads as a bug. */
function reading(row) {
  const parts = [row.palette?.reading, row.tone?.reading, row.fonts?.reading]
    .filter(Boolean)
    .map((text) => text.replace(/\.$/, ''));

  if (!parts.length) return 'Not enough was readable to compare.';

  const first = parts[0];
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}, ${parts.slice(1).join(', ')}.`;
}

/* ── Positioning ──────────────────────────────────────────────────────────── */

function positioning(positioning) {
  const card = el('section', 'bench-card');

  const head = el('header', 'bench-head');
  head.append(el('h3', '', 'Vocabulary this brand owns'));
  const nearest = positioning.nearestNeighbour;
  head.append(el(
    'p',
    '',
    nearest
      ? `Closest by colour: ${nearest.brand} at ${nearest.paletteDistance} ΔE`
      : 'No nearest neighbour could be measured',
  ));

  const grid = el('div', 'pos-grid');

  grid.append(termCell('Its own', positioning.owned, 'owned'));
  grid.append(termCell('Shared with the set', positioning.crowded, 'crowded'));

  card.append(head, grid);
  return card;
}

function termCell(heading, block, tone) {
  const cell = el('div', 'pos-cell');
  cell.append(el('h4', '', heading));

  const note = block?.note || 'Nothing to report.';
  cell.append(el('p', '', note));

  const terms = block?.terms || [];
  if (terms.length) {
    const wrap = el('div', 'terms');
    for (const term of terms) {
      const chip = el('span', 'term', term);
      if (tone === 'owned') chip.dataset.tone = 'owned';
      wrap.append(chip);
    }
    cell.append(wrap);
  }

  return cell;
}

/* ── How each name resolved ───────────────────────────────────────────────── */

function resolutionCard(resolved) {
  const card = el('section', 'bench-card');

  const head = el('header', 'bench-head');
  head.append(el('h3', '', 'How each name resolved'));
  head.append(el('p', '', 'A bare name is turned into a domain by search before anything is read'));

  const body = el('div', 'bench-body bench-body-pad');
  const list = el('ul', 'resolved-list');

  for (const entry of resolved) {
    const item = el('li');
    item.dataset.ok = String(Boolean(entry.url));

    const link = el('a', '', shortHost(entry.url) || entry.name);
    if (entry.url) {
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = entry.reasoning || entry.url;
    }
    item.append(link, el('em', '', entry.method || 'unresolved'));
    list.append(item);
  }

  body.append(list);
  card.append(head, body);
  return card;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function shortHost(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.hostname.replace(/^www\./, '') + parsed.pathname).replace(/\/$/, '') || parsed.hostname;
  } catch {
    return String(url);
  }
}

function setContextTitle(text) {
  const slot = $('#appbar-context');
  const label = $('#context-name');
  if (!slot || !label || !text) return;  label.textContent = text;
  slot.hidden = false;
}