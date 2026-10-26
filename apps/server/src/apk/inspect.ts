import type { Entry } from 'yauzl';
import { AppError } from '../errors.js';
import { isPackage } from '../android/validate.js';
import { readManifest } from './axml.js';
import { listEntries, openZip, readEntry, readEntryHead } from './zip.js';

export const BUNDLE_ENTRY = 'assets/index.android.bundle';
/** Hermes bytecode magic, little-endian 0x1F1903C103BC1FC6. */
const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface ApkInfo {
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  launchActivity: string | null;
  debuggable: boolean;
  isReactNative: boolean;
  jsEngine: 'hermes' | 'jsc' | 'unknown';
  bundleFormat: 'hbc' | 'js' | 'none';
  bundleSize: number | null;
  /** Plain-JS bundle built with __DEV__=true. */
  devBundle: boolean;
  abis: string[];
}

export async function inspectApk(path: string): Promise<ApkInfo> {
  const zip = await openZip(path);
  try {
    const entries = await listEntries(zip);
    const byName = new Map<string, Entry>();
    for (const e of entries) byName.set(e.fileName, e);

    const manifestEntry = byName.get('AndroidManifest.xml');
    if (!manifestEntry) throw new AppError(422, 'INVALID_APK', 'AndroidManifest.xml is missing — is this an APK?');
    if (![...byName.keys()].some((n) => /^classes\d*\.dex$/.test(n))) {
      throw new AppError(422, 'INVALID_APK', 'No classes.dex found — is this an APK?');
    }

    let manifest;
    try {
      manifest = readManifest(await readEntry(zip, manifestEntry, MAX_MANIFEST_BYTES));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, 'INVALID_MANIFEST', `Could not parse AndroidManifest.xml: ${(error as Error).message}`);
    }
    if (!isPackage(manifest.packageName)) throw new AppError(422, 'INVALID_MANIFEST', 'Manifest has an invalid package name');

    const libs = [...byName.keys()].filter((n) => n.startsWith('lib/') && n.endsWith('.so'));
    const abis = [...new Set(libs.map((n) => n.split('/')[1]).filter((a): a is string => !!a))].sort();
    const libNames = new Set(libs.map((n) => n.split('/').pop() ?? ''));
    const isReactNative =
      libNames.has('libreactnativejni.so') || libNames.has('libreactnative.so') || libNames.has('libhermes_executor.so') || byName.has(BUNDLE_ENTRY);

    const bundle = byName.get(BUNDLE_ENTRY);
    let bundleFormat: ApkInfo['bundleFormat'] = 'none';
    let devBundle = false;
    if (bundle) {
      const head = await readEntryHead(zip, bundle, 4096);
      if (head.subarray(0, 8).equals(HBC_MAGIC)) bundleFormat = 'hbc';
      else {
        bundleFormat = 'js';
        devBundle = /__DEV__\s*=\s*true/.test(head.toString('utf8'));
      }
    }

    const jsEngine: ApkInfo['jsEngine'] = libNames.has('libhermes.so') || bundleFormat === 'hbc' ? 'hermes' : libNames.has('libjsc.so') ? 'jsc' : 'unknown';

    return {
      ...manifest,
      isReactNative,
      jsEngine,
      bundleFormat,
      bundleSize: bundle ? bundle.uncompressedSize : null,
      devBundle,
      abis,
    };
  } finally {
    zip.close();
  }
}

export interface InstrumentationSupport {
  supported: boolean;
  strategy: 'bundle' | 'loader' | null;
  reason: string;
}

export function instrumentationSupport(info: Pick<ApkInfo, 'isReactNative' | 'bundleFormat'>, apktoolAvailable: boolean): InstrumentationSupport {
  if (!info.isReactNative) {
    return { supported: false, strategy: null, reason: 'Not a React Native app. Native metrics (startup, frames, memory, CPU) still work.' };
  }
  if (info.bundleFormat === 'none') {
    return {
      supported: false,
      strategy: null,
      reason: 'No JS bundle is embedded (debug builds load it from Metro). Integrate @rnpa/agent in the app, or build a release/bundled APK.',
    };
  }
  if (info.bundleFormat === 'js') {
    return { supported: true, strategy: 'bundle', reason: 'Plain JS bundle: the agent is prepended to the bundle.' };
  }
  if (!apktoolAvailable) {
    return {
      supported: false,
      strategy: 'loader',
      reason: 'Hermes bytecode bundle: install apktool (e.g. `brew install apktool`) to load the agent as a separate script, or integrate @rnpa/agent.',
    };
  }
  return {
    supported: true,
    strategy: 'loader',
    reason: 'Hermes bytecode bundle: the agent is loaded as a separate script before the bundle (experimental).',
  };
}
