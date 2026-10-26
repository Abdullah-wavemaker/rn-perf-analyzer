import type { EventSource, EventType } from '@rnpa/shared';

/** An event before the session assigns its id (and, if missing, its screen). */
export interface NewEvent {
  ts: number;
  type: EventType;
  source: EventSource;
  duration?: number | null;
  screen?: string | null;
  metadata: Record<string, unknown>;
}

export type Emit = (events: NewEvent[]) => void;
export type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface Collector {
  start(): void;
  stop(): void;
}

/** Runs `tick` every `intervalMs`, never overlapping, until stopped. */
export function poller(intervalMs: number, tick: () => Promise<void>, onError: (error: unknown) => void): Collector {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = true;
  const loop = async () => {
    if (stopped) return;
    const started = Date.now();
    running = true;
    try {
      await tick();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(loop, Math.max(50, intervalMs - (Date.now() - started)));
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (!running) void loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
