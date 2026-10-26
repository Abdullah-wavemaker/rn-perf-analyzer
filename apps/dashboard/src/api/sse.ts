import { useEffect, useRef, useState } from 'react';
import type { LogLevel, LogMessage, PerfEvent, Session } from './types';
import { authStore } from './client';

export const LIVE_EVENT_CAP = 5000;
export const LOG_CAP = 500;

/** Fixed-capacity buffer; keeps the newest `cap` items. */
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}

  pushMany(next: readonly T[]): void {
    if (next.length === 0) return;
    if (next.length >= this.cap) {
      this.items = next.slice(next.length - this.cap);
      return;
    }
    this.items.push(...next);
    const overflow = this.items.length - this.cap;
    if (overflow > 0) this.items.splice(0, overflow);
  }

  clear(): void {
    this.items = [];
  }

  /** Oldest → newest snapshot (copy). */
  toArray(): T[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function asSession(v: unknown): Session | null {
  return isRecord(v) && typeof v.id === 'string' && typeof v.status === 'string' ? (v as unknown as Session) : null;
}

function asEvents(v: unknown): PerfEvent[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is PerfEvent => isRecord(e) && typeof e.id === 'string' && typeof e.ts === 'number' && typeof e.type === 'string',
  );
}

function asLog(v: unknown): LogMessage | null {
  if (!isRecord(v) || typeof v.message !== 'string') return null;
  const level: LogLevel = v.level === 'warn' || v.level === 'error' ? v.level : 'info';
  return { ts: typeof v.ts === 'number' ? v.ts : Date.now(), level, message: v.message };
}

export interface SessionStream {
  /** Latest session status pushed by the server (null until first `status`). */
  session: Session | null;
  /** Newest-last snapshot of the bounded live buffer. */
  events: PerfEvent[];
  /** Total events received over this connection (not bounded). */
  received: number;
  logs: LogMessage[];
  connected: boolean;
  clear: () => void;
}

/**
 * Subscribes to `/api/sessions/:id/stream`. Event batches are coalesced into
 * at most ~4 renders/s regardless of server batch rate.
 */
export function useSessionStream(sessionId: string | null): SessionStream {
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<{ events: PerfEvent[]; logs: LogMessage[]; received: number }>({
    events: [],
    logs: [],
    received: 0,
  });
  const eventsBuf = useRef(new RingBuffer<PerfEvent>(LIVE_EVENT_CAP));
  const logsBuf = useRef(new RingBuffer<LogMessage>(LOG_CAP));
  const received = useRef(0);
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    eventsBuf.current.clear();
    logsBuf.current.clear();
    received.current = 0;
    setSnapshot({ events: [], logs: [], received: 0 });
    setSession(null);

    const flush = () => {
      flushTimer.current = null;
      setSnapshot({
        events: eventsBuf.current.toArray(),
        logs: logsBuf.current.toArray(),
        received: received.current,
      });
    };
    const scheduleFlush = () => {
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, 250);
    };

    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
    let errorCount = 0;
    es.onopen = () => {
      errorCount = 0;
      setConnected(true);
    };
    es.onerror = () => {
      setConnected(false);
      errorCount += 1;
      // EventSource hides the HTTP status. After repeated failures, probe auth.
      if (errorCount === 3) {
        fetch('/api/env', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => {
            if (r.status === 401) authStore.markUnauthenticated();
          })
          .catch(() => undefined);
      }
    };
    es.addEventListener('status', (ev) => {
      const s = asSession(parseJson((ev as MessageEvent).data));
      if (s) setSession(s);
    });
    es.addEventListener('events', (ev) => {
      const batch = asEvents(parseJson((ev as MessageEvent).data));
      if (batch.length === 0) return;
      received.current += batch.length;
      eventsBuf.current.pushMany(batch);
      scheduleFlush();
    });
    es.addEventListener('log', (ev) => {
      const log = asLog(parseJson((ev as MessageEvent).data));
      if (!log) return;
      logsBuf.current.pushMany([log]);
      scheduleFlush();
    });

    return () => {
      es.close();
      setConnected(false);
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [sessionId]);

  const clear = () => {
    eventsBuf.current.clear();
    logsBuf.current.clear();
    setSnapshot({ events: [], logs: [], received: received.current });
  };

  return { session, events: snapshot.events, received: snapshot.received, logs: snapshot.logs, connected, clear };
}
