import { WIRE_VERSION, type EventType, type WireEvent } from '@rnpa/shared/events';
import { redactUrl } from '@rnpa/shared/redact';
import type { AgentConfig } from './config.js';
import { now, originals, randomId } from './env.js';
import type { Transport } from './transport.js';

export interface CallbackSample {
  name: string;
  start: number;
  duration: number;
}

export interface Recorder {
  readonly instanceId: string;
  emit(type: EventType, metadata?: Record<string, unknown>, duration?: number, ts?: number): void;
  getScreen(): string | null;
  setScreen(screen: string | null): void;
  /** Records a JS callback execution for long-task attribution. */
  noteCallback(name: string, start: number, duration: number): void;
  /** Callbacks that ran within [from, to]. */
  callbacksBetween(from: number, to: number): CallbackSample[];
  /** Starts the periodic flush once timers exist. Safe to call repeatedly. */
  ensureScheduled(): void;
  flush(): void;
}

const RING_SIZE = 256;

export function createRecorder(config: AgentConfig, transport: Transport): Recorder {
  const instanceId = randomId();
  const buffer: WireEvent[] = [];
  const ring: CallbackSample[] = [];
  let ringIndex = 0;
  let screen: string | null = null;
  let seq = 0;
  let dropped = 0;
  let scheduled = false;

  function emit(type: EventType, metadata?: Record<string, unknown>, duration?: number, ts?: number): void {
    if (buffer.length >= config.limits.maxBufferedEvents) {
      dropped++;
      return;
    }
    const event: WireEvent = { t: type, ts: ts !== undefined ? ts : now() };
    if (screen !== null) event.s = screen;
    if (duration !== undefined && duration >= 0) event.d = Math.round(duration * 100) / 100;
    if (metadata) {
      if (typeof metadata.url === 'string') metadata.url = redactUrl(metadata.url);
      event.m = metadata;
    }
    buffer.push(event);
    if (buffer.length >= config.limits.maxEventsPerBatch) flush();
  }

  function flush(): void {
    if (buffer.length === 0 && dropped === 0) return;
    if (dropped > 0) {
      buffer.push({ t: 'MARK', ts: now(), m: { name: 'rnpa:dropped', count: dropped } });
      dropped = 0;
    }
    while (buffer.length > 0) {
      const events = buffer.slice(0, config.limits.maxEventsPerBatch);
      const ok = transport.send({ v: WIRE_VERSION, i: instanceId, c: config.channel, q: seq, n: Date.now(), e: events });
      if (!ok) return;
      seq++;
      buffer.splice(0, events.length);
    }
  }

  function tick(): void {
    try {
      flush();
    } finally {
      const st = originals.setTimeout;
      if (st) st(tick, config.intervals.flushMs);
    }
  }

  return {
    instanceId,
    emit,
    flush,
    getScreen: () => screen,
    setScreen(next) {
      screen = next;
    },
    noteCallback(name, start, duration) {
      ring[ringIndex] = { name, start, duration };
      ringIndex = (ringIndex + 1) % RING_SIZE;
    },
    callbacksBetween(from, to) {
      const out: CallbackSample[] = [];
      for (let i = 0; i < ring.length; i++) {
        const sample = ring[i];
        if (sample && sample.start + sample.duration >= from && sample.start <= to) out.push(sample);
      }
      return out.sort((a, b) => b.duration - a.duration);
    },
    ensureScheduled() {
      if (scheduled || !originals.setTimeout) return;
      scheduled = true;
      originals.setTimeout(tick, config.intervals.flushMs);
    },
  };
}
