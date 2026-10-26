import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { unavailable } from '../errors.js';
import { run } from '../exec.js';

export interface ToolStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface Toolchain {
  adb: ToolStatus;
  emulator: ToolStatus;
  apksigner: ToolStatus;
  zipalign: ToolStatus;
  keytool: ToolStatus;
  apktool: ToolStatus;
  /** zipalign supports -P <kb> (16 KB page alignment). */
  zipalignPageSize: boolean;
}

function sdkRoots(): string[] {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Android', 'sdk'));
  if (process.platform === 'linux') roots.push(join(homedir(), 'Android', 'Sdk'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  return [...new Set(roots.filter((r): r is string => !!r && existsSync(r)))];
}

function onPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function latestBuildTools(): string | null {
  for (const root of sdkRoots()) {
    const dir = join(root, 'build-tools');
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir).filter((v) => /^\d+(\.\d+)*/.test(v)).sort(compareVersions).reverse();
    for (const v of versions) {
      if (existsSync(join(dir, v, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'))) return join(dir, v);
    }
  }
  return null;
}

function inSdk(...segments: string[]): string | null {
  for (const root of sdkRoots()) {
    const candidate = join(root, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function probe(path: string | null, args: string[], pick: (out: string) => string | null): Promise<ToolStatus> {
  if (!path) return { available: false, path: null, version: null };
  try {
    const result = await run(path, args, { timeoutMs: 15_000, allowFailure: true });
    return { available: true, path, version: pick(`${result.stdout}\n${result.stderr}`) };
  } catch {
    return { available: false, path, version: null };
  }
}

let cached: Promise<Toolchain> | null = null;

/** Locates the Android/Java tools the server drives. Cached; pass refresh=true to re-scan. */
export function detectToolchain(refresh = false): Promise<Toolchain> {
  if (!cached || refresh) cached = scan();
  return cached;
}

async function scan(): Promise<Toolchain> {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const buildTools = latestBuildTools();
  const adbPath = inSdk('platform-tools', `adb${exe}`) ?? onPath('adb');
  const emulatorPath = inSdk('emulator', `emulator${exe}`) ?? onPath('emulator');
  const apksignerPath = buildTools ? join(buildTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner') : onPath('apksigner');
  const zipalignPath = buildTools ? join(buildTools, `zipalign${exe}`) : onPath('zipalign');
  const javaHome = process.env.JAVA_HOME;
  const keytoolPath = (javaHome && existsSync(join(javaHome, 'bin', `keytool${exe}`)) ? join(javaHome, 'bin', `keytool${exe}`) : null) ?? onPath('keytool');
  const apktoolPath = onPath('apktool');

  const firstLine = (out: string) => out.trim().split('\n')[0]?.trim() || null;
  const [adb, emulator, apksigner, zipalign, keytool, apktool] = await Promise.all([
    probe(adbPath, ['version'], (o) => /Android Debug Bridge version ([\d.]+)/.exec(o)?.[1] ?? firstLine(o)),
    probe(emulatorPath, ['-version'], (o) => /version ([\d.]+)/i.exec(o)?.[1] ?? null),
    probe(apksignerPath, ['version'], firstLine),
    probe(zipalignPath, [], () => null),
    probe(keytoolPath, ['-help'], () => null),
    probe(apktoolPath, ['--version'], firstLine),
  ]);

  let zipalignPageSize = false;
  if (zipalign.available && zipalign.path) {
    const usage = await run(zipalign.path, [], { allowFailure: true, timeoutMs: 10_000 }).catch(() => null);
    zipalignPageSize = !!usage && /-P <pagesize_kb>/.test(`${usage.stdout}${usage.stderr}`);
    zipalign.version = buildTools ? (buildTools.split(/[\\/]/).pop() ?? null) : null;
  }

  return { adb, emulator, apksigner, zipalign, keytool, apktool, zipalignPageSize };
}

export function requireTool(status: ToolStatus, name: string): string {
  if (!status.available || !status.path) {
    throw unavailable('TOOL_MISSING', `${name} is not available. Run \`rnpa doctor\` for setup help.`);
  }
  return status.path;
}
