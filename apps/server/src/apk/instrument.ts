import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { DataPaths } from '../config.js';
import { AppError } from '../errors.js';
import { run } from '../exec.js';
import { requireTool, type Toolchain } from '../android/sdk.js';
import { BUNDLE_ENTRY } from './inspect.js';
import { alignAndSign } from './signing.js';
import { RawZipWriter, isSignatureEntry, listEntries, openZip, readEntry } from './zip.js';

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const PRELUDE_ASSET = 'rnpa_prelude.js';

export interface InstrumentOptions {
  strategy: 'bundle' | 'loader';
  /** Identifies this build on the logcat transport. */
  channel: string;
  devMode: boolean;
  signal?: AbortSignal;
}

export function newChannel(): string {
  return randomBytes(9).toString('base64url');
}

let preludeSource: string | null = null;
function agentPrelude(): string {
  if (preludeSource === null) {
    const path = fileURLToPath(import.meta.resolve('@rnpa/agent/prelude'));
    preludeSource = readFileSync(path, 'utf8');
  }
  return preludeSource;
}

/**
 * The script injected into the app: build settings followed by the agent.
 * The config object is JSON (server-generated values only); U+2028/2029 are
 * escaped for engines that predate ES2019 JSON superset semantics.
 */
export function buildPrelude(channel: string, devMode: boolean): string {
  const config = JSON.stringify({ channel, transport: 'logcat', devMode }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return [
    '/* RN Performance Analyzer agent — test build instrumentation */',
    `;(typeof globalThis!=='undefined'?globalThis:this).__RNPA_CONFIG__=${config};`,
    agentPrelude(),
    '',
  ].join('\n');
}

/**
 * Produces a signed, instrumented copy of `source` at `output`.
 *  - bundle: prepend the agent to a plain-JS index.android.bundle (pure ZIP rewrite).
 *  - loader: for Hermes bytecode bundles, ship the agent as a separate asset and
 *            patch React Native's script loader (smali) to evaluate it first.
 */
export async function instrumentApk(source: string, output: string, paths: DataPaths, tools: Toolchain, options: InstrumentOptions): Promise<void> {
  const work = join(paths.tmp, `instrument-${randomBytes(8).toString('hex')}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const unsigned = join(work, 'unsigned.apk');
    if (options.strategy === 'bundle') await rewriteBundle(source, unsigned, buildPrelude(options.channel, options.devMode));
    else await patchLoader(source, unsigned, work, tools, buildPrelude(options.channel, false), options.signal);
    await alignAndSign(unsigned, output, paths, tools, options.signal);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function rewriteBundle(source: string, output: string, prelude: string): Promise<void> {
  const zip = await openZip(source);
  const writer = new RawZipWriter(output);
  try {
    const entries = await listEntries(zip);
    let replaced = false;
    for (const entry of entries) {
      if (entry.fileName.endsWith('/') || isSignatureEntry(entry.fileName)) continue;
      if (entry.fileName === BUNDLE_ENTRY) {
        const bundle = await readEntry(zip, entry, MAX_BUNDLE_BYTES);
        await writer.replace(entry, Buffer.concat([Buffer.from(prelude, 'utf8'), bundle]));
        replaced = true;
      } else {
        await writer.copyRaw(zip, entry);
      }
    }
    if (!replaced) throw new AppError(422, 'NO_BUNDLE', `${BUNDLE_ENTRY} not found`);
    await writer.finish();
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    zip.close();
  }
}

/* ------------------------------------------------------------------------ */
/* Loader strategy (Hermes bytecode)                                        */
/* ------------------------------------------------------------------------ */

const DELEGATE = 'Lcom/facebook/react/bridge/JSBundleLoaderDelegate;';
const LOAD_SIG = 'loadScriptFromAssets(Landroid/content/res/AssetManager;Ljava/lang/String;Z)V';

/** Static helper injected into the app: loads the prelude asset before any other asset script. */
const HELPER_SMALI = `.class public final Lcom/rnpa/Prelude;
.super Ljava/lang/Object;
.source "Prelude.java"

.method public static beforeLoad(${DELEGATE}Landroid/content/res/AssetManager;Ljava/lang/String;Z)V
    .registers 6

    if-eqz p2, :done
    const-string v0, "${PRELUDE_ASSET}"
    invoke-virtual {p2, v0}, Ljava/lang/String;->endsWith(Ljava/lang/String;)Z
    move-result v1
    if-nez v1, :done
    const-string v0, "assets://${PRELUDE_ASSET}"
    invoke-interface {p0, p1, v0, p3}, ${DELEGATE}->${LOAD_SIG}
    :done
    return-void
.end method
`;

const CALL = `    invoke-static/range {p0 .. p3}, Lcom/rnpa/Prelude;->beforeLoad(${DELEGATE}Landroid/content/res/AssetManager;Ljava/lang/String;Z)V`;

async function smaliDirs(root: string): Promise<string[]> {
  return (await readdir(root)).filter((d) => /^smali(_classes\d+)?$/.test(d)).sort();
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.name.endsWith('.smali')) yield full;
  }
}

/** Inserts the helper call at the start of every concrete loadScriptFromAssets in RN's loader classes. */
export function patchSmali(source: string): { patched: string; count: number } {
  const lines = source.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith('.method ') || !line.endsWith(LOAD_SIG) || /\b(abstract|native)\b/.test(line)) continue;
    // Skip the register directive, parameter and annotation blocks, then insert before the first instruction.
    let j = i + 1;
    let inAnnotation = 0;
    for (; j < lines.length; j++) {
      const t = (lines[j] as string).trim();
      if (t.startsWith('.annotation') || t.startsWith('.param')) {
        if (t.startsWith('.annotation')) inAnnotation++;
        continue;
      }
      if (t.startsWith('.end annotation')) {
        inAnnotation--;
        continue;
      }
      if (inAnnotation > 0 || t === '' || t.startsWith('.locals') || t.startsWith('.registers') || t.startsWith('.end param') || t.startsWith('.prologue') || t.startsWith('#')) continue;
      break;
    }
    if (lines.slice(i, j + 3).some((l) => l.includes('Lcom/rnpa/Prelude;'))) continue;
    lines.splice(j, 0, CALL, '');
    count++;
    i = j + 1;
  }
  return { patched: lines.join('\n'), count };
}

async function patchLoader(source: string, output: string, work: string, tools: Toolchain, prelude: string, signal?: AbortSignal): Promise<void> {
  const apktool = requireTool(tools.apktool, 'apktool');
  const decoded = join(work, 'decoded');
  // -r: keep resources compiled (far more reliable rebuilds); only dex is decoded.
  await run(apktool, ['d', '-r', '-f', '-o', decoded, source], { timeoutMs: 20 * 60_000, signal, maxOutputBytes: 4 * 1024 * 1024 });

  const dirs = await smaliDirs(decoded);
  const hasDelegate = await Promise.all(
    dirs.map((d) => readFile(join(decoded, d, 'com/facebook/react/bridge/JSBundleLoaderDelegate.smali'), 'utf8').then(() => true, () => false)),
  );
  if (!hasDelegate.some(Boolean)) {
    throw new AppError(422, 'LOADER_NOT_FOUND', "React Native's JSBundleLoaderDelegate was not found (the app may be obfuscated). Integrate @rnpa/agent instead.");
  }

  let patchedMethods = 0;
  for (const dir of dirs) {
    const reactDir = join(decoded, dir, 'com/facebook/react');
    const exists = await readdir(reactDir).then(() => true, () => false);
    if (!exists) continue;
    for await (const file of walkFiles(reactDir)) {
      const text = await readFile(file, 'utf8');
      if (!text.includes(LOAD_SIG)) continue;
      const { patched, count } = patchSmali(text);
      if (count > 0) {
        await writeFile(file, patched);
        patchedMethods += count;
      }
    }
  }
  if (patchedMethods === 0) {
    throw new AppError(422, 'LOADER_NOT_FOUND', 'No React Native script loader implementation was found to patch.');
  }

  const helperDir = join(decoded, `smali_classes${dirs.length + 1}`, 'com', 'rnpa');
  await mkdir(helperDir, { recursive: true });
  await writeFile(join(helperDir, 'Prelude.smali'), HELPER_SMALI);
  await mkdir(join(decoded, 'assets'), { recursive: true });
  await writeFile(join(decoded, 'assets', PRELUDE_ASSET), prelude);

  await run(apktool, ['b', '-o', output, decoded], { timeoutMs: 30 * 60_000, signal, maxOutputBytes: 4 * 1024 * 1024 });
}
