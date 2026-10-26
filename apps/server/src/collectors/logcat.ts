import { LIMITS, LOGCAT_PREFIX, wireBatchSchema, type ParsedWireBatch } from '@rnpa/shared';
import type { Adb } from '../android/adb.js';
import type { StreamHandle } from '../exec.js';
import type { Collector, Emit, Log } from './types.js';

/**
 * Tails logcat for one app and turns it into timeline signals:
 *  - agent batches written through React Native's native logger
 *    (`RNPA1|<instance>|<seq>|<i>|<n>|<chunk>`), reassembled and validated;
 *  - Java crashes (AndroidRuntime FATAL EXCEPTION), native crashes (libc
 *    Fatal signal) and ANRs;
 *  - ActivityTaskManager "Displayed" lines (launches done outside the tool).
 *
 * Agent lines are only accepted from processes that belong to the package.
 */

export interface LogcatDeps {
  adb: Adb;
  packageName: string;
  /** Device clock − host clock (ms). */
  clockOffset: () => number;
  onBatch: (batch: ParsedWireBatch) => void;
  onDisplayed: (component: string, totalMs: number, hostTs: number, pid: number) => void;
  emit: Emit;
  log: Log;
}

const LINE = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+?)\s*: ?(.*)$/;
const MAX_PENDING_BATCHES = 64;
const MAX_CHUNKS = Math.ceil(LIMITS.maxBatchBytes / 3000) + 1;
const PENDING_TTL_MS = 15_000;

interface PendingBatch {
  parts: (string | undefined)[];
  received: number;
  bytes: number;
  at: number;
}

interface CrashBlock {
  pid: number;
  ts: number;
  lines: string[];
  timer: NodeJS.Timeout;
}

export function parseDisplayedTime(text: string): number | null {
  // "+1s234ms", "+523ms", "+2s"
  const m = /\+(?:(\d+)s)?(?:(\d+)ms)?/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 1000 + Number(m[2] ?? 0);
}

export function createLogcatCollector(deps: LogcatDeps): Collector {
  const { adb, packageName } = deps;
  let stream: StreamHandle | null = null;
  let stopped = true;
  const pending = new Map<string, PendingBatch>();
  const pidOwnership = new Map<number, boolean>();
  const pidChecks = new Map<number, Promise<boolean>>();
  const queuedByPid = new Map<number, string[]>();
  let crash: CrashBlock | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  const toHost = (deviceSeconds: number) => deviceSeconds * 1000 - deps.clockOffset();

  function ownsPid(pid: number): Promise<boolean> {
    const known = pidOwnership.get(pid);
    if (known !== undefined) return Promise.resolve(known);
    let check = pidChecks.get(pid);
    if (!check) {
      check = adb
        .processName(pid)
        .then((name) => {
          const owned = !!name && (name === packageName || name.startsWith(`${packageName}:`));
          if (pidOwnership.size > 512) pidOwnership.clear();
          pidOwnership.set(pid, owned);
          return owned;
        })
        .catch(() => false)
        .finally(() => pidChecks.delete(pid));
      pidChecks.set(pid, check);
    }
    return check;
  }

  function handleAgentLine(message: string): void {
    // RNPA1|instance|seq|index|count|payload  (payload may contain '|')
    const fields: string[] = [];
    let rest = message;
    for (let i = 0; i < 5; i++) {
      const at = rest.indexOf('|');
      if (at === -1) {
        fields.push(rest);
        rest = '';
        break;
      }
      fields.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
    if (fields[1] === 'init-failed') {
      deps.log('error', `Agent failed to initialise in the app: ${message.slice(0, 300)}`);
      return;
    }
    if (fields.length < 5) return;
    const [, instance, seqText, indexText, countText] = fields;
    const index = Number(indexText);
    const count = Number(countText);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(instance ?? '') || !/^\d{1,9}$/.test(seqText ?? '')) return;
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > MAX_CHUNKS || index < 0 || index >= count) return;

    const key = `${instance}|${seqText}`;
    let batch = pending.get(key);
    if (!batch) {
      const now = Date.now();
      for (const [k, b] of pending) if (now - b.at > PENDING_TTL_MS) pending.delete(k);
      if (pending.size >= MAX_PENDING_BATCHES) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      batch = { parts: new Array(count), received: 0, bytes: 0, at: now };
      pending.set(key, batch);
    }
    if (batch.parts.length !== count || batch.parts[index] !== undefined) return;
    batch.parts[index] = rest;
    batch.received++;
    batch.bytes += rest.length;
    if (batch.bytes > LIMITS.maxBatchBytes) {
      pending.delete(key);
      deps.log('warn', 'Dropped an oversized agent batch');
      return;
    }
    if (batch.received < count) return;
    pending.delete(key);
    try {
      const parsed = wireBatchSchema.safeParse(JSON.parse(batch.parts.join('')));
      if (parsed.success) deps.onBatch(parsed.data);
      else deps.log('warn', `Rejected malformed agent batch: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    } catch {
      deps.log('warn', 'Rejected unparseable agent batch');
    }
  }

  function flushCrash(): void {
    if (!crash) return;
    const block = crash;
    crash = null;
    clearTimeout(block.timer);
    const exceptionLine = block.lines.find((l) => /(Exception|Error)\b/.test(l) && !l.startsWith('Process:')) ?? block.lines[0] ?? 'Java crash';
    deps.emit([
      {
        ts: block.ts,
        type: 'CRASH',
        source: 'device',
        metadata: { kind: 'java', message: exceptionLine.slice(0, 500), stack: block.lines.join('\n').slice(0, 8000), pid: block.pid },
      },
    ]);
  }

  function handleLine(line: string): void {
    const m = LINE.exec(line);
    if (!m) return;
    const [, tsText, pidText, , level, tag, message = ''] = m;
    const ts = toHost(Number(tsText));
    const pid = Number(pidText);

    switch (tag) {
      case 'ReactNativeJS': {
        if (!message.startsWith(`${LOGCAT_PREFIX}|`)) return;
        const owned = pidOwnership.get(pid);
        if (owned === true) handleAgentLine(message);
        else if (owned === undefined) {
          const queue = queuedByPid.get(pid) ?? [];
          if (queue.length < 2000) queue.push(message);
          queuedByPid.set(pid, queue);
          void ownsPid(pid).then((ok) => {
            const lines = queuedByPid.get(pid) ?? [];
            queuedByPid.delete(pid);
            if (ok) for (const l of lines) handleAgentLine(l);
          });
        }
        return;
      }
      case 'AndroidRuntime': {
        if (level !== 'E') return;
        if (message.startsWith('FATAL EXCEPTION')) {
          flushCrash();
          crash = { pid, ts, lines: [message], timer: setTimeout(flushCrash, 500) };
          return;
        }
        if (crash && crash.pid === pid) {
          if (message.startsWith('Process:') && !message.includes(packageName)) {
            clearTimeout(crash.timer);
            crash = null;
            return;
          }
          if (crash.lines.length < 80) crash.lines.push(message);
        }
        return;
      }
      case 'libc': {
        if (level === 'F' && message.includes('Fatal signal') && message.includes(`(${packageName})`)) {
          deps.emit([{ ts, type: 'CRASH', source: 'device', metadata: { kind: 'native', message: message.slice(0, 500), pid } }]);
        }
        return;
      }
      case 'ActivityManager':
      case 'ActivityTaskManager': {
        if (message.startsWith(`ANR in ${packageName}`)) {
          deps.emit([{ ts, type: 'CRASH', source: 'device', metadata: { kind: 'anr', message: message.slice(0, 500) } }]);
          return;
        }
        // Android 10+ logs "Displayed" under ActivityTaskManager, older versions under ActivityManager.
        const displayed = /^Displayed ([\w.]+\/[\w.$]+)(?: for user \d+)?: (\+\S+)/.exec(message);
        if (displayed && displayed[1]?.startsWith(`${packageName}/`)) {
          const total = parseDisplayedTime(displayed[2] ?? '');
          if (total !== null) deps.onDisplayed(displayed[1], total, ts, pid);
        }
        return;
      }
      default:
        return;
    }
  }

  function startStream(): void {
    stream = adb.logcat(handleLine, () => {
      stream = null;
      if (!stopped) restartTimer = setTimeout(startStream, 1000);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      startStream();
    },
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      flushCrash();
      stream?.stop();
      stream = null;
      pending.clear();
    },
  };
}
