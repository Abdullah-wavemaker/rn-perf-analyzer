import type { AgentConfig } from './config.js';
import { type AnyFn, g, now, originals } from './env.js';
import { hookGlobal } from './hooks.js';
import type { Recorder } from './recorder.js';

/**
 * React commit instrumentation through `__REACT_DEVTOOLS_GLOBAL_HOOK__`.
 *
 * React calls `hook.onCommitFiberRoot` after every commit, in production
 * builds too. On each commit the agent walks only the parts of the fiber tree
 * that changed (same pruning rule React DevTools uses: a subtree is untouched
 * when `fiber.child === fiber.alternate.child`) and counts composite
 * components that performed work. The walk also spots React Navigation
 * navigator state, which yields the focused route without any app changes.
 */

interface Fiber {
  tag: number;
  type: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  flags?: number;
  effectTag?: number;
  memoizedProps?: Record<string, unknown> | null;
  actualDuration?: number;
}

interface FiberRoot {
  current: Fiber;
}

interface NavState {
  key?: string;
  index?: number;
  routes: { name: string; key?: string; state?: NavState }[];
  routeNames?: unknown;
}

const PERFORMED_WORK = 1;
const COMPOSITE: Record<number, true> = { 0: true, 1: true, 11: true, 14: true, 15: true };
const RENDER_MERGE_WINDOW_MS = 50;

export interface NavigationSink {
  /** True once the app registered its navigation container through the SDK. */
  sdkAttached: boolean;
  routeChanged(name: string, key: string | null, enterTs: number, renderTs: number | null): void;
  /** Called after every commit (lets SDK-reported routes resolve their first render). */
  onCommit(ts: number): void;
}

export interface ReactInstrumentation {
  lastCommitTs(): number;
}

function componentName(fiber: Fiber): string {
  const type = fiber.type as { displayName?: string; name?: string; render?: AnyFn; type?: AnyFn } | AnyFn | null;
  if (!type) return 'Anonymous';
  if (typeof type === 'function') {
    const f = type as { displayName?: string; name?: string };
    return f.displayName || f.name || 'Anonymous';
  }
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName;
    const inner = (type.render || type.type) as { displayName?: string; name?: string } | undefined;
    if (inner) return inner.displayName || inner.name || 'Anonymous';
  }
  return 'Anonymous';
}

function isNavState(value: unknown): value is NavState {
  const s = value as NavState | null;
  return !!s && typeof s === 'object' && Array.isArray(s.routes) && typeof s.index === 'number' && s.routeNames !== undefined;
}

function focusedRoute(state: NavState): { name: string; key: string | null } | null {
  let current: NavState | undefined = state;
  let route: { name: string; key?: string } | null = null;
  for (let depth = 0; depth < 16 && current && Array.isArray(current.routes); depth++) {
    const index: number = typeof current.index === 'number' ? current.index : current.routes.length - 1;
    const next: { name: string; key?: string; state?: NavState } | undefined = current.routes[index];
    if (!next) break;
    route = next;
    current = next.state;
  }
  return route && typeof route.name === 'string' ? { name: route.name.slice(0, 200), key: route.key || null } : null;
}

export function installReactInstrumentation(
  config: AgentConfig,
  recorder: Recorder,
  navigation: NavigationSink,
): ReactInstrumentation {
  let commits = 0;
  let firstRenderEmitted = false;
  let lastCommit = 0;
  let rootNavDepth = Infinity;
  let currentRouteKey: string | null = null;
  let currentRouteName: string | null = null;

  // Pending merged RENDER event.
  let pending: { ts: number; commits: number; counts: Record<string, { count: number; duration: number }>; total: number; truncated: boolean; duration: number } | null = null;

  function flushPending(): void {
    if (!pending) return;
    const p = pending;
    pending = null;
    const names = Object.keys(p.counts);
    names.sort((a, b) => (p.counts[b] as { count: number }).count - (p.counts[a] as { count: number }).count);
    const components = names.slice(0, config.limits.maxComponentsPerCommit).map(function toEntry(name) {
      const c = p.counts[name] as { count: number; duration: number };
      return c.duration > 0 ? { name, count: c.count, duration: Math.round(c.duration * 100) / 100 } : { name, count: c.count };
    });
    recorder.emit(
      'RENDER',
      { commit: p.commits, components, totalComponents: p.total, truncated: p.truncated || names.length > components.length },
      p.duration > 0 ? p.duration : undefined,
      p.ts,
    );
  }

  function onCommit(root: FiberRoot): void {
    const ts = now();
    commits++;
    lastCommit = ts;
    const counts: Record<string, { count: number; duration: number }> = {};
    let total = 0;
    let visited = 0;
    let truncated = false;
    let totalDuration = 0;
    let navFound: { state: NavState; depth: number } | null = null;

    const rootFiber = root.current;
    const stack: { fiber: Fiber; depth: number; isNew: boolean }[] = [];
    if (rootFiber && rootFiber.child) stack.push({ fiber: rootFiber.child, depth: 1, isNew: rootFiber.alternate === null });

    while (stack.length > 0) {
      const item = stack.pop() as { fiber: Fiber; depth: number; isNew: boolean };
      let fiber: Fiber | null = item.fiber;
      // Iterate siblings in-line, push children.
      while (fiber) {
        if (++visited > config.limits.maxFibersPerCommit) {
          truncated = true;
          stack.length = 0;
          break;
        }
        const alt: Fiber | null = fiber.alternate;
        const isNew = item.isNew || alt === null;
        if (COMPOSITE[fiber.tag]) {
          const flags = fiber.flags !== undefined ? fiber.flags : fiber.effectTag || 0;
          if (isNew || (flags & PERFORMED_WORK) === PERFORMED_WORK) {
            const name = componentName(fiber);
            const entry = counts[name] || (counts[name] = { count: 0, duration: 0 });
            entry.count++;
            total++;
            if (typeof fiber.actualDuration === 'number' && fiber.actualDuration > 0) {
              entry.duration += fiber.actualDuration;
            }
          }
          if (config.instrument.navigationFromFiber && !navigation.sdkAttached && navFound === null) {
            const props = fiber.memoizedProps;
            if (props && isNavState(props.state) && item.depth <= rootNavDepth) {
              navFound = { state: props.state, depth: item.depth };
            }
          }
        }
        if (fiber.child && (isNew || alt === null || fiber.child !== alt.child)) {
          stack.push({ fiber: fiber.child, depth: item.depth + 1, isNew: isNew && fiber.alternate === null });
        }
        fiber = fiber.sibling;
      }
    }

    // Root duration: React profiling builds only.
    if (rootFiber && typeof rootFiber.actualDuration === 'number') totalDuration = rootFiber.actualDuration;

    if (!firstRenderEmitted) {
      firstRenderEmitted = true;
      recorder.emit('FIRST_RENDER', { components: total }, undefined, ts);
    }

    if (navFound) {
      rootNavDepth = navFound.depth;
      const route = focusedRoute(navFound.state);
      if (route && (route.key !== currentRouteKey || route.name !== currentRouteName)) {
        currentRouteKey = route.key;
        currentRouteName = route.name;
        navigation.routeChanged(route.name, route.key, ts, ts);
      }
    }

    navigation.onCommit(ts);

    if (total === 0) return;
    if (pending && ts - pending.ts > RENDER_MERGE_WINDOW_MS) flushPending();
    if (!pending) {
      pending = { ts, commits: 0, counts: {}, total: 0, truncated: false, duration: 0 };
      const st = originals.setTimeout;
      if (st) st(flushPending, RENDER_MERGE_WINDOW_MS + 10);
    }
    pending.commits++;
    pending.total += total;
    pending.truncated = pending.truncated || truncated;
    pending.duration += totalDuration;
    for (const name of Object.keys(counts)) {
      const src = counts[name] as { count: number; duration: number };
      const dst = pending.counts[name] || (pending.counts[name] = { count: 0, duration: 0 });
      dst.count += src.count;
      dst.duration += src.duration;
    }
  }

  function attach(hook: Record<string, unknown>): void {
    if (hook.__rnpaAttached) return;
    hook.__rnpaAttached = true;
    const previous = hook.onCommitFiberRoot as AnyFn | undefined;
    hook.onCommitFiberRoot = function rnpaOnCommitFiberRoot(this: unknown, _rendererId: unknown, root: FiberRoot) {
      try {
        if (root && root.current) onCommit(root);
      } catch {
        /* never break React */
      }
      // eslint-disable-next-line prefer-rest-params
      if (typeof previous === 'function') return previous.apply(this, arguments as unknown as unknown[]);
      return undefined;
    };
  }

  const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
  if (config.devMode) {
    // Debug builds: React DevTools installs the real hook during InitializeCore.
    // Attach to whatever gets installed rather than shadowing it.
    hookGlobal(HOOK, function onHookDefined(hook) {
      if (hook && typeof hook === 'object') attach(hook as Record<string, unknown>);
      return hook;
    });
  } else if (g[HOOK] && typeof g[HOOK] === 'object') {
    attach(g[HOOK]);
  } else {
    let rendererId = 0;
    const renderers = typeof Map === 'function' ? new Map() : null;
    const hook: Record<string, unknown> = {
      supportsFiber: true,
      isDisabled: false,
      renderers,
      inject(renderer: unknown) {
        rendererId++;
        if (renderers) renderers.set(rendererId, renderer);
        return rendererId;
      },
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      setStrictMode() {},
      checkDCE() {},
    };
    attach(hook);
    Object.defineProperty(g, HOOK, { value: hook, configurable: true, writable: true, enumerable: false });
  }

  return {
    lastCommitTs: () => lastCommit,
  };
}
