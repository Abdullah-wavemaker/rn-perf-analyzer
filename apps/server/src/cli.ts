#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { detectToolchain } from './android/sdk.js';
import { createServer } from './app.js';
import { resolveConfig, VERSION } from './config.js';

const HELP = `RN Performance Analyzer ${VERSION}

Usage:
  rnpa [serve] [options]   Start the local server and dashboard
  rnpa doctor              Check the Android/Java toolchain
  rnpa --version

Options:
  --port <n>          Dashboard/API port on 127.0.0.1 (default 4310, env RNPA_PORT)
  --ingest-port <n>   Enable the HTTP agent transport on this loopback port (default off)
  --data-dir <path>   Where apps, builds and recordings are stored (default ~/.rnpa, env RNPA_HOME)
  --open              Open the dashboard in the default browser
  --dev               Allow the Vite dev server origin (dashboard development)
  -h, --help          Show this help
`;

function nodeVersionOk(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
}

async function doctor(): Promise<number> {
  const tools = await detectToolchain(true);
  const rows: [string, boolean, string, string][] = [
    ['Node.js ≥ 22.13', nodeVersionOk(), process.versions.node, 'Install Node 22.13+ (node:sqlite is required).'],
    ['adb', tools.adb.available, tools.adb.path ?? '', 'Install Android SDK platform-tools and set ANDROID_HOME.'],
    ['emulator', tools.emulator.available, tools.emulator.path ?? '', 'Optional: install the Android Emulator to start AVDs from the dashboard.'],
    ['apksigner', tools.apksigner.available, tools.apksigner.path ?? '', 'Install Android SDK build-tools (needed to build instrumented APKs).'],
    ['zipalign', tools.zipalign.available, tools.zipalign.path ?? '', 'Install Android SDK build-tools (needed to build instrumented APKs).'],
    ['keytool', tools.keytool.available, tools.keytool.path ?? '', 'Install a JDK 17+ and set JAVA_HOME (needed to sign instrumented APKs).'],
    ['apktool', tools.apktool.available, tools.apktool.path ?? '', 'Optional: `brew install apktool` to instrument Hermes bytecode builds.'],
  ];
  let failed = 0;
  for (const [name, ok, detail, hint] of rows) {
    const optional = name === 'emulator' || name === 'apktool';
    if (!ok && !optional) failed++;
    console.log(`${ok ? '✔' : optional ? '–' : '✘'} ${name.padEnd(16)} ${ok ? detail : hint}`);
  }
  console.log(failed === 0 ? '\nReady.' : `\n${failed} required tool(s) missing.`);
  return failed === 0 ? 0 : 1;
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  spawn(command, [url], { shell: false, detached: true, stdio: 'ignore' }).unref();
}

async function serve(values: Record<string, string | boolean | undefined>): Promise<void> {
  if (!nodeVersionOk()) throw new Error(`Node.js 22.13 or newer is required (found ${process.versions.node}).`);
  const port = values.port !== undefined ? Number(values.port) : undefined;
  const ingestPort = values['ingest-port'] !== undefined ? Number(values['ingest-port']) : undefined;
  for (const [name, value] of [['port', port], ['ingest-port', ingestPort]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1024 || value > 65535)) throw new Error(`--${name} must be between 1024 and 65535`);
  }
  const config = resolveConfig({
    port,
    ingestPort,
    dataDir: typeof values['data-dir'] === 'string' ? values['data-dir'] : undefined,
    devOrigins: values.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
  });

  const server = await createServer(config);
  await server.app.listen({ host: config.host, port: config.port });
  if (server.ingest) await server.ingest.listen({ host: '127.0.0.1', port: config.ingestPort });

  const url = `http://127.0.0.1:${config.port}/auth?token=${server.secrets.launchToken}`;
  const tools = server.tools();
  console.log(`\n  RN Performance Analyzer ${VERSION}\n`);
  console.log(`  Dashboard  ${url}`);
  console.log('             (this link signs you in — do not share it)');
  console.log(`  Data       ${config.dataDir}`);
  if (server.ingest) console.log(`  Ingest     http://127.0.0.1:${config.ingestPort}/ingest (via adb reverse)`);
  if (!tools.adb.available) console.log('\n  ! adb was not found. Run `rnpa doctor`.');
  console.log('');
  if (values.open) openBrowser(url);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n  ${signal} received, stopping recordings…`);
    const timer = setTimeout(() => process.exit(1), 10_000);
    try {
      await server.close();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'ingest-port': { type: 'string' },
      'data-dir': { type: 'string' },
      open: { type: 'boolean' },
      dev: { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (command === 'doctor') process.exitCode = await doctor();
  else if (command === 'serve') await serve(values);
  else {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(`rnpa: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
