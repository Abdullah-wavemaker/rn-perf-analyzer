export interface AnalyzerOptions {
  /** A screen is interactive once no network or commits happen for this long. */
  ttiQuietMs: number;
  /** Derived TTI is capped at this value (protects against polling screens). */
  ttiMaxMs: number;
  /** User action → screen enter attribution window. */
  transitionLookbackMs: number;
  slowApiMs: number;
  /** Identical requests within this window on the same screen are duplicates. */
  duplicateWindowMs: number;
  /** Max gap between one response and the next request to call them sequential. */
  sequentialGapMs: number;
  longTaskMs: number;
  excessiveRendersPerSecond: number;
  excessiveRendersPerVisit: number;
  leakGrowthKbPerVisit: number;
  memoryJumpKb: number;
}

export const DEFAULT_OPTIONS: AnalyzerOptions = {
  ttiQuietMs: 500,
  ttiMaxMs: 30_000,
  transitionLookbackMs: 3_000,
  slowApiMs: 1_000,
  duplicateWindowMs: 3_000,
  sequentialGapMs: 150,
  longTaskMs: 50,
  excessiveRendersPerSecond: 15,
  excessiveRendersPerVisit: 100,
  leakGrowthKbPerVisit: 2_048,
  memoryJumpKb: 10_240,
};

/**
 * Good / poor thresholds used for scoring (values at "good" score 90,
 * values at "poor" score 50). Based on common mobile performance budgets.
 */
export const BUDGETS = {
  coldTti: { good: 1_500, poor: 4_000 },
  coldTtid: { good: 800, poor: 2_000 },
  screenTti: { good: 500, poor: 2_500 },
  apiP90: { good: 300, poor: 1_500 },
  blockedMsPerMinute: { good: 250, poor: 3_000 },
  uiJankPct: { good: 2, poor: 15 },
  jsFpsDeficit: { good: 2, poor: 20 },
  memoryGrowthKb: { good: 10_240, poor: 102_400 },
} as const;
