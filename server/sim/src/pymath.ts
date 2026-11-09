// Python-compatible numerics: the float results and strings CPython 3.12 produces, so a TS run
// matches the Python sim bit for bit. Pure functions, no Node-only APIs.

export const DT = 0.1; // sim-min per tick
export const EPS = 1e-9;

// ------------------------------------------------------------------ hypot (CPython 3.12)
const SPLIT = 134217729; // 2^27 + 1, Veltkamp split

/** Exact product a*b = hi + lo (Dekker); identical to fma-based dl_mul without overflow. */
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;
  let t = SPLIT * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b);
  const bl = b - bh;
  const err = ah * bh - p + ah * bl + al * bh + al * bl;
  return [p, err];
}

/** math.hypot(x, y) as CPython 3.12's vector_norm computes it (correctly rounded in practice). */
export function hypot(x: number, y: number): number {
  x = Math.abs(x);
  y = Math.abs(y);
  if (x === Infinity || y === Infinity) return Infinity;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const max = Math.max(x, y);
  if (max === 0) return 0;
  // frexp(max): max = m * 2^e, 0.5 <= m < 1
  let e = Math.floor(Math.log2(max)) + 1;
  let scale = Math.pow(2, -e);
  while (max * scale >= 1) {
    e += 1;
    scale = Math.pow(2, -e);
  }
  while (max * scale < 0.5) {
    e -= 1;
    scale = Math.pow(2, -e);
  }
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  for (const v of [x, y]) {
    const xs = v * scale;
    const [hi, lo] = twoProd(xs, xs);
    const s = csum + hi;
    const slo = csum - s + hi;
    csum = s;
    frac1 += lo;
    frac2 += slo;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [phi, plo] = twoProd(-h, h);
  const s = csum + phi;
  const slo = csum - s + phi;
  csum = s;
  frac1 += plo;
  frac2 += slo;
  const corr = csum - 1.0 + (frac1 + frac2);
  h += corr / (2.0 * h);
  return h / scale;
}

export function dist(a: readonly number[], b: readonly number[]): number {
  return hypot(a[0] - b[0], a[1] - b[1]);
}

// ------------------------------------------------------------------ rounding (half-even on exact ties)
const VIEW = new DataView(new ArrayBuffer(8));

/** If x * 10^n is exactly j + 0.5 (x > 0), return j; else null. */
function exactTie(x: number, n: number): bigint | null {
  const y = x * Math.pow(10, n);
  if (Math.abs(y - Math.floor(y) - 0.5) > 1e-6 * Math.max(1, Math.abs(y))) return null;
  VIEW.setFloat64(0, x);
  const hi = VIEW.getUint32(0);
  const lo = VIEW.getUint32(4);
  const ex = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let E: number;
  if (ex === 0) E = -1074;
  else {
    mant |= 1n << 52n;
    E = ex - 1075;
  }
  if (E >= 0) return null; // x is an integer: x*10^n*2 is even
  const num = mant * 10n ** BigInt(n) * 2n;
  const sh = BigInt(-E);
  if ((num & ((1n << sh) - 1n)) !== 0n) return null;
  const v = num >> sh;
  if ((v & 1n) === 0n) return null;
  return (v - 1n) / 2n;
}

/** Python round(x, n) for n >= 0 (round(x) when n = 0). */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x < 0) return -pyRound(-x, n);
  if (x === 0) return x;
  const j = exactTie(x, n);
  if (j !== null) {
    const k = j % 2n === 0n ? j : j + 1n;
    return Number(`${k}e-${n}`);
  }
  return Number(x.toFixed(n));
}

/** Python f"{x:.{n}f}". */
export function pyFixed(x: number, n: number): string {
  if (x < 0 || Object.is(x, -0)) {
    const s = pyFixed(-x, n);
    return "-" + s;
  }
  const j = x === 0 ? null : exactTie(x, n);
  if (j !== null) {
    const k = (j % 2n === 0n ? j : j + 1n).toString().padStart(n + 1, "0");
    return n ? `${k.slice(0, k.length - n)}.${k.slice(k.length - n)}` : k;
  }
  return x.toFixed(n);
}

/** Python f"{x:g}" (6 significant digits). */
export function pyG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const [mant, expS] = x.toExponential(5).split("e");
  const exp = Number(expS);
  if (exp < -4 || exp >= 6) {
    let m = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
    if (m === "") m = "0";
    const sign = exp < 0 ? "-" : "+";
    return `${m}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = x.toFixed(Math.max(0, 5 - exp));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Python float // for the positive divisor case (CPython float_floor_div). */
export function pyFloorDiv(vx: number, wx: number): number {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  }
  if (div) {
    let fl = Math.floor(div);
    if (div - fl > 0.5) fl += 1.0;
    return fl;
  }
  return 0 * (vx / wx);
}

/** Python 3.12 sum() over floats (Neumaier compensated). */
export function pySum(xs: readonly number[]): number {
  let f = 0.0;
  let c = 0.0;
  for (const x of xs) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
    else c += x - t + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Minutes -> 'HH:MM' or 'HH:MM:SS' (sim/geo.py fmt). */
export function fmt(t: number): string {
  const h = Math.trunc(pyFloorDiv(t, 60));
  const m = t - h * 60;
  let s = Math.trunc(pyRound((m - Math.trunc(m)) * 60));
  let mm = Math.trunc(m);
  if (s === 60) {
    mm += 1;
    s = 0;
  }
  return `${pad2(h)}:${pad2(mm)}` + (s ? `:${pad2(s)}` : "");
}

/** '17:12.5' / '17:12' / '17:12:30' -> minutes since 00:00 (sim/geo.py tmin). */
export function tmin(s: string | number): number {
  if (typeof s === "number") return s;
  const parts = s.split(":");
  let m = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  if (parts.length === 3) m += parseInt(parts[2], 10) / 60;
  return m;
}

// ------------------------------------------------------------------ Python-style ordering helpers
export type Key = number | string | boolean | null;

export function cmpKey(a: readonly Key[], b: readonly Key[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xv = typeof x === "boolean" ? Number(x) : x;
    const yv = typeof y === "boolean" ? Number(y) : y;
    if ((xv as number | string) < (yv as number | string)) return -1;
    if ((xv as number | string) > (yv as number | string)) return 1;
  }
  return a.length - b.length;
}

/** Python min(xs, key=...): the first minimal element. */
export function minBy<T>(xs: readonly T[], key: (x: T) => Key[]): T | undefined {
  let best: T | undefined;
  let bk: Key[] | undefined;
  for (const x of xs) {
    const k = key(x);
    if (bk === undefined || cmpKey(k, bk) < 0) {
      best = x;
      bk = k;
    }
  }
  return best;
}

/** Python max(xs, key=...): the first maximal element. */
export function maxBy<T>(xs: readonly T[], key: (x: T) => Key[]): T | undefined {
  let best: T | undefined;
  let bk: Key[] | undefined;
  for (const x of xs) {
    const k = key(x);
    if (bk === undefined || cmpKey(k, bk) > 0) {
      best = x;
      bk = k;
    }
  }
  return best;
}

/** Python sorted(xs, key=...): stable. */
export function sortBy<T>(xs: readonly T[], key: (x: T) => Key[]): T[] {
  return xs
    .map((x, i) => ({ x, k: key(x), i }))
    .sort((a, b) => cmpKey(a.k, b.k) || a.i - b.i)
    .map((r) => r.x);
}

/** Python str() of a value that may be None. */
export function pyStr(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  return String(x);
}
