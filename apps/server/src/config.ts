import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const VERSION = '0.1.0';

export interface ServerConfig {
  host: string;
  port: number;
  /** Separate loopback listener that only accepts agent batches (HTTP transport). 0 = disabled. */
  ingestPort: number;
  dataDir: string;
  maxApkBytes: number;
  maxProfileBytes: number;
  /** Allow the Vite dev server origin (development only). */
  devOrigins: string[];
  metroUrl: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const config: ServerConfig = {
    host: overrides.host ?? env.RNPA_HOST ?? '127.0.0.1',
    port: overrides.port ?? intEnv(env.RNPA_PORT, 4310),
    ingestPort: overrides.ingestPort ?? intEnv(env.RNPA_INGEST_PORT, 0),
    dataDir: resolve(overrides.dataDir ?? env.RNPA_HOME ?? join(homedir(), '.rnpa')),
    maxApkBytes: overrides.maxApkBytes ?? intEnv(env.RNPA_MAX_APK_MB, 1024) * 1024 * 1024,
    maxProfileBytes: overrides.maxProfileBytes ?? 64 * 1024 * 1024,
    devOrigins: overrides.devOrigins ?? [],
    metroUrl: overrides.metroUrl ?? env.RNPA_METRO_URL ?? 'http://127.0.0.1:8081',
  };
  if (!isLoopbackHost(config.host)) {
    // The API controls connected devices and installs software on them.
    // It is never exposed beyond the local machine.
    throw new Error(`Refusing to listen on non-loopback host "${config.host}". Use 127.0.0.1 or localhost.`);
  }
  const metro = new URL(config.metroUrl);
  if (!isLoopbackHost(metro.hostname) || metro.protocol !== 'http:') {
    throw new Error('RNPA_METRO_URL must be an http:// URL on the loopback interface.');
  }
  return config;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric environment value: ${value}`);
  return n;
}

export interface DataPaths {
  root: string;
  db: string;
  apks: string;
  builds: string;
  tmp: string;
  keystore: string;
}

/** Creates the data directory tree with owner-only permissions. */
export function ensureDataDirs(dataDir: string): DataPaths {
  const paths: DataPaths = {
    root: dataDir,
    db: join(dataDir, 'rnpa.db'),
    apks: join(dataDir, 'apks'),
    builds: join(dataDir, 'builds'),
    tmp: join(dataDir, 'tmp'),
    keystore: join(dataDir, 'keystore'),
  };
  for (const dir of [paths.root, paths.apks, paths.builds, paths.tmp, paths.keystore]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return paths;
}
