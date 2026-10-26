/**
 * Pure: turns a flat PerfEvent list into lanes of drawable items, sorted for
 * binary-search culling. No DOM access here (unit-testable).
 */
import type { PerfEvent } from '@rnpa/shared';
import { httpTone, TONE_VAR } from '../lib/colors';
import { urlPath as urlPathRaw } from '../lib/format';

export interface SpanItem {
  key: string;
  start: number;
  end: number;
  row: number;
  label: string;
  color: string;
  /** Primary event shown when selected. */
  ev: PerfEvent;
  /** All event ids this item represents (for evidence highlighting). */
  ids: string[];
}

export interface TickItem {
  key: string;
  ts: number;
  label: string;
  color: string;
  /** Relative height 0..1 of the tick band. */
  weight: number;
  ev: PerfEvent;
  ids: string[];
}

export interface SeriesPt {
  ts: number;
  value: number;
  ev: PerfEvent;
}

export interface SeriesDef {
  id: string;
  label: string;
  color: string;
  points: SeriesPt[];
  format: (v: number) => string;
}

export interface Lane {
  id: string;
  label: string;
  height: number;
  /** Span rows (y offsets relative to lane top). */
  spans: SpanItem[];
  spanRows: number;
  spanTop: number;
  spanRowH: number;
  maxSpanDur: number;
  ticks: TickItem[];
  tickTop: number;
  tickH: number;
  series: SeriesDef[];
  seriesTop: number;
  seriesH: number;
  /** Shared max for all series in the lane (min is 0). */
  seriesMax: number;
  /** Optional reference value drawn as a hairline (e.g. 60 fps). */
  seriesRef: number | null;
  empty: boolean;
  emptyHint: string;
}

export interface TimelineModel {
  lanes: Lane[];
  start: number;
  end: number;
  byId: Map<string, PerfEvent>;
  count: number;
}

/* ------------------------------- metadata ------------------------------- */

function meta(ev: PerfEvent): Record<string, unknown> {
  const m: unknown = ev.metadata;
  return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
export function mNum(ev: PerfEvent, key: string): number | null {
  const v = meta(ev)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function mStr(ev: PerfEvent, key: string): string | null {
  const v = meta(ev)[key];
  return typeof v === 'string' ? v : null;
}

/* ------------------------------- helpers -------------------------------- */

const SCREEN_SLOTS = ['var(--series-1)', 'var(--series-3)', 'var(--series-7)', 'var(--series-5)', 'var(--series-6)', 'var(--series-4)', 'var(--series-2)'];

function packRows(spans: SpanItem[], maxRows: number): number {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const rowEnds: number[] = [];
  for (const s of spans) {
    let placed = -1;
    for (let r = 0; r < rowEnds.length; r++) {
      const re = rowEnds[r];
      if (re !== undefined && re <= s.start) {
        placed = r;
        break;
      }
    }
    if (placed === -1) {
      if (rowEnds.length < maxRows) {
        placed = rowEnds.length;
        rowEnds.push(s.end);
      } else {
        // Overflow: reuse the row that frees up first.
        let best = 0;
        for (let r = 1; r < rowEnds.length; r++) if ((rowEnds[r] ?? Infinity) < (rowEnds[best] ?? Infinity)) best = r;
        placed = best;
      }
    }
    rowEnds[placed] = Math.max(rowEnds[placed] ?? 0, s.end);
    s.row = placed;
  }
  return Math.max(1, rowEnds.length);
}

function maxDur(spans: SpanItem[]): number {
  let m = 0;
  for (const s of spans) m = Math.max(m, s.end - s.start);
  return m;
}

function lane(id: string, label: string, emptyHint: string): Lane {
  return {
    id,
    label,
    height: 0,
    spans: [],
    spanRows: 0,
    spanTop: 0,
    spanRowH: 0,
    maxSpanDur: 0,
    ticks: [],
    tickTop: 0,
    tickH: 0,
    series: [],
    seriesTop: 0,
    seriesH: 0,
    seriesMax: 1,
    seriesRef: null,
    empty: true,
    emptyHint,
  };
}

/** Stack the bands of a lane vertically and compute its height. */
function finalizeLane(l: Lane, opts: { spanRowH?: number; maxRows?: number; tickH?: number; seriesH?: number }): Lane {
  const PAD = 4;
  let y = PAD;
  if (l.series.length) {
    l.seriesTop = y;
    l.seriesH = opts.seriesH ?? 36;
    y += l.seriesH + 2;
    let max = 0;
    for (const s of l.series) for (const p of s.points) max = Math.max(max, p.value);
    if (l.seriesRef !== null) max = Math.max(max, l.seriesRef);
    l.seriesMax = max > 0 ? max * 1.08 : 1;
  }
  if (l.spans.length || opts.spanRowH) {
    l.spanRowH = opts.spanRowH ?? 14;
    l.spanRows = l.spans.length ? packRows(l.spans, opts.maxRows ?? 6) : 1;
    l.spanTop = y;
    y += l.spanRows * (l.spanRowH + 2);
    l.maxSpanDur = maxDur(l.spans);
    // Re-sort by start for culling (packRows sorts already).
  }
  if (l.ticks.length || opts.tickH) {
    l.ticks.sort((a, b) => a.ts - b.ts);
    l.tickTop = y;
    l.tickH = opts.tickH ?? 14;
    y += l.tickH;
  }
  for (const s of l.series) s.points.sort((a, b) => a.ts - b.ts);
  l.height = Math.max(26, y + PAD, l.series.length ? 22 + l.series.length * 12 + 4 : 0);
  l.empty = l.spans.length === 0 && l.ticks.length === 0 && l.series.every((s) => s.points.length === 0);
  return l;
}

const fmtKbShort = (v: number) => (v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(2)} GB` : v >= 1024 ? `${(v / 1024).toFixed(1)} MB` : `${Math.round(v)} KB`);
const fmtPctShort = (v: number) => `${v.toFixed(1)}%`;
const fmtFpsShort = (v: number) => `${v.toFixed(1)} fps`;

/* -------------------------------- build --------------------------------- */

const urlCache = new Map<string, string>();
function urlPath(raw: string): string {
  let v = urlCache.get(raw);
  if (v === undefined) {
    v = urlPathRaw(raw);
    if (urlCache.size > 20_000) urlCache.clear();
    urlCache.set(raw, v);
  }
  return v;
}

const MAX_SPAN_MS = 10 * 60 * 1000;

export function buildTimelineModel(events: readonly PerfEvent[]): TimelineModel {
  const byId = new Map<string, PerfEvent>();
  const sorted: PerfEvent[] = [];
  for (const e of events) {
    if (!e || typeof e.ts !== 'number' || !Number.isFinite(e.ts) || byId.has(e.id)) continue;
    byId.set(e.id, e);
    sorted.push(e);
  }
  sorted.sort((a, b) => a.ts - b.ts);

  let start = Infinity;
  let end = -Infinity;
  for (const e of sorted) {
    start = Math.min(start, e.ts);
    // Clamp spans so a single corrupt duration cannot stretch the whole view.
    const d = Math.min(e.duration ?? 0, MAX_SPAN_MS);
    end = Math.max(end, e.type === 'API_END' ? e.ts : e.ts + (Number.isFinite(d) ? d : 0));
  }
  if (!Number.isFinite(start)) {
    start = Date.now();
    end = start + 1000;
  }
  if (end - start < 100) end = start + 100;

  const screens = lane('screens', 'Screens', 'No navigation events (needs the agent)');
  const actions = lane('actions', 'User actions', 'No user actions recorded');
  const network = lane('network', 'Network', 'No API calls (needs the agent)');
  const js = lane('js', 'JS thread', 'No JS samples (agent or profile import)');
  const rendering = lane('rendering', 'Rendering', 'No FPS/render data');
  const memory = lane('memory', 'Memory', 'No memory samples');
  const cpu = lane('cpu', 'CPU', 'No CPU samples');
  const lifecycle = lane('lifecycle', 'Lifecycle', 'No lifecycle events');

  const screenColor = new Map<string, string>();
  const colorForScreen = (name: string) => {
    let c = screenColor.get(name);
    if (!c) {
      c = SCREEN_SLOTS[screenColor.size] ?? 'var(--series-other)';
      screenColor.set(name, c);
    }
    return c;
  };

  const apiStarts = new Map<string, PerfEvent>();
  const apiEnded = new Set<string>();
  const enters: PerfEvent[] = [];

  const fpsUi: SeriesPt[] = [];
  const fpsJs: SeriesPt[] = [];
  const pss: SeriesPt[] = [];
  const jsHeap: SeriesPt[] = [];
  const cpuTotal: SeriesPt[] = [];
  const cpuUi: SeriesPt[] = [];
  const cpuJs: SeriesPt[] = [];

  const tick = (l: Lane, ev: PerfEvent, label: string, color: string, weight = 1) =>
    l.ticks.push({ key: ev.id, ts: ev.ts, label, color, weight, ev, ids: [ev.id] });
  const span = (l: Lane, ev: PerfEvent, s: number, e: number, label: string, color: string, ids = [ev.id]) =>
    l.spans.push({ key: ev.id, start: s, end: Math.max(e, s), row: 0, label, color, ev, ids });

  for (const ev of sorted) {
    switch (ev.type) {
      case 'SCREEN_ENTER':
        enters.push(ev);
        break;
      case 'SCREEN_RENDER':
        tick(screens, ev, `Rendered ${ev.screen ?? ''}`.trim(), 'var(--text-muted)', 0.5);
        break;
      case 'SCREEN_READY':
        tick(screens, ev, `Ready ${ev.screen ?? ''}${mStr(ev, 'reason') ? ` (${mStr(ev, 'reason')})` : ''}`.trim(), 'var(--good)', 1);
        break;
      case 'USER_ACTION': {
        const kind = mStr(ev, 'kind') ?? 'action';
        const label = mStr(ev, 'label');
        tick(actions, ev, label ? `${kind}: ${label}` : kind, 'var(--series-2)', 1);
        break;
      }
      case 'API_START': {
        const rid = mStr(ev, 'requestId');
        if (rid) apiStarts.set(rid, ev);
        break;
      }
      case 'API_END': {
        const rid = mStr(ev, 'requestId');
        const st = rid ? apiStarts.get(rid) : undefined;
        if (rid) apiEnded.add(rid);
        const dur = ev.duration ?? (st ? ev.ts - st.ts : 0);
        const s = st ? st.ts : ev.ts - Math.max(0, dur);
        const status = mNum(ev, 'status');
        const err = mStr(ev, 'error');
        const label = `${mStr(ev, 'method') ?? ''} ${urlPath(mStr(ev, 'url') ?? '')}`.trim();
        span(network, ev, s, ev.ts, `${status ?? (err ? 'ERR' : '')} ${label}`.trim(), TONE_VAR[httpTone(status, err)], st ? [st.id, ev.id] : [ev.id]);
        break;
      }
      case 'LONG_TASK':
        span(js, ev, ev.ts, ev.ts + (ev.duration ?? 0), `Long task`, 'var(--serious)');
        break;
      case 'FUNCTION':
        span(js, ev, ev.ts, ev.ts + (ev.duration ?? 0), mStr(ev, 'name') ?? 'function', 'var(--series-4)');
        break;
      case 'TIMER':
        if (mStr(ev, 'phase') === 'fire')
          span(js, ev, ev.ts, ev.ts + (ev.duration ?? 0), `${mStr(ev, 'kind') ?? 'timer'} ${mStr(ev, 'name') ?? ''}`.trim(), 'var(--series-7)');
        break;
      case 'RENDER': {
        const n = mNum(ev, 'totalComponents');
        tick(rendering, ev, `Commit${n !== null ? ` · ${n} components` : ''}`, 'var(--series-5)', 0.45);
        break;
      }
      case 'FRAME_DROP': {
        const n = mNum(ev, 'droppedFrames');
        tick(rendering, ev, `${n ?? '?'} dropped frames (${mStr(ev, 'thread') ?? '?'})`, 'var(--critical)', 1);
        break;
      }
      case 'FPS': {
        const fps = mNum(ev, 'fps');
        if (fps === null) break;
        (mStr(ev, 'thread') === 'js' ? fpsJs : fpsUi).push({ ts: ev.ts, value: fps, ev });
        break;
      }
      case 'MEMORY': {
        const p = mNum(ev, 'totalPssKb');
        if (p !== null) pss.push({ ts: ev.ts, value: p, ev });
        const j = mNum(ev, 'jsHeapKb');
        if (j !== null) jsHeap.push({ ts: ev.ts, value: j, ev });
        break;
      }
      case 'CPU': {
        const t = mNum(ev, 'total');
        if (t !== null) cpuTotal.push({ ts: ev.ts, value: t, ev });
        const u = mNum(ev, 'ui');
        if (u !== null) cpuUi.push({ ts: ev.ts, value: u, ev });
        const j = mNum(ev, 'js');
        if (j !== null) cpuJs.push({ ts: ev.ts, value: j, ev });
        break;
      }
      case 'STARTUP': {
        const total = ev.duration ?? mNum(ev, 'totalTime');
        const kind = mStr(ev, 'kind') ?? 'startup';
        if (total !== null && total > 0) span(lifecycle, ev, ev.ts, ev.ts + total, `${kind} start · TTID`, 'var(--series-7)');
        else tick(lifecycle, ev, `${kind} start`, 'var(--series-7)', 1);
        break;
      }
      case 'CRASH':
        tick(lifecycle, ev, `Crash: ${mStr(ev, 'message') ?? ''}`, 'var(--critical)', 1);
        break;
      case 'ERROR':
        tick(lifecycle, ev, `Error: ${mStr(ev, 'message') ?? ''}`, 'var(--critical)', 0.8);
        break;
      case 'MARK':
        tick(lifecycle, ev, `Mark: ${mStr(ev, 'name') ?? mStr(ev, 'label') ?? ''}`, 'var(--text-secondary)', 1);
        break;
      case 'APP_STATE':
        tick(lifecycle, ev, `App state: ${mStr(ev, 'state') ?? ''}`, 'var(--text-muted)', 0.6);
        break;
      case 'APP_START':
      case 'JS_INIT':
      case 'FIRST_RENDER':
      case 'APP_READY':
        tick(lifecycle, ev, ev.type.replace('_', ' ').toLowerCase(), 'var(--series-7)', 0.8);
        break;
      default:
        break;
    }
  }

  // Unmatched API starts → open spans to the end of the window.
  for (const [rid, st] of apiStarts) {
    if (apiEnded.has(rid)) continue;
    span(network, st, st.ts, end, `pending ${mStr(st, 'method') ?? ''} ${urlPath(mStr(st, 'url') ?? '')}`.trim(), TONE_VAR.neutral);
  }

  // Screen visits: enter → next enter.
  for (let i = 0; i < enters.length; i++) {
    const ev = enters[i];
    if (!ev) continue;
    const next = enters[i + 1];
    const name = ev.screen ?? 'unknown';
    span(screens, ev, ev.ts, next ? next.ts : end, name, colorForScreen(name));
  }

  if (fpsUi.length) rendering.series.push({ id: 'fps-ui', label: 'UI fps', color: 'var(--series-1)', points: fpsUi, format: fmtFpsShort });
  if (fpsJs.length) rendering.series.push({ id: 'fps-js', label: 'JS fps', color: 'var(--series-2)', points: fpsJs, format: fmtFpsShort });
  if (fpsUi.length || fpsJs.length) rendering.seriesRef = 60;
  if (pss.length) memory.series.push({ id: 'pss', label: 'PSS', color: 'var(--series-1)', points: pss, format: fmtKbShort });
  if (jsHeap.length) memory.series.push({ id: 'jsheap', label: 'JS heap', color: 'var(--series-2)', points: jsHeap, format: fmtKbShort });
  if (cpuTotal.length) cpu.series.push({ id: 'cpu', label: 'Total', color: 'var(--series-1)', points: cpuTotal, format: fmtPctShort });
  if (cpuUi.length) cpu.series.push({ id: 'cpu-ui', label: 'UI thread', color: 'var(--series-2)', points: cpuUi, format: fmtPctShort });
  if (cpuJs.length) cpu.series.push({ id: 'cpu-js', label: 'JS thread', color: 'var(--series-3)', points: cpuJs, format: fmtPctShort });

  const lanes = [
    finalizeLane(screens, { spanRowH: 18, maxRows: 1, tickH: 8 }),
    finalizeLane(actions, { tickH: 18 }),
    finalizeLane(network, { spanRowH: 12, maxRows: 8 }),
    finalizeLane(js, { spanRowH: 12, maxRows: 6 }),
    finalizeLane(rendering, { seriesH: 30, tickH: 14 }),
    finalizeLane(memory, { seriesH: 38 }),
    finalizeLane(cpu, { seriesH: 38 }),
    finalizeLane(lifecycle, { spanRowH: 12, maxRows: 2, tickH: 16 }),
  ];

  return { lanes, start, end, byId, count: sorted.length };
}

/* ----------------------------- lane geometry ---------------------------- */

export const AXIS_H = 26;
export const GUTTER_W = 118;

export function laneTops(model: TimelineModel): number[] {
  const tops: number[] = [];
  let y = AXIS_H;
  for (const l of model.lanes) {
    tops.push(y);
    y += l.height;
  }
  return tops;
}

export function totalHeight(model: TimelineModel): number {
  return AXIS_H + model.lanes.reduce((a, l) => a + l.height, 0);
}
