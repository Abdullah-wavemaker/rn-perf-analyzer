import { g, safe } from './env.js';

/**
 * Lazily instruments globals that React Native defines *after* the agent has
 * loaded (fetch, XMLHttpRequest, timers, ErrorUtils, …).
 *
 * RN installs most of them through `polyfillGlobal`, which calls
 * `Object.defineProperty(global, name, { get })` and later replaces the
 * accessor with a data property on first access. Plain assignment is also
 * used by apps and libraries. To cover every path the agent:
 *   1. wraps whatever value exists now,
 *   2. keeps an accessor on the global so later assignments are wrapped, and
 *   3. intercepts `Object.defineProperty` calls that target the global object
 *      for hooked names only.
 * Wrapping is idempotent and cached per original value.
 */

type Instrumenter = (original: unknown) => unknown;

const instrumenters: Record<string, Instrumenter> = {};
const wrappedByOriginal = new WeakMap<object, unknown>();
const WRAPPED = '__rnpaWrapped';

let definePropertyPatched = false;

function instrument(name: string, value: unknown): unknown {
  const fn = instrumenters[name];
  if (!fn || value === null || (typeof value !== 'function' && typeof value !== 'object')) return value;
  const obj = value as Record<string, unknown>;
  if (obj[WRAPPED]) return value;
  const cached = wrappedByOriginal.get(obj);
  if (cached !== undefined) return cached;
  let wrapped: unknown = value;
  try {
    wrapped = fn(value);
  } catch {
    wrapped = value;
  }
  wrappedByOriginal.set(obj, wrapped);
  if (wrapped !== value && wrapped && (typeof wrapped === 'function' || typeof wrapped === 'object')) {
    try {
      Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
    } catch {
      /* frozen — fine */
    }
  }
  return wrapped;
}

function wrapDescriptor(name: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  if ('value' in descriptor) {
    return Object.assign({}, descriptor, { value: instrument(name, descriptor.value) });
  }
  if (typeof descriptor.get === 'function') {
    const originalGet = descriptor.get;
    return Object.assign({}, descriptor, {
      get: function instrumentedGetter(this: unknown) {
        return instrument(name, originalGet.call(this));
      },
    });
  }
  return descriptor;
}

function patchDefineProperty(): void {
  if (definePropertyPatched) return;
  definePropertyPatched = true;
  const originalDefine = Object.defineProperty;
  const patched = function defineProperty<T>(obj: T, prop: PropertyKey, descriptor: PropertyDescriptor & ThisType<unknown>): T {
    if (obj === g && typeof prop === 'string' && instrumenters[prop] && descriptor) {
      descriptor = wrapDescriptor(prop, descriptor);
    }
    return originalDefine(obj, prop, descriptor);
  };
  try {
    Object.defineProperty = patched as typeof Object.defineProperty;
  } catch {
    /* non-writable in exotic environments — fall back to accessor hooks only */
  }
}

/**
 * Instruments `global[name]` now and whenever it is (re)defined later.
 * `instrumenter` receives the original value and returns the replacement
 * (or mutates and returns the same object, e.g. for prototype patching).
 */
export function hookGlobal(name: string, instrumenter: Instrumenter): void {
  if (instrumenters[name]) throw new Error(`rnpa: global "${name}" is already hooked`);
  instrumenters[name] = safe(instrumenter) as Instrumenter;
  patchDefineProperty();

  const existing = Object.getOwnPropertyDescriptor(g, name);
  if (existing && !existing.configurable) {
    // Cannot redefine — best effort assignment.
    if ('value' in existing && existing.writable) g[name] = instrument(name, existing.value);
    return;
  }

  if (existing && typeof existing.get === 'function') {
    Object.defineProperty(g, name, wrapDescriptor(name, existing));
    return;
  }

  let current: unknown = existing ? instrument(name, existing.value) : undefined;
  Object.defineProperty(g, name, {
    configurable: true,
    enumerable: existing ? existing.enumerable : true,
    get: function hookedGet() {
      return current;
    },
    set: function hookedSet(value: unknown) {
      current = instrument(name, value);
    },
  });
}

/** Runs `callback` with the value of `global[name]` as soon as it exists. */
export function whenGlobal(name: string, callback: (value: unknown) => void): void {
  let fired = false;
  hookGlobal(name, function onDefined(value) {
    if (!fired && value != null) {
      fired = true;
      callback(value);
    }
    return value;
  });
}
