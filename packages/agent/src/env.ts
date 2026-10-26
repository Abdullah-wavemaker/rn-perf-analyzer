/**
 * Runtime environment helpers. The agent may run before React Native's
 * InitializeCore, so nothing here can assume RN globals exist yet.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...args: any[]) => any;

declare const global: unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const g: any = typeof globalThis !== 'undefined' ? globalThis : global;

/**
 * Untouched references to globals the agent depends on internally, captured
 * before instrumentation wraps them so the agent never measures itself.
 */
export const originals: {
  setTimeout?: AnyFn;
  clearTimeout?: AnyFn;
  setInterval?: AnyFn;
  clearInterval?: AnyFn;
  requestAnimationFrame?: AnyFn;
  XMLHttpRequest?: { new (): XMLHttpRequestLike };
} = {};

export interface XMLHttpRequestLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  timeout: number;
  __rnpaInternal?: boolean;
}

const perfNow: () => number = (function pickClock() {
  if (typeof g.nativePerformanceNow === 'function') {
    return function nativeNow() {
      return g.nativePerformanceNow() as number;
    };
  }
  if (g.performance && typeof g.performance.now === 'function') {
    return function webNow() {
      return g.performance.now() as number;
    };
  }
  return Date.now;
})();

const epochAtInit = Date.now();
const perfAtInit = perfNow();

/**
 * Monotonic, sub-millisecond clock expressed in device epoch milliseconds.
 * Durations use the high-resolution clock; the epoch anchor lets the host
 * align events with device-side and host-side signals.
 */
export function now(): number {
  return epochAtInit + (perfNow() - perfAtInit);
}

/** Converts a value from the native performance clock to epoch ms. */
export function perfToEpoch(perfTime: number): number {
  return epochAtInit + (perfTime - perfAtInit);
}

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e9;
  return prefix + idCounter.toString(36);
}

export function randomId(): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

export function safe<T extends AnyFn>(fn: T): T {
  return function guarded(this: unknown) {
    try {
      // eslint-disable-next-line prefer-rest-params
      return fn.apply(this, arguments as unknown as unknown[]);
    } catch {
      return undefined;
    }
  } as T;
}

export function fnName(fn: unknown): string {
  if (typeof fn !== 'function') return 'anonymous';
  const f = fn as { displayName?: unknown; name?: unknown };
  const name = typeof f.displayName === 'string' && f.displayName ? f.displayName : f.name;
  return typeof name === 'string' && name ? name.slice(0, 120) : 'anonymous';
}
