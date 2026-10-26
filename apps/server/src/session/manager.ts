import { analyze } from '@rnpa/analyzer';
import type { AnalysisReport, ParsedWireBatch } from '@rnpa/shared';
import { requireTool, type Toolchain } from '../android/sdk.js';
import type { AppRecord, SessionRecord, Store } from '../db.js';
import { notFound } from '../errors.js';
import { SessionRuntime } from './runtime.js';

/**
 * Owns live session runtimes (created lazily on first use) and caches
 * analysis results until new events arrive.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly analysisCache = new Map<string, { eventCount: number; report: AnalysisReport }>();

  constructor(
    private readonly store: Store,
    private readonly tools: () => Toolchain,
    private readonly apkPathFor: (app: AppRecord, variant: SessionRecord['variant']) => string,
    private readonly metroUrl: string,
    private readonly ingestPort: number,
  ) {
    // Recordings cannot survive a restart: collectors are gone.
    for (const s of store.listSessions()) {
      if (s.status === 'recording') store.saveSession({ ...s, status: 'stopped', recordingStoppedAt: s.recordingStoppedAt ?? Date.now() });
    }
  }

  runtime(sessionId: string): SessionRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const record = this.store.getSession(sessionId);
    if (!record) throw notFound('Session');
    const app = this.store.getApp(record.appId);
    if (!app) throw notFound('App');
    const runtime = new SessionRuntime(
      { store: this.store, apkPathFor: this.apkPathFor, metroUrl: this.metroUrl, ingestPort: this.ingestPort },
      record,
      app,
      requireTool(this.tools().adb, 'adb'),
    );
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  /**
   * Routes a batch received over the HTTP transport. Prefers the recording
   * session whose instrumented build carries the batch's channel, otherwise
   * the only recording session.
   */
  routeBatch(batch: ParsedWireBatch): boolean {
    const recording = [...this.runtimes.values()].filter((r) => r.view().status === 'recording');
    const byChannel = recording.find((r) => this.store.getApp(r.view().appId)?.instrumented.channel === batch.c);
    const target = byChannel ?? (recording.length === 1 ? recording[0] : undefined);
    if (!target) return false;
    target.ingestBatch(batch);
    return true;
  }

  /** Runtime only if already live (for read-only views). */
  peek(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  analysis(sessionId: string): AnalysisReport {
    const record = this.store.getSession(sessionId);
    if (!record) throw notFound('Session');
    const count = this.store.countEvents(sessionId);
    const cached = this.analysisCache.get(sessionId);
    if (cached && cached.eventCount === count) return cached.report;
    const report = analyze(this.store.queryEvents(sessionId));
    this.analysisCache.set(sessionId, { eventCount: count, report });
    if (this.analysisCache.size > 8) {
      const oldest = this.analysisCache.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) this.analysisCache.delete(oldest);
    }
    return report;
  }

  async delete(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await runtime.dispose();
    this.runtimes.delete(sessionId);
    this.analysisCache.delete(sessionId);
    this.store.deleteSession(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((r) => r.dispose()));
    this.runtimes.clear();
  }
}
