/**
 * MatrixOrb.
 *
 * A port of the React component to plain Canvas2D, because this project has no
 * framework, no JSX and no build step. The algorithm is carried over unchanged:
 * the same envelope, the same three intensity functions, the same orbiters, the
 * same spring on scale, the same frame-rate-independent smoothing, the same
 * per-state weight blend, and the same single-frame reduced-motion path.
 *
 * The React hooks map to plain calls: useRef to closure variables, useEffect to
 * mount and teardown, useSyncExternalStore to a resize listener.
 *
 * One deliberate omission: the component renders its own label from a
 * STATES map. Here the canvas is presentation-free and the caller owns the
 * surrounding text, because the label changes with what the pipeline is doing
 * rather than with the orb.
 */

const TAU = Math.PI * 2;

const STATES = ['idle', 'listening', 'thinking'];

const SCALE = {
  idle: 0.88,
  listening: 1,
  thinking: 0.92,
};

const STIFFNESS = 180;
const DAMPING = 26;
const ATTACK = 0.22;
const RELEASE = 0.08;
const BLEND = 0.16;

const ORBITERS = [
  { radius: 0.62, speed: 2.2, phase: 0, spread: 0.42 },
  { radius: 0.4, speed: -1.7, phase: 2.1, spread: 0.36 },
  { radius: 0.8, speed: 1.15, phase: 4, spread: 0.34 },
];

/**
 * The level envelope, when the caller does not supply one.
 *
 * No Math.abs here: its corners read as a snap at every trough.
 */
function envelope(t) {
  const slow = 0.5 + 0.5 * Math.sin(t * 0.62 + 0.4);
  const fast = 0.5 + 0.5 * Math.sin(t * 1.9 + 1.1);
  return 0.22 + 0.78 * (0.45 + 0.55 * slow) * fast;
}

/**
 * Per-state brightness for one dot.
 *
 * listening  a ripple travelling out from the centre
 * thinking   three orbiters sweeping heat across the field
 * idle       a slow breathing falloff
 */
function intensityOf(state, d, nx, ny, t, amplitude) {
  if (state === 'listening') {
    const ripple = 0.5 + 0.5 * Math.sin(d * 4.2 - t * 3);
    return 0.32 + amplitude * (0.34 + 0.38 * ripple);
  }

  if (state === 'thinking') {
    let heat = 0;
    for (const o of ORBITERS) {
      const a = t * o.speed + o.phase;
      const dx = nx - Math.cos(a) * o.radius;
      const dy = ny - Math.sin(a) * o.radius;
      heat += Math.exp(-(dx * dx + dy * dy) / (o.spread * o.spread));
    }
    return 0.26 + 0.8 * Math.min(1, heat);
  }

  return 0.62 + 0.12 * Math.sin(t * 1.05 - d * 2.4);
}

/* ── Mount ────────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   state?: 'idle'|'listening'|'thinking',
 *   level?: number,
 *   size?: number,
 *   color?: string,
 *   dots?: number,
 * }} [options]
 * @returns {{ setState(s: string): void, setLevel(v: number): void, redraw(): void, destroy(): void }}
 */
export function mountOrb(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { setState() {}, setLevel() {}, redraw() {}, destroy() {} };
  }

  const size = options.size ?? 168;
  const color = options.color ?? '#f5bde6';
  const grid = Math.max(3, Math.round(options.dots ?? 11));

  // Read by the loop through these, so changing either does not restart it.
  let currentState = STATES.includes(options.state) ? options.state : 'idle';
  let suppliedLevel = Number.isFinite(options.level) ? options.level : null;

  const dpr = () => Math.min(window.devicePixelRatio || 1, 4);

  const half = (grid - 1) / 2;
  const spacing = (size * 0.74) / (grid - 1);
  const maxRadius = spacing * 0.6;
  const center = size / 2;

  const weights = { idle: 0, listening: 0, thinking: 0 };
  weights[currentState] = 1;

  // A non-finite level would stick in the smoother forever.
  const levelAt = (t) => (
    suppliedLevel === null
      ? envelope(t)
      : Math.min(1, Math.max(0, suppliedLevel))
  );

  let ratio = dpr();

  function sizeCanvas() {
    // Scaling by buffer/size, not dpr, keeps the transform exact when it rounds.
    const buffer = Math.round(size * ratio);
    canvas.width = buffer;
    canvas.height = buffer;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(buffer / size, buffer / size);
    ctx.fillStyle = color;
  }

  sizeCanvas();

  function draw(t, amplitude, scale) {
    ctx.clearRect(0, 0, size, size);

    for (let iy = 0; iy < grid; iy += 1) {
      for (let ix = 0; ix < grid; ix += 1) {
        const nx = (ix - half) / half;
        const ny = (iy - half) / half;
        const d = Math.hypot(nx, ny);

        // 1.12, not the square's 1.41 corner, is what makes the outline round.
        if (d > 1.12) continue;

        let blended = 0;
        for (const state of STATES) {
          if (weights[state] < 0.001) continue;
          blended += weights[state] * intensityOf(state, d, nx, ny, t, amplitude);
        }

        const intensity = Math.min(1, Math.max(0, blended));
        const radius = maxRadius * Math.exp(-d * d * 1.7) * intensity * scale;

        // Anything under half a device pixel renders as haze, not a dot.
        if (radius * ratio < 0.5) continue;

        ctx.beginPath();
        ctx.arc(
          center + (ix - half) * spacing * scale,
          center + (iy - half) * spacing * scale,
          radius,
          0,
          TAU,
        );
        ctx.fill();
      }
    }
  }

  /* ── Reduced motion: one frame, and redraw whenever the state changes ──── */

  const reduce = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce) {
    const still = () => {
      for (const state of STATES) weights[state] = state === currentState ? 1 : 0;
      draw(0, levelAt(0), SCALE[currentState]);
    };
    still();
    return {
      setState(next) {
        if (!STATES.includes(next)) return;
        currentState = next;
        still();
      },
      setLevel(value) {
        suppliedLevel = Number.isFinite(value) ? value : null;
        still();
      },
      redraw: still,
      destroy() {},
    };
  }

  /* ── The loop ──────────────────────────────────────────────────────────── */

  let t = 0;
  let amplitude = 0;
  let scale = SCALE[currentState];
  let velocity = 0;
  let last = performance.now();
  let raf = 0;
  let running = false;

  function frame(now) {
    raf = 0;
    if (!running) return;

    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;

    const target = levelAt(t);
    const rate = target > amplitude ? ATTACK : RELEASE;
    amplitude += (target - amplitude) * (1 - Math.pow(1 - rate, dt * 60));

    // Per-state weights, so interrupting a change blends from what is on screen.
    const step = 1 - Math.pow(1 - BLEND, dt * 60);
    for (const state of STATES) {
      weights[state] += ((state === currentState ? 1 : 0) - weights[state]) * step;
    }

    velocity += (-STIFFNESS * (scale - SCALE[currentState]) - DAMPING * velocity) * dt;
    scale += velocity * dt;

    draw(t, amplitude, scale);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* Zoom changes devicePixelRatio, and a buffer built for the old one gets
     upscaled, so the canvas is rebuilt on resize. */
  const onResize = () => {
    const next = dpr();
    if (next === ratio) return;
    ratio = next;
    sizeCanvas();
    if (running) draw(t, amplitude, scale);
  };

  window.addEventListener('resize', onResize, { passive: true });

  // Off-screen and background tabs cost nothing.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) start();
      else stop();
    }, { threshold: 0 })
    : null;
  observer?.observe(canvas);

  start();

  return {
    setState(next) {
      // The loop retargets; it never restarts.
      if (STATES.includes(next)) currentState = next;
    },
    setLevel(value) {
      suppliedLevel = Number.isFinite(value) ? value : null;
    },
    redraw() {
      draw(t, amplitude, scale);
    },
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    },
  };
}