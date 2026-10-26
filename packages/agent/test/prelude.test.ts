import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { wireBatchSchema, type WireEvent } from '@rnpa/shared';

/**
 * Runs the built prelude in an isolated VM that mimics how React Native
 * defines its globals (lazy polyfill getters, XHR-backed fetch, the DevTools
 * hook) and decodes what the agent writes to the logcat channel.
 */

const prelude = readFileSync(join(__dirname, '..', 'dist', 'prelude.js'), 'utf8');

class FakeXhr {
  status = 0;
  readyState = 0;
  responseType = '';
  responseText = '';
  response: unknown = null;
  private listeners: Record<string, (() => void)[]> = {};
  open(_m: string, _u: string) {}
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return name === 'content-length' ? '42' : null;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  send() {
    setTimeout(() => {
      this.readyState = 2;
      this.listeners.readystatechange?.forEach((f) => f());
      this.status = 200;
      this.readyState = 4;
      this.responseText = 'x'.repeat(42);
      this.listeners.load?.forEach((f) => f());
      this.listeners.loadend?.forEach((f) => f());
    }, 20);
  }
}

function setup() {
  const lines: string[] = [];
  const context = vm.createContext({
    nativeLoggingHook: (message: string) => lines.push(message),
    nativePerformanceNow: () => performance.now(),
    console,
  });
  vm.runInContext(`globalThis.__RNPA_CONFIG__ = { channel: 'test', transport: 'logcat', intervals: { flushMs: 50 } };\n${prelude}`, context);

  // React Native's InitializeCore: lazy getters through Object.defineProperty (polyfillGlobal).
  const define = (name: string, value: unknown) =>
    vm.runInContext(`(name, value) => Object.defineProperty(globalThis, name, { get: () => value, configurable: true, enumerable: true })`, context)(name, value);
  define('setTimeout', setTimeout);
  define('clearTimeout', clearTimeout);
  define('setInterval', setInterval);
  define('clearInterval', clearInterval);
  define('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16));
  define('XMLHttpRequest', FakeXhr);
  // whatwg-fetch style: fetch creates an XHR synchronously.
  define('fetch', function fetch(url: string) {
    const Xhr = vm.runInContext('XMLHttpRequest', context) as typeof FakeXhr;
    const xhr = new Xhr();
    xhr.open('GET', url);
    return new Promise((resolve) => {
      xhr.addEventListener('loadend', () => resolve({ status: xhr.status, headers: { get: () => null } }));
      xhr.send();
    });
  });

  const decode = (): WireEvent[] => {
    const parts = new Map<string, string[]>();
    for (const line of lines) {
      const [prefix, instance, seq, index, count, ...rest] = line.split('|');
      if (prefix !== 'RNPA1') continue;
      const key = `${instance}|${seq}`;
      const list = parts.get(key) ?? new Array(Number(count));
      list[Number(index)] = rest.join('|');
      parts.set(key, list);
    }
    return [...parts.values()].flatMap((chunks) => wireBatchSchema.parse(JSON.parse(chunks.join(''))).e);
  };
  return { context, decode };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agent prelude', () => {
  it('captures startup, timers, network, renders and navigation without double counting fetch', async () => {
    const { context, decode } = setup();
    const run = <T>(code: string) => vm.runInContext(code, context) as T;

    // A slow timer callback → FUNCTION + TIMER.
    run(`setTimeout(function heavyWork(){ const end = Date.now() + 20; while (Date.now() < end) {} }, 0)`);
    // fetch goes through XHR; must produce exactly one API pair, labelled fetch.
    run(`fetch('https://api.example.com/users/42?token=secret')`);

    // React commits through the DevTools hook with a React Navigation state.
    const hook = run<{ inject(r: unknown): number; onCommitFiberRoot(id: number, root: unknown): void }>('__REACT_DEVTOOLS_GLOBAL_HOOK__');
    const id = hook.inject({});
    const screen = { tag: 0, type: function HomeScreen() {}, child: null, sibling: null, alternate: null, flags: 1, memoizedProps: {} };
    const navigator = {
      tag: 0,
      type: function NativeStackView() {},
      child: screen,
      sibling: null,
      alternate: null,
      flags: 1,
      memoizedProps: { state: { key: 'stack-1', index: 0, routeNames: ['Home'], routes: [{ name: 'Home', key: 'Home-1' }] } },
    };
    hook.onCommitFiberRoot(id, { current: { tag: 3, child: navigator, sibling: null, alternate: null } });

    await wait(300);
    const events = decode();
    const types = events.map((e) => e.t);

    expect(types).toContain('JS_INIT');
    expect(types).toContain('FIRST_RENDER');
    expect(types).toContain('SCREEN_ENTER');
    expect(events.find((e) => e.t === 'SCREEN_ENTER')?.s).toBe('Home');
    expect(types).toContain('RENDER');
    const render = events.find((e) => e.t === 'RENDER');
    expect((render?.m?.components as { name: string }[]).map((c) => c.name)).toEqual(expect.arrayContaining(['HomeScreen', 'NativeStackView']));

    const fn = events.find((e) => e.t === 'FUNCTION');
    expect(fn?.m?.name).toBe('heavyWork');
    expect(fn?.d).toBeGreaterThanOrEqual(15);

    const apiStarts = events.filter((e) => e.t === 'API_START');
    const apiEnds = events.filter((e) => e.t === 'API_END');
    expect(apiStarts).toHaveLength(1);
    expect(apiEnds).toHaveLength(1);
    expect(apiEnds[0]?.m?.client).toBe('fetch');
    expect(apiEnds[0]?.m?.status).toBe(200);
    expect(apiEnds[0]?.m?.responseSize).toBe(42);
    expect(apiEnds[0]?.m?.url).toBe('https://api.example.com/users/42?token=[redacted]');
  });

  it('is idempotent when loaded twice', () => {
    const { context } = setup();
    const first = vm.runInContext('__RNPA_AGENT__', context);
    vm.runInContext(prelude, context);
    expect(vm.runInContext('__RNPA_AGENT__', context)).toBe(first);
  });
});
