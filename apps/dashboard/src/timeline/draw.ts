/**
 * Canvas renderer. Draws only what intersects the view: spans/ticks are
 * found by binary search and coalesced per pixel, series are min/max
 * decimated per pixel column — so 100k+ events stay interactive.
 */
import { fmtTickOffset, lowerBound, timeStep, timeTicks } from '../charts/scale';
import type { HitResult } from './hit';
import { AXIS_H, GUTTER_W, type Lane, type TimelineModel } from './model';
import { timeToX, type View } from './view';

export type ColorFn = (cssColor: string) => string;

export interface DrawArgs {
  model: TimelineModel;
  tops: number[];
  view: View;
  width: number;
  height: number;
  color: ColorFn;
  font: string;
  hover: HitResult | null;
  hoverX: number | null;
  selectedId: string | null;
  highlight: ReadonlySet<string>;
  focusTs: number | null;
}

/** Pick black or white ink for text on a fill. */
export function inkOn(fill: string): string {
  let r = 128;
  let g = 128;
  let b = 128;
  const hex = /^#([0-9a-f]{6})$/i.exec(fill.trim());
  if (hex && hex[1]) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(fill);
    if (rgb) {
      r = Number(rgb[1]);
      g = Number(rgb[2]);
      b = Number(rgb[3]);
    }
  }
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#0b0b0b' : '#ffffff';
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 8) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  // Estimate then refine.
  let n = Math.max(1, Math.floor((maxW / Math.max(1, ctx.measureText(text).width)) * text.length));
  while (n > 1 && ctx.measureText(`${text.slice(0, n)}…`).width > maxW) n--;
  return n <= 1 ? '' : `${text.slice(0, n)}…`;
}

function isMarked(ids: string[], set: ReadonlySet<string>): boolean {
  if (set.size === 0) return false;
  for (const id of ids) if (set.has(id)) return true;
  return false;
}

export function drawTimeline(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  const { model, tops, view, width, height, color } = a;
  const plotX0 = GUTTER_W;
  const plotW = Math.max(1, width - GUTTER_W);
  const X = (t: number) => timeToX(t, view, plotX0, plotW);

  const surface = color('var(--surface-1)');
  const gutterBg = color('var(--surface-2)');
  const grid = color('var(--grid)');
  const border = color('var(--border-strong)');
  const textSecondary = color('var(--text-secondary)');
  const textMuted = color('var(--text-muted)');
  const textPrimary = color('var(--text-primary)');
  const accent = color('var(--accent)');

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  /* ---- axis + grid ---- */
  const target = Math.max(2, Math.floor(plotW / 110));
  const step = timeStep(view.end - view.start, target);
  const ticks = timeTicks(view.start, view.end, target, model.start);
  ctx.font = `11px ${a.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (const t of ticks) {
    const x = Math.round(X(t)) + 0.5;
    if (x < plotX0) continue;
    ctx.beginPath();
    ctx.moveTo(x, AXIS_H - 6);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillStyle = textMuted;
    ctx.fillText(fmtTickOffset(t - model.start, step), x, AXIS_H / 2 - 1);
  }
  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_H - 0.5);
  ctx.lineTo(width, AXIS_H - 0.5);
  ctx.stroke();

  /* ---- lanes ---- */
  model.lanes.forEach((lane, i) => {
    const top = tops[i] ?? 0;
    // gutter
    ctx.fillStyle = gutterBg;
    ctx.fillRect(0, top, GUTTER_W, lane.height);
    ctx.fillStyle = textSecondary;
    ctx.font = `600 11px ${a.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(lane.label, 10, top + 6);
    if (lane.series.length > 0) {
      ctx.font = `10px ${a.font}`;
      let ly = top + 21;
      for (const s of lane.series) {
        if (ly > top + lane.height - 8) break;
        ctx.fillStyle = color(s.color);
        ctx.fillRect(10, ly + 4, 10, 2);
        ctx.fillStyle = textMuted;
        ctx.fillText(s.label, 24, ly);
        ly += 12;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX0, top, plotW, lane.height);
    ctx.clip();

    if (lane.empty) {
      ctx.fillStyle = textMuted;
      ctx.font = `italic 11px ${a.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(lane.emptyHint, plotX0 + 10, top + lane.height / 2);
    } else {
      drawSeries(ctx, lane, top, a, X, plotX0, plotW);
      drawSpans(ctx, lane, top, a, X, plotX0, plotW, accent, textPrimary);
      drawTicks(ctx, lane, top, a, X, plotX0, accent, textPrimary);
    }
    ctx.restore();

    // separators
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(0, top + lane.height - 0.5);
    ctx.lineTo(width, top + lane.height - 0.5);
    ctx.stroke();
  });

  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(GUTTER_W - 0.5, 0);
  ctx.lineTo(GUTTER_W - 0.5, height);
  ctx.stroke();

  /* ---- focus marker (?t=) ---- */
  if (a.focusTs !== null) {
    const x = Math.round(X(a.focusTs)) + 0.5;
    if (x >= plotX0 && x <= width) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(x - 5, AXIS_H - 7);
      ctx.lineTo(x + 5, AXIS_H - 7);
      ctx.lineTo(x, AXIS_H);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ---- hover cursor ---- */
  if (a.hoverX !== null && a.hoverX >= plotX0) {
    const x = Math.round(a.hoverX) + 0.5;
    ctx.strokeStyle = textMuted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, AXIS_H);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  lane: Lane,
  top: number,
  a: DrawArgs,
  X: (t: number) => number,
  plotX0: number,
  plotW: number,
): void {
  if (lane.series.length === 0) return;
  const y0 = top + lane.seriesTop;
  const h = lane.seriesH;
  const Y = (v: number) => y0 + h - (Math.max(0, v) / lane.seriesMax) * h;

  if (lane.seriesRef !== null) {
    const y = Math.round(Y(lane.seriesRef)) + 0.5;
    ctx.strokeStyle = a.color('var(--axis)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX0, y);
    ctx.lineTo(plotX0 + plotW, y);
    ctx.stroke();
    ctx.fillStyle = a.color('var(--text-muted)');
    ctx.font = `10px ${a.font}`;
    ctx.textAlign = 'left';
    const nearTop = y - y0 < 12;
    ctx.textBaseline = nearTop ? 'top' : 'bottom';
    ctx.fillText(`${lane.seriesRef}`, plotX0 + 4, nearTop ? y + 2 : y - 1);
  }

  for (const s of lane.series) {
    const pts = s.points;
    if (pts.length === 0) continue;
    const i0 = Math.max(0, lowerBound(pts, a.view.start, (p) => p.ts) - 1);
    const i1 = Math.min(pts.length - 1, lowerBound(pts, a.view.end, (p) => p.ts));
    ctx.strokeStyle = a.color(s.color);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let col = NaN;
    let mn = 0;
    let mx = 0;
    let started = false;
    const flush = (c: number) => {
      if (!started) {
        ctx.moveTo(c, Y(mn));
        started = true;
      } else ctx.lineTo(c, Y(mn));
      if (mx !== mn) ctx.lineTo(c, Y(mx));
    };
    for (let i = i0; i <= i1; i++) {
      const p = pts[i];
      if (!p) continue;
      const c = Math.round(X(p.ts));
      if (c !== col) {
        if (!Number.isNaN(col)) flush(col);
        col = c;
        mn = p.value;
        mx = p.value;
      } else {
        mn = Math.min(mn, p.value);
        mx = Math.max(mx, p.value);
      }
    }
    if (!Number.isNaN(col)) flush(col);
    ctx.stroke();
  }

  // Hovered sample dots.
  if (a.hover?.kind === 'series' && a.hover.lane === lane) {
    for (const r of a.hover.series) {
      ctx.fillStyle = a.color('var(--surface-1)');
      ctx.beginPath();
      ctx.arc(X(r.pt.ts), Y(r.pt.value), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = a.color(r.def.color);
      ctx.beginPath();
      ctx.arc(X(r.pt.ts), Y(r.pt.value), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSpans(
  ctx: CanvasRenderingContext2D,
  lane: Lane,
  top: number,
  a: DrawArgs,
  X: (t: number) => number,
  plotX0: number,
  plotW: number,
  accent: string,
  textPrimary: string,
): void {
  const spans = lane.spans;
  if (spans.length === 0) return;
  const lastRight = new Float64Array(lane.spanRows).fill(-Infinity);
  const i0 = lowerBound(spans, a.view.start - lane.maxSpanDur, (s) => s.start);
  const xMax = plotX0 + plotW;
  ctx.font = `11px ${a.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const hoverKey = a.hover?.kind === 'span' ? a.hover.span.key : null;

  for (let i = i0; i < spans.length; i++) {
    const s = spans[i];
    if (!s) continue;
    if (s.start > a.view.end) break;
    if (s.end < a.view.start) continue;
    let x0 = X(s.start);
    let x1 = X(s.end);
    if (x1 < plotX0) continue;
    x0 = Math.max(plotX0 - 2, x0);
    x1 = Math.min(xMax + 2, x1);
    const row = Math.min(s.row, lane.spanRows - 1);
    const y = top + lane.spanTop + row * (lane.spanRowH + 2);
    const marked = isMarked(s.ids, a.highlight);
    const selected = a.selectedId !== null && s.ids.includes(a.selectedId);
    const hovered = hoverKey === s.key;
    const w = Math.max(1, x1 - x0);

    // Pixel coalescing for sub-pixel spans that overlap what's already drawn.
    if (!marked && !selected && !hovered && w < 2 && x1 <= (lastRight[row] ?? -Infinity) + 0.5) continue;
    lastRight[row] = Math.max(lastRight[row] ?? -Infinity, x1);

    const fill = a.color(s.color);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y, w > 3 ? w - 1 : w, lane.spanRowH);

    if (w > 40) {
      const label = truncate(ctx, s.label, w - 8);
      if (label) {
        ctx.fillStyle = inkOn(fill);
        ctx.fillText(label, Math.max(x0, plotX0) + 4, y + lane.spanRowH / 2 + 0.5);
      }
    }
    if (marked || selected || hovered) {
      ctx.lineWidth = selected || marked ? 2 : 1;
      ctx.strokeStyle = marked && !selected ? accent : textPrimary;
      ctx.strokeRect(x0 - 1, y - 1, Math.max(3, w + 1), lane.spanRowH + 2);
    }
  }
}

function drawTicks(
  ctx: CanvasRenderingContext2D,
  lane: Lane,
  top: number,
  a: DrawArgs,
  X: (t: number) => number,
  plotX0: number,
  accent: string,
  textPrimary: string,
): void {
  const ticks = lane.ticks;
  if (ticks.length === 0) return;
  const i0 = lowerBound(ticks, a.view.start, (t) => t.ts);
  const base = top + lane.tickTop + lane.tickH;
  let lastPx = -Infinity;
  let lastWeight = 0;
  const hoverKey = a.hover?.kind === 'tick' ? a.hover.tick.key : null;
  for (let i = i0; i < ticks.length; i++) {
    const t = ticks[i];
    if (!t) continue;
    if (t.ts > a.view.end) break;
    const x = X(t.ts);
    if (x < plotX0) continue;
    const px = Math.round(x);
    const marked = isMarked(t.ids, a.highlight);
    const selected = a.selectedId !== null && t.ids.includes(a.selectedId);
    const hovered = hoverKey === t.key;
    if (px === lastPx && t.weight <= lastWeight && !marked && !selected && !hovered) continue;
    lastPx = px;
    lastWeight = t.weight;
    const h = Math.max(4, lane.tickH * t.weight);
    const col = a.color(t.color);
    ctx.fillStyle = col;
    ctx.fillRect(px - 0.75, base - h, 1.5, h);
    if (t.weight >= 0.8) {
      ctx.beginPath();
      ctx.arc(px, base - h + 2.5, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (marked || selected || hovered) {
      ctx.strokeStyle = marked && !selected ? accent : textPrimary;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, base - h + 2.5, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
