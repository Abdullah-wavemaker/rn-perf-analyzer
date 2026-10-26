import type { Adb } from '../android/adb.js';
import { assertPackage, assertPid } from '../android/validate.js';
import { errorMessage } from '../errors.js';
import { type Collector, type Emit, type Log, type NewEvent, poller } from './types.js';

/* ------------------------------------------------------------------------ */
/* Memory: dumpsys meminfo                                                  */
/* ------------------------------------------------------------------------ */

export interface MemInfo {
  totalPssKb: number;
  javaHeapKb: number | null;
  nativeHeapKb: number | null;
  codeKb: number | null;
  stackKb: number | null;
  graphicsKb: number | null;
}

export function parseMeminfo(text: string): MemInfo | null {
  if (/No process found/i.test(text)) return null;
  const grab = (label: string) => {
    const m = new RegExp(`^\\s*${label}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = /TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? /^\s*TOTAL:?\s+(\d+)/m.exec(text)?.[1];
  if (!total) return null;
  return {
    totalPssKb: Number(total),
    javaHeapKb: grab('Java Heap'),
    nativeHeapKb: grab('Native Heap'),
    codeKb: grab('Code'),
    stackKb: grab('Stack'),
    graphicsKb: grab('Graphics'),
  };
}

export function createMemoryCollector(adb: Adb, packageName: string, emit: Emit, log: Log, intervalMs = 2000): Collector {
  const pkg = assertPackage(packageName);
  let failures = 0;
  return poller(
    intervalMs,
    async () => {
      const t0 = Date.now();
      const text = await adb.shell(`dumpsys meminfo ${pkg}`, { timeoutMs: 15_000 });
      const info = parseMeminfo(text);
      if (!info) return;
      failures = 0;
      emit([{ ts: (t0 + Date.now()) / 2, type: 'MEMORY', source: 'device', metadata: { origin: 'device', ...info } }]);
    },
    (error) => {
      if (++failures === 3) log('warn', `Memory sampling failing: ${errorMessage(error)}`);
    },
  );
}

/* ------------------------------------------------------------------------ */
/* CPU: /proc/<pid>/stat and per-thread task stats                          */
/* ------------------------------------------------------------------------ */

export interface ProcSnapshot {
  totalJiffies: number;
  cores: number;
  process: number | null;
  threads: { tid: number; name: string; jiffies: number }[];
}

function parseStatLine(line: string): { id: number; name: string; jiffies: number } | null {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const id = Number.parseInt(line.slice(0, open).trim(), 10);
  const rest = line.slice(close + 2).split(' ');
  // rest[0] = state (field 3); utime = field 14, stime = field 15.
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(id) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { id, name: line.slice(open + 1, close), jiffies: utime + stime };
}

export function parseProcSnapshot(text: string, pid: number): ProcSnapshot | null {
  let totalJiffies = 0;
  let cores = 0;
  let process: number | null = null;
  const threads: ProcSnapshot['threads'] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('cpu ')) {
      totalJiffies = line
        .slice(4)
        .trim()
        .split(/\s+/)
        .slice(0, 8)
        .reduce((s, v) => s + (Number(v) || 0), 0);
    } else if (/^cpu\d+ /.test(line)) {
      cores++;
    } else if (/^\d+ \(/.test(line)) {
      const stat = parseStatLine(line);
      if (!stat) continue;
      if (process === null && stat.id === pid) process = stat.jiffies;
      else threads.push({ tid: stat.id, name: stat.name, jiffies: stat.jiffies });
    }
  }
  if (totalJiffies === 0 || process === null) return null;
  return { totalJiffies, cores: Math.max(1, cores), process, threads };
}

function classifyThread(name: string, tid: number, pid: number): 'ui' | 'js' | 'nativeModules' | 'render' | null {
  if (tid === pid) return 'ui';
  if (name === 'mqt_js' || name === 'mqt_v_js') return 'js';
  if (name.startsWith('mqt_native_modu') || name.startsWith('mqt_v_native')) return 'nativeModules';
  if (name === 'RenderThread') return 'render';
  return null;
}

/** CPU % of one core between two snapshots (100 = one core fully busy). */
export function cpuBetween(prev: ProcSnapshot, next: ProcSnapshot, pid: number): Record<string, number> | null {
  const dTotal = next.totalJiffies - prev.totalJiffies;
  if (dTotal <= 0 || prev.process === null || next.process === null) return null;
  const perCore = dTotal / next.cores;
  const pct = (d: number) => Math.round((Math.max(0, d) / perCore) * 1000) / 10;
  const out: Record<string, number> = { total: pct(next.process - prev.process), cores: next.cores };
  const prevThreads = new Map(prev.threads.map((t) => [t.tid, t.jiffies]));
  const acc: Record<string, number> = {};
  for (const t of next.threads) {
    const kind = classifyThread(t.name, t.tid, pid);
    const before = prevThreads.get(t.tid);
    if (!kind || before === undefined) continue;
    acc[kind] = (acc[kind] ?? 0) + (t.jiffies - before);
  }
  for (const [k, v] of Object.entries(acc)) out[k] = pct(v);
  return out;
}

export function createCpuCollector(adb: Adb, packageName: string, emit: Emit, log: Log, intervalMs = 1000): Collector {
  const pkg = assertPackage(packageName);
  let pid: number | null = null;
  let prev: ProcSnapshot | null = null;
  let pidCheckedAt = 0;
  let failures = 0;
  return poller(
    intervalMs,
    async () => {
      if (pid === null || Date.now() - pidCheckedAt > 5000) {
        const pids = await adb.pids(pkg);
        pidCheckedAt = Date.now();
        const next = pids[0] ?? null;
        if (next !== pid) prev = null;
        pid = next;
      }
      if (pid === null) return;
      const p = assertPid(pid);
      const t0 = Date.now();
      const text = await adb.shell(`cat /proc/stat /proc/${p}/stat /proc/${p}/task/*/stat 2>/dev/null`, { timeoutMs: 10_000, allowFailure: true });
      const snapshot = parseProcSnapshot(text, p);
      if (!snapshot) {
        pid = null;
        prev = null;
        return;
      }
      if (prev) {
        const cpu = cpuBetween(prev, snapshot, p);
        if (cpu) emit([{ ts: (t0 + Date.now()) / 2, type: 'CPU', source: 'device', metadata: cpu }]);
      }
      prev = snapshot;
      failures = 0;
    },
    (error) => {
      if (++failures === 3) log('warn', `CPU sampling failing: ${errorMessage(error)}`);
    },
  );
}

/* ------------------------------------------------------------------------ */
/* Frames: dumpsys gfxinfo framestats                                       */
/* ------------------------------------------------------------------------ */

export interface FrameSample {
  /** CLOCK_MONOTONIC ms */
  start: number;
  duration: number;
}

export function parseFramestats(text: string): { uptimeMs: number | null; frames: FrameSample[] } {
  const uptime = /Uptime:\s*(\d+)/.exec(text);
  const frames: FrameSample[] = [];
  const lines = text.split('\n');
  let columns: string[] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('Flags,')) {
      columns = line.split(',').map((c) => c.trim());
      continue;
    }
    if (line === '---PROFILEDATA---') {
      // Marks both the start and the end of a section; the header follows the start marker.
      columns = null;
      continue;
    }
    if (!columns || !/^\d/.test(line)) continue;
    const values = line.split(',');
    const get = (name: string) => {
      const i = (columns as string[]).indexOf(name);
      return i === -1 ? Number.NaN : Number(values[i]);
    };
    const flags = get('Flags');
    const intended = get('IntendedVsync');
    const completed = get('FrameCompleted');
    if (flags !== 0 || !Number.isFinite(intended) || !Number.isFinite(completed) || completed <= intended) continue;
    frames.push({ start: intended / 1e6, duration: (completed - intended) / 1e6 });
  }
  return { uptimeMs: uptime ? Number(uptime[1]) : null, frames };
}

export function summarizeFrames(frames: FrameSample[], budgetMs: number): { fps: number; janky: number; p50: number; p90: number; p99: number } {
  const durations = frames.map((f) => f.duration).sort((a, b) => a - b);
  const q = (p: number) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] ?? 0;
  const slots = frames.reduce((s, f) => s + Math.max(1, Math.ceil(f.duration / budgetMs - 1e-6)), 0);
  const refresh = 1000 / budgetMs;
  return {
    fps: Math.round(Math.min(refresh, (frames.length / slots) * refresh) * 10) / 10,
    janky: frames.filter((f) => f.duration > budgetMs).length,
    p50: Math.round(q(50) * 10) / 10,
    p90: Math.round(q(90) * 10) / 10,
    p99: Math.round(q(99) * 10) / 10,
  };
}

export function createFrameCollector(adb: Adb, packageName: string, emit: Emit, log: Log, minDroppedFrames = 2, intervalMs = 1000): Collector {
  const pkg = assertPackage(packageName);
  let budgetMs: number | null = null;
  // Only frames rendered after this host time are new; framestats also returns frames from
  // long before recording started (and from previous processes) on the first dump.
  let since = Date.now();
  let failures = 0;
  return poller(
    intervalMs,
    async () => {
      if (budgetMs === null) {
        const display = await adb.shell('dumpsys display', { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 }).catch(() => '');
        const rate = Number(/mRefreshRate=([\d.]+)/.exec(display)?.[1] ?? /refreshRate[=:\s]+([\d.]+)/.exec(display)?.[1] ?? /fps=([\d.]+)/.exec(display)?.[1] ?? 60);
        budgetMs = 1000 / (rate >= 30 && rate <= 240 ? rate : 60);
      }
      const t0 = Date.now();
      const text = await adb.shell(`dumpsys gfxinfo ${pkg} framestats reset`, { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
      const hostAtDump = (t0 + Date.now()) / 2;
      const { uptimeMs, frames: all } = parseFramestats(text);
      if (uptimeMs === null) return;
      const toHost = (monotonicMs: number) => hostAtDump - (uptimeMs - monotonicMs);
      const frames = all.filter((f) => toHost(f.start) > since);
      if (frames.length === 0) return;
      since = Math.max(...frames.map((f) => toHost(f.start)));
      const budget = budgetMs;
      const events: NewEvent[] = [];
      for (const f of frames) {
        const dropped = Math.ceil(f.duration / budget - 1e-6) - 1;
        if (dropped >= minDroppedFrames) {
          events.push({ ts: toHost(f.start), type: 'FRAME_DROP', source: 'device', duration: f.duration, metadata: { thread: 'ui', droppedFrames: dropped } });
        }
      }
      if (frames.length >= 2) {
        const first = frames.reduce((a, b) => (b.start < a.start ? b : a));
        events.push({
          ts: toHost(first.start),
          type: 'FPS',
          source: 'device',
          duration: Math.max(...frames.map((f) => f.start + f.duration)) - first.start,
          metadata: { thread: 'ui', frames: frames.length, ...summarizeFrames(frames, budget) },
        });
      }
      emit(events);
      failures = 0;
    },
    (error) => {
      if (++failures === 3) log('warn', `Frame sampling failing: ${errorMessage(error)}`);
    },
  );
}
