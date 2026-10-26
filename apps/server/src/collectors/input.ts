import type { UserActionKind } from '@rnpa/shared';
import type { Adb } from '../android/adb.js';
import type { StreamHandle } from '../exec.js';
import { errorMessage } from '../errors.js';
import type { Collector, Log } from './types.js';

/**
 * Records what the user physically does on the device/emulator from raw
 * kernel input events (`getevent -lt`), so manual interaction needs no app
 * changes. Taps injected by the tool (`input tap`) do not pass through
 * /dev/input and are therefore never double counted.
 */

export interface DeviceAction {
  kind: UserActionKind;
  ts: number;
  durationMs: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  /** Normalized 0..1 coordinates. */
  nx: number;
  ny: number;
  nx2: number;
  ny2: number;
  keyCode?: string;
}

interface TouchDevice {
  path: string;
  maxX: number;
  maxY: number;
}

export function parseInputDevices(text: string): TouchDevice[] {
  const devices: TouchDevice[] = [];
  const blocks = text.split(/^add device \d+: /m).slice(1);
  for (const block of blocks) {
    const path = block.split('\n')[0]?.trim() ?? '';
    const x = /ABS_MT_POSITION_X\s*:.*?max (\d+)/.exec(block);
    const y = /ABS_MT_POSITION_Y\s*:.*?max (\d+)/.exec(block);
    if (path.startsWith('/dev/input/') && x && y) devices.push({ path, maxX: Number(x[1]), maxY: Number(y[1]) });
  }
  return devices;
}

const EVENT = /^\[\s*(\d+\.\d+)\]\s+(\/dev\/input\/event\d+):\s+(\w+)\s+(\w+)\s+(\w+)/;
const KEYS: Record<string, UserActionKind> = { KEY_BACK: 'back', KEY_HOMEPAGE: 'home', KEY_HOME: 'home', KEY_APPSELECT: 'key' };

export function createInputCollector(adb: Adb, onAction: (action: DeviceAction) => void, log: Log): Collector {
  let stream: StreamHandle | null = null;
  let stopped = true;
  let devices = new Map<string, TouchDevice>();
  let screen = { width: 1, height: 1 };
  // Kernel timestamps are CLOCK_MONOTONIC seconds; host time ≈ kernel + offset, offset estimated as the minimum observed delta.
  let offset = Number.POSITIVE_INFINITY;
  let touch: { down: number; x: number | null; y: number | null; x0: number | null; y0: number | null; device: TouchDevice } | null = null;
  let pendingX: number | null = null;
  let pendingY: number | null = null;

  const host = (kernelSeconds: number) => kernelSeconds * 1000 + (Number.isFinite(offset) ? offset : Date.now() - kernelSeconds * 1000);

  function finishTouch(upKernel: number): void {
    if (!touch || touch.x0 === null || touch.y0 === null) {
      touch = null;
      return;
    }
    const d = touch.device;
    const px = (v: number, max: number, size: number) => Math.round((v / Math.max(1, max)) * size);
    const x = px(touch.x0, d.maxX, screen.width);
    const y = px(touch.y0, d.maxY, screen.height);
    const x2 = px(touch.x ?? touch.x0, d.maxX, screen.width);
    const y2 = px(touch.y ?? touch.y0, d.maxY, screen.height);
    const durationMs = Math.max(0, (upKernel - touch.down) * 1000);
    const distance = Math.hypot(x2 - x, y2 - y);
    const moved = distance > Math.max(24, Math.min(screen.width, screen.height) * 0.03);
    const kind: UserActionKind = moved ? 'swipe' : durationMs >= 500 ? 'long_press' : 'tap';
    onAction({
      kind,
      ts: host(touch.down),
      durationMs: Math.round(durationMs),
      x,
      y,
      x2,
      y2,
      nx: x / screen.width,
      ny: y / screen.height,
      nx2: x2 / screen.width,
      ny2: y2 / screen.height,
    });
    touch = null;
  }

  function handleLine(line: string): void {
    const m = EVENT.exec(line);
    if (!m) return;
    const [, tsText, path, type, code, value] = m;
    const kernel = Number(tsText);
    offset = Math.min(offset, Date.now() - kernel * 1000);

    if (type === 'EV_KEY' && code && KEYS[code] && value === 'DOWN') {
      const kind = KEYS[code] as UserActionKind;
      onAction({ kind, ts: host(kernel), durationMs: 0, x: 0, y: 0, x2: 0, y2: 0, nx: 0, ny: 0, nx2: 0, ny2: 0, keyCode: code });
      return;
    }
    const device = devices.get(path ?? '');
    if (!device) return;

    if (type === 'EV_ABS' && code === 'ABS_MT_POSITION_X') pendingX = Number.parseInt(value ?? '', 16);
    else if (type === 'EV_ABS' && code === 'ABS_MT_POSITION_Y') pendingY = Number.parseInt(value ?? '', 16);
    else if (type === 'EV_ABS' && code === 'ABS_MT_TRACKING_ID') {
      if (value === 'ffffffff') finishTouch(kernel);
      else if (!touch) touch = { down: kernel, x: null, y: null, x0: null, y0: null, device };
    } else if (type === 'EV_KEY' && code === 'BTN_TOUCH') {
      if (value === 'DOWN' && !touch) touch = { down: kernel, x: null, y: null, x0: null, y0: null, device };
      else if (value === 'UP') finishTouch(kernel);
    } else if (type === 'EV_SYN' && code === 'SYN_REPORT' && touch) {
      if (pendingX !== null) touch.x = pendingX;
      if (pendingY !== null) touch.y = pendingY;
      if (touch.x0 === null && touch.x !== null) touch.x0 = touch.x;
      if (touch.y0 === null && touch.y !== null) touch.y0 = touch.y;
      pendingX = null;
      pendingY = null;
    }
  }

  async function begin(): Promise<void> {
    try {
      const [info, size] = await Promise.all([adb.shell('getevent -lp', { timeoutMs: 15_000 }), adb.screenSize()]);
      devices = new Map(parseInputDevices(info).map((d) => [d.path, d]));
      screen = size;
      if (devices.size === 0) log('warn', 'No touchscreen input device found; manual taps on the device will not be recorded.');
    } catch (error) {
      log('warn', `Input recording unavailable: ${errorMessage(error)}`);
      return;
    }
    if (stopped) return;
    stream = adb.getevent(handleLine, () => {
      stream = null;
      if (!stopped) setTimeout(() => void begin(), 2000);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void begin();
    },
    stop() {
      stopped = true;
      stream?.stop();
      stream = null;
      touch = null;
    },
  };
}
