import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DataPaths } from '../config.js';
import type { AppRecord, SessionRecord, Store } from '../db.js';
import { AppError, conflict, errorMessage, notFound } from '../errors.js';
import type { Toolchain } from '../android/sdk.js';
import { inspectApk, instrumentationSupport, type InstrumentationSupport } from '../apk/inspect.js';
import { instrumentApk, newChannel } from '../apk/instrument.js';

export interface AppView extends AppRecord {
  instrumentation: InstrumentationSupport;
}

/** Strips paths and control characters from a client-supplied file name (display only). */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'app.apk';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().slice(0, 200);
  return clean || 'app.apk';
}

export class AppService {
  private uploading = 0;
  private readonly jobs = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly paths: DataPaths,
    private readonly tools: () => Toolchain,
  ) {
    // Builds interrupted by a restart are marked failed.
    for (const app of store.listApps()) {
      if (app.instrumented.status === 'running') {
        store.saveApp({ ...app, instrumented: { ...app.instrumented, status: 'failed', error: 'Interrupted by a server restart' } });
      }
    }
  }

  originalPath(app: AppRecord): string {
    return join(this.paths.apks, `${app.id}.apk`);
  }

  instrumentedPath(app: AppRecord): string {
    return join(this.paths.builds, `${app.id}-instrumented.apk`);
  }

  apkPathFor = (app: AppRecord, variant: SessionRecord['variant']): string =>
    variant === 'instrumented' ? this.instrumentedPath(app) : this.originalPath(app);

  view(app: AppRecord): AppView {
    return { ...app, instrumentation: instrumentationSupport(app, this.tools().apktool.available) };
  }

  get(id: string): AppRecord {
    const app = this.store.getApp(id);
    if (!app) throw notFound('App');
    return app;
  }

  /** Streams an upload to disk (size-capped, hashed), validates it as an APK, then stores it. */
  async upload(stream: Readable & { truncated?: boolean }, fileName: string): Promise<AppRecord> {
    const name = sanitizeFileName(fileName);
    if (!name.toLowerCase().endsWith('.apk')) throw new AppError(415, 'NOT_APK', 'Only .apk files are supported');
    if (this.uploading >= 2) throw new AppError(429, 'BUSY', 'Another upload is in progress');
    this.uploading++;
    const tmp = join(this.paths.tmp, `${randomUUID()}.upload`);
    try {
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            size += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (stream.truncated) throw new AppError(413, 'TOO_LARGE', 'The APK exceeds the maximum upload size');
      if (size < 22) throw new AppError(422, 'INVALID_APK', 'File is too small to be an APK');

      const fh = await open(tmp, 'r');
      const magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
      await fh.close();
      if (magic.readUInt32LE(0) !== 0x04034b50) throw new AppError(422, 'INVALID_APK', 'Not a ZIP/APK file');

      const info = await inspectApk(tmp);
      const id = randomUUID();
      const record: AppRecord = {
        id,
        fileName: name,
        sha256: hash.digest('hex'),
        size,
        uploadedAt: Date.now(),
        packageName: info.packageName,
        versionName: info.versionName,
        versionCode: info.versionCode,
        minSdk: info.minSdk,
        targetSdk: info.targetSdk,
        launchActivity: info.launchActivity,
        debuggable: info.debuggable,
        isReactNative: info.isReactNative,
        jsEngine: info.jsEngine,
        bundleFormat: info.bundleFormat,
        bundleSize: info.bundleSize,
        devBundle: info.devBundle,
        abis: info.abis,
        instrumented: { status: 'none', strategy: null, error: null, builtAt: null, channel: null },
      };
      await rename(tmp, this.originalPath(record));
      this.store.saveApp(record);
      return record;
    } finally {
      this.uploading--;
      await rm(tmp, { force: true });
    }
  }

  /** Starts building the instrumented APK in the background. */
  instrument(id: string): AppRecord {
    const app = this.get(id);
    if (app.instrumented.status === 'running') throw conflict('BUSY', 'An instrumented build is already running');
    const support = instrumentationSupport(app, this.tools().apktool.available);
    if (!support.supported || !support.strategy) throw new AppError(422, 'NOT_SUPPORTED', support.reason);
    const strategy = support.strategy;
    const channel = newChannel();
    const running: AppRecord = { ...app, instrumented: { status: 'running', strategy, error: null, builtAt: null, channel } };
    this.store.saveApp(running);

    const controller = new AbortController();
    this.jobs.set(id, controller);
    const output = this.instrumentedPath(app);
    const partial = `${output}.partial`;
    void instrumentApk(this.originalPath(app), partial, this.paths, this.tools(), { strategy, channel, devMode: app.devBundle, signal: controller.signal })
      .then(async () => {
        await rename(partial, output);
        const current = this.store.getApp(id);
        if (current) this.store.saveApp({ ...current, instrumented: { status: 'ready', strategy, error: null, builtAt: Date.now(), channel } });
      })
      .catch(async (error: unknown) => {
        await rm(partial, { force: true });
        const current = this.store.getApp(id);
        if (current) this.store.saveApp({ ...current, instrumented: { status: 'failed', strategy, error: errorMessage(error).slice(0, 1000), builtAt: null, channel: null } });
      })
      .finally(() => this.jobs.delete(id));
    return running;
  }

  async delete(id: string): Promise<void> {
    const app = this.get(id);
    if (this.store.listSessions().some((s) => s.appId === id)) {
      throw conflict('IN_USE', 'Delete the sessions that use this app first');
    }
    this.jobs.get(id)?.abort();
    for (const path of [this.originalPath(app), this.instrumentedPath(app)]) {
      if (existsSync(path)) await rm(path, { force: true });
    }
    this.store.deleteApp(id);
  }
}
