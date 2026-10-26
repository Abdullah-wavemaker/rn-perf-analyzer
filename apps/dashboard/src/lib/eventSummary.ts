import type { PerfEvent } from '@rnpa/shared';
import { fmtKb, fmtMs, urlPath } from './format';

function rec(ev: PerfEvent): Record<string, unknown> {
  const m: unknown = ev.metadata;
  return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One-line, text-only description of an event for feeds and lists. */
export function summarizeEvent(ev: PerfEvent): string {
  const m = rec(ev);
  const dur = ev.duration !== null && ev.duration !== undefined ? fmtMs(ev.duration) : null;
  switch (ev.type) {
    case 'API_START':
      return `${s(m.method) ?? ''} ${urlPath(s(m.url) ?? '')}`.trim();
    case 'API_END': {
      const status = n(m.status);
      const err = s(m.error);
      return `${s(m.method) ?? ''} ${urlPath(s(m.url) ?? '')} → ${err ? `failed: ${err}` : (status ?? '—')}${dur ? ` · ${dur}` : ''}`.trim();
    }
    case 'SCREEN_ENTER':
      return `${s(m.previous) ? `${s(m.previous)} → ` : ''}${ev.screen ?? '?'}`;
    case 'SCREEN_RENDER':
    case 'SCREEN_READY':
      return `${ev.screen ?? '?'}${s(m.reason) ? ` (${s(m.reason)})` : ''}${dur ? ` · ${dur}` : ''}`;
    case 'FUNCTION':
      return `${s(m.name) ?? 'function'}${dur ? ` · ${dur}` : ''}${s(m.origin) ? ` (${s(m.origin)})` : ''}`;
    case 'TIMER':
      return `${s(m.kind) ?? 'timer'} ${s(m.phase) ?? ''}${s(m.name) ? ` ${s(m.name)}` : ''}${n(m.lateness) ? ` · late ${fmtMs(n(m.lateness))}` : ''}${dur ? ` · ${dur}` : ''}`;
    case 'LONG_TASK': {
      const sus = Array.isArray(m.suspects) ? m.suspects.length : 0;
      return `${dur ?? ''} blocked${sus ? ` · ${sus} suspect${sus === 1 ? '' : 's'}` : ''}`;
    }
    case 'RENDER':
      return `commit #${n(m.commit) ?? '?'} · ${n(m.totalComponents) ?? '?'} components${dur ? ` · ${dur}` : ''}`;
    case 'FPS':
      return `${s(m.thread) ?? '?'} ${n(m.fps)?.toFixed(1) ?? '?'} fps${n(m.janky) ? ` · ${n(m.janky)} janky` : ''}`;
    case 'FRAME_DROP':
      return `${n(m.droppedFrames) ?? '?'} frames dropped on ${s(m.thread) ?? '?'} thread`;
    case 'MEMORY':
      return s(m.origin) === 'js'
        ? `JS heap ${fmtKb(n(m.jsHeapKb))}`
        : `PSS ${fmtKb(n(m.totalPssKb))} · Java ${fmtKb(n(m.javaHeapKb))} · native ${fmtKb(n(m.nativeHeapKb))}`;
    case 'CPU':
      return `total ${n(m.total)?.toFixed(1) ?? '?'}%${n(m.ui) !== null ? ` · UI ${n(m.ui)?.toFixed(1)}%` : ''}${n(m.js) !== null ? ` · JS ${n(m.js)?.toFixed(1)}%` : ''}`;
    case 'USER_ACTION':
      return `${s(m.kind) ?? 'action'}${s(m.label) ? ` “${s(m.label)}”` : ''} via ${s(m.origin) ?? '?'}`;
    case 'STARTUP':
      return `${s(m.kind) ?? ''} start · TTID ${fmtMs(n(m.totalTime) ?? ev.duration)}${s(m.launchState) ? ` · ${s(m.launchState)}` : ''}`;
    case 'ERROR':
    case 'CRASH':
      return `${s(m.kind) ? `[${s(m.kind)}] ` : ''}${s(m.message) ?? 'unknown error'}`;
    case 'MARK':
      return s(m.name) ?? s(m.label) ?? 'mark';
    case 'APP_STATE':
      return s(m.state) ?? '';
    default:
      return dur ?? '';
  }
}
