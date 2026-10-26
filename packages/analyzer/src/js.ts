import type { FunctionSummary, JsReport, LongTask, PerfEvent, TimerKind, TimerReport } from '@rnpa/shared';
import type { Ctx } from './context.js';
import { endOf, num, range, round, str } from './util.js';

const TIMER_KINDS: TimerKind[] = ['timeout', 'interval', 'raf', 'immediate'];

export function analyzeJs(ctx: Ctx): JsReport {
  const { by } = ctx;

  const longTasks: LongTask[] = by.LONG_TASK.map((e) => {
    const suspects = new Map<string, number>();
    const listed = Array.isArray(e.metadata.suspects) ? (e.metadata.suspects as unknown[]) : [];
    for (const s of listed) {
      const name = str((s as { name?: unknown })?.name);
      const duration = num((s as { duration?: unknown })?.duration);
      if (name && duration !== null) suspects.set(name, Math.max(suspects.get(name) ?? 0, duration));
    }
    // Functions measured inside the blocked window (explicit measures, profiles).
    for (const f of range(by.FUNCTION, e.ts - 2_000, endOf(e))) {
      if (endOf(f) <= e.ts) continue;
      const name = str(f.metadata.name);
      if (name) suspects.set(name, Math.max(suspects.get(name) ?? 0, f.duration ?? 0));
    }
    return {
      id: e.id,
      ts: e.ts,
      duration: e.duration ?? 0,
      screen: e.screen,
      suspects: [...suspects.entries()]
        .map(([name, duration]) => ({ name, duration: round(duration) }))
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5),
    };
  });

  const fnMap = new Map<string, FunctionSummary>();
  for (const e of by.FUNCTION) {
    const name = str(e.metadata.name) ?? 'anonymous';
    const origin = (['callback', 'measure', 'profile'].includes(str(e.metadata.origin) ?? '') ? e.metadata.origin : 'callback') as FunctionSummary['origin'];
    const key = `${origin}:${name}`;
    const d = e.duration ?? num(e.metadata.selfTime) ?? 0;
    const entry = fnMap.get(key) ?? { name, origin, count: 0, total: 0, max: 0, mean: 0, blockingHits: 0 };
    entry.count++;
    entry.total += d;
    entry.max = Math.max(entry.max, d);
    fnMap.set(key, entry);
  }
  const functions = [...fnMap.values()]
    .map((f) => ({ ...f, total: round(f.total), max: round(f.max), mean: round(f.total / f.count) }))
    .sort((a, b) => b.total - a.total);

  return {
    longTasks,
    blockedMs: round(longTasks.reduce((s, l) => s + l.duration, 0)),
    functions,
    timers: analyzeTimers(by.TIMER),
    profileImported: ctx.events.some((e) => e.source === 'profiler'),
  };
}

function analyzeTimers(events: PerfEvent[]): TimerReport {
  // Summaries carry cumulative counters per agent instance: keep the latest of each, then sum.
  const latest = new Map<string, PerfEvent>();
  const heavy = new Map<string, { name: string; kind: TimerKind; count: number; total: number; max: number }>();
  let late = 0;
  let maxLatenessMs = 0;
  let maxActiveIntervals = 0;

  for (const e of events) {
    const phase = str(e.metadata.phase);
    if (phase === 'summary') {
      latest.set(str(e.metadata.agentInstance) ?? '', e);
      maxActiveIntervals = Math.max(maxActiveIntervals, num(e.metadata.maxActiveIntervals) ?? 0);
    } else if (phase === 'fire') {
      const lateness = num(e.metadata.lateness) ?? 0;
      if (lateness >= 100) late++;
      maxLatenessMs = Math.max(maxLatenessMs, lateness);
      const kind = (TIMER_KINDS.includes(e.metadata.kind as TimerKind) ? e.metadata.kind : 'timeout') as TimerKind;
      const name = str(e.metadata.name) ?? 'anonymous';
      const d = e.duration ?? 0;
      if (d > 0) {
        const key = `${kind}:${name}`;
        const entry = heavy.get(key) ?? { name, kind, count: 0, total: 0, max: 0 };
        entry.count++;
        entry.total += d;
        entry.max = Math.max(entry.max, d);
        heavy.set(key, entry);
      }
    }
  }

  const created: TimerReport['created'] = {};
  const fired: TimerReport['fired'] = {};
  for (const e of latest.values()) {
    const counts = (e.metadata.counts ?? {}) as Record<string, unknown>;
    const fires = (e.metadata.fired ?? {}) as Record<string, unknown>;
    for (const kind of TIMER_KINDS) {
      const c = num(counts[kind]);
      const f = num(fires[kind]);
      if (c !== null) created[kind] = (created[kind] ?? 0) + c;
      if (f !== null) fired[kind] = (fired[kind] ?? 0) + f;
    }
  }

  return {
    created,
    fired,
    late,
    maxLatenessMs: round(maxLatenessMs),
    maxActiveIntervals,
    heavyCallbacks: [...heavy.values()]
      .map((h) => ({ ...h, total: round(h.total), max: round(h.max) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 50),
  };
}
