import type { EventType, PerfEvent, Stat } from '@rnpa/shared';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

export function stat(values: Iterable<number | null | undefined>): Stat | null {
  const list: number[] = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) list.push(v);
  if (list.length === 0) return null;
  list.sort((a, b) => a - b);
  const total = list.reduce((s, v) => s + v, 0);
  return {
    count: list.length,
    min: list[0] as number,
    max: list[list.length - 1] as number,
    mean: round(total / list.length),
    p50: round(percentile(list, 50)),
    p90: round(percentile(list, 90)),
    p95: round(percentile(list, 95)),
    total: round(total),
  };
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((s, v) => s + v, 0) / values.length);
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Index of the first element with ts >= value (array sorted by ts). */
export function lowerBound(events: PerfEvent[], ts: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid] as PerfEvent).ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element with ts > value (array sorted by ts). */
export function upperBound(events: PerfEvent[], ts: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid] as PerfEvent).ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Events with from <= ts < to. */
export function range(events: PerfEvent[], from: number, to: number): PerfEvent[] {
  const start = lowerBound(events, from);
  const end = lowerBound(events, to);
  return events.slice(start, end);
}

/** Last event with ts <= at, optionally matching a predicate. */
export function lastAtOrBefore(events: PerfEvent[], at: number, predicate?: (e: PerfEvent) => boolean): PerfEvent | null {
  for (let i = upperBound(events, at) - 1; i >= 0; i--) {
    const e = events[i] as PerfEvent;
    if (!predicate || predicate(e)) return e;
  }
  return null;
}

export function firstAtOrAfter(events: PerfEvent[], at: number, predicate?: (e: PerfEvent) => boolean): PerfEvent | null {
  for (let i = lowerBound(events, at); i < events.length; i++) {
    const e = events[i] as PerfEvent;
    if (!predicate || predicate(e)) return e;
  }
  return null;
}

/** Total length of the union of [start, end] intervals clipped to [from, to]. */
export function unionLength(intervals: [number, number][], from: number, to: number): number {
  const clipped = intervals
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of clipped) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) total += curE - curS;
  return total;
}

export type EventIndex = Record<EventType, PerfEvent[]>;

export function indexByType(events: PerfEvent[]): EventIndex {
  const index = {} as EventIndex;
  for (const e of events) (index[e.type] ||= []).push(e);
  return new Proxy(index, {
    get(target, key: string) {
      return (target as Record<string, PerfEvent[]>)[key] ?? [];
    },
  });
}

export function endOf(e: PerfEvent): number {
  return e.ts + (e.duration ?? 0);
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${round(ms / 1000, 2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtKb(kb: number): string {
  if (Math.abs(kb) >= 1024) return `${round(kb / 1024, 1)} MB`;
  return `${Math.round(kb)} KB`;
}
