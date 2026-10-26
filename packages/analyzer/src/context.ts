import type { ApiCall, PerfEvent, ScreenVisit } from '@rnpa/shared';
import type { AnalyzerOptions } from './options.js';
import { type EventIndex, indexByType } from './util.js';

const MAX_SPAN_MS = 10 * 60 * 1000;

export interface Ctx {
  events: PerfEvent[];
  by: EventIndex;
  options: AnalyzerOptions;
  start: number;
  end: number;
  /** Filled by the network pass, used by later passes. */
  calls: ApiCall[];
  /** Filled by the navigation pass. */
  visits: ScreenVisit[];
  /** Device-side memory samples (origin=device), sorted. */
  deviceMemory: PerfEvent[];
  derived: PerfEvent[];
}

export function createContext(events: PerfEvent[], options: AnalyzerOptions): Ctx {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const by = indexByType(sorted);
  const start = sorted.length > 0 ? (sorted[0] as PerfEvent).ts : 0;
  let end = start;
  // Durations only extend the window when plausible; a corrupt span must not stretch it for hours.
  for (const e of sorted) end = Math.max(end, e.ts + Math.min(e.duration ?? 0, MAX_SPAN_MS));
  return {
    events: sorted,
    by,
    options,
    start,
    end,
    calls: [],
    visits: [],
    deviceMemory: by.MEMORY.filter((e) => e.metadata.origin === 'device'),
    derived: [],
  };
}

/** Key that pairs API_START/API_END across app restarts (request ids reset per JS runtime). */
export function requestKey(e: PerfEvent): string {
  const instance = typeof e.metadata.agentInstance === 'string' ? e.metadata.agentInstance : '';
  return `${instance}:${String(e.metadata.requestId ?? e.id)}`;
}

/** Index of the visit active at `ts`, or null. Visits are sorted by enterTs. */
export function visitAt(visits: ScreenVisit[], ts: number): number | null {
  let lo = 0;
  let hi = visits.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = visits[mid] as ScreenVisit;
    if (v.enterTs <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === null) return null;
  const v = visits[found] as ScreenVisit;
  return v.leaveTs === null || ts < v.leaveTs ? found : null;
}
