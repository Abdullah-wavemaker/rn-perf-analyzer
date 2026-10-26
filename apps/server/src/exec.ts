import { spawn, type ChildProcess } from 'node:child_process';
import { AppError } from './errors.js';

/**
 * The only way the server runs external programs. Arguments are passed as an
 * array with `shell: false`, output is size-capped, and every call has a
 * timeout and can be aborted. Callers validate any value that reaches a
 * *remote* shell (adb shell joins its arguments into a device-side command
 * line) with the validators in android/validate.ts.
 */

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Resolve with binary stdout (screenshots). */
  binary?: boolean;
  /** Do not throw on a non-zero exit code. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new AppError(500, 'EXEC_FAILED', `Could not start ${command}: ${(error as Error).message}`));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killedReason: string | null = null;

    const kill = (reason: string) => {
      if (killedReason) return;
      killedReason = reason;
      child.kill('SIGKILL');
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutput) kill('output limit exceeded');
      else out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= 1024 * 1024) err.push(chunk);
    });

    const timer = setTimeout(() => kill('timed out'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => kill('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new AppError(500, 'EXEC_FAILED', `Could not run ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stdoutBuffer = Buffer.concat(out);
      const result: RunResult = {
        code,
        stdout: options.binary ? '' : stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutBuffer,
        durationMs: Date.now() - started,
      };
      if (killedReason) {
        const status = killedReason === 'aborted' ? 499 : 504;
        reject(new AppError(status, killedReason === 'aborted' ? 'ABORTED' : 'EXEC_TIMEOUT', `${basename(command)} ${killedReason}`));
        return;
      }
      if (code !== 0 && !options.allowFailure) {
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
        reject(new AppError(500, 'EXEC_FAILED', `${basename(command)} exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

export interface StreamHandle {
  child: ChildProcess;
  stop(): void;
}

/**
 * Starts a long-running process and delivers stdout line by line. Lines are
 * capped to protect against unbounded memory use from a misbehaving producer.
 */
export function streamLines(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  onExit: (code: number | null) => void,
  maxLineBytes = 64 * 1024,
): StreamHandle {
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (line.length <= maxLineBytes) onLine(line);
    }
    if (pending.length > maxLineBytes) pending = '';
  });
  child.on('error', () => onExit(null));
  child.on('close', (code) => onExit(code));
  return {
    child,
    stop() {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
