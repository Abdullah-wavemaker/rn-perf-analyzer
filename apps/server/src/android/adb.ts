import { spawn } from 'node:child_process';
import { AppError } from '../errors.js';
import { run, streamLines, type RunOptions, type StreamHandle } from '../exec.js';
import { assertAvdName, assertComponent, assertInt, assertKeycode, assertPackage, assertPid, assertSerial } from './validate.js';

export interface DeviceInfo {
  serial: string;
  state: string;
  model: string | null;
  sdk: number | null;
  release: string | null;
  abi: string | null;
  isEmulator: boolean;
  screen: { width: number; height: number; density: number | null } | null;
}

export interface LaunchResult {
  kind: 'cold' | 'warm' | 'hot';
  totalTime: number | null;
  waitTime: number | null;
  launchState: string | null;
  activity: string | null;
}

export class InstallError extends AppError {}

/**
 * Typed wrapper over adb for one device. Every method validates the values it
 * interpolates into device-side shell commands.
 */
export class Adb {
  readonly serial: string;

  constructor(
    private readonly adbPath: string,
    serial: string,
  ) {
    this.serial = assertSerial(serial);
  }

  private exec(args: string[], options?: RunOptions) {
    return run(this.adbPath, ['-s', this.serial, ...args], options);
  }

  /** Runs a device-side shell command built only from validated parts. */
  async shell(command: string, options?: RunOptions): Promise<string> {
    const result = await this.exec(['shell', command], options);
    return result.stdout;
  }

  async getprop(name: string): Promise<string> {
    if (!/^[a-z0-9._]+$/.test(name)) throw new AppError(400, 'INVALID_PROP', 'Invalid property name');
    return (await this.shell(`getprop ${name}`, { timeoutMs: 10_000 })).trim();
  }

  async info(state = 'device'): Promise<DeviceInfo> {
    const base: DeviceInfo = { serial: this.serial, state, model: null, sdk: null, release: null, abi: null, isEmulator: this.serial.startsWith('emulator-'), screen: null };
    if (state !== 'device') return base;
    const out = await this.shell('getprop ro.product.model; getprop ro.build.version.sdk; getprop ro.build.version.release; getprop ro.product.cpu.abi; getprop ro.kernel.qemu; wm size; wm density', { timeoutMs: 15_000 }).catch(() => '');
    const lines = out.split('\n').map((l) => l.trim());
    const size = /(?:Override|Physical) size: (\d+)x(\d+)/.exec(out.split('\n').filter((l) => l.includes('size:')).pop() ?? '');
    const density = /(?:Override|Physical) density: (\d+)/.exec(out.split('\n').filter((l) => l.includes('density:')).pop() ?? '');
    return {
      ...base,
      model: lines[0] || null,
      sdk: Number.parseInt(lines[1] ?? '', 10) || null,
      release: lines[2] || null,
      abi: lines[3] || null,
      isEmulator: base.isEmulator || lines[4] === '1',
      screen: size ? { width: Number(size[1]), height: Number(size[2]), density: density ? Number(density[1]) : null } : null,
    };
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const out = await this.shell('wm size', { timeoutMs: 10_000 });
    const lines = out.split('\n').filter((l) => l.includes('size:'));
    const m = /(\d+)x(\d+)/.exec(lines.pop() ?? '');
    if (!m) throw new AppError(500, 'SCREEN_SIZE', 'Could not read the device screen size');
    // `wm size` reports portrait dimensions; swap when rotated to landscape.
    let width = Number(m[1]);
    let height = Number(m[2]);
    const rotation = await this.shell('dumpsys input | grep -m 1 SurfaceOrientation', { timeoutMs: 10_000, allowFailure: true }).catch(() => '');
    const r = /SurfaceOrientation:\s*(\d)/.exec(rotation);
    if (r && (r[1] === '1' || r[1] === '3') && height > width) [width, height] = [height, width];
    return { width, height };
  }

  async install(apkPath: string, options: { grantPermissions?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const args = ['install', '-r', '-t', '-d'];
    if (options.grantPermissions) args.push('-g');
    args.push(apkPath);
    const result = await this.exec(args, { timeoutMs: 10 * 60_000, allowFailure: true, signal: options.signal });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /Success/.test(output)) return;
    const failure = /(INSTALL_[A-Z_]+|INSTALL_FAILED_[A-Z_]+)/.exec(output)?.[1] ?? 'INSTALL_FAILED';
    if (failure === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' || /signatures do not match/i.test(output)) {
      throw new InstallError(409, 'SIGNATURE_MISMATCH', 'The installed app was signed with a different key. Replacing it uninstalls the existing app and deletes its data.');
    }
    const hints: Record<string, string> = {
      INSTALL_FAILED_NO_MATCHING_ABIS: 'The APK has no native libraries for this device CPU architecture.',
      INSTALL_FAILED_INSUFFICIENT_STORAGE: 'The device is out of storage.',
      INSTALL_FAILED_OLDER_SDK: 'The device Android version is lower than the app minSdk.',
      INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'The APK is not signed.',
    };
    throw new InstallError(422, failure, hints[failure] ?? `Install failed: ${failure}`);
  }

  async uninstall(pkg: string): Promise<void> {
    await this.exec(['uninstall', assertPackage(pkg)], { timeoutMs: 120_000, allowFailure: true });
  }

  async isInstalled(pkg: string): Promise<boolean> {
    const out = await this.shell(`pm path ${assertPackage(pkg)}`, { timeoutMs: 15_000, allowFailure: true });
    return out.includes('package:');
  }

  async resolveLaunchActivity(pkg: string): Promise<string | null> {
    const out = await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${assertPackage(pkg)}`, {
      timeoutMs: 15_000,
      allowFailure: true,
    });
    const line = out.trim().split('\n').pop()?.trim() ?? '';
    return /^[\w.]+\/[\w.$]+$/.test(line) ? line : null;
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shell(`am force-stop ${assertPackage(pkg)}`, { timeoutMs: 15_000 });
  }

  /** `am start -W` with launcher flags; returns Android's own launch timing. */
  async launch(component: string, expected: LaunchResult['kind'], signal?: AbortSignal): Promise<LaunchResult> {
    const out = await this.shell(
      `am start -W -n ${assertComponent(component)} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000`,
      { timeoutMs: 120_000, signal },
    );
    if (/Error:|Exception/.test(out) && !/Status: ok/.test(out)) {
      throw new AppError(500, 'LAUNCH_FAILED', out.trim().split('\n').slice(-3).join(' '));
    }
    const value = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(out)?.[1]?.trim() ?? null;
    const launchState = value('LaunchState');
    const totalTime = Number.parseInt(value('TotalTime') ?? '', 10);
    const waitTime = Number.parseInt(value('WaitTime') ?? '', 10);
    const kind = launchState === 'HOT' ? 'hot' : launchState === 'WARM' ? 'warm' : launchState === 'COLD' ? 'cold' : expected;
    return {
      kind,
      totalTime: Number.isFinite(totalTime) && totalTime > 0 ? totalTime : null,
      waitTime: Number.isFinite(waitTime) && waitTime > 0 ? waitTime : null,
      launchState,
      activity: value('Activity'),
    };
  }

  async pids(pkg: string): Promise<number[]> {
    const out = await this.shell(`pidof ${assertPackage(pkg)}`, { timeoutMs: 10_000, allowFailure: true });
    return out
      .trim()
      .split(/\s+/)
      .map((p) => Number.parseInt(p, 10))
      .filter((p) => Number.isInteger(p) && p > 0);
  }

  /** Process name of a pid (cmdline), or null when it is gone. */
  async processName(pid: number): Promise<string | null> {
    const out = await this.shell(`cat /proc/${assertPid(pid)}/cmdline`, { timeoutMs: 10_000, allowFailure: true });
    const name = out.split('\0')[0]?.trim();
    return name || null;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${assertInt(x, 0, 20000, 'x')} ${assertInt(y, 0, 20000, 'y')}`, { timeoutMs: 15_000 });
  }

  async swipe(x: number, y: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.shell(
      `input swipe ${assertInt(x, 0, 20000, 'x')} ${assertInt(y, 0, 20000, 'y')} ${assertInt(x2, 0, 20000, 'x2')} ${assertInt(y2, 0, 20000, 'y2')} ${assertInt(durationMs, 1, 10000, 'duration')}`,
      { timeoutMs: 30_000 },
    );
  }

  async keyevent(keycode: string): Promise<void> {
    await this.shell(`input keyevent ${assertKeycode(keycode)}`, { timeoutMs: 15_000 });
  }

  async screencap(): Promise<Buffer> {
    const result = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 * 1024 });
    const png = result.stdoutBuffer;
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new AppError(502, 'SCREENCAP_FAILED', 'Device did not return a PNG');
    return png;
  }

  async uiDump(): Promise<string> {
    const path = '/data/local/tmp/rnpa_ui.xml';
    await this.shell(`uiautomator dump ${path}`, { timeoutMs: 30_000, allowFailure: true });
    const xml = await this.shell(`cat ${path}; rm -f ${path}`, { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (!xml.includes('<hierarchy')) throw new AppError(502, 'UI_DUMP_FAILED', 'uiautomator could not dump the UI (screen may be animating or secure)');
    return xml;
  }

  async reverse(port: number): Promise<void> {
    const p = assertInt(port, 1024, 65535, 'port');
    await this.exec(['reverse', `tcp:${p}`, `tcp:${p}`], { timeoutMs: 15_000 });
  }

  async removeReverse(port: number): Promise<void> {
    const p = assertInt(port, 1024, 65535, 'port');
    await this.exec(['reverse', '--remove', `tcp:${p}`], { timeoutMs: 15_000, allowFailure: true });
  }

  /** Device wall clock minus host wall clock (ms), measured over the lowest-latency of several round trips. */
  async clockOffset(): Promise<{ offset: number; rtt: number }> {
    let best: { offset: number; rtt: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const out = await this.shell('echo $EPOCHREALTIME', { timeoutMs: 10_000 });
      const t1 = Date.now();
      const device = Number.parseFloat(out.trim()) * 1000;
      if (!Number.isFinite(device) || device <= 0) break;
      const sample = { offset: device - (t0 + t1) / 2, rtt: t1 - t0 };
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    if (best) return best;
    const t0 = Date.now();
    const out = await this.shell('date +%s%3N', { timeoutMs: 10_000 });
    const t1 = Date.now();
    const device = Number.parseInt(out.trim(), 10);
    if (!Number.isFinite(device)) return { offset: 0, rtt: t1 - t0 };
    return { offset: device - (t0 + t1) / 2, rtt: t1 - t0 };
  }

  logcat(onLine: (line: string) => void, onExit: (code: number | null) => void): StreamHandle {
    return streamLines(
      this.adbPath,
      [
        '-s', this.serial, 'logcat', '-v', 'threadtime', '-v', 'epoch', '-T', '1',
        'ReactNativeJS:V', 'AndroidRuntime:E', 'DEBUG:F', 'libc:F', 'ActivityManager:I', 'ActivityTaskManager:I', '*:S',
      ],
      onLine,
      onExit,
    );
  }

  /** Raw touch/key events; `-tt` forces a pty so getevent line-buffers. */
  getevent(onLine: (line: string) => void, onExit: (code: number | null) => void): StreamHandle {
    return streamLines(this.adbPath, ['-s', this.serial, 'shell', '-tt', 'getevent', '-lt'], onLine, onExit, 4096);
  }
}

export async function listDevices(adbPath: string): Promise<{ serial: string; state: string }[]> {
  const result = await run(adbPath, ['devices'], { timeoutMs: 15_000 });
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([serial, state]) => ({ serial: serial as string, state: state as string }))
    .filter((d) => /^[A-Za-z0-9._:-]{1,128}$/.test(d.serial));
}

export async function listAvds(emulatorPath: string): Promise<string[]> {
  const result = await run(emulatorPath, ['-list-avds'], { timeoutMs: 20_000, allowFailure: true });
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]{1,128}$/.test(l));
}

export function startAvd(emulatorPath: string, name: string): void {
  // Detached so it outlives the request; output is discarded.
  const child = spawn(emulatorPath, ['-avd', assertAvdName(name), '-no-snapshot-save', '-no-boot-anim'], {
    shell: false,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
