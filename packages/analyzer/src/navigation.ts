import type { ApiCall, NavigationReport, PerfEvent, ScreenSummary, ScreenVisit } from '@rnpa/shared';
import type { Ctx } from './context.js';
import { BUDGETS } from './options.js';
import { scoreValue } from './score.js';
import { endOf, lastAtOrBefore, mean, num, range, round, stat, str, unionLength } from './util.js';

/**
 * Builds screen visits from SCREEN_ENTER events and computes per-visit
 * first render, transition time and time-to-interactive.
 *
 * Derived TTI: starting at the screen's first render, the ready point is
 * pushed forward while, within `ttiQuietMs`, a request is still in flight or
 * starts, a React commit lands, or a long task blocks the JS thread. The first
 * quiet window ends the search. An explicit SCREEN_READY from the app wins.
 */
export function analyzeNavigation(ctx: Ctx): NavigationReport {
  const { by, options } = ctx;
  const enters: PerfEvent[] = [];
  for (const e of by.SCREEN_ENTER) {
    const prev = enters[enters.length - 1];
    const key = str(e.metadata.key);
    if (prev && prev.screen === e.screen && str(prev.metadata.key) === key) continue;
    enters.push(e);
  }

  const visits: ScreenVisit[] = [];
  enters.forEach((enter, index) => {
    const next = enters[index + 1];
    const screen = enter.screen ?? str(enter.metadata.screen) ?? 'unknown';
    const enterTs = enter.ts;
    const leaveTs = next ? next.ts : null;
    const limit = leaveTs ?? ctx.end;

    const renderEvent = range(by.SCREEN_RENDER, enterTs, limit)[0] ?? null;
    const renderTs = renderEvent ? renderEvent.ts : null;
    const firstRender = renderTs !== null ? round(renderTs - enterTs) : null;

    const action = lastAtOrBefore(by.USER_ACTION, enterTs, (a) => a.ts >= enterTs - options.transitionLookbackMs);
    const transition = action ? round((renderTs ?? enterTs) - action.ts) : null;

    // TTI
    let tti: number | null = null;
    let ttiReason: ScreenVisit['ttiReason'] = null;
    const explicit = range(by.SCREEN_READY, enterTs, limit).find((r) => {
      const named = str(r.metadata.screen);
      return named === null || named === screen;
    });
    const visitCalls = ctx.calls.filter((c) => c.start >= enterTs - 50 && c.start < limit);
    const commits = range(by.RENDER, enterTs, limit);
    const longTasks = range(by.LONG_TASK, enterTs, limit);
    if (explicit) {
      tti = round(explicit.ts - enterTs);
      ttiReason = 'explicit';
    } else if (renderTs !== null || commits.length > 0) {
      const deadline = Math.min(limit, enterTs + options.ttiMaxMs);
      const candidate = deriveReady(renderTs ?? (commits[0] as PerfEvent).ts, deadline, visitCalls, commits, longTasks, options.ttiQuietMs);
      tti = round(candidate - enterTs);
      ttiReason = 'derived';
      ctx.derived.push({
        id: `derived-ready-${index}`,
        ts: candidate,
        type: 'SCREEN_READY',
        screen,
        duration: null,
        source: 'analyzer',
        metadata: { reason: 'derived', screen, tti },
      });
    }

    const readyTs = tti !== null ? enterTs + tti : limit;
    const networkIntervals = visitCalls
      .filter((c) => c.start < readyTs)
      .map((c) => [c.start, c.end ?? readyTs] as [number, number]);
    const networkTime = networkIntervals.length > 0 ? round(Math.max(...networkIntervals.map(([, e]) => Math.min(e, readyTs))) - enterTs) : null;

    const frameDrops = range(by.FRAME_DROP, enterTs, limit);
    const uiDrops = frameDrops.filter((f) => f.metadata.thread === 'ui');
    const dropsForVisit = uiDrops.length > 0 ? uiDrops : frameDrops;
    const memStart = memoryAt(ctx.deviceMemory, enterTs);
    const memEnd = memoryAt(ctx.deviceMemory, limit);
    const cpu = range(by.CPU, enterTs, limit).map((c) => num(c.metadata.total)).filter((v): v is number => v !== null);

    let breakdown: ScreenVisit['breakdown'] = null;
    if (tti !== null && tti > 0) {
      const network = unionLength(networkIntervals, enterTs, readyTs);
      const js = unionLength(
        longTasks.map((l) => [l.ts, endOf(l)] as [number, number]),
        enterTs,
        readyTs,
      );
      const render = Math.min(
        tti,
        commits.filter((c) => c.ts < readyTs).reduce((s, c) => s + (c.duration ?? 0), 0),
      );
      const other = Math.max(0, tti - network - js - render);
      breakdown = { network: round(network), js: round(js), render: round(render), other: round(other) };
    }

    visits.push({
      index,
      screen,
      key: str(enter.metadata.key),
      enterTs,
      leaveTs,
      transition,
      firstRender,
      tti,
      ttiReason,
      apiCount: visitCalls.length,
      networkTime,
      longTasks: longTasks.length,
      longTaskTime: round(longTasks.reduce((s, l) => s + (l.duration ?? 0), 0)),
      droppedFrames: dropsForVisit.reduce((s, f) => s + (num(f.metadata.droppedFrames) ?? 0), 0),
      commits: commits.reduce((s, c) => s + (num(c.metadata.commit) ?? 1), 0),
      componentRenders: commits.reduce((s, c) => s + (num(c.metadata.totalComponents) ?? 0), 0),
      memoryDeltaKb: memStart !== null && memEnd !== null ? memEnd - memStart : null,
      cpuAvg: mean(cpu),
      breakdown,
    });
  });

  ctx.visits = visits;

  const byScreen = new Map<string, ScreenVisit[]>();
  for (const v of visits) {
    const list = byScreen.get(v.screen);
    if (list) list.push(v);
    else byScreen.set(v.screen, [v]);
  }
  const screens: ScreenSummary[] = [...byScreen.entries()].map(([screen, list]) => {
    const tti = stat(list.map((v) => v.tti));
    return {
      screen,
      visits: list.length,
      tti,
      firstRender: stat(list.map((v) => v.firstRender)),
      transition: stat(list.map((v) => v.transition)),
      apiCalls: list.reduce((s, v) => s + v.apiCount, 0),
      droppedFrames: list.reduce((s, v) => s + v.droppedFrames, 0),
      longTaskTime: round(list.reduce((s, v) => s + v.longTaskTime, 0)),
      memoryDeltaKb: stat(list.map((v) => v.memoryDeltaKb)),
      score: tti ? scoreValue(tti.p50, BUDGETS.screenTti) : null,
    };
  });
  screens.sort((a, b) => (b.tti?.p50 ?? 0) - (a.tti?.p50 ?? 0));

  return { visits, screens };
}

/**
 * Pushes a ready candidate forward while, within `quietMs`, a request is in
 * flight or starts, a commit lands, or a long task blocks the JS thread.
 */
export function deriveReady(
  start: number,
  deadline: number,
  calls: ApiCall[],
  commits: PerfEvent[],
  longTasks: PerfEvent[],
  quietMs: number,
): number {
  let candidate = start;
  for (let i = 0; i < 1000 && candidate < deadline; i++) {
    let next = candidate;
    const horizon = candidate + quietMs;
    for (const c of calls) {
      if (c.start <= horizon) {
        const end = c.end ?? deadline;
        if (end > next) next = end;
      }
    }
    for (const commit of commits) {
      if (commit.ts > candidate && commit.ts <= horizon) next = Math.max(next, endOf(commit));
    }
    for (const lt of longTasks) {
      if (lt.ts <= horizon && endOf(lt) > next) next = endOf(lt);
    }
    if (next <= candidate) break;
    candidate = Math.min(next, deadline);
  }
  return candidate;
}

/** Total PSS (KB) at a point in time from device memory samples. */
export function memoryAt(samples: PerfEvent[], ts: number): number | null {
  const before = lastAtOrBefore(samples, ts);
  const value = before ? num(before.metadata.totalPssKb) : null;
  if (value !== null) return value;
  const after = samples.find((s) => s.ts >= ts && s.ts - ts < 5000);
  return after ? num(after.metadata.totalPssKb) : null;
}
