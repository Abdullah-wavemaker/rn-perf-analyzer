import type { PerfEvent, StartupPhaseStats, StartupReport, StartupRun } from '@rnpa/shared';
import type { Ctx } from './context.js';
import { deriveReady } from './navigation.js';
import { firstAtOrAfter, num, range, round, stat, str } from './util.js';

const HOT_RENDER_WINDOW_MS = 5_000;

/**
 * Startup runs are anchored on host-side STARTUP events (one per `am start
 * -W`), which carry the native time-to-initial-display. JS-side milestones in
 * the same window give the phase breakdown:
 *
 *   launch ─▶ JS_INIT ─▶ FIRST_RENDER ─▶ APP_READY (TTI)
 *
 * When the app was launched outside the tool, each JS_INIT starts a run with
 * unknown native timing.
 */
export function analyzeStartup(ctx: Ctx): StartupReport {
  const { by } = ctx;
  interface Anchor {
    ts: number;
    kind: StartupRun['kind'];
    ttid: number | null;
    waitTime: number | null;
    iteration: number | null;
  }
  let anchors: Anchor[] = by.STARTUP.map((e) => ({
    ts: e.ts,
    kind: (['cold', 'warm', 'hot'].includes(str(e.metadata.kind) ?? '') ? e.metadata.kind : 'cold') as StartupRun['kind'],
    ttid: num(e.metadata.totalTime) ?? e.duration,
    waitTime: num(e.metadata.waitTime),
    iteration: num(e.metadata.iteration),
  }));
  if (anchors.length === 0) {
    anchors = by.JS_INIT.map((e) => {
      const appStart = range(by.APP_START, e.ts - 10_000, e.ts + 1).pop();
      return { ts: appStart?.ts ?? e.ts, kind: 'cold' as const, ttid: null, waitTime: null, iteration: null };
    });
  }

  const runs: StartupRun[] = anchors.map((anchor, i) => {
    const t0 = anchor.ts;
    const windowEnd = anchors[i + 1]?.ts ?? ctx.end + 1;
    const rel = (e: PerfEvent | null | undefined) => (e ? round(e.ts - t0) : null);

    if (anchor.kind === 'cold') {
      const jsInit = range(by.JS_INIT, t0 - 1, windowEnd)[0];
      const firstRender = range(by.FIRST_RENDER, t0, windowEnd)[0] ?? range(by.RENDER, t0, windowEnd)[0];
      const explicitReady = range(by.APP_READY, t0, windowEnd)[0];
      let tti: number | null = null;
      let ttiReason: StartupRun['ttiReason'] = null;
      if (explicitReady) {
        tti = rel(explicitReady);
        ttiReason = 'explicit';
      } else {
        const firstVisit = ctx.visits.find((v) => v.enterTs >= t0 && v.enterTs < windowEnd && v.tti !== null);
        let screen: string | null = null;
        if (firstVisit) {
          tti = round(firstVisit.enterTs + (firstVisit.tti as number) - t0);
          screen = firstVisit.screen;
        } else if (firstRender) {
          // No navigation data: the app is ready once the first render settles (same quiet-window rule as screens).
          const deadline = Math.min(windowEnd, firstRender.ts + ctx.options.ttiMaxMs);
          const ready = deriveReady(
            firstRender.ts,
            deadline,
            ctx.calls.filter((c) => c.start >= t0 && c.start < deadline),
            range(by.RENDER, firstRender.ts, deadline),
            range(by.LONG_TASK, firstRender.ts, deadline),
            ctx.options.ttiQuietMs,
          );
          tti = round(ready - t0);
        }
        if (tti !== null) {
          ttiReason = 'derived';
          ctx.derived.push({
            id: `derived-app-ready-${i}`,
            ts: t0 + tti,
            type: 'APP_READY',
            screen,
            duration: null,
            source: 'analyzer',
            metadata: { reason: 'derived', tti },
          });
        }
      }
      return {
        kind: anchor.kind,
        ts: t0,
        iteration: anchor.iteration,
        ttid: anchor.ttid,
        waitTime: anchor.waitTime,
        jsInit: rel(jsInit),
        firstRender: rel(firstRender),
        tti: tti !== null && anchor.ttid !== null ? Math.max(tti, anchor.ttid) : tti,
        ttiReason,
      };
    }

    // Warm/hot: the JS runtime survives; the first commit after resume is the render milestone.
    const resumeRender = firstAtOrAfter(by.RENDER, t0, (e) => e.ts < Math.min(windowEnd, t0 + HOT_RENDER_WINDOW_MS));
    const firstRender = rel(resumeRender);
    const candidates = [anchor.ttid, firstRender].filter((v): v is number => v !== null);
    return {
      kind: anchor.kind,
      ts: t0,
      iteration: anchor.iteration,
      ttid: anchor.ttid,
      waitTime: anchor.waitTime,
      jsInit: null,
      firstRender,
      tti: candidates.length > 0 ? Math.max(...candidates) : null,
      ttiReason: candidates.length > 0 ? 'derived' : null,
    };
  });

  const phase = (kind: StartupRun['kind']): StartupPhaseStats => {
    const list = runs.filter((r) => r.kind === kind);
    return {
      ttid: stat(list.map((r) => r.ttid)),
      jsInit: stat(list.map((r) => r.jsInit)),
      firstRender: stat(list.map((r) => r.firstRender)),
      tti: stat(list.map((r) => r.tti)),
    };
  };

  return { runs, cold: phase('cold'), warm: phase('warm'), hot: phase('hot') };
}
