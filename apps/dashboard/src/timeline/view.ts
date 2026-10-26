/** Pure viewport math for the timeline (absolute epoch-ms window). */

export interface View {
  start: number;
  end: number;
}

export interface Bounds {
  start: number;
  end: number;
}

export const MIN_SPAN_MS = 0.5;

export function fitView(b: Bounds): View {
  const span = Math.max(1, b.end - b.start);
  const pad = span * 0.02;
  return { start: b.start - pad, end: b.end + pad };
}

export function clampView(v: View, b: Bounds): View {
  const full = Math.max(1, b.end - b.start);
  const maxSpan = full * 1.5;
  let span = Math.min(maxSpan, Math.max(MIN_SPAN_MS, v.end - v.start));
  if (!Number.isFinite(span)) span = full;
  const margin = Math.max(span * 0.5, full * 0.05);
  let start = v.start;
  if (start < b.start - margin) start = b.start - margin;
  if (start + span > b.end + margin) start = b.end + margin - span;
  return { start, end: start + span };
}

/** Zoom by `factor` (<1 zooms in) keeping `anchor` (epoch ms) under the cursor. */
export function zoomAt(v: View, anchor: number, factor: number, b: Bounds): View {
  const span = v.end - v.start;
  const nextSpan = span * factor;
  const ratio = span > 0 ? (anchor - v.start) / span : 0.5;
  const start = anchor - ratio * nextSpan;
  return clampView({ start, end: start + nextSpan }, b);
}

export function panBy(v: View, deltaMs: number, b: Bounds): View {
  return clampView({ start: v.start + deltaMs, end: v.end + deltaMs }, b);
}

export function centerOn(t: number, span: number, b: Bounds): View {
  return clampView({ start: t - span / 2, end: t + span / 2 }, b);
}

export function timeToX(t: number, v: View, x0: number, w: number): number {
  return x0 + ((t - v.start) / (v.end - v.start)) * w;
}

export function xToTime(x: number, v: View, x0: number, w: number): number {
  return v.start + ((x - x0) / Math.max(1, w)) * (v.end - v.start);
}
