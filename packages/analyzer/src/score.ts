import type { AnalysisReport, Score, ScoreCategory } from '@rnpa/shared';
import { BUDGETS } from './options.js';
import { round } from './util.js';

/**
 * Maps a "lower is better" metric onto 0–100: at or under `good` scores
 * 90–100, `poor` scores 50, and the score decays toward 0 beyond that.
 */
export function scoreValue(value: number, budget: { good: number; poor: number }): number {
  const { good, poor } = budget;
  let score: number;
  if (value <= good) score = 90 + 10 * (1 - value / good);
  else if (value <= poor) score = 90 - (40 * (value - good)) / (poor - good);
  else score = 50 * Math.max(0, 1 - (value - poor) / poor);
  return Math.round(Math.min(100, Math.max(0, score)));
}

const WEIGHTS: Record<ScoreCategory, number> = {
  startup: 0.2,
  navigation: 0.2,
  network: 0.15,
  js: 0.15,
  rendering: 0.15,
  memory: 0.1,
  stability: 0.05,
};

type ReportWithoutScore = Omit<AnalysisReport, 'score' | 'bottlenecks'>;

export function computeScore(r: ReportWithoutScore): Score {
  const categories = {} as Score['categories'];
  const set = (cat: ScoreCategory, score: number | null, note: string) => {
    categories[cat] = { score, weight: WEIGHTS[cat], note };
  };

  // Startup: cold TTI, else native TTID.
  const coldTti = r.startup.cold.tti?.p50 ?? null;
  const coldTtid = r.startup.cold.ttid?.p50 ?? null;
  if (coldTti !== null) set('startup', scoreValue(coldTti, BUDGETS.coldTti), `Cold start TTI p50 ${Math.round(coldTti)} ms`);
  else if (coldTtid !== null) set('startup', scoreValue(coldTtid, BUDGETS.coldTtid), `Cold start TTID p50 ${Math.round(coldTtid)} ms`);
  else set('startup', null, 'No cold start measured');

  // Navigation: visit-weighted mean of per-screen scores.
  const scored = r.navigation.screens.filter((s) => s.score !== null);
  if (scored.length > 0) {
    const visits = scored.reduce((s, x) => s + x.visits, 0);
    const value = scored.reduce((s, x) => s + (x.score as number) * x.visits, 0) / visits;
    set('navigation', Math.round(value), `${scored.length} screens, ${visits} visits`);
  } else set('navigation', null, 'No screen transitions captured');

  // Network: p90 latency, penalized by failures and duplicates.
  const durations = r.network.calls.map((c) => c.duration).filter((d): d is number => d !== null).sort((a, b) => a - b);
  if (durations.length > 0) {
    const p90 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))] as number;
    const failRate = r.network.failed.length / r.network.calls.length;
    const dupCount = r.network.duplicates.reduce((s, d) => s + d.count - 1, 0);
    const dupRate = dupCount / r.network.calls.length;
    const base = scoreValue(p90, BUDGETS.apiP90);
    set('network', Math.max(0, Math.round(base - failRate * 50 - dupRate * 30)), `p90 ${Math.round(p90)} ms, ${r.network.failed.length} failed, ${dupCount} duplicate`);
  } else set('network', null, 'No requests captured');

  // JS: blocked time per minute of recording.
  const minutes = r.window ? Math.max(r.window.duration / 60_000, 1 / 6) : null;
  if (minutes !== null && (r.js.longTasks.length > 0 || r.coverage.agent)) {
    const perMinute = r.js.blockedMs / minutes;
    set('js', scoreValue(perMinute, BUDGETS.blockedMsPerMinute), `${Math.round(perMinute)} ms blocked per minute`);
  } else set('js', null, 'No JS thread data');

  // Rendering: UI jank when the device reported frames, else JS FPS deficit.
  if (r.rendering.uiJankPct !== null) {
    set('rendering', scoreValue(r.rendering.uiJankPct, BUDGETS.uiJankPct), `${r.rendering.uiJankPct}% janky UI frames`);
  } else if (r.rendering.jsFpsAvg !== null) {
    const deficit = Math.max(0, 60 - r.rendering.jsFpsAvg);
    set('rendering', scoreValue(deficit, BUDGETS.jsFpsDeficit), `JS thread ${r.rendering.jsFpsAvg} fps average`);
  } else set('rendering', null, 'No frame data');

  // Memory: growth over the session, penalized for leak suspects.
  if (r.memory.growthKb !== null) {
    const base = scoreValue(Math.max(0, r.memory.growthKb), BUDGETS.memoryGrowthKb);
    set('memory', Math.max(0, base - r.memory.leakSuspects.length * 10), `Grew ${round(r.memory.growthKb / 1024)} MB over the session`);
  } else set('memory', null, 'No memory samples');

  // Stability.
  const crashes = r.stability.crashes.length;
  const errors = r.stability.errors.length;
  set('stability', crashes > 0 ? 0 : errors > 0 ? Math.max(40, 90 - errors * 10) : r.window ? 100 : null, `${crashes} crashes, ${errors} JS errors`);

  let weighted = 0;
  let weights = 0;
  for (const cat of Object.keys(categories) as ScoreCategory[]) {
    const c = categories[cat];
    if (c.score !== null) {
      weighted += c.score * c.weight;
      weights += c.weight;
    }
  }
  return { overall: weights > 0 ? Math.round(weighted / weights) : null, categories };
}
