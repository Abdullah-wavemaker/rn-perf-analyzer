/**
 * The unified event model. Every signal the analyzer understands — from the
 * in-app agent, from adb-driven device collectors, from the host orchestrator
 * and from imported profiles — is normalized into a {@link PerfEvent} and
 * stored on a single per-session timeline.
 *
 * This module must stay dependency-free: it is bundled into the on-device
 * agent, which runs inside the app's JS runtime before React Native boots.
 */

export const EVENT_TYPES = [
  // Startup & lifecycle
  'APP_START',
  'JS_INIT',
  'FIRST_RENDER',
  'APP_READY',
  'APP_STATE',
  'STARTUP',
  // Navigation
  'SCREEN_ENTER',
  'SCREEN_RENDER',
  'SCREEN_READY',
  // Network
  'API_START',
  'API_END',
  // JS thread
  'FUNCTION',
  'TIMER',
  'LONG_TASK',
  // Rendering
  'RENDER',
  'FPS',
  'FRAME_DROP',
  // Native resources
  'MEMORY',
  'CPU',
  // Interaction
  'USER_ACTION',
  // Failures
  'ERROR',
  'CRASH',
  // Free-form developer marks
  'MARK',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = ['agent', 'device', 'host', 'profiler', 'analyzer'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface PerfEvent<M extends object = Record<string, unknown>> {
  /** Unique within a session. */
  id: string;
  /** Epoch milliseconds on the host clock (device clocks are aligned on ingest). */
  ts: number;
  type: EventType;
  /** Screen that was focused when the event happened, if known. */
  screen: string | null;
  /** Duration in milliseconds for span-like events; null for instants. */
  duration: number | null;
  source: EventSource;
  metadata: M;
}

/* ------------------------------------------------------------------------ */
/* Metadata shapes per event type. These are the contract between producers */
/* (agent, collectors) and the analyzer. Unknown extra keys are tolerated.   */
/* ------------------------------------------------------------------------ */

export type ApiClient = 'fetch' | 'xhr' | 'axios';

export interface ApiStartMeta {
  requestId: string;
  method: string;
  url: string;
  client: ApiClient;
  requestSize?: number;
}

export interface ApiEndMeta extends ApiStartMeta {
  status: number | null;
  responseSize?: number;
  error?: string;
  /** Time from API_START to response headers, when the client exposes it. */
  ttfb?: number;
}

export type TimerKind = 'timeout' | 'interval' | 'raf' | 'immediate';

export interface TimerMeta {
  kind: TimerKind;
  /** create | fire | summary */
  phase: 'create' | 'fire' | 'summary';
  name?: string;
  requestedDelay?: number;
  /** How late the callback ran compared to its requested delay (ms). */
  lateness?: number;
  /** Aggregates for phase=summary. */
  counts?: Partial<Record<TimerKind, number>>;
  activeIntervals?: number;
}

export interface FunctionMeta {
  name: string;
  /** Where the sample came from: wrapped callback, explicit measure(), CPU profile. */
  origin: 'callback' | 'measure' | 'profile';
  selfTime?: number;
  url?: string;
  line?: number;
}

export interface LongTaskMeta {
  /** Callbacks known to have executed inside the blocked window. */
  suspects?: { name: string; duration: number }[];
}

export interface RenderMeta {
  commit: number;
  components: { name: string; count: number; duration?: number }[];
  totalComponents: number;
  truncated?: boolean;
}

export interface FpsMeta {
  thread: 'js' | 'ui';
  fps: number;
  frames: number;
  janky?: number;
  p50?: number;
  p90?: number;
  p99?: number;
}

export interface FrameDropMeta {
  thread: 'js' | 'ui';
  droppedFrames: number;
}

export interface MemoryMeta {
  /** device = dumpsys meminfo (KB), js = Hermes heap (bytes → KB). */
  origin: 'device' | 'js';
  totalPssKb?: number;
  javaHeapKb?: number;
  nativeHeapKb?: number;
  graphicsKb?: number;
  codeKb?: number;
  stackKb?: number;
  jsHeapKb?: number;
  jsAllocatedKb?: number;
}

export interface CpuMeta {
  /** Process CPU % (100 = one core fully busy). */
  total: number;
  ui?: number;
  js?: number;
  nativeModules?: number;
  render?: number;
  cores?: number;
}

export type UserActionKind = 'tap' | 'long_press' | 'swipe' | 'back' | 'home' | 'key';

export interface UserActionMeta {
  kind: UserActionKind;
  origin: 'device' | 'dashboard' | 'journey' | 'explorer';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  label?: string;
  keyCode?: string;
}

export interface StartupMeta {
  kind: 'cold' | 'warm' | 'hot';
  /** `am start -W` TotalTime: launch → first frame drawn (TTID). */
  totalTime?: number;
  waitTime?: number;
  launchState?: string;
  activity?: string;
  iteration?: number;
}

export interface ScreenMeta {
  previous?: string | null;
  params?: Record<string, unknown>;
  /** Navigator route key, used to distinguish repeated visits. */
  key?: string;
  /** For SCREEN_READY: 'explicit' (app called markScreenReady) or 'derived'. */
  reason?: 'explicit' | 'derived';
}

export interface ErrorMeta {
  message: string;
  stack?: string;
  fatal?: boolean;
  kind?: 'js' | 'java' | 'native' | 'anr' | 'promise';
}

/* ------------------------------------------------------------------------ */
/* Wire format used by the agent. Kept compact because the default transport */
/* is logcat, where every byte costs.                                        */
/* ------------------------------------------------------------------------ */

export const WIRE_VERSION = 1;

/** Prefix of every agent log line on the logcat transport. */
export const LOGCAT_PREFIX = 'RNPA1';
/** Max characters of payload per logcat line (logger limit is ~4 KB). */
export const LOGCAT_CHUNK_SIZE = 3000;

export interface WireEvent {
  /** type */
  t: EventType;
  /** device epoch ms */
  ts: number;
  /** screen */
  s?: string | null;
  /** duration ms */
  d?: number;
  /** metadata */
  m?: Record<string, unknown>;
}

export interface WireBatch {
  v: typeof WIRE_VERSION;
  /** Agent instance id — changes on every JS runtime start. */
  i: string;
  /** Channel id baked into the instrumented build / SDK config. */
  c: string;
  /** Monotonic batch sequence number for this instance. */
  q: number;
  /** Device Date.now() when the batch was flushed (for clock alignment). */
  n: number;
  e: WireEvent[];
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}
