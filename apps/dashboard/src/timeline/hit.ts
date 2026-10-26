/** Pure hit testing against the timeline model. */
import { lowerBound, nearestIndex } from '../charts/scale';
import { GUTTER_W, type Lane, type SeriesDef, type SeriesPt, type SpanItem, type TickItem, type TimelineModel } from './model';
import { timeToX, xToTime, type View } from './view';

export type HitResult =
  | { kind: 'span'; lane: Lane; span: SpanItem }
  | { kind: 'tick'; lane: Lane; tick: TickItem }
  | { kind: 'series'; lane: Lane; ts: number; series: { def: SeriesDef; pt: SeriesPt }[] };

const TOL_PX = 4;

export function hitTest(model: TimelineModel, tops: number[], view: View, width: number, x: number, y: number): HitResult | null {
  if (x < GUTTER_W) return null;
  const plotW = Math.max(1, width - GUTTER_W);
  const li = tops.findIndex((t, i) => y >= t && y < t + (model.lanes[i]?.height ?? 0));
  const lane = li >= 0 ? model.lanes[li] : undefined;
  const top = tops[li];
  if (!lane || top === undefined || lane.empty) return null;
  const ly = y - top;
  const t = xToTime(x, view, GUTTER_W, plotW);
  const tol = (TOL_PX / plotW) * (view.end - view.start);

  // Ticks
  if (lane.ticks.length && ly >= lane.tickTop - 4 && ly <= lane.tickTop + lane.tickH + 2) {
    const i = nearestIndex(lane.ticks, t, (k) => k.ts);
    let best: TickItem | null = null;
    let bestD = Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(lane.ticks.length - 1, i + 3); j++) {
      const k = lane.ticks[j];
      if (!k) continue;
      const d = Math.abs(timeToX(k.ts, view, GUTTER_W, plotW) - x);
      if (d <= TOL_PX + 2 && (d < bestD || (d === bestD && best && k.weight > best.weight))) {
        best = k;
        bestD = d;
      }
    }
    if (best) return { kind: 'tick', lane, tick: best };
  }

  // Spans
  if (lane.spans.length && ly >= lane.spanTop && ly < lane.spanTop + lane.spanRows * (lane.spanRowH + 2)) {
    const row = Math.floor((ly - lane.spanTop) / (lane.spanRowH + 2));
    const i0 = lowerBound(lane.spans, t - lane.maxSpanDur - tol, (s) => s.start);
    let best: SpanItem | null = null;
    for (let i = i0; i < lane.spans.length; i++) {
      const s = lane.spans[i];
      if (!s) continue;
      if (s.start > t + tol) break;
      if (s.row !== row) continue;
      if (s.start - tol <= t && t <= s.end + tol) {
        if (!best || s.end - s.start < best.end - best.start) best = s;
      }
    }
    if (best) return { kind: 'span', lane, span: best };
  }

  // Series (anywhere in the series band)
  if (lane.series.length && ly >= lane.seriesTop - 2 && ly <= lane.seriesTop + lane.seriesH + 2) {
    const rows: { def: SeriesDef; pt: SeriesPt }[] = [];
    for (const def of lane.series) {
      const i = nearestIndex(def.points, t, (p) => p.ts);
      const pt = def.points[i];
      if (pt && Math.abs(timeToX(pt.ts, view, GUTTER_W, plotW) - x) < 40) rows.push({ def, pt });
    }
    if (rows.length) return { kind: 'series', lane, ts: rows[0]?.pt.ts ?? t, series: rows };
  }
  return null;
}

export function hitKey(h: HitResult | null): string | null {
  if (!h) return null;
  if (h.kind === 'span') return `s:${h.span.key}`;
  if (h.kind === 'tick') return `t:${h.tick.key}`;
  return `p:${h.lane.id}:${h.ts}`;
}
