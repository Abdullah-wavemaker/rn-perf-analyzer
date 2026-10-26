import type { AnyFn } from './env.js';
import { whenGlobal } from './hooks.js';
import type { Recorder } from './recorder.js';

/**
 * Observes uncaught JS errors through React Native's `ErrorUtils`. The app's
 * own handler (red box, crash reporter) always still runs. Fatal errors flush
 * the buffer synchronously because the process may be about to die.
 */
export function installErrorInstrumentation(recorder: Recorder): void {
  whenGlobal('ErrorUtils', function onErrorUtils(value) {
    const errorUtils = value as {
      setGlobalHandler?: AnyFn;
      getGlobalHandler?: AnyFn;
    };
    if (typeof errorUtils.setGlobalHandler !== 'function') return;
    const setGlobalHandler = errorUtils.setGlobalHandler;

    function wrap(handler: unknown): unknown {
      if (typeof handler !== 'function' || (handler as { __rnpa?: boolean }).__rnpa) return handler;
      const wrapped = function rnpaGlobalErrorHandler(this: unknown, error: unknown, isFatal?: boolean) {
        try {
          const e = error as { message?: unknown; stack?: unknown } | null;
          const message = e && typeof e.message === 'string' ? e.message : String(error);
          const stack = e && typeof e.stack === 'string' ? e.stack : undefined;
          recorder.emit('ERROR', {
            message: message.slice(0, 1000),
            stack: stack ? stack.slice(0, 4000) : undefined,
            fatal: !!isFatal,
            kind: 'js',
          });
          if (isFatal) recorder.flush();
        } catch {
          /* ignore */
        }
        // eslint-disable-next-line prefer-rest-params
        return (handler as AnyFn).apply(this, arguments as unknown as unknown[]);
      };
      (wrapped as { __rnpa?: boolean }).__rnpa = true;
      return wrapped;
    }

    errorUtils.setGlobalHandler = function rnpaSetGlobalHandler(this: unknown, handler: unknown) {
      return setGlobalHandler.call(this, wrap(handler));
    };
    const current = typeof errorUtils.getGlobalHandler === 'function' ? errorUtils.getGlobalHandler() : null;
    if (current) setGlobalHandler.call(errorUtils, wrap(current));
  });
}
