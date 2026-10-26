import type { AnalysisReport, EventType, PerfEvent } from '@rnpa/shared';
import { detectBottlenecks } from './bottlenecks.js';
import { createContext } from './context.js';
import { correlate } from './correlate.js';
import { analyzeJs } from './js.js';
import { analyzeNavigation } from './navigation.js';
import { analyzeNetwork, buildCalls } from './network.js';
import { type AnalyzerOptions, DEFAULT_OPTIONS } from './options.js';
import { analyzeRendering } from './rendering.js';
import { analyzeCpu, analyzeMemory, analyzeStability } from './resources.js';
import { computeScore } from './score.js';
import { analyzeStartup } from './startup.js';

export { type AnalyzerOptions, DEFAULT_OPTIONS, BUDGETS } from './options.js';
export { scoreValue } from './score.js';

/**
 * Analyzes one session timeline. Pure and deterministic: the same events and
 * options always produce the same report, so results can be cached by
 * (session, event count) and re-derived when thresholds change.
 */
export function analyze(events: PerfEvent[], options: Partial<AnalyzerOptions> = {}): AnalysisReport {
  const ctx = createContext(events, { ...DEFAULT_OPTIONS, ...options });

  // Order matters: calls feed TTI, visits feed network attribution, startup reads visits.
  ctx.calls = buildCalls(ctx);
  const navigation = analyzeNavigation(ctx);
  const network = analyzeNetwork(ctx);
  const startup = analyzeStartup(ctx);
  const js = analyzeJs(ctx);
  const rendering = analyzeRendering(ctx);
  const memory = analyzeMemory(ctx);
  const cpu = analyzeCpu(ctx);
  const stability = analyzeStability(ctx);
  const correlations = correlate(ctx, js, rendering);

  const eventCounts: Partial<Record<EventType, number>> = {};
  for (const e of ctx.events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;

  const has = (type: EventType) => (eventCounts[type] ?? 0) > 0;
  const partial = {
    version: 1 as const,
    generatedAt: Date.now(),
    window: ctx.events.length > 0 ? { start: ctx.start, end: ctx.end, duration: ctx.end - ctx.start } : null,
    eventCounts,
    coverage: {
      agent: ctx.events.some((e) => e.source === 'agent'),
      device: ctx.events.some((e) => e.source === 'device'),
      profiler: ctx.events.some((e) => e.source === 'profiler'),
      navigation: has('SCREEN_ENTER'),
      network: has('API_START') || has('API_END'),
      rendering: has('FPS') || has('RENDER') || has('FRAME_DROP'),
    },
    startup,
    navigation,
    network,
    js,
    rendering,
    memory,
    cpu,
    stability,
    correlations,
    derivedEvents: ctx.derived.sort((a, b) => a.ts - b.ts),
  };

  return {
    ...partial,
    score: computeScore(partial),
    bottlenecks: detectBottlenecks(ctx, partial),
  };
}
