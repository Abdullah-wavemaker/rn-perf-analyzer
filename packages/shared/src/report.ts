import type { EventType, PerfEvent, ApiClient, TimerKind } from './events.js';

/**
 * Output of the analyzer: everything the dashboard and exported reports
 * render. Plain JSON — no class instances — so it can be cached, diffed and
 * shipped to a browser as-is.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SCORE_CATEGORIES = ['startup', 'navigation', 'network', 'js', 'rendering', 'memory', 'stability'] as const;
export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

export type BottleneckCategory = ScoreCategory | 'cpu';

export interface Stat {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  total: number;
}

export interface SeriesPoint {
  ts: number;
  value: number;
}

/* ------------------------------- Startup -------------------------------- */

export interface StartupRun {
  kind: 'cold' | 'warm' | 'hot';
  ts: number;
  iteration: number | null;
  /** Native time to initial display (am start -W TotalTime). */
  ttid: number | null;
  waitTime: number | null;
  /** Launch → JS bundle started evaluating. */
  jsInit: number | null;
  /** Launch → first React commit. */
  firstRender: number | null;
  /** Launch → first screen interactive (TTI). */
  tti: number | null;
  ttiReason: 'explicit' | 'derived' | null;
}

export interface StartupPhaseStats {
  ttid: Stat | null;
  jsInit: Stat | null;
  firstRender: Stat | null;
  tti: Stat | null;
}

export interface StartupReport {
  runs: StartupRun[];
  cold: StartupPhaseStats;
  warm: StartupPhaseStats;
  hot: StartupPhaseStats;
}

/* ------------------------------ Navigation ------------------------------ */

export interface ScreenVisit {
  index: number;
  screen: string;
  key: string | null;
  enterTs: number;
  leaveTs: number | null;
  /** Triggering user action → screen enter. */
  transition: number | null;
  /** Enter → first committed render of the screen. */
  firstRender: number | null;
  /** Enter → interactive (TTI). */
  tti: number | null;
  ttiReason: 'explicit' | 'derived' | null;
  apiCount: number;
  /** Enter → last API response that preceded readiness. */
  networkTime: number | null;
  longTasks: number;
  longTaskTime: number;
  droppedFrames: number;
  commits: number;
  componentRenders: number;
  memoryDeltaKb: number | null;
  cpuAvg: number | null;
  /** Where the time-to-interactive went. Sums to roughly `tti`. */
  breakdown: { network: number; js: number; render: number; other: number } | null;
}

export interface ScreenSummary {
  screen: string;
  visits: number;
  tti: Stat | null;
  firstRender: Stat | null;
  transition: Stat | null;
  apiCalls: number;
  droppedFrames: number;
  longTaskTime: number;
  memoryDeltaKb: Stat | null;
  score: number | null;
}

export interface NavigationReport {
  visits: ScreenVisit[];
  screens: ScreenSummary[];
}

/* -------------------------------- Network -------------------------------- */

export interface ApiCall {
  requestId: string;
  method: string;
  url: string;
  endpoint: string;
  client: ApiClient;
  status: number | null;
  error: string | null;
  start: number;
  end: number | null;
  duration: number | null;
  requestSize: number | null;
  responseSize: number | null;
  screen: string | null;
  visitIndex: number | null;
}

export interface EndpointSummary {
  endpoint: string;
  count: number;
  errors: number;
  slow: number;
  duplicates: number;
  duration: Stat | null;
  requestBytes: number;
  responseBytes: number;
}

export interface DuplicateGroup {
  endpoint: string;
  url: string;
  screen: string | null;
  count: number;
  requestIds: string[];
  wastedMs: number;
}

export interface SequentialChain {
  screen: string | null;
  visitIndex: number | null;
  requestIds: string[];
  endpoints: string[];
  totalMs: number;
  /** Estimated wall time if the chain had run in parallel. */
  parallelMs: number;
}

export interface NetworkReport {
  calls: ApiCall[];
  endpoints: EndpointSummary[];
  slow: string[];
  failed: string[];
  duplicates: DuplicateGroup[];
  sequentialChains: SequentialChain[];
  totalBytes: number;
}

/* ---------------------------------- JS ---------------------------------- */

export interface LongTask {
  id: string;
  ts: number;
  duration: number;
  screen: string | null;
  suspects: { name: string; duration: number }[];
}

export interface FunctionSummary {
  name: string;
  origin: 'callback' | 'measure' | 'profile';
  count: number;
  total: number;
  max: number;
  mean: number;
  /** Times this function overlapped a dropped frame or long task. */
  blockingHits: number;
}

export interface TimerReport {
  created: Partial<Record<TimerKind, number>>;
  fired: Partial<Record<TimerKind, number>>;
  late: number;
  maxLatenessMs: number;
  maxActiveIntervals: number;
  heavyCallbacks: { name: string; kind: TimerKind; count: number; total: number; max: number }[];
}

export interface JsReport {
  longTasks: LongTask[];
  blockedMs: number;
  functions: FunctionSummary[];
  timers: TimerReport;
  profileImported: boolean;
}

/* ------------------------------- Rendering ------------------------------- */

export interface FrameDrop {
  id: string;
  ts: number;
  thread: 'js' | 'ui';
  droppedFrames: number;
  screen: string | null;
  culprits: string[];
}

export interface ComponentRenderSummary {
  name: string;
  renders: number;
  screens: string[];
  /** Highest renders observed within any 1 s window. */
  peakPerSecond: number;
  excessive: boolean;
}

export interface RenderingReport {
  uiFps: SeriesPoint[];
  jsFps: SeriesPoint[];
  uiFpsAvg: number | null;
  jsFpsAvg: number | null;
  uiJankPct: number | null;
  frameDrops: FrameDrop[];
  droppedFramesByScreen: Record<string, number>;
  commits: number;
  components: ComponentRenderSummary[];
}

/* ---------------------------- Memory & CPU ------------------------------ */

export interface MemoryPoint {
  ts: number;
  pssKb: number | null;
  javaHeapKb: number | null;
  nativeHeapKb: number | null;
  jsHeapKb: number | null;
}

export interface MemoryReport {
  series: MemoryPoint[];
  startKb: number | null;
  endKb: number | null;
  peakKb: number | null;
  peakTs: number | null;
  growthKb: number | null;
  byTransition: { ts: number; from: string | null; to: string; deltaKb: number }[];
  leakSuspects: { screen: string; visits: number; growthPerVisitKb: number }[];
}

export interface CpuPoint {
  ts: number;
  total: number;
  ui: number | null;
  js: number | null;
}

export interface CpuReport {
  series: CpuPoint[];
  avg: number | null;
  peak: number | null;
  uiAvg: number | null;
  jsAvg: number | null;
  byScreen: Record<string, number>;
}

/* ---------------------------- Correlation ------------------------------- */

export type CorrelationKind =
  | 'api-render-tti'
  | 'function-frame-drop'
  | 'timer-js-block'
  | 'memory-navigation';

export interface Correlation {
  kind: CorrelationKind;
  ts: number;
  screen: string | null;
  summary: string;
  eventIds: string[];
}

export interface Bottleneck {
  id: string;
  severity: Severity;
  category: BottleneckCategory;
  title: string;
  detail: string;
  recommendation: string;
  screen: string | null;
  metric: { name: string; value: number; unit: string; threshold: number } | null;
  evidence: string[];
  ts: number | null;
}

export interface Stability {
  crashes: { ts: number; kind: string; message: string; id: string }[];
  errors: { ts: number; message: string; id: string; screen: string | null }[];
}

export interface Score {
  overall: number | null;
  categories: Record<ScoreCategory, { score: number | null; weight: number; note: string }>;
}

export interface Coverage {
  agent: boolean;
  device: boolean;
  profiler: boolean;
  navigation: boolean;
  network: boolean;
  rendering: boolean;
}

export interface AnalysisReport {
  version: 1;
  generatedAt: number;
  window: { start: number; end: number; duration: number } | null;
  eventCounts: Partial<Record<EventType, number>>;
  coverage: Coverage;
  score: Score;
  startup: StartupReport;
  navigation: NavigationReport;
  network: NetworkReport;
  js: JsReport;
  rendering: RenderingReport;
  memory: MemoryReport;
  cpu: CpuReport;
  stability: Stability;
  correlations: Correlation[];
  bottlenecks: Bottleneck[];
  /** Events synthesized by the analyzer (e.g. derived SCREEN_READY) for the timeline. */
  derivedEvents: PerfEvent[];
}
