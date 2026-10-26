import type { AnalysisReport, Bottleneck, BottleneckCategory, Severity } from '@rnpa/shared';
import type { Ctx } from './context.js';
import { fmtKb, fmtMs, round } from './util.js';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

type Input = Omit<AnalysisReport, 'score' | 'bottlenecks'>;

interface Draft {
  severity: Severity;
  category: BottleneckCategory;
  title: string;
  detail: string;
  recommendation: string;
  screen?: string | null;
  metric?: Bottleneck['metric'];
  evidence?: string[];
  ts?: number | null;
  /** Used to order findings of equal severity (bigger = worse). */
  impact: number;
}

function tiered(value: number, tiers: [number, Severity][]): Severity | null {
  for (const [threshold, severity] of tiers) if (value >= threshold) return severity;
  return null;
}

/**
 * Rule-based bottleneck detection. Every finding cites a metric, its budget,
 * the evidence events and a concrete recommendation.
 */
export function detectBottlenecks(ctx: Ctx, r: Input): Bottleneck[] {
  const out: Draft[] = [];

  /* ------------------------------ Startup ------------------------------ */
  const coldTti = r.startup.cold.tti;
  if (coldTti) {
    const sev = tiered(coldTti.p50, [[6000, 'critical'], [4000, 'high'], [2000, 'medium']]);
    if (sev) {
      const run = r.startup.runs.find((x) => x.kind === 'cold' && x.tti !== null);
      const phases = run
        ? ` Phases (first run): native first frame ${run.ttid !== null ? fmtMs(run.ttid) : 'n/a'}, JS init at ${run.jsInit !== null ? fmtMs(run.jsInit) : 'n/a'}, first render at ${run.firstRender !== null ? fmtMs(run.firstRender) : 'n/a'}.`
        : '';
      out.push({
        severity: sev,
        category: 'startup',
        title: 'Slow cold start',
        detail: `Cold start reaches an interactive screen after ${fmtMs(coldTti.p50)} (p50 of ${coldTti.count} runs).${phases}`,
        recommendation:
          'Defer non-critical work until after the first screen is interactive (InteractionManager / lazy requires), enable Hermes and inline requires, trim the initial bundle, and avoid blocking the first render on network requests — render a cached or skeleton state first.',
        metric: { name: 'Cold start TTI p50', value: round(coldTti.p50), unit: 'ms', threshold: 2000 },
        impact: coldTti.p50,
      });
    }
  }
  const coldTtid = r.startup.cold.ttid;
  if (coldTtid) {
    const sev = tiered(coldTtid.p50, [[3000, 'high'], [1500, 'medium']]);
    if (sev) {
      out.push({
        severity: sev,
        category: 'startup',
        title: 'Slow native launch (time to initial display)',
        detail: `Android reports the first frame after ${fmtMs(coldTtid.p50)} (p50).`,
        recommendation:
          'Reduce work in Application.onCreate and MainActivity (SDK initialisation, synchronous I/O), avoid heavy native module constructors, and check splash-screen configuration.',
        metric: { name: 'Cold TTID p50', value: round(coldTtid.p50), unit: 'ms', threshold: 1500 },
        impact: coldTtid.p50,
      });
    }
  }
  const hotTti = r.startup.hot.tti;
  if (hotTti) {
    const sev = tiered(hotTti.p50, [[1500, 'high'], [700, 'medium']]);
    if (sev) {
      out.push({
        severity: sev,
        category: 'startup',
        title: 'Slow resume (hot start)',
        detail: `Returning to the app takes ${fmtMs(hotTti.p50)} (p50).`,
        recommendation: 'Avoid heavy work in AppState "active" listeners and onResume; do not refetch everything on foreground — revalidate in the background.',
        metric: { name: 'Hot start p50', value: round(hotTti.p50), unit: 'ms', threshold: 700 },
        impact: hotTti.p50,
      });
    }
  }

  /* ---------------------------- Navigation ----------------------------- */
  for (const s of r.navigation.screens) {
    if (!s.tti) continue;
    const sev = tiered(s.tti.p50, [[5000, 'critical'], [2500, 'high'], [1000, 'medium']]);
    if (!sev) continue;
    const visits = r.navigation.visits.filter((v) => v.screen === s.screen && v.breakdown);
    const agg = visits.reduce(
      (a, v) => {
        const b = v.breakdown as NonNullable<typeof v.breakdown>;
        return { network: a.network + b.network, js: a.js + b.js, render: a.render + b.render, other: a.other + b.other };
      },
      { network: 0, js: 0, render: 0, other: 0 },
    );
    const total = agg.network + agg.js + agg.render + agg.other || 1;
    const dominant = (Object.entries(agg) as [keyof typeof agg, number][]).sort((a, b) => b[1] - a[1])[0];
    const share = dominant ? Math.round((dominant[1] / total) * 100) : 0;
    const advice: Record<string, string> = {
      network: 'Most of the wait is network: parallelise independent requests, prefetch on the previous screen, cache responses, and render progressively instead of waiting for every request.',
      js: 'Most of the wait is JS work: move heavy computation off the render path (memoise, paginate, virtualise lists), and split long synchronous tasks.',
      render: 'Most of the wait is rendering: reduce the size of the initial tree, memoise expensive children and virtualise long lists.',
      other: 'Time is spent between events (often waiting on native modules, animations or deliberate delays): check transition animations, InteractionManager usage and native calls.',
    };
    out.push({
      severity: sev,
      category: 'navigation',
      title: `Slow screen: ${s.screen}`,
      detail: `${s.screen} becomes interactive after ${fmtMs(s.tti.p50)} (p50 over ${s.visits} visit${s.visits > 1 ? 's' : ''}, p90 ${fmtMs(s.tti.p90)}).${dominant ? ` ${share}% of that time is ${dominant[0]}.` : ''}`,
      recommendation: advice[dominant?.[0] ?? 'other'] ?? advice.other ?? '',
      screen: s.screen,
      metric: { name: 'Screen TTI p50', value: round(s.tti.p50), unit: 'ms', threshold: 1000 },
      ts: visits[0]?.enterTs ?? null,
      impact: s.tti.p50 * s.visits,
    });
  }
  for (const s of r.navigation.screens) {
    if (!s.transition || s.transition.p50 < 400) continue;
    out.push({
      severity: s.transition.p50 >= 1000 ? 'high' : 'medium',
      category: 'navigation',
      title: `Slow transition into ${s.screen}`,
      detail: `From the user's tap to the first render of ${s.screen} takes ${fmtMs(s.transition.p50)} (p50).`,
      recommendation: 'Keep the navigation action cheap: avoid synchronous work in press handlers, render the new screen immediately with placeholders, and use native-stack transitions.',
      screen: s.screen,
      metric: { name: 'Transition p50', value: round(s.transition.p50), unit: 'ms', threshold: 400 },
      impact: s.transition.p50,
    });
  }

  /* ------------------------------ Network ------------------------------ */
  for (const ep of r.network.endpoints) {
    if (!ep.duration) continue;
    const sev = tiered(ep.duration.p90, [[3000, 'high'], [1000, 'medium']]);
    if (!sev) continue;
    const ids = r.network.calls.filter((c) => c.endpoint === ep.endpoint).map((c) => c.requestId);
    out.push({
      severity: sev,
      category: 'network',
      title: `Slow endpoint: ${ep.endpoint}`,
      detail: `${ep.count} call${ep.count > 1 ? 's' : ''}, p50 ${fmtMs(ep.duration.p50)}, p90 ${fmtMs(ep.duration.p90)}, max ${fmtMs(ep.duration.max)}.`,
      recommendation: 'Investigate server latency for this endpoint, add caching (HTTP cache headers or a client cache), reduce payload size, and avoid blocking the UI on it.',
      metric: { name: 'Endpoint p90', value: round(ep.duration.p90), unit: 'ms', threshold: 1000 },
      evidence: ids.slice(0, 20),
      impact: ep.duration.total,
    });
  }
  for (const d of r.network.duplicates.slice(0, 10)) {
    out.push({
      severity: d.count >= 3 ? 'medium' : 'low',
      category: 'network',
      title: `Duplicate requests: ${d.endpoint}`,
      detail: `The same request was sent ${d.count} times within ${ctx.options.duplicateWindowMs / 1000} s${d.screen ? ` on ${d.screen}` : ''}, costing ${fmtMs(d.wastedMs)} of extra network time.`,
      recommendation: 'De-duplicate in-flight requests (shared promise or a query cache such as React Query/SWR), and check effects that refetch on every render or focus.',
      screen: d.screen,
      evidence: d.requestIds,
      impact: d.wastedMs,
    });
  }
  for (const chain of r.network.sequentialChains.slice(0, 10)) {
    const saving = chain.totalMs - chain.parallelMs;
    if (saving < 200) continue;
    out.push({
      severity: chain.requestIds.length >= 3 && saving >= 800 ? 'high' : 'medium',
      category: 'network',
      title: `Sequential request waterfall${chain.screen ? ` on ${chain.screen}` : ''}`,
      detail: `${chain.requestIds.length} requests ran back-to-back (${chain.endpoints.slice(0, 4).join(' → ')}${chain.endpoints.length > 4 ? ' → …' : ''}), taking ${fmtMs(chain.totalMs)}. In parallel they would take about ${fmtMs(chain.parallelMs)}.`,
      recommendation: 'If the requests do not depend on each other, start them together (Promise.all). If they do, consider a combined endpoint or prefetching the first one earlier.',
      screen: chain.screen,
      evidence: chain.requestIds,
      metric: { name: 'Potential saving', value: round(saving), unit: 'ms', threshold: 200 },
      impact: saving,
    });
  }
  if (r.network.failed.length > 0) {
    const failed = r.network.calls.filter((c) => r.network.failed.includes(c.requestId));
    const endpoints = [...new Set(failed.map((c) => c.endpoint))];
    out.push({
      severity: failed.length >= 5 ? 'high' : 'medium',
      category: 'network',
      title: `${failed.length} failed request${failed.length > 1 ? 's' : ''}`,
      detail: `Failures on ${endpoints.slice(0, 5).join(', ')}${endpoints.length > 5 ? ` and ${endpoints.length - 5} more` : ''}.`,
      recommendation: 'Failed requests often trigger retries and error states that slow screens down. Check status codes, auth expiry and retry policies.',
      evidence: failed.map((c) => c.requestId).slice(0, 20),
      impact: failed.length * 100,
    });
  }

  /* --------------------------------- JS -------------------------------- */
  const worstTasks = [...r.js.longTasks].sort((a, b) => b.duration - a.duration);
  const worst = worstTasks[0];
  if (worst) {
    const sev = tiered(worst.duration, [[700, 'critical'], [250, 'high'], [100, 'medium'], [50, 'low']]);
    if (sev) {
      const suspects = worst.suspects.map((s) => `${s.name} (${fmtMs(s.duration)})`).join(', ');
      out.push({
        severity: sev,
        category: 'js',
        title: 'Long JS tasks block the JS thread',
        detail: `${r.js.longTasks.length} long task${r.js.longTasks.length > 1 ? 's' : ''} blocked the JS thread for ${fmtMs(r.js.blockedMs)} in total. The worst lasted ${fmtMs(worst.duration)}${worst.screen ? ` on ${worst.screen}` : ''}${suspects ? `; suspects: ${suspects}` : ''}.`,
        recommendation: 'Split long synchronous work into chunks, move parsing/sorting/filtering of large data out of render, memoise derived data, and consider a worklet/native module for CPU-heavy work. Import a Hermes CPU profile for function-level attribution.',
        screen: worst.screen,
        metric: { name: 'Longest task', value: round(worst.duration), unit: 'ms', threshold: 50 },
        evidence: worstTasks.slice(0, 20).map((t) => t.id),
        ts: worst.ts,
        impact: r.js.blockedMs,
      });
    }
  }
  for (const f of r.js.functions.slice(0, 5)) {
    if (f.max < 50 && f.total < 500) continue;
    out.push({
      severity: f.max >= 200 || f.blockingHits >= 5 ? 'high' : 'medium',
      category: 'js',
      title: `Expensive function: ${f.name}`,
      detail: `Ran ${f.count} time${f.count > 1 ? 's' : ''} for ${fmtMs(f.total)} total (max ${fmtMs(f.max)})${f.blockingHits > 0 ? `, overlapping ${f.blockingHits} dropped-frame event${f.blockingHits > 1 ? 's' : ''}` : ''}.`,
      recommendation: 'Profile this function, cache its results, avoid calling it on every render or animation frame, and defer it with InteractionManager when it is not urgent.',
      metric: { name: 'Max duration', value: round(f.max), unit: 'ms', threshold: 50 },
      impact: f.total,
    });
  }
  if (r.js.timers.maxActiveIntervals >= 5) {
    out.push({
      severity: r.js.timers.maxActiveIntervals >= 15 ? 'high' : 'medium',
      category: 'js',
      title: 'Many concurrent intervals',
      detail: `Up to ${r.js.timers.maxActiveIntervals} setInterval timers were active at once.`,
      recommendation: 'Leaked or redundant intervals keep waking the JS thread. Clear intervals in effect cleanups and pause polling when screens are not focused (useFocusEffect).',
      metric: { name: 'Active intervals', value: r.js.timers.maxActiveIntervals, unit: '', threshold: 5 },
      impact: r.js.timers.maxActiveIntervals * 50,
    });
  }
  if (r.js.timers.late >= 5) {
    out.push({
      severity: r.js.timers.maxLatenessMs >= 500 ? 'medium' : 'low',
      category: 'js',
      title: 'Timers fire late',
      detail: `${r.js.timers.late} timer callbacks ran at least 100 ms late (worst ${fmtMs(r.js.timers.maxLatenessMs)}), a symptom of a congested JS thread.`,
      recommendation: 'Reduce long tasks on the JS thread; do not rely on precise timers for animations — use the native driver or Reanimated.',
      metric: { name: 'Max lateness', value: r.js.timers.maxLatenessMs, unit: 'ms', threshold: 100 },
      impact: r.js.timers.maxLatenessMs,
    });
  }

  /* ----------------------------- Rendering ----------------------------- */
  if (r.rendering.uiJankPct !== null) {
    const sev = tiered(r.rendering.uiJankPct, [[25, 'critical'], [10, 'high'], [5, 'medium']]);
    if (sev) {
      out.push({
        severity: sev,
        category: 'rendering',
        title: 'Janky UI thread frames',
        detail: `${r.rendering.uiJankPct}% of frames missed their deadline on the UI/render thread (average ${r.rendering.uiFpsAvg ?? 'n/a'} fps).`,
        recommendation: 'Reduce overdraw and view nesting, avoid large images without resizing, use the native driver for animations, and check for expensive layout passes (onLayout loops, flex re-measurement).',
        metric: { name: 'Janky frames', value: r.rendering.uiJankPct, unit: '%', threshold: 5 },
        impact: r.rendering.uiJankPct * 100,
      });
    }
  }
  if (r.rendering.jsFpsAvg !== null && r.rendering.jsFpsAvg < 55) {
    out.push({
      severity: r.rendering.jsFpsAvg < 40 ? 'high' : 'medium',
      category: 'rendering',
      title: 'Low JS thread frame rate',
      detail: `The JS thread averaged ${r.rendering.jsFpsAvg} fps; JS-driven animations and gestures will stutter.`,
      recommendation: 'Use useNativeDriver / Reanimated for animations and gestures, and keep per-frame JS work small.',
      metric: { name: 'JS FPS avg', value: r.rendering.jsFpsAvg, unit: 'fps', threshold: 55 },
      impact: (60 - r.rendering.jsFpsAvg) * 50,
    });
  }
  const dropsByScreen = Object.entries(r.rendering.droppedFramesByScreen).sort((a, b) => b[1] - a[1]);
  for (const [screen, dropped] of dropsByScreen.slice(0, 3)) {
    if (dropped < 30) continue;
    const drops = r.rendering.frameDrops.filter((f) => (f.screen ?? '(no screen)') === screen);
    const culprits = new Map<string, number>();
    for (const d of drops) for (const c of d.culprits) culprits.set(c, (culprits.get(c) ?? 0) + d.droppedFrames);
    const top = [...culprits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
    out.push({
      severity: dropped >= 120 ? 'high' : 'medium',
      category: 'rendering',
      title: `Frame drops on ${screen}`,
      detail: `${dropped} frames dropped while on ${screen}.${top.length ? ` Most often overlapping: ${top.join(', ')}.` : ''}`,
      recommendation: 'Look at what runs during the drops on the Timeline tab. Common causes: rendering long non-virtualised lists, synchronous work in scroll handlers, and JS-driven animations.',
      screen: screen === '(no screen)' ? null : screen,
      evidence: drops.slice(0, 20).map((d) => d.id),
      metric: { name: 'Dropped frames', value: dropped, unit: 'frames', threshold: 30 },
      impact: dropped * 16,
    });
  }
  const excessive = r.rendering.components.filter((c) => c.excessive).slice(0, 5);
  for (const c of excessive) {
    out.push({
      severity: c.peakPerSecond >= ctx.options.excessiveRendersPerSecond * 3 ? 'high' : 'medium',
      category: 'rendering',
      title: `Excessive re-renders: ${c.name}`,
      detail: `${c.name} rendered ${c.renders} times (peak ${c.peakPerSecond}/s)${c.screens.length ? ` on ${c.screens.slice(0, 3).join(', ')}` : ''}.`,
      recommendation: 'Wrap it in React.memo, stabilise props (useCallback/useMemo for callbacks and objects), split context providers so unrelated updates do not cascade, and select narrower state from stores.',
      metric: { name: 'Peak renders/s', value: c.peakPerSecond, unit: '/s', threshold: ctx.options.excessiveRendersPerSecond },
      impact: c.renders,
    });
  }

  /* ------------------------------- Memory ------------------------------ */
  if (r.memory.growthKb !== null && r.memory.growthKb >= 30 * 1024) {
    out.push({
      severity: r.memory.growthKb >= 150 * 1024 ? 'high' : 'medium',
      category: 'memory',
      title: 'Memory grows during the session',
      detail: `Memory grew by ${fmtKb(r.memory.growthKb)} (from ${fmtKb(r.memory.startKb ?? 0)} to ${fmtKb(r.memory.endKb ?? 0)}), peaking at ${fmtKb(r.memory.peakKb ?? 0)}.`,
      recommendation: 'Check for listeners, subscriptions and timers that are not cleaned up, caches without limits, and large images held in state. Repeat a journey several times to confirm a leak.',
      metric: { name: 'Growth', value: Math.round(r.memory.growthKb / 1024), unit: 'MB', threshold: 30 },
      ts: r.memory.peakTs,
      impact: r.memory.growthKb / 10,
    });
  }
  for (const leak of r.memory.leakSuspects.slice(0, 5)) {
    out.push({
      severity: leak.growthPerVisitKb >= 10 * 1024 ? 'high' : 'medium',
      category: 'memory',
      title: `Possible leak on ${leak.screen}`,
      detail: `Memory at entry kept rising across ${leak.visits} visits of ${leak.screen}, about ${fmtKb(leak.growthPerVisitKb)} per visit.`,
      recommendation: 'Make sure the screen releases everything on unmount/blur: event listeners, intervals, subscriptions, and module-level caches that keep data from previous visits.',
      screen: leak.screen,
      metric: { name: 'Growth per visit', value: Math.round(leak.growthPerVisitKb / 1024), unit: 'MB', threshold: Math.round(ctx.options.leakGrowthKbPerVisit / 1024) },
      impact: leak.growthPerVisitKb,
    });
  }
  if (r.memory.peakKb !== null && r.memory.peakKb >= 600 * 1024) {
    out.push({
      severity: r.memory.peakKb >= 1024 * 1024 ? 'high' : 'medium',
      category: 'memory',
      title: 'High peak memory',
      detail: `Total PSS peaked at ${fmtKb(r.memory.peakKb)}. Low-end devices may kill the app in the background.`,
      recommendation: 'Downsample images, limit in-memory caches, and release data for screens that are no longer visible.',
      metric: { name: 'Peak PSS', value: Math.round(r.memory.peakKb / 1024), unit: 'MB', threshold: 600 },
      ts: r.memory.peakTs,
      impact: r.memory.peakKb / 20,
    });
  }

  /* -------------------------------- CPU -------------------------------- */
  if (r.cpu.avg !== null && r.cpu.avg >= 60) {
    out.push({
      severity: r.cpu.avg >= 120 ? 'high' : 'medium',
      category: 'cpu',
      title: 'High CPU usage',
      detail: `The app process averaged ${r.cpu.avg}% CPU (peak ${r.cpu.peak}%; UI thread ${r.cpu.uiAvg ?? 'n/a'}%, JS thread ${r.cpu.jsAvg ?? 'n/a'}%).`,
      recommendation: 'Sustained CPU drains battery and causes thermal throttling. Look for busy loops, frequent re-renders, polling, and JS-driven animations.',
      metric: { name: 'Average CPU', value: r.cpu.avg, unit: '%', threshold: 60 },
      impact: r.cpu.avg * 10,
    });
  }

  /* ------------------------------ Stability ---------------------------- */
  for (const crash of r.stability.crashes.slice(0, 5)) {
    out.push({
      severity: 'critical',
      category: 'stability',
      title: `App crash (${crash.kind})`,
      detail: crash.message,
      recommendation: 'Open the crash on the timeline to see what preceded it, then reproduce with the same journey.',
      evidence: [crash.id],
      ts: crash.ts,
      impact: 1e9,
    });
  }
  if (r.stability.errors.length > 0) {
    const fatal = ctx.by.ERROR.filter((e) => e.metadata.fatal === true);
    out.push({
      severity: fatal.length > 0 ? 'critical' : 'medium',
      category: 'stability',
      title: `${r.stability.errors.length} uncaught JS error${r.stability.errors.length > 1 ? 's' : ''}`,
      detail: r.stability.errors.slice(0, 3).map((e) => e.message).join(' · '),
      recommendation: 'Uncaught errors can unmount screens or leave them half-loaded, which also distorts performance metrics. Fix them first.',
      evidence: r.stability.errors.slice(0, 20).map((e) => e.id),
      ts: r.stability.errors[0]?.ts ?? null,
      impact: 1e8,
    });
  }

  return out
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.impact - a.impact)
    .map((d, i) => ({
      id: `b${i + 1}`,
      severity: d.severity,
      category: d.category,
      title: d.title,
      detail: d.detail,
      recommendation: d.recommendation,
      screen: d.screen ?? null,
      metric: d.metric ?? null,
      evidence: d.evidence ?? [],
      ts: d.ts ?? null,
    }));
}
