/**
 * Colour maths: sRGB <-> HSL, WCAG contrast, and CIEDE2000 for /compare.
 */

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Parse any CSS colour string into { r, g, b, a } with 0-255 channels.
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  if (value.startsWith('#')) return parseHex(value);
  if (value.startsWith('rgb')) return parseRgbFn(value);
  if (value.startsWith('hsl')) return parseHslFn(value);

  const named = NAMED_COLORS[value];
  if (named) {
    const n = parseHex(named);
    return n ? { ...n, a: 1 } : null;
  }
  return null;
}

function parseHex(value) {
  let hex = value.slice(1);
  if (/^[0-9a-f]{3,4}$/.test(hex)) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseRgbFn(value) {
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  return {
    r: channel(parts[0]),
    g: channel(parts[1]),
    b: channel(parts[2]),
    a: parts.length > 3 ? alpha(parts[3]) : 1,
  };
}

function parseHslFn(value) {
  const match = value.match(/^hsla?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = ((parseFloat(parts[0]) % 360) + 360) % 360;
  const s = clamp(parsePercent(parts[1]), 0, 100) / 100;
  const l = clamp(parsePercent(parts[2]), 0, 100) / 100;
  const { r, g, b } = hslToRgb(h, s, l);
  return { r, g, b, a: parts.length > 3 ? alpha(parts[3]) : 1 };
}

function channel(token) {
  const n = token.endsWith('%') ? (parseFloat(token) / 100) * 255 : parseFloat(token);
  return clamp(Math.round(Number.isFinite(n) ? n : 0), 0, 255);
}

function alpha(token) {
  const n = token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
  return clamp(Number.isFinite(n) ? n : 1, 0, 1);
}

function parsePercent(token) {
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : 0;
}

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function toRgbString({ r, g, b, a = 1 }) {
  return a >= 1
    ? `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
    : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;
}

/** @returns {{h:number,s:number,l:number}} h in [0,360), s and l in [0,1] */
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  const seg = Math.floor(hue / 60) % 6;
  const table = [
    [c, x, 0], [x, c, 0], [0, c, x],
    [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[seg];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function describeColour(rgb) {
  const { h, s, l } = rgbToHsl(rgb);
  return {
    hex: toHex(rgb),
    rgb: toRgbString(rgb),
    hsl: `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
    hue: Math.round(h),
    saturation: Number(s.toFixed(3)),
    // Max channel spread, 0-255. HSL saturation is unreliable here: a pale grey
    // like #dee2e6 reports s=0.14 because the denominator collapses near white,
    // which would let a framework's default grey pass as a brand link colour.
    chroma: Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b),
    lightness: Number(l.toFixed(3)),
    alpha: rgb.a ?? 1,
  };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

/** WCAG grade for a contrast ratio. */
export function wcagGrade(ratio) {
  if (ratio >= 7) return { label: 'AAA', normal: true, large: true };
  if (ratio >= 4.5) return { label: 'AA', normal: true, large: true };
  if (ratio >= 3) return { label: 'AA Large', normal: false, large: true };
  return { label: 'Fail', normal: false, large: false };
}

/** Mix two colours in linear-ish sRGB space. */
export function mix(a, b, weight = 0.5) {
  return {
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
    a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * weight,
  };
}

/**
 * CIEDE2000 colour difference, in Lab space.
 */
export function deltaE2000(colour1, colour2) {
  return deltaE2000Lab(rgbToLab(colour1), rgbToLab(colour2));
}

/**
 * The same distance for colours already in CIE Lab, which is how the published
 * Sharma et al. test set is expressed.
 *
 * @param {[number,number,number]} lab1 L*, a*, b*
 * @param {[number,number,number]} lab2
 */
export function deltaE2000Lab([L1, a1, b1], [L2, a2, b2]) {
  return Number(cieDelta(L1, a1, b1, L2, a2, b2).toFixed(4));
}

/** sRGB -> CIE Lab, D65. */
export function rgbToLab({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);

  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function cieDelta(L1, a1, b1, L2, a2, b2) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const hp = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    const angle = Math.atan2(b, ap) * deg;
    return angle >= 0 ? angle : angle + 360;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt(
    (dLp / Sl) ** 2 +
      (dCp / Sc) ** 2 +
      (dHp / Sh) ** 2 +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** Human-readable name for a colour, via nearest CSS named colour in Lab space. */
export function nearestNamedColour(rgb, names = CSS_COLOR_NAMES) {
  let best = { name: names[0].name, distance: Infinity };
  for (const entry of names) {
    const d = deltaE2000(rgb, entry.rgb);
    if (d < best.distance) best = { name: entry.name, distance: Number(d.toFixed(2)) };
  }
  return best;
}

/** CSS named colours, precomputed to Lab so nearest-name lookup stays fast. */
const CSS_COLOR_NAMES = [
  ['black', '#000000'], ['white', '#ffffff'], ['red', '#ff0000'], ['crimson', '#dc143c'],
  ['tomato', '#ff6347'], ['coral', '#ff7f50'], ['orange', '#ffa500'], ['darkorange', '#ff8c00'],
  ['amber', '#ffbf00'], ['gold', '#ffd700'], ['yellow', '#ffff00'], ['olive', '#808000'],
  ['chartreuse', '#7fff00'], ['lime', '#00ff00'], ['green', '#008000'], ['forestgreen', '#228b22'],
  ['seagreen', '#2e8b57'], ['emerald', '#50c878'], ['teal', '#008080'], ['turquoise', '#40e0d0'],
  ['cyan', '#00ffff'], ['darkcyan', '#008b8b'], ['skyblue', '#87ceeb'], ['dodgerblue', '#1e90ff'],
  ['blue', '#0000ff'], ['royalblue', '#4169e1'], ['navy', '#000080'], ['midnightblue', '#191970'],
  ['indigo', '#4b0082'], ['purple', '#800080'], ['rebeccapurple', '#663399'], ['violet', '#ee82ee'],
  ['magenta', '#ff00ff'], ['fuchsia', '#ff00ff'], ['pink', '#ffc0cb'], ['hotpink', '#ff69b4'],
  ['brown', '#a52a2a'], ['saddlebrown', '#8b4513'], ['sienna', '#a0522d'], ['peru', '#cd853f'],
  ['tan', '#d2b48c'], ['beige', '#f5f5dc'], ['ivory', '#fffff0'], ['wheat', '#f5deb3'],
  ['khaki', '#f0e68c'], ['plum', '#dda0dd'], ['orchid', '#da70d6'], ['lavender', '#e6e6fa'],
  ['slategray', '#708090'], ['gray', '#808080'], ['dimgray', '#696969'], ['silver', '#c0c0c0'],
  ['darkgray', '#a9a9a9'], ['lightgray', '#d3d3d3'], ['whitesmoke', '#f5f5f5'],
  ['gainsboro', '#dcdcdc'], ['linen', '#faf0e6'], ['azure', '#f0ffff'], ['aliceblue', '#f0f8ff'],
].map(([name, hex]) => ({ name, rgb: parseHex(hex) }));

/** Named colours usable directly in CSS `font-family` / colour values. */
const NAMED_COLORS = Object.fromEntries(
  CSS_COLOR_NAMES.map(({ name, rgb }) => [name, toHex(rgb)]),
);