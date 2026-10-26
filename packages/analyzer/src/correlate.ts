import type { Correlation, FrameDrop, FunctionSummary, JsReport, PerfEvent, RenderingReport } from '@rnpa/shared';
import type { Ctx } from './context.js';
import { endOf, fmtKb, fmtMs, num, range, str } from './util.js';

/** Device frame timestamps are aligned via adb round-trips; allow this much slack. */
const UI_CLOCK_SLACK_MS = 50;
const MAX_CORRELATIONS_PER_KIND = 100;

/**
 * Cross-signal correlation on the unified timeline:
 *  - api-render-tti:      which requests and renders a screen's TTI waited on
 *  - function-frame-drop: JS work overlapping dropped frames
 *  - timer-js-block:      timer/interval callbacks inside long tasks
 *  - memory-navigation:   large memory jumps attributed to screen transitions
 * Also annotates FrameDrop.culprits and FunctionSummary.blockingHits in place.
 */
export function correlate(ctx: Ctx, js: JsReport, rendering: RenderingReport): Correlation[] {
  const { by } = ctx;
  const out: Correlation[] = [];
  const fnByName = new Map<string, FunctionSummary>();
  for (const f of js.functions) fnByName.set(f.name, f);

  // API → render → TTI
  const apiTti: Correlation[] = [];
  for (const v of ctx.visits) {
    const tti = v.tti;
    if (tti === null || tti < 300 || v.apiCount === 0) continue;
    const calls = ctx.calls.filter((c) => c.visitIndex === v.index && c.start < v.enterTs + tti);
    if (calls.length === 0) continue;
    const slowest = calls.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
    const lastEnd = Math.max(...calls.map((c) => c.end ?? c.start));
    const renderAfter = range(by.RENDER, lastEnd, v.enterTs + tti + 1)[0];
    const networkShare = v.breakdown ? Math.round((v.breakdown.network / tti) * 100) : null;
    const parts = [
      `${v.screen}: interactive after ${fmtMs(tti)}`,
      `${calls.length} request${calls.length > 1 ? 's' : ''} on the critical path${networkShare !== null ? ` (${networkShare}% of TTI)` : ''}`,
      `slowest ${slowest.endpoint} ${fmtMs(slowest.duration ?? 0)}`,
    ];
    if (renderAfter) parts.push(`render committed ${fmtMs(renderAfter.ts - lastEnd)} after the last response`);
    apiTti.push({
      kind: 'api-render-tti',
      ts: v.enterTs,
      screen: v.screen,
      summary: parts.join('; '),
      eventIds: calls.map((c) => c.requestId).slice(0, 20),
    });
  }
  out.push(...apiTti.sort((a, b) => b.ts - a.ts).slice(0, MAX_CORRELATIONS_PER_KIND));

  // Function / long task / render → frame drops
  const frameCorrelations: Correlation[] = [];
  const dropSize = new Map<Correlation, number>();
  const dropEvents = new Map<string, PerfEvent>();
  for (const e of by.FRAME_DROP) dropEvents.set(e.id, e);
  for (const drop of rendering.frameDrops) {
    const event = dropEvents.get(drop.id);
    const slack = drop.thread === 'ui' ? UI_CLOCK_SLACK_MS : 0;
    const from = drop.ts - slack;
    const to = (event ? endOf(event) : drop.ts + drop.droppedFrames * 16.7) + slack;
    const overlaps = (e: PerfEvent) => e.ts < to && endOf(e) > from;
    const blame = new Map<string, number>();
    const add = (name: string, e: PerfEvent) => {
      const overlap = Math.min(endOf(e), to) - Math.max(e.ts, from);
      blame.set(name, (blame.get(name) ?? 0) + Math.max(0, overlap));
    };
    for (const f of range(by.FUNCTION, from - 5_000, to)) {
      if (!overlaps(f)) continue;
      const name = str(f.metadata.name) ?? 'anonymous';
      add(name, f);
      const summary = fnByName.get(name);
      if (summary) summary.blockingHits++;
    }
    for (const l of range(by.LONG_TASK, from - 30_000, to)) if (overlaps(l)) add('Long JS task', l);
    for (const r of range(by.RENDER, from - 5_000, to)) {
      if (overlaps(r) && (r.duration ?? 0) > 0) add(`React commit (${num(r.metadata.totalComponents) ?? '?'} components)`, r);
    }
    drop.culprits = [...blame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
    if (drop.culprits.length > 0) {
      const correlation = frameDropCorrelation(drop);
      dropSize.set(correlation, drop.droppedFrames);
      frameCorrelations.push(correlation);
    }
  }
  out.push(
    ...frameCorrelations
      .sort((a, b) => (dropSize.get(b) ?? 0) - (dropSize.get(a) ?? 0) || a.ts - b.ts)
      .slice(0, MAX_CORRELATIONS_PER_KIND),
  );

  // Timers → JS blocking
  const timerBlocks: Correlation[] = [];
  for (const task of js.longTasks) {
    const end = task.ts + task.duration;
    const timerCallbacks = range(by.FUNCTION, task.ts - 5_000, end).filter(
      (f) => typeof f.metadata.timer === 'string' && endOf(f) > task.ts - 60,
    );
    const timerFires = range(by.TIMER, task.ts - 5_000, end).filter((t) => t.metadata.phase === 'fire' && endOf(t) > task.ts - 60);
    const names = new Set<string>();
    for (const f of timerCallbacks) names.add(`${str(f.metadata.timer)}:${str(f.metadata.name) ?? 'anonymous'}`);
    for (const t of timerFires) names.add(`${str(t.metadata.kind)}:${str(t.metadata.name) ?? 'anonymous'}`);
    if (names.size === 0) continue;
    timerBlocks.push({
      kind: 'timer-js-block',
      ts: task.ts,
      screen: task.screen,
      summary: `JS thread blocked ${fmtMs(task.duration)} while timer callbacks ran: ${[...names].slice(0, 4).join(', ')}`,
      eventIds: [task.id, ...timerCallbacks.map((f) => f.id), ...timerFires.map((t) => t.id)].slice(0, 20),
    });
  }
  out.push(...timerBlocks.sort((a, b) => b.ts - a.ts).slice(0, MAX_CORRELATIONS_PER_KIND));

  // Memory → navigation
  const memoryJumps: Correlation[] = [];
  ctx.visits.forEach((v, i) => {
    if (v.memoryDeltaKb === null || Math.abs(v.memoryDeltaKb) < ctx.options.memoryJumpKb) return;
    const from = i > 0 ? ctx.visits[i - 1]?.screen : null;
    memoryJumps.push({
      kind: 'memory-navigation',
      ts: v.enterTs,
      screen: v.screen,
      summary: `${from ? `${from} → ` : ''}${v.screen}: memory ${v.memoryDeltaKb > 0 ? 'grew' : 'dropped'} ${fmtKb(Math.abs(v.memoryDeltaKb))} during the visit`,
      eventIds: [],
    });
  });
  out.push(...memoryJumps.slice(0, MAX_CORRELATIONS_PER_KIND));

  return out.sort((a, b) => a.ts - b.ts);
}

function frameDropCorrelation(drop: FrameDrop): Correlation {
  return {
    kind: 'function-frame-drop',
    ts: drop.ts,
    screen: drop.screen,
    summary: `${drop.droppedFrames} frame${drop.droppedFrames === 1 ? '' : 's'} dropped on the ${drop.thread.toUpperCase()} thread while ${drop.culprits.join(', ')} ran`,
    eventIds: [drop.id],
  };
}
