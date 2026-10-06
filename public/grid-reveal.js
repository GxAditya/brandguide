/**
 * GridReveal: a cell grid that splits toward a detail-first image reveal.
 *
 * Deliberately imperative rather than prop-driven. The grid must animate for the
 * whole duration of a crawl and stop only when the output exists, so `start()` paces
 * it to a cap and waits there, and `complete()` resolves into the image. Tying
 * completion to the image loading — as a `progress` prop would — would leave the
 * caller waiting on a transition that never fires when a logo URL 404s.
 */

const CELLS = 180;
const OPENING_CELLS = 4;

// Hold short of the end so the run can never finish before the image does.
const HOLD = 0.9;

// The grid stops splitting here while waiting, leaving arrival somewhere to go.
const WAIT_CAP = 0.72;
const LAST_SPLIT = 0.92;

// How long one cell takes to separate, in progress units.
const MORPH = 0.055;
const SAMPLE = 128;
const COLOR_MS = 420;
const GUTTER_FROM = 0.35;
const GUTTER_TO = 0.75;
const PHOTO_FROM = 0.93;

/* Written as comparisons so NaN falls through to 0. */
const clamp01 = (n) => (n > 0 ? (n < 1 ? n : 1) : 0);
const mix = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Never reaches its ceiling, so a job that outruns the estimate keeps creeping. */
function selfPaced(elapsed, duration) {
  const span = duration > 0 ? duration : 1;
  return HOLD * (1 - Math.exp(-elapsed / span));
}

function hash(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function makeCell(x, y, w, h, parent) {
  return {
    x, y, w, h,
    r: 0, g: 0, b: 0,
    tone: hash(x + 3.1, y + 1.7, w * 31.7),
    detail: 0,
    splitAt: 0,
    parent,
    kids: null,
  };
}

/** Splitting the biggest cell each time keeps cells square and the count rising one at a time. */
function buildTree(aspect) {
  const root = makeCell(0, 0, 1, 1, null);
  const leaves = [root];
  const branches = [];

  while (leaves.length < CELLS) {
    let pick = 0;
    let widest = -1;
    for (let i = 0; i < leaves.length; i += 1) {
      const c = leaves[i];
      // The jitter only breaks ties between cells of equal size.
      const area = c.w * aspect * c.h * (1 + 0.12 * hash(c.x, c.y, 7.3));
      if (area > widest) {
        widest = area;
        pick = i;
      }
    }

    const parent = leaves.splice(pick, 1)[0];
    const wide = parent.w * aspect >= parent.h;
    const half = wide ? parent.w / 2 : parent.h / 2;

    const a = wide
      ? makeCell(parent.x, parent.y, half, parent.h, parent)
      : makeCell(parent.x, parent.y, parent.w, half, parent);
    const b = wide
      ? makeCell(parent.x + half, parent.y, half, parent.h, parent)
      : makeCell(parent.x, parent.y + half, parent.w, half, parent);

    parent.kids = [a, b];
    branches.push(parent);
    leaves.push(a, b);
  }

  const opening = OPENING_CELLS - 1;
  const rest = Math.max(1, branches.length - opening);

  // The opening splits sit before zero, so those cells are already apart on
  // frame one.
  branches.forEach((cell, i) => {
    cell.splitAt = i < opening ? -MORPH : (LAST_SPLIT * (i - opening + 1)) / rest;
  });

  return { root, branches };
}

/** Average colour per cell, plus the luminance spread that decides what splits first. */
function measureTree(root, pixels, size) {
  const gather = (cell) => {
    let s;

    if (cell.kids) {
      const a = gather(cell.kids[0]);
      const b = gather(cell.kids[1]);
      s = {
        n: a.n + b.n, r: a.r + b.r, g: a.g + b.g, b: a.b + b.b,
        l: a.l + b.l, l2: a.l2 + b.l2,
      };
    } else {
      s = { n: 0, r: 0, g: 0, b: 0, l: 0, l2: 0 };
      const x0 = Math.round(cell.x * size);
      const y0 = Math.round(cell.y * size);
      const x1 = Math.max(x0 + 1, Math.round((cell.x + cell.w) * size));
      const y1 = Math.max(y0 + 1, Math.round((cell.y + cell.h) * size));

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * size + x) * 4;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          s.n += 1;
          s.r += r;
          s.g += g;
          s.b += b;
          s.l += l;
          s.l2 += l * l;
        }
      }
    }

    const n = s.n || 1;
    cell.r = s.r / n;
    cell.g = s.g / n;
    cell.b = s.b / n;
    cell.detail = Math.max(0, s.l2 / n - (s.l / n) * (s.l / n));
    return s;
  };

  gather(root);
}

/** Reuse the same time slots so only the order changes and the pacing is identical. */
function orderByDetail(branches, openedBefore) {
  const pending = branches.filter((c) => c.splitAt > openedBefore);
  if (pending.length < 2) return;

  const slots = pending.map((c) => c.splitAt).sort((a, b) => a - b);
  const queue = pending.filter((c) => !c.parent || c.parent.splitAt <= openedBefore);

  let next = 0;
  while (queue.length && next < slots.length) {
    let pick = 0;
    for (let i = 1; i < queue.length; i += 1) {
      if (queue[i].detail > queue[pick].detail) pick = i;
    }
    const cell = queue.splice(pick, 1)[0];
    cell.splitAt = slots[next];
    next += 1;
    for (const kid of cell.kids ?? []) {
      if (kid.kids) queue.push(kid);
    }
  }
}

function coverRect(iw, ih, w, h) {
  const s = Math.max(w / iw, h / ih);
  return { dx: (w - iw * s) / 2, dy: (h - ih * s) / 2, dw: iw * s, dh: ih * s };
}

function greyOf(tone, dark, clock) {
  return (dark ? 30 : 228) + tone * 13 + Math.sin(clock * 1.5 + tone * 6.28) * 3;
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */

const scene = {
  ctx: null,
  root: null,
  width: 0,
  height: 0,
  scale: 1,
  dark: false,
  clock: 0,
  split: 0,
  fade: 0,
  hasColors: false,
  image: null,
};

function paint(p) {
  const { ctx, width, height, split } = scene;

  // Snap to whole pixels so neighbouring cells stay flush with no seam.
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const w = Math.round(p.x + p.w) - x;
  const h = Math.round(p.y + p.h) - y;

  const onLeft = x <= 0;
  const onTop = y <= 0;
  const onRight = x + w >= width;
  const onBottom = y + h >= height;

  // Only interior edges get a gutter, so the outer silhouette stays the frame.
  const left = onLeft ? 0: scene.gutter;
  const top = onTop ? 0 : scene.gutter;
  const innerW = w - left - (onRight ? 0 : scene.gutter);
  const innerH = h - top - (onBottom ? 0 : scene.gutter);
  if (innerW <= 0 || innerH <= 0) return;

  const grey = greyOf(p.tone, scene.dark, scene.clock);
  ctx.fillStyle = `rgb(${shade(grey, p.r)},${shade(grey, p.g)},${shade(grey, p.b)})`;

  if (scene.rounded) {
    const radius = Math.min(innerW, innerH) * 0.12 * scene.soft;
    ctx.beginPath();
    ctx.roundRect(x + left, y + top, innerW, innerH, [
      !onLeft && !onTop ? radius : 0,
      !onRight && !onTop ? radius : 0,
      !onRight && !onBottom ? radius : 0,
      !onLeft && !onBottom ? radius : 0,
    ]);
    ctx.fill();
  } else {
    ctx.fillRect(x + left, y + top, innerW, innerH);
  }
}

function drawScene() {
  const { ctx, root, width, height, split } = scene;

  // Without pixel access the grid stays grey, but the image still fades in below.
  const tint = scene.hasColors ? scene.fade : 0;
  const base = greyOf(root.tone, scene.dark, scene.clock);

  // Gutters recess into this instead of cutting through to the surface behind.
  ctx.fillStyle = `rgb(${Math.round(shade(base, root.r) * 0.92)},${Math.round(
    shade(base, root.g) * 0.92,
  )},${Math.round(shade(base, root.b) * 0.92)})`;
  ctx.fillRect(0, 0, width, height);

  const walk = (cell, p) => {
    if (!cell.kids || split < cell.splitAt) {
      paint(p);
      return;
    }
    // Children start on the parent's rect and separate into their own.
    const t = easeOut(clamp01((split - cell.splitAt) / MORPH));
    for (const kid of cell.kids) {
      walk(kid, {
        x: mix(p.x, kid.x * width, t),
        y: mix(p.y, kid.y * height, t),
        w: mix(p.w, kid.w * width, t),
        h: mix(p.h, kid.h * height, t),
        r: mix(p.r, kid.r, t),
        g: mix(p.g, kid.g, t),
        b: mix(p.b, kid.b, t),
        tone: mix(p.tone, kid.tone, t),
      });
    }
  };

  walk(root, { x: 0, y: 0, w: width, h: height, r: root.r, g: root.g, b: root.b, tone: root.tone });

  if (!scene.image) return;
  const photo = scene.hasColors ? smoothstep(PHOTO_FROM, 1, split) * scene.fade : scene.fade;
  if (photo <= 0.002) return;

  const fit = coverRect(scene.image.naturalWidth, scene.image.naturalHeight, width, height);
  ctx.globalAlpha = photo;
  ctx.drawImage(scene.image, fit.dx, fit.dy, fit.dw, fit.dh);
  ctx.globalAlpha = 1;
}

function shade(grey, target) {
  return Math.round(mix(grey, target, scene.hasColors ? scene.fade : 0));
}

/* ── Mount ───────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   src?: string|null,
 *   svg?: string|null,
 *   aspect?: number,
 *   dark?: boolean,
 *   estimate?: number,
 *   onComplete?: () => void,
 * }} [options]
 * @returns {{ start(): void, complete(): void, destroy(): void }}
 */
export function mountGridReveal(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { start() {}, complete() {}, destroy() {} };

  const ratio = Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 1;
  const estimate = options.estimate ?? 6000;
  const onComplete = options.onComplete;

  const { root, branches } = buildTree(ratio);

  Object.assign(scene, {
    ctx, root, width: 0, height: 0, scale: 1,
    dark: options.dark ?? false,
    clock: 0, split: 0, fade: 0,
    hasColors: false, image: null,
    gutter: 0, soft: 1, rounded: false,
  });

  let loadedAt = -1;
  let cancelled = false;
  let finished = false;
  let stopped = false;
  let running = false;
  let raf = 0;

  const reduce = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function paint_() {
    scene.soft = 1 - smoothstep(GUTTER_FROM, GUTTER_TO, scene.split);
    scene.gutter = scene.scale * scene.soft;
    scene.rounded = scene.soft > 0.01 && typeof ctx.roundRect === 'function';
    drawScene();
  }

  function render(split, now) {
    scene.split = split;
    scene.fade = loadedAt < 0 ? 0 : smoothstep(0, COLOR_MS, now - loadedAt);
    paint_();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    scene.scale = dpr;
    if (w === scene.width && h === scene.height) return;
    scene.width = w;
    scene.height = h;
    canvas.width = w;
    canvas.height = h;
    // Resizing the canvas clears it, so always paint again.
    repaint();
  }

  function repaint() {
    if (!reduce) return render(scene.split, performance.now());
    // Reduced motion has no loop, so jump straight to the settled frame.
    const settled = loadedAt < 0 ? performance.now() : loadedAt + COLOR_MS;
    render(scene.image && finished ? 1 : WAIT_CAP, settled);
  }

  /* An inlined SVG is preferred over a remote URL because a blob URL never taints
     the canvas, so the grid keeps the mark's own colours. In practice the extractor
     records cross-origin URLs, so the grey-cells path is the normal one. */

  function adopt(image) {
    scene.image = image;
    loadedAt = performance.now();
    scene.hasColors = readAverages(image, root, branches, scene.split);

    // Reduced motion has no loop, so it needs an explicit repaint.
    if (reduce) repaint();
    // The loop may already have stopped, in which case the settled frame is
    // already on screen and a mark that arrived late has to repaint it.
    else if (stopped) repaint();
  }

  function loadImage() {
    const inline = options.svg;
    const remote = options.src;
    if (!inline && !remote) return;

    function loadInline(markup) {
      const blob = new Blob([markup], { type: 'image/svg+xml' });
      loadRemote(URL.createObjectURL(blob), false);
    }

    function loadRemote(url, cors) {
      const image = new Image();
      if (cors) image.crossOrigin = 'anonymous';
      image.decoding = 'async';

      image.onload = () => {
        if (cancelled) return;
        // A viewBox with no width and height reports 0, which the cover maths
        // cannot scale. Treat it as a failed load and try the next candidate.
        if (!image.naturalWidth || !image.naturalHeight) return;
        adopt(image);
      };

      image.onerror = () => {
        if (cancelled) return;
        // A host that sends no CORS headers rejects the crossOrigin request
        // outright, so the same URL is worth one plain retry. That image will
        // still taint the canvas, and readAverages handles that.
        if (cors) loadRemote(url, false);
        else if (inline) loadInline(inline);
      };

      image.src = url;
    }

    if (inline) loadInline(inline);
    else loadRemote(remote, true);
  }

  function readAverages(el, cellRoot, cellBranches, at) {
    const buffer = document.createElement('canvas');
    buffer.width = SAMPLE;
    buffer.height = SAMPLE;
    const bctx = buffer.getContext('2d', { willReadFrequently: true });
    if (!bctx) return false;

    const fit = coverRect(el.naturalWidth, el.naturalHeight, SAMPLE, SAMPLE);
    bctx.drawImage(el, fit.dx, fit.dy, fit.dw, fit.dh);

    try {
      measureTree(cellRoot, bctx.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE);
      orderByDetail(cellBranches, at);
      return true;
    } catch {
      // A tainted canvas lands here: the grey grid is the fallback, not a bug.
      return false;
    }
  }

  /* ── Reduced motion: no loop, so settle on whatever is true ──────────── */

  if (reduce) {
    resize();
    loadImage();
    repaint();
    return {
      start() {},
      complete() {
        finished = true;
        repaint();
        onComplete?.();
      },
      destroy() { cancelled = true; },
    };
  }

  /* ── The loop ────────────────────────────────────────────────────────── */

  let last = 0;
  let elapsed = 0;
  let eased = 0;
  let split = 0;

  function tick(now) {
    raf = 0;
    if (!running) return;

    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;
    scene.clock = elapsed;

    // The image landing is not what finishes the run. complete() is.
    const target = finished ? 1 : selfPaced(elapsed * 1000, estimate);

    eased += (target - eased) * (1 - Math.exp(-dt * 5.5));
    const wanted = Math.min(eased, finished ? 1 : WAIT_CAP);
    split += (wanted - split) * (1 - Math.exp(-dt * 4));
    render(split, now);

    if (finished && split > 0.999) {
      render(1, now);
      stopped = true;
      stop();
      // Unconditional: the image decides how the last frame looks, never whether
      // this runs, or a 404 leaves the caller waiting on a transition that cannot
      // happen.
      onComplete?.();
      return;
    }

    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running || stopped) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // No reason to animate a frame nobody is looking at.
  const visibility = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) start();
      else stop();
    }, { rootMargin: '150px' })
    : null;

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(resize)
    : null;

  observer?.observe(canvas);
  visibility?.observe(canvas);

  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  resize();
  loadImage();

  return {
    start,
    complete() {
      finished = true;
      // A run can finish before the image does, so make sure the loop is alive
      // to carry it the rest of the way.
      if (!stopped) start();
    },
    destroy() {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      visibility?.disconnect();
      scene.image = null;
    },
  };
}