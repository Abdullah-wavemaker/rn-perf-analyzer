/** Pure scale/tick helpers shared by SVG charts and the canvas timeline. */

export interface LinearScale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  invert: (px: number) => number;
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const k = (r1 - r0) / span;
  const f = ((v: number) => r0 + (v - d0) * k) as LinearScale;
  f.domain = domain;
  f.range = range;
  f.invert = (px: number) => d0 + (px - r0) / k;
  return f;
}

/** "Nice" step: 1, 2, 2.5, 5 × 10^n. */
export function niceStep(span: number, targetTicks: number): number {
  if (!(span > 0) || !(targetTicks > 0)) return 1;
  const raw = span / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = niceStep(max - min, target);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Extend a [min,max] domain to nice boundaries. */
export function niceDomain(min: number, max: number, target = 5): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return min === 0 ? [0, 1] : [Math.min(0, min), max * 1.1];
  const step = niceStep(max - min, target);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

/** Time ticks for a ms span: steps snap to human units (1/2/5 × ms, s, min). */
const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];

export function timeStep(spanMs: number, targetTicks: number): number {
  const raw = spanMs / Math.max(1, targetTicks);
  for (const s of TIME_STEPS) if (s >= raw) return s;
  return niceStep(spanMs, targetTicks);
}

export function timeTicks(startMs: number, endMs: number, targetTicks: number, origin = 0): number[] {
  const step = timeStep(endMs - startMs, targetTicks);
  const first = origin + Math.ceil((startMs - origin) / step) * step;
  const out: number[] = [];
  for (let t = first; t <= endMs && out.length < 200; t += step) out.push(t);
  return out;
}

/** Label for a relative offset given the tick step (more precision when zoomed in). */
export function fmtTickOffset(offsetMs: number, stepMs: number): string {
  const sign = offsetMs < 0 ? '−' : '';
  const a = Math.abs(offsetMs);
  if (stepMs < 1) return `${sign}${a.toFixed(2)}ms`;
  if (stepMs < 1000) {
    if (a < 1000) return `${sign}${Math.round(a)}ms`;
    const decimals = stepMs < 10 ? 3 : stepMs < 100 ? 2 : 1;
    return `${sign}${(a / 1000).toFixed(decimals)}s`;
  }
  if (a < 60_000 || stepMs < 60_000) {
    if (a >= 60_000) {
      const m = Math.floor(a / 60_000);
      const s = Math.round((a % 60_000) / 1000);
      return `${sign}${m}m${String(s).padStart(2, '0')}s`;
    }
    return `${sign}${Math.round(a / 1000)}s`;
  }
  return `${sign}${Math.round(a / 60_000)}m`;
}

/** Index of the first element with key >= target in a sorted array. */
export function lowerBound<T>(arr: readonly T[], target: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = arr[mid];
    if (item !== undefined && key(item) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nearest element by key in a sorted array. */
export function nearestIndex<T>(arr: readonly T[], target: number, key: (t: T) => number): number {
  if (arr.length === 0) return -1;
  const i = lowerBound(arr, target, key);
  if (i <= 0) return 0;
  if (i >= arr.length) return arr.length - 1;
  const a = arr[i - 1];
  const b = arr[i];
  if (a === undefined || b === undefined) return i;
  return Math.abs(key(a) - target) <= Math.abs(key(b) - target) ? i - 1 : i;
}

/**
 * Min/max decimation: keeps the first, min, max and last point per pixel
 * bucket so spikes survive downsampling.
 */
export function decimate<P extends { x: number; y: number | null }>(points: readonly P[], x0: number, x1: number, buckets: number): P[] {
  if (points.length <= buckets * 2 || buckets <= 0) return points.slice();
  const out: P[] = [];
  const span = x1 - x0 || 1;
  let curBucket = -1;
  let first: P | null = null;
  let min: P | null = null;
  let max: P | null = null;
  let last: P | null = null;
  const flush = () => {
    const set = new Set<P>();
    for (const p of [first, min, max, last]) if (p) set.add(p);
    const sorted = Array.from(set).sort((a, b) => a.x - b.x);
    out.push(...sorted);
  };
  for (const p of points) {
    const b = Math.floor(((p.x - x0) / span) * buckets);
    if (b !== curBucket) {
      if (curBucket !== -1) flush();
      curBucket = b;
      first = p;
      min = p;
      max = p;
      last = p;
      continue;
    }
    last = p;
    if (p.y !== null) {
      if (min === null || min.y === null || p.y < min.y) min = p;
      if (max === null || max.y === null || p.y > max.y) max = p;
    }
  }
  if (curBucket !== -1) flush();
  return out;
}

/** Path for a bar with 4px rounded data end and square baseline. */
export function hBarPath(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = x1 - x0;
  if (Math.abs(w) < 0.5) return '';
  const rr = Math.min(r, Math.abs(w), h / 2);
  if (w > 0) {
    return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  }
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

/** Vertical bar (column) growing up from baseline y0 to y1 (< y0). */
export function vBarPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const h = y0 - y1;
  if (h < 0.5) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
}
