import { type AgentOptions, type AgentConfig, resolveConfig } from './config.js';
import { type AnyFn, g, now, originals, perfToEpoch } from './env.js';
import { installErrorInstrumentation } from './errors.js';
import { type AxiosLike, installNetworkInstrumentation, instrumentAxios } from './network.js';
import { installReactInstrumentation, type NavigationSink, type ReactInstrumentation } from './react.js';
import { createRecorder, type Recorder } from './recorder.js';
import { installTimerInstrumentation } from './timers.js';
import { createTransport } from './transport.js';

export const AGENT_VERSION = '0.1.0';
const GLOBAL_KEY = '__RNPA_AGENT__';

/** Subset of React Navigation's NavigationContainerRef used by the agent. */
export interface NavigationRefLike {
  addListener(event: string, callback: (e?: unknown) => void): () => void;
  getCurrentRoute(): { name: string; key?: string } | undefined | null;
  isReady?: () => boolean;
}

export interface RnpaAgent {
  readonly version: string;
  readonly instanceId: string;
  readonly mode: 'prelude' | 'sdk';
  readonly config: AgentConfig;
  /** Drops a named marker on the timeline. */
  mark(name: string, metadata?: Record<string, unknown>): void;
  /** Runs `fn` and records its duration as a FUNCTION event. */
  measure<T>(name: string, fn: () => T): T;
  /** Starts a span; call the returned function to end it. */
  startSpan(name: string): () => void;
  /** Declares the app interactive. Overrides the derived APP_READY. */
  markAppReady(metadata?: Record<string, unknown>): void;
  /** Declares the current (or given) screen interactive. Overrides derived TTI. */
  markScreenReady(screen?: string): void;
  /** Manually sets the current screen (apps without React Navigation). */
  setScreen(name: string): void;
  /** Precise navigation tracking via a NavigationContainer ref. */
  instrumentNavigation(ref: NavigationRefLike): void;
  /** Labels axios traffic (it is captured either way through XHR). */
  instrumentAxios(instance: AxiosLike): void;
  /** Records a lifecycle transition (SDK passes AppState changes). */
  appState(state: string): void;
  flush(): void;
}

export function getAgent(): RnpaAgent | null {
  const existing = g[GLOBAL_KEY];
  return existing && typeof existing === 'object' ? (existing as RnpaAgent) : null;
}

export function createAgent(options: AgentOptions | undefined, mode: 'prelude' | 'sdk'): RnpaAgent {
  const existing = getAgent();
  if (existing) return existing;

  const config = resolveConfig(options);
  const transport = createTransport(config);
  const recorder: Recorder = createRecorder(config, transport);
  let appReadyMarked = false;
  let pendingRender: { key: string | null; enterTs: number } | null = null;

  const navigation: NavigationSink = {
    sdkAttached: false,
    routeChanged(name, key, enterTs, renderTs) {
      const previous = recorder.getScreen();
      recorder.setScreen(name);
      recorder.emit('SCREEN_ENTER', { previous, key }, undefined, enterTs);
      if (renderTs !== null) {
        recorder.emit('SCREEN_RENDER', { key }, Math.max(0, renderTs - enterTs), renderTs);
        pendingRender = null;
      } else {
        pendingRender = { key, enterTs };
      }
    },
    onCommit(ts) {
      if (pendingRender && ts >= pendingRender.enterTs) {
        recorder.emit('SCREEN_RENDER', { key: pendingRender.key }, ts - pendingRender.enterTs, ts);
        pendingRender = null;
      }
    },
  };

  // JS_INIT: when the bundle started evaluating.
  const bundleStart = g.__BUNDLE_START_TIME__;
  const jsInitTs =
    typeof bundleStart === 'number' && bundleStart > 0 ? (bundleStart > 1e12 ? bundleStart : perfToEpoch(bundleStart)) : now();
  recorder.emit(
    'JS_INIT',
    {
      mode,
      agentVersion: AGENT_VERSION,
      engine: g.HermesInternal ? 'hermes' : 'jsc',
      transport: transport.kind,
      bridgeless: !!g.RN$Bridgeless,
      fabric: !!g.nativeFabricUIManager,
    },
    undefined,
    jsInitTs,
  );

  if (config.instrument.timers || config.instrument.longTasks || config.instrument.fps) {
    installTimerInstrumentation(config, recorder, function onTimersReady() {
      recorder.ensureScheduled();
      if (config.instrument.memory) startMemorySampler(config, recorder);
    });
  }
  if (config.instrument.network) installNetworkInstrumentation(recorder);
  if (config.instrument.errors) installErrorInstrumentation(recorder);
  let react: ReactInstrumentation | null = null;
  if (config.instrument.react) react = installReactInstrumentation(config, recorder, navigation);

  const agent: RnpaAgent = {
    version: AGENT_VERSION,
    instanceId: recorder.instanceId,
    mode,
    config,
    mark(name, metadata) {
      recorder.emit('MARK', Object.assign({}, metadata || {}, { name: String(name).slice(0, 200) }));
    },
    measure<T>(name: string, fn: () => T): T {
      const start = now();
      try {
        return fn();
      } finally {
        const duration = now() - start;
        recorder.noteCallback(name, start, duration);
        recorder.emit('FUNCTION', { name: String(name).slice(0, 200), origin: 'measure' }, duration, start);
      }
    },
    startSpan(name) {
      const start = now();
      let ended = false;
      return function endSpan() {
        if (ended) return;
        ended = true;
        const duration = now() - start;
        recorder.noteCallback(name, start, duration);
        recorder.emit('FUNCTION', { name: String(name).slice(0, 200), origin: 'measure' }, duration, start);
      };
    },
    markAppReady(metadata) {
      if (appReadyMarked) return;
      appReadyMarked = true;
      recorder.emit('APP_READY', Object.assign({}, metadata || {}, { reason: 'explicit' }));
      recorder.flush();
    },
    markScreenReady(screen) {
      const name = typeof screen === 'string' ? screen : recorder.getScreen();
      recorder.emit('SCREEN_READY', { reason: 'explicit', screen: name });
    },
    setScreen(name) {
      const key = String(name).slice(0, 200);
      if (key === recorder.getScreen()) return;
      const t = now();
      navigation.routeChanged(key, null, t, null);
    },
    instrumentNavigation(ref) {
      if (!ref || typeof ref.addListener !== 'function') return;
      navigation.sdkAttached = true;
      let actionAt: number | null = null;
      let lastKey: string | null = null;
      const report = function report() {
        const route = ref.getCurrentRoute();
        if (!route || typeof route.name !== 'string') return;
        const key = route.key || route.name;
        if (key === lastKey) return;
        lastKey = key;
        const t = now();
        const enter = actionAt !== null && t - actionAt < 5000 ? actionAt : t;
        actionAt = null;
        const lastCommit = react ? react.lastCommitTs() : 0;
        navigation.routeChanged(route.name.slice(0, 200), route.key || null, enter, lastCommit >= enter ? lastCommit : null);
      };
      ref.addListener('__unsafe_action__', function onAction() {
        actionAt = now();
      });
      ref.addListener('state', report);
      // Initial route: the container may not be ready yet.
      let attempts = 0;
      const poll = function poll() {
        if (typeof ref.isReady !== 'function' || ref.isReady()) {
          report();
          return;
        }
        if (++attempts < 100 && originals.setTimeout) originals.setTimeout(poll, 100);
      };
      poll();
    },
    instrumentAxios(instance) {
      instrumentAxios(instance);
    },
    appState(state) {
      recorder.emit('APP_STATE', { state: String(state).slice(0, 32) });
      if (state !== 'active') recorder.flush();
    },
    flush() {
      recorder.flush();
    },
  };

  try {
    Object.defineProperty(g, GLOBAL_KEY, { value: agent, configurable: false, writable: false, enumerable: false });
  } catch {
    g[GLOBAL_KEY] = agent;
  }
  return agent;
}

function startMemorySampler(config: AgentConfig, recorder: Recorder): void {
  const hermes = g.HermesInternal as { getInstrumentedStats?: AnyFn } | undefined;
  if (!hermes || typeof hermes.getInstrumentedStats !== 'function') return;
  const st = originals.setTimeout as AnyFn;
  const sample = function sampleMemory() {
    try {
      const stats = (hermes.getInstrumentedStats as AnyFn)() as Record<string, number>;
      const heap = stats.js_heapSize;
      const allocated = stats.js_allocatedBytes;
      recorder.emit('MEMORY', {
        origin: 'js',
        jsHeapKb: typeof heap === 'number' ? Math.round(heap / 1024) : undefined,
        jsAllocatedKb: typeof allocated === 'number' ? Math.round(allocated / 1024) : undefined,
        gcCount: stats.js_numGCs,
      });
    } catch {
      return;
    }
    st(sampleMemory, config.intervals.memoryMs);
  };
  st(sample, config.intervals.memoryMs);
}
