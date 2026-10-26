import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';
import { api, isAbort } from './client';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** True only for the very first load (no data yet). */
  initialLoading: boolean;
  reload: () => void;
  setData: (updater: (prev: T | undefined) => T | undefined) => void;
}

export interface UseApiOptions<T> {
  /** Poll interval. Polling is skipped while the tab is hidden. */
  pollMs?: number | null;
  /** Keep polling only while this returns true. */
  pollWhile?: (data: T | undefined) => boolean;
}

/**
 * Minimal data hook: fetches `path` (null = idle), keeps the previous data
 * while refetching (no skeleton flash), optional polling.
 */
export function useApi<T>(path: string | null, options: UseApiOptions<T> = {}): ApiState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);
  const optsRef = useRef(options);
  optsRef.current = options;
  const dataRef = useRef<T | undefined>(undefined);
  const pathRef = useRef(path);

  // Reset when the resource changes.
  if (pathRef.current !== path) {
    pathRef.current = path;
    dataRef.current = undefined;
  }

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let timer: number | undefined;
    let disposed = false;

    const run = async () => {
      if (document.hidden && dataRef.current !== undefined) {
        schedule();
        return;
      }
      setLoading(true);
      try {
        const result = await api.get<T>(path, { signal: ctrl.signal });
        if (disposed) return;
        dataRef.current = result;
        setDataState(result);
        setError(null);
      } catch (err) {
        if (disposed || isAbort(err)) return;
        setError(err);
      } finally {
        if (!disposed) setLoading(false);
      }
      schedule();
    };

    const schedule = () => {
      if (disposed) return;
      const { pollMs, pollWhile } = optsRef.current;
      if (!pollMs) return;
      if (pollWhile && !pollWhile(dataRef.current)) return;
      timer = window.setTimeout(run, pollMs);
    };

    void run();
    return () => {
      disposed = true;
      ctrl.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // options.pollMs participates so enabling polling restarts the loop.
  }, [path, nonce, options.pollMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: (prev: T | undefined) => T | undefined) => {
    setDataState((prev) => {
      const next = updater(prev);
      dataRef.current = next;
      return next;
    });
  }, []);

  return {
    data: path === null ? undefined : data,
    error,
    loading,
    initialLoading: loading && data === undefined,
    reload,
    setData,
  };
}

/** Re-render every `ms` (for elapsed timers and relative times). */
export function useNow(ms: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return now;
}

/** Observe an element's content-box size. */
export function useElementSize<E extends HTMLElement>(): [RefCallback<E>, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: E | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        Math.round(prev.width) === Math.round(width) && Math.round(prev.height) === Math.round(height)
          ? prev
          : { width, height },
      );
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  return [ref, size];
}

/** Track an async action's pending state. */
export function useAsyncAction(): [boolean, <R>(fn: () => Promise<R>) => Promise<R>] {
  const [pending, setPending] = useState(0);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R> => {
    setPending((n) => n + 1);
    try {
      return await fn();
    } finally {
      setPending((n) => n - 1);
    }
  }, []);
  return [pending > 0, run];
}
