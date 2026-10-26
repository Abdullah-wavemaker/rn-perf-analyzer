import { z } from 'zod';
import { badRequest } from '../errors.js';
import type { NewEvent } from '../collectors/types.js';

/**
 * Converts a Chrome-format CPU profile (what Hermes produces through
 * `react-native profile-hermes` or the CDP Profiler domain) into FUNCTION
 * events: runs of consecutive samples in the same leaf function become one
 * span with the function's self time. Spans shorter than `minSpanMs` are
 * dropped to keep the timeline readable.
 */

const callFrame = z.object({
  functionName: z.string().max(1000),
  url: z.string().max(2000).optional(),
  lineNumber: z.number().int().optional(),
  columnNumber: z.number().int().optional(),
});

const node = z.object({
  id: z.number().int(),
  callFrame,
  children: z.array(z.number().int()).optional(),
});

export const cpuProfileSchema = z.object({
  nodes: z.array(node).min(1).max(2_000_000),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number().int()).max(20_000_000),
  timeDeltas: z.array(z.number()).max(20_000_000),
});

export type CpuProfile = z.infer<typeof cpuProfileSchema>;

const IGNORED = new Set(['(root)', '(program)', '(idle)', '(garbage collector)', '']);
const MAX_EVENTS = 50_000;

export interface ProfileMapping {
  /** Host epoch ms that corresponds to the profile's startTime. */
  hostStart: number;
  /** Optional host epoch ms at endTime, to correct for clock-rate differences. */
  hostEnd?: number;
}

export function parseCpuProfile(input: unknown): CpuProfile {
  const parsed = cpuProfileSchema.safeParse(input);
  if (!parsed.success) throw badRequest(`Not a CPU profile: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 'INVALID_PROFILE');
  if (parsed.data.samples.length !== parsed.data.timeDeltas.length) throw badRequest('Profile samples and timeDeltas differ in length', 'INVALID_PROFILE');
  return parsed.data;
}

export function profileToEvents(profile: CpuProfile, mapping: ProfileMapping, minSpanMs = 2): NewEvent[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const durationUs = Math.max(1, profile.endTime - profile.startTime);
  const scale = mapping.hostEnd !== undefined ? (mapping.hostEnd - mapping.hostStart) / (durationUs / 1000) : 1;
  const toHost = (us: number) => mapping.hostStart + ((us - profile.startTime) / 1000) * scale;

  const events: NewEvent[] = [];
  let t = profile.startTime;
  let span: { nodeId: number; start: number; end: number } | null = null;
  const flush = () => {
    if (!span || events.length >= MAX_EVENTS) return;
    const n = byId.get(span.nodeId);
    const name = n?.callFrame.functionName || '(anonymous)';
    const durationMs = ((span.end - span.start) / 1000) * scale;
    if (n && !IGNORED.has(n.callFrame.functionName) && durationMs >= minSpanMs) {
      events.push({
        ts: toHost(span.start),
        type: 'FUNCTION',
        source: 'profiler',
        duration: Math.round(durationMs * 100) / 100,
        metadata: {
          name: name.slice(0, 200),
          origin: 'profile',
          selfTime: Math.round(durationMs * 100) / 100,
          url: n.callFrame.url ? n.callFrame.url.slice(0, 300) : undefined,
          line: n.callFrame.lineNumber,
        },
      });
    }
  };
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] as number;
    const id = profile.samples[i] as number;
    // A sample lasts until the next one; the last sample reuses the previous interval.
    const next = profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0;
    if (span && span.nodeId === id) {
      span.end = t + Math.max(0, next);
    } else {
      flush();
      span = { nodeId: id, start: t, end: t + Math.max(0, next) };
    }
  }
  flush();
  return events;
}

/** Profiles whose clock looks like epoch microseconds can be placed directly. */
export function looksLikeEpochMicros(profile: CpuProfile): boolean {
  return profile.startTime > 1e15 && profile.startTime < 1e17;
}
