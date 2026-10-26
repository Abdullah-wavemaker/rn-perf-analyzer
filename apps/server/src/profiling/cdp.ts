import { AppError } from '../errors.js';
import { isLoopbackHost } from '../config.js';

/**
 * Minimal Chrome DevTools Protocol client for Hermes, reached through Metro's
 * inspector proxy (debug builds). Only loopback targets are accepted — the
 * target list is data from another process and must not redirect us
 * elsewhere.
 */

interface Target {
  id: string;
  title?: string;
  description?: string;
  vm?: string;
  webSocketDebuggerUrl?: string;
}

export class HermesProfiler {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  hostStart = 0;

  constructor(private readonly metroUrl: string) {}

  static async findTarget(metroUrl: string, packageName: string): Promise<string> {
    let targets: Target[];
    try {
      const res = await fetch(new URL('/json/list', metroUrl), { signal: AbortSignal.timeout(5000) });
      targets = (await res.json()) as Target[];
    } catch {
      throw new AppError(503, 'METRO_UNAVAILABLE', `Metro is not reachable at ${metroUrl}. CPU profiling over CDP needs a debug build connected to Metro.`);
    }
    if (!Array.isArray(targets)) throw new AppError(502, 'METRO_INVALID', 'Unexpected response from Metro');
    const candidates = targets.filter((t) => typeof t.webSocketDebuggerUrl === 'string');
    const preferred =
      candidates.find((t) => `${t.description ?? ''} ${t.title ?? ''}`.includes(packageName) && /hermes/i.test(`${t.vm ?? ''} ${t.title ?? ''}`)) ??
      candidates.find((t) => `${t.description ?? ''} ${t.title ?? ''}`.includes(packageName)) ??
      candidates[candidates.length - 1];
    if (!preferred?.webSocketDebuggerUrl) throw new AppError(404, 'NO_TARGET', 'No debuggable Hermes runtime is connected to Metro');
    const url = new URL(preferred.webSocketDebuggerUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || !isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new AppError(502, 'METRO_INVALID', 'Metro returned a non-loopback debugger URL; refusing to connect');
    }
    return url.toString();
  }

  async connect(wsUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new AppError(504, 'CDP_TIMEOUT', 'Timed out connecting to the Hermes inspector')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new AppError(502, 'CDP_ERROR', 'Could not connect to the Hermes inspector'));
      });
      socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
      socket.addEventListener('close', () => {
        for (const w of this.waiting.values()) w.reject(new AppError(502, 'CDP_CLOSED', 'Inspector connection closed'));
        this.waiting.clear();
        this.socket = null;
      });
    });
  }

  private onMessage(data: string): void {
    if (data.length > 256 * 1024 * 1024) return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new AppError(502, 'CDP_ERROR', message.error.message ?? 'CDP error'));
    else waiter.resolve(message.result);
  }

  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new AppError(409, 'CDP_NOT_CONNECTED', 'Profiler is not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new AppError(504, 'CDP_TIMEOUT', `${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async start(): Promise<void> {
    await this.send('Profiler.enable');
    await this.send('Profiler.start');
    this.hostStart = Date.now();
  }

  async stop(): Promise<{ profile: unknown; hostStart: number; hostEnd: number }> {
    const result = await this.send<{ profile: unknown }>('Profiler.stop', {}, 120_000);
    const hostEnd = Date.now();
    this.close();
    return { profile: result.profile, hostStart: this.hostStart, hostEnd };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
