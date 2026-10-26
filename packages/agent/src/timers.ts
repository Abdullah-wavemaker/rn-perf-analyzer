import type { TimerKind } from '@rnpa/shared/events';
import type { AgentConfig } from './config.js';
import { type AnyFn, fnName, g, now, originals } from './env.js';
import { hookGlobal } from './hooks.js';
import type { Recorder } from './recorder.js';

/**
 * Timer, animation-frame and event-loop instrumentation.
 *
 * - Every scheduled callback is wrapped to measure how late it ran and how
 *   long it took. Only outliers become events (FUNCTION / TIMER), plus a
 *   periodic TIMER summary with counts — so overhead and volume stay bounded.
 * - A heartbeat on the *original* setTimeout detects event-loop blocks
 *   (LONG_TASK) and attributes them to callbacks that ran in the window.
 * - A requestAnimationFrame loop measures JS-thread FPS and dropped frames.
 */
export function installTimerInstrumentation(config: AgentConfig, recorder: Recorder, onTimersReady: () => void): void {
  const created: Partial<Record<TimerKind, number>> = {};
  const fired: Partial<Record<TimerKind, number>> = {};
  const activeIntervals: Record<string, true> = {};
  let activeIntervalCount = 0;
  let maxActiveIntervals = 0;
  let readyNotified = false;

  function bump(map: Partial<Record<TimerKind, number>>, kind: TimerKind): void {
    map[kind] = (map[kind] || 0) + 1;
  }

  function wrapCallback(kind: TimerKind, callback: AnyFn, requestedDelay: number): AnyFn {
    const scheduledAt = now();
    const name = fnName(callback);
    return function rnpaTimerCallback(this: unknown) {
      const start = now();
      bump(fired, kind);
      try {
        // eslint-disable-next-line prefer-rest-params
        return callback.apply(this, arguments as unknown as unknown[]);
      } finally {
        const end = now();
        const duration = end - start;
        if (duration >= 1) recorder.noteCallback(name, start, duration);
        const lateness = kind === 'timeout' || kind === 'interval' ? start - scheduledAt - requestedDelay : 0;
        if (duration >= config.thresholds.functionMs) {
          recorder.emit('FUNCTION', { name, origin: 'callback', timer: kind }, duration, start);
        }
        if (lateness >= config.thresholds.timerLatenessMs || duration >= config.thresholds.functionMs) {
          recorder.emit(
            'TIMER',
            { kind, phase: 'fire', name, requestedDelay, lateness: Math.round(lateness) },
            duration,
            start,
          );
        }
      }
    };
  }

  let fpsStarted = false;

  /** Called whenever an original timer becomes known; starts samplers once their dependency exists. */
  function markReady(): void {
    if (!readyNotified && originals.setTimeout) {
      readyNotified = true;
      onTimersReady();
      scheduleSummary();
      if (config.instrument.longTasks) startHeartbeat();
      // RN defines timers lazily; touching rAF forces its (already loaded) polyfill to resolve.
      (originals.setTimeout as AnyFn)(function resolveRaf() {
        void g.requestAnimationFrame;
      }, 0);
    }
    if (!fpsStarted && config.instrument.fps && readyNotified && originals.requestAnimationFrame) {
      fpsStarted = true;
      startFpsLoop();
    }
  }

  hookGlobal('setTimeout', function instrumentSetTimeout(original) {
    if (typeof original !== 'function') return original;
    originals.setTimeout = original as AnyFn;
    markReady();
    return function setTimeout(this: unknown, callback: unknown, delay?: number) {
      // eslint-disable-next-line prefer-rest-params
      const args = Array.prototype.slice.call(arguments);
      if (typeof callback === 'function') {
        bump(created, 'timeout');
        args[0] = wrapCallback('timeout', callback as AnyFn, Number(delay) || 0);
      }
      return (original as AnyFn).apply(this, args);
    };
  });

  hookGlobal('clearTimeout', function instrumentClearTimeout(original) {
    if (typeof original === 'function') originals.clearTimeout = original as AnyFn;
    return original;
  });

  hookGlobal('setInterval', function instrumentSetInterval(original) {
    if (typeof original !== 'function') return original;
    originals.setInterval = original as AnyFn;
    return function setInterval(this: unknown, callback: unknown, delay?: number) {
      // eslint-disable-next-line prefer-rest-params
      const args = Array.prototype.slice.call(arguments);
      const isFn = typeof callback === 'function';
      if (isFn) {
        bump(created, 'interval');
        args[0] = wrapCallback('interval', callback as AnyFn, Number(delay) || 0);
      }
      const id = (original as AnyFn).apply(this, args);
      if (isFn) {
        activeIntervals[String(id)] = true;
        activeIntervalCount++;
        if (activeIntervalCount > maxActiveIntervals) maxActiveIntervals = activeIntervalCount;
        recorder.emit('TIMER', { kind: 'interval', phase: 'create', name: fnName(callback), requestedDelay: Number(delay) || 0 });
      }
      return id;
    };
  });

  hookGlobal('clearInterval', function instrumentClearInterval(original) {
    if (typeof original !== 'function') return original;
    originals.clearInterval = original as AnyFn;
    return function clearInterval(this: unknown, id: unknown) {
      if (activeIntervals[String(id)]) {
        delete activeIntervals[String(id)];
        activeIntervalCount--;
      }
      // eslint-disable-next-line prefer-rest-params
      return (original as AnyFn).apply(this, arguments as unknown as unknown[]);
    };
  });

  hookGlobal('setImmediate', function instrumentSetImmediate(original) {
    if (typeof original !== 'function') return original;
    return function setImmediate(this: unknown, callback: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const args = Array.prototype.slice.call(arguments);
      if (typeof callback === 'function') {
        bump(created, 'immediate');
        args[0] = wrapCallback('immediate', callback as AnyFn, 0);
      }
      return (original as AnyFn).apply(this, args);
    };
  });

  hookGlobal('requestAnimationFrame', function instrumentRaf(original) {
    if (typeof original !== 'function') return original;
    originals.requestAnimationFrame = original as AnyFn;
    markReady();
    return function requestAnimationFrame(this: unknown, callback: unknown) {
      if (typeof callback !== 'function') return (original as AnyFn).call(this, callback);
      bump(created, 'raf');
      return (original as AnyFn).call(this, wrapCallback('raf', callback as AnyFn, 0));
    };
  });

  markReady();

  function scheduleSummary(): void {
    const st = originals.setTimeout as AnyFn;
    st(function timerSummary() {
      recorder.emit('TIMER', {
        kind: 'timeout',
        phase: 'summary',
        counts: Object.assign({}, created),
        fired: Object.assign({}, fired),
        activeIntervals: activeIntervalCount,
        maxActiveIntervals,
      });
      scheduleSummary();
    }, config.intervals.timerSummaryMs);
  }

  function startHeartbeat(): void {
    const st = originals.setTimeout as AnyFn;
    const interval = config.intervals.heartbeatMs;
    let expected = now() + interval;
    st(function heartbeat() {
      const t = now();
      const lag = t - expected;
      // Ignore huge gaps: the app was backgrounded or the device slept.
      if (lag >= config.thresholds.longTaskMs && lag < 30000) {
        const blockStart = expected - interval;
        const suspects = recorder.callbacksBetween(blockStart, t).slice(0, 5).map(function toSuspect(s) {
          return { name: s.name, duration: Math.round(s.duration * 10) / 10 };
        });
        recorder.emit('LONG_TASK', { suspects }, lag, expected);
      }
      expected = now() + interval;
      st(heartbeat, interval);
    }, interval);
  }

  function startFpsLoop(): void {
    const raf = originals.requestAnimationFrame as AnyFn;
    const budget = config.thresholds.frameBudgetMs;
    let windowStart = now();
    let frames = 0;
    let last = 0;
    raf(function frame() {
      const t = now();
      if (last > 0) {
        const delta = t - last;
        if (delta < 1000) {
          const dropped = Math.round(delta / budget) - 1;
          if (dropped >= config.thresholds.droppedFrames) {
            recorder.emit('FRAME_DROP', { thread: 'js', droppedFrames: dropped }, delta, last);
          }
        } else {
          // Long pause (background / sleep): restart the window.
          windowStart = t;
          frames = 0;
        }
      }
      last = t;
      frames++;
      const elapsed = t - windowStart;
      if (elapsed >= config.intervals.fpsWindowMs) {
        recorder.emit('FPS', { thread: 'js', fps: Math.round((frames * 10000) / elapsed) / 10, frames }, elapsed, windowStart);
        windowStart = t;
        frames = 0;
      }
      raf(frame);
    });
  }
}
