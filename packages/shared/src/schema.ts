import { z } from 'zod';
import { EVENT_TYPES, WIRE_VERSION } from './events.js';

/**
 * Validation for everything that crosses a trust boundary into the host:
 * agent batches (from logcat or HTTP) and imported event files. Limits are
 * deliberately tight — a misbehaving or hostile app must not be able to
 * exhaust host memory or disk through the collector.
 */

export const LIMITS = {
  maxEventsPerBatch: 500,
  maxMetadataBytes: 16 * 1024,
  maxScreenNameLength: 200,
  maxBatchBytes: 512 * 1024,
  maxEventsPerSession: 2_000_000,
} as const;

const finite = z.number().finite();

const metadata = z
  .record(z.string().max(64), z.unknown())
  .refine((m) => JSON.stringify(m).length <= LIMITS.maxMetadataBytes, {
    message: `metadata exceeds ${LIMITS.maxMetadataBytes} bytes`,
  });

export const wireEventSchema = z.object({
  t: z.enum(EVENT_TYPES),
  ts: finite.positive(),
  s: z.string().max(LIMITS.maxScreenNameLength).nullable().optional(),
  d: finite.min(0).max(24 * 60 * 60 * 1000).optional(),
  m: metadata.optional(),
});

export const wireBatchSchema = z.object({
  v: z.literal(WIRE_VERSION),
  i: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  c: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  q: z.number().int().min(0),
  n: finite.positive(),
  e: z.array(wireEventSchema).max(LIMITS.maxEventsPerBatch),
});

export type ParsedWireBatch = z.infer<typeof wireBatchSchema>;

export const perfEventSchema = z.object({
  id: z.string().max(64),
  ts: finite,
  type: z.enum(EVENT_TYPES),
  screen: z.string().max(LIMITS.maxScreenNameLength).nullable(),
  duration: finite.min(0).nullable(),
  source: z.enum(['agent', 'device', 'host', 'profiler', 'analyzer']),
  metadata,
});
