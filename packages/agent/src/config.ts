export type TransportKind = 'logcat' | 'http' | 'auto';

export interface AgentConfig {
  /** Identifies the instrumented build. Must match [A-Za-z0-9_-]{1,64}. */
  channel: string;
  /**
   * `logcat` writes batches through React Native's native logger (no network,
   * works in release builds). `http` POSTs batches to the collector through
   * `adb reverse`. `auto` prefers logcat.
   */
  transport: TransportKind;
  httpUrl?: string;
  httpToken?: string;
  /** True when the host app is a __DEV__ build (keeps React DevTools working). */
  devMode: boolean;
  intervals: {
    flushMs: number;
    heartbeatMs: number;
    fpsWindowMs: number;
    memoryMs: number;
    timerSummaryMs: number;
  };
  thresholds: {
    /** Event-loop blocks at least this long are reported as LONG_TASK. */
    longTaskMs: number;
    /** Wrapped callbacks at least this long are reported as FUNCTION. */
    functionMs: number;
    /** Timers firing this late (vs. requested delay) are reported. */
    timerLatenessMs: number;
    /** Minimum consecutive dropped JS frames to report FRAME_DROP. */
    droppedFrames: number;
    frameBudgetMs: number;
  };
  instrument: {
    network: boolean;
    timers: boolean;
    react: boolean;
    navigationFromFiber: boolean;
    fps: boolean;
    longTasks: boolean;
    memory: boolean;
    errors: boolean;
  };
  limits: {
    maxBufferedEvents: number;
    maxEventsPerBatch: number;
    maxComponentsPerCommit: number;
    maxFibersPerCommit: number;
  };
}

export const DEFAULT_CONFIG: AgentConfig = {
  channel: 'default',
  transport: 'auto',
  devMode: false,
  intervals: {
    flushMs: 1000,
    heartbeatMs: 50,
    fpsWindowMs: 1000,
    memoryMs: 2000,
    timerSummaryMs: 5000,
  },
  thresholds: {
    longTaskMs: 50,
    functionMs: 8,
    timerLatenessMs: 100,
    droppedFrames: 2,
    frameBudgetMs: 1000 / 60,
  },
  instrument: {
    network: true,
    timers: true,
    react: true,
    navigationFromFiber: true,
    fps: true,
    longTasks: true,
    memory: true,
    errors: true,
  },
  limits: {
    maxBufferedEvents: 20000,
    maxEventsPerBatch: 200,
    maxComponentsPerCommit: 25,
    maxFibersPerCommit: 20000,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type AgentOptions = DeepPartial<AgentConfig>;

const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;

export function resolveConfig(options: AgentOptions | undefined): AgentConfig {
  const o = options || {};
  const config: AgentConfig = {
    channel: typeof o.channel === 'string' && CHANNEL.test(o.channel) ? o.channel : DEFAULT_CONFIG.channel,
    transport: o.transport === 'http' || o.transport === 'logcat' ? o.transport : 'auto',
    httpUrl: typeof o.httpUrl === 'string' ? o.httpUrl : undefined,
    httpToken: typeof o.httpToken === 'string' ? o.httpToken : undefined,
    devMode: o.devMode === true,
    intervals: Object.assign({}, DEFAULT_CONFIG.intervals, pickNumbers(o.intervals)),
    thresholds: Object.assign({}, DEFAULT_CONFIG.thresholds, pickNumbers(o.thresholds)),
    instrument: Object.assign({}, DEFAULT_CONFIG.instrument, pickBooleans(o.instrument)),
    limits: Object.assign({}, DEFAULT_CONFIG.limits, pickNumbers(o.limits)),
  };
  return config;
}

function pickNumbers(source: object | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!source) return out;
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === 'number' && isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

function pickBooleans(source: object | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!source) return out;
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}
