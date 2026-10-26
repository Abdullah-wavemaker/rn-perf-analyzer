import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { LIMITS, redactUrl, type ParsedWireBatch, type PerfEvent, type UserActionKind } from '@rnpa/shared';
import { Adb, type LaunchResult } from '../android/adb.js';
import { assertPackage, isComponent } from '../android/validate.js';
import { explore } from '../automation/explorer.js';
import { center, label, nodeAt, parseUiDump, type UiSnapshot } from '../automation/ui.js';
import { createLogcatCollector } from '../collectors/logcat.js';
import { createCpuCollector, createFrameCollector, createMemoryCollector } from '../collectors/device.js';
import { createInputCollector, type DeviceAction } from '../collectors/input.js';
import type { Collector, NewEvent } from '../collectors/types.js';
import type { AppRecord, JourneyRecord, JourneyStep, SessionRecord, Store } from '../db.js';
import { AppError, conflict, errorMessage } from '../errors.js';
import { HermesProfiler } from '../profiling/cdp.js';
import { looksLikeEpochMicros, parseCpuProfile, profileToEvents } from '../profiling/cpuprofile.js';

export type Activity = 'installing' | 'launching' | 'benchmark' | 'exploring' | 'replaying' | 'profiling';

export interface SessionView extends SessionRecord {
  activity: Activity | null;
  agentConnected: boolean;
  /** The timeline contains agent events (from this or an earlier recording). */
  hasAgentData: boolean;
  lastAgentEventAt: number | null;
  journeyRecording: { name: string; steps: number } | null;
}

export type StreamMessage =
  | { event: 'status'; data: SessionView }
  | { event: 'events'; data: PerfEvent[] }
  | { event: 'log'; data: { ts: number; level: 'info' | 'warn' | 'error'; message: string } };

export interface RuntimeDeps {
  store: Store;
  apkPathFor: (app: AppRecord, variant: SessionRecord['variant']) => string;
  metroUrl: string;
  /** Loopback port of the HTTP ingest listener, 0 when disabled. */
  ingestPort: number;
}

export interface InputAction {
  kind: 'tap' | 'long_press' | 'swipe' | 'back' | 'home';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
}

const AGENT_CONNECTED_WINDOW_MS = 15_000;
const BROADCAST_INTERVAL_MS = 250;
const CLOCK_REFRESH_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(499, 'ABORTED', 'Cancelled'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AppError(499, 'ABORTED', 'Cancelled'));
      },
      { once: true },
    );
  });
}

/**
 * Live state for one session: device connection, collectors, recording,
 * clock alignment, the unified timeline and long-running activities.
 */
export class SessionRuntime {
  readonly adb: Adb;
  private record: SessionRecord;
  private readonly listeners = new Set<(message: StreamMessage) => void>();
  private collectors: Collector[] = [];
  private clockOffset = 0;
  private clockTimer: NodeJS.Timeout | null = null;
  private currentScreen: string | null = null;
  private lastAgentEventAt: number | null = null;
  private agentInstance: string | null = null;
  private seq: number;
  private pendingBroadcast: PerfEvent[] = [];
  private broadcastTimer: NodeJS.Timeout | null = null;
  private activity: Activity | null = null;
  private abort: AbortController | null = null;
  private launchInProgress = false;
  private displayedDuringLaunch: number | null = null;
  private lastToolLaunchAt: number | null = null;
  private lastPid: number | null = null;
  private screen: { width: number; height: number; at: number } | null = null;
  private journey: { name: string; steps: JourneyStep[]; lastAt: number } | null = null;
  private profiler: HermesProfiler | null = null;
  private disposed = false;
  private hasAgentData = false;

  constructor(
    private readonly deps: RuntimeDeps,
    record: SessionRecord,
    private readonly app: AppRecord,
    adbPath: string,
  ) {
    this.record = record;
    this.adb = new Adb(adbPath, record.serial);
    this.seq = deps.store.nextSeq(record.id);
    assertPackage(record.packageName);
  }

  /* ----------------------------- status & stream ----------------------------- */

  view(): SessionView {
    return {
      ...this.record,
      activity: this.activity,
      agentConnected: this.lastAgentEventAt !== null && Date.now() - this.lastAgentEventAt < AGENT_CONNECTED_WINDOW_MS,
      hasAgentData: this.hasAgentData || (this.hasAgentData = this.deps.store.hasAgentEvents(this.record.id)),
      lastAgentEventAt: this.lastAgentEventAt,
      journeyRecording: this.journey ? { name: this.journey.name, steps: this.journey.steps.length } : null,
    };
  }

  subscribe(listener: (message: StreamMessage) => void): () => void {
    this.listeners.add(listener);
    listener({ event: 'status', data: this.view() });
    return () => this.listeners.delete(listener);
  }

  private send(message: StreamMessage): void {
    for (const l of this.listeners) {
      try {
        l(message);
      } catch {
        /* a broken listener must not affect others */
      }
    }
  }

  private notify(): void {
    this.send({ event: 'status', data: this.view() });
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.send({ event: 'log', data: { ts: Date.now(), level, message } });
  }

  private save(patch: Partial<SessionRecord>): void {
    this.record = { ...this.record, ...patch };
    this.deps.store.saveSession(this.record);
    this.notify();
  }

  /* --------------------------------- events --------------------------------- */

  /** Stores events on the timeline. Outside a recording they are dropped unless `force`. */
  addEvents(events: NewEvent[], force = false): void {
    if (this.disposed || events.length === 0) return;
    if (this.record.status !== 'recording' && !force) return;
    if (this.record.eventCount + events.length > LIMITS.maxEventsPerSession) {
      this.log('error', 'Session event limit reached; stopping recording.');
      void this.stopRecording();
      return;
    }
    const stored: PerfEvent[] = events.map((e) => ({
      id: `e${this.seq++}`,
      ts: Math.round(e.ts * 1000) / 1000,
      type: e.type,
      screen: e.screen !== undefined ? e.screen : this.currentScreen,
      duration: e.duration ?? null,
      source: e.source,
      metadata: e.metadata,
    }));
    this.deps.store.insertEvents(this.record.id, stored);
    this.record = { ...this.record, eventCount: this.record.eventCount + stored.length };
    this.pendingBroadcast.push(...stored);
    if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null;
        const batch = this.pendingBroadcast.splice(0, this.pendingBroadcast.length);
        if (batch.length > 0) this.send({ event: 'events', data: batch });
        this.deps.store.saveSession(this.record);
        this.notify();
      }, BROADCAST_INTERVAL_MS);
    }
  }

  /** Converts a validated agent batch (device clock) onto the host timeline. */
  ingestBatch(batch: ParsedWireBatch): void {
    const wasConnected = this.view().agentConnected;
    this.lastAgentEventAt = Date.now();
    this.hasAgentData = true;
    if (batch.i !== this.agentInstance) {
      this.agentInstance = batch.i;
      this.currentScreen = null;
    }
    const events: NewEvent[] = [];
    for (const w of batch.e) {
      const metadata: Record<string, unknown> = { ...(w.m ?? {}), agentInstance: batch.i };
      if (typeof metadata.url === 'string') metadata.url = redactUrl(metadata.url);
      if (w.t === 'SCREEN_ENTER' && typeof w.s === 'string') this.currentScreen = w.s;
      events.push({
        ts: w.ts - this.clockOffset,
        type: w.t,
        source: 'agent',
        duration: w.d ?? null,
        screen: w.s ?? null,
        metadata,
      });
    }
    this.addEvents(events);
    if (!wasConnected) this.notify();
  }

  private host(type: NewEvent['type'], metadata: Record<string, unknown>, ts = Date.now(), duration: number | null = null): void {
    this.addEvents([{ ts, type, source: 'host', duration, metadata }]);
  }

  /* -------------------------------- recording ------------------------------- */

  async startRecording(): Promise<SessionView> {
    if (this.record.status === 'recording') return this.view();
    await this.refreshClock();
    this.save({ status: 'recording', recordingStartedAt: this.record.recordingStartedAt ?? Date.now(), recordingStoppedAt: null });
    const emit = (events: NewEvent[]) => this.addEvents(events);
    const log = (level: 'info' | 'warn' | 'error', message: string) => this.log(level, message);
    const pkg = this.record.packageName;
    this.collectors = [
      createLogcatCollector({
        adb: this.adb,
        packageName: pkg,
        clockOffset: () => this.clockOffset,
        onBatch: (batch) => this.ingestBatch(batch),
        onDisplayed: (component, totalMs, ts, pid) => this.onDisplayed(component, totalMs, ts, pid),
        emit,
        log,
      }),
      createMemoryCollector(this.adb, pkg, emit, log),
      createCpuCollector(this.adb, pkg, emit, log),
      createFrameCollector(this.adb, pkg, emit, log),
      createInputCollector(this.adb, (action) => this.onDeviceAction(action), log),
    ];
    for (const c of this.collectors) c.start();
    if (this.deps.ingestPort > 0) {
      await this.adb.reverse(this.deps.ingestPort).catch((error: unknown) => this.log('warn', `adb reverse failed: ${errorMessage(error)}`));
    }
    this.clockTimer = setInterval(() => void this.refreshClock(), CLOCK_REFRESH_MS);
    this.host('MARK', { name: 'recording:start' });
    this.log('info', 'Recording started');
    return this.view();
  }

  async stopRecording(): Promise<SessionView> {
    if (this.record.status !== 'recording') return this.view();
    this.host('MARK', { name: 'recording:stop' });
    for (const c of this.collectors) c.stop();
    this.collectors = [];
    if (this.deps.ingestPort > 0) await this.adb.removeReverse(this.deps.ingestPort);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.save({ status: 'stopped', recordingStoppedAt: Date.now() });
    this.log('info', 'Recording stopped');
    return this.view();
  }

  private async refreshClock(): Promise<void> {
    try {
      const { offset, rtt } = await this.adb.clockOffset();
      this.clockOffset = offset;
      if (rtt > 500) this.log('warn', `Slow adb round trip (${rtt} ms): timestamp alignment is less precise`);
    } catch (error) {
      this.log('warn', `Could not read the device clock: ${errorMessage(error)}`);
    }
  }

  private onDisplayed(component: string, totalMs: number, ts: number, pid: number): void {
    if (this.launchInProgress) {
      // Fallback for launches where `am start -W` reports no TotalTime (e.g. first launch after install).
      this.displayedDuringLaunch = totalMs;
      return;
    }
    // Android may log a second "Displayed" (starting window vs. activity) for a launch we made.
    if (this.lastToolLaunchAt !== null && Math.abs(ts - totalMs - this.lastToolLaunchAt) < 5000) return;
    const kind = this.lastPid !== null && this.lastPid === pid ? 'warm' : 'cold';
    this.lastPid = pid;
    const start = ts - totalMs;
    this.addEvents([
      { ts: start, type: 'APP_START', source: 'device', metadata: { kind, activity: component, external: true } },
      { ts: start, type: 'STARTUP', source: 'device', duration: totalMs, metadata: { kind, totalTime: totalMs, activity: component, external: true } },
    ]);
  }

  private onDeviceAction(action: DeviceAction): void {
    this.addEvents([
      {
        ts: action.ts,
        type: 'USER_ACTION',
        source: 'device',
        duration: action.durationMs,
        metadata: { kind: action.kind, origin: 'device', x: action.x, y: action.y, x2: action.x2, y2: action.y2, keyCode: action.keyCode },
      },
    ]);
    if (this.journey && action.kind !== 'home' && action.kind !== 'key') {
      this.appendJourneyStep({
        kind: action.kind as JourneyStep['kind'],
        ...(action.kind === 'back' ? {} : { x: action.nx, y: action.ny, x2: action.nx2, y2: action.ny2, durationMs: action.durationMs }),
      });
    }
  }

  /* -------------------------------- activities ------------------------------ */

  private async runActivity<T>(activity: Activity, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activity) throw conflict('BUSY', `The session is busy (${this.activity}). Cancel it or wait.`);
    this.activity = activity;
    this.abort = new AbortController();
    this.notify();
    try {
      return await work(this.abort.signal);
    } finally {
      this.activity = null;
      this.abort = null;
      this.notify();
    }
  }

  /** Starts an activity in the background; failures are reported on the stream. */
  private background(activity: Activity, work: (signal: AbortSignal) => Promise<void>): void {
    if (this.activity) throw conflict('BUSY', `The session is busy (${this.activity}). Cancel it or wait.`);
    void this.runActivity(activity, work).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'ABORTED') this.log('info', `${activity} cancelled`);
      else this.log('error', `${activity} failed: ${errorMessage(error)}`);
    });
  }

  cancel(): void {
    this.abort?.abort();
  }

  /* ------------------------------ install/launch ---------------------------- */

  async install(options: { replace?: boolean; grantPermissions?: boolean }): Promise<void> {
    const apk = this.deps.apkPathFor(this.app, this.record.variant);
    if (!existsSync(apk)) throw new AppError(409, 'APK_MISSING', this.record.variant === 'instrumented' ? 'Build the instrumented APK first.' : 'The uploaded APK file is missing.');
    await this.runActivity('installing', async (signal) => {
      this.log('info', `Installing ${this.record.variant} build…`);
      try {
        await this.adb.install(apk, { grantPermissions: options.grantPermissions ?? true, signal });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'SIGNATURE_MISMATCH' || !options.replace) throw error;
        this.log('warn', 'Signature mismatch: uninstalling the existing app (its data is deleted)');
        await this.adb.uninstall(this.record.packageName);
        await this.adb.install(apk, { grantPermissions: options.grantPermissions ?? true, signal });
      }
      this.log('info', 'Installed');
    });
  }

  private async component(): Promise<string> {
    const resolved = await this.adb.resolveLaunchActivity(this.record.packageName);
    const component = resolved ?? this.app.launchActivity;
    if (!component || !isComponent(component)) throw new AppError(409, 'NO_LAUNCH_ACTIVITY', 'Could not find a launcher activity. Is the app installed?');
    return component;
  }

  private async launchInternal(expected: 'cold' | 'hot', iteration: number | null, signal?: AbortSignal): Promise<LaunchResult & { iteration: number | null }> {
    if (!(await this.adb.isInstalled(this.record.packageName))) throw new AppError(409, 'NOT_INSTALLED', 'The app is not installed on this device.');
    const component = await this.component();
    if (expected === 'cold') {
      await this.adb.forceStop(this.record.packageName);
      this.currentScreen = null;
      await sleep(600, signal);
    }
    const t0 = Date.now();
    this.lastToolLaunchAt = t0;
    this.host('APP_START', { kind: expected, activity: component, iteration }, t0);
    if (expected === 'hot') this.host('APP_STATE', { state: 'active', origin: 'host' }, t0);
    this.launchInProgress = true;
    this.displayedDuringLaunch = null;
    let result: LaunchResult;
    try {
      result = await this.adb.launch(component, expected, signal);
      if (result.totalTime === null) {
        // logcat may deliver the "Displayed" line after am start returns; when am itself timed
        // out (very slow first frame), keep waiting for it for up to a minute.
        const attempts = result.launchState?.startsWith('UNKNOWN') ? 600 : 10;
        for (let i = 0; i < attempts && this.displayedDuringLaunch === null; i++) await sleep(100, signal);
        if (this.displayedDuringLaunch !== null) result = { ...result, totalTime: this.displayedDuringLaunch };
      }
    } finally {
      this.launchInProgress = false;
    }
    this.host('STARTUP', { ...result, iteration }, t0, result.totalTime);
    this.lastPid = (await this.adb.pids(this.record.packageName))[0] ?? null;
    return { ...result, iteration };
  }

  async launch(cold: boolean): Promise<LaunchResult & { iteration: number | null }> {
    await this.startRecording();
    return this.runActivity('launching', (signal) => this.launchInternal(cold ? 'cold' : 'hot', null, signal));
  }

  private async goHome(signal?: AbortSignal): Promise<void> {
    await this.adb.keyevent('KEYCODE_HOME');
    this.host('APP_STATE', { state: 'background', origin: 'host' });
    await sleep(1500, signal);
  }

  async hotStart(): Promise<LaunchResult & { iteration: number | null }> {
    await this.startRecording();
    return this.runActivity('launching', async (signal) => {
      await this.goHome(signal);
      return this.launchInternal('hot', null, signal);
    });
  }

  async startupBenchmark(iterations: number, includeHot: boolean, settleMs = 5000): Promise<(LaunchResult & { iteration: number | null })[]> {
    await this.startRecording();
    return this.runActivity('benchmark', async (signal) => {
      const runs: (LaunchResult & { iteration: number | null })[] = [];
      this.host('MARK', { name: 'benchmark:start', iterations, includeHot });
      for (let i = 1; i <= iterations; i++) {
        this.log('info', `Cold start ${i}/${iterations}`);
        runs.push(await this.launchInternal('cold', i, signal));
        await sleep(settleMs, signal);
        if (includeHot) {
          this.log('info', `Hot start ${i}/${iterations}`);
          await this.goHome(signal);
          runs.push(await this.launchInternal('hot', i, signal));
          await sleep(Math.min(settleMs, 3000), signal);
        }
      }
      this.host('MARK', { name: 'benchmark:end' });
      return runs;
    });
  }

  /* ---------------------------------- input --------------------------------- */

  private async screenSize(): Promise<{ width: number; height: number }> {
    if (!this.screen || Date.now() - this.screen.at > 30_000) {
      const size = await this.adb.screenSize();
      this.screen = { ...size, at: Date.now() };
    }
    return this.screen;
  }

  async input(action: InputAction): Promise<void> {
    const size = await this.screenSize();
    const px = (n: number | undefined, max: number) => Math.round(Math.min(1, Math.max(0, n ?? 0)) * (max - 1));
    const x = px(action.x, size.width);
    const y = px(action.y, size.height);
    let selector: JourneyStep['selector'];
    let elementLabel: string | undefined;
    if (this.journey && (action.kind === 'tap' || action.kind === 'long_press')) {
      try {
        const node = nodeAt(parseUiDump(await this.adb.uiDump(), size), x, y);
        if (node) {
          elementLabel = label(node);
          selector = node.resourceId ? { resourceId: node.resourceId } : node.text ? { text: node.text } : node.contentDesc ? { contentDesc: node.contentDesc } : undefined;
        }
      } catch {
        /* selector capture is best effort */
      }
    }
    const ts = Date.now();
    switch (action.kind) {
      case 'tap':
        await this.adb.tap(x, y);
        break;
      case 'long_press':
        await this.adb.swipe(x, y, x, y, 700);
        break;
      case 'swipe':
        await this.adb.swipe(x, y, px(action.x2, size.width), px(action.y2, size.height), action.durationMs ?? 300);
        break;
      case 'back':
        await this.adb.keyevent('KEYCODE_BACK');
        break;
      case 'home':
        await this.adb.keyevent('KEYCODE_HOME');
        break;
    }
    this.host('USER_ACTION', {
      kind: action.kind as UserActionKind,
      origin: 'dashboard',
      ...(action.kind === 'back' || action.kind === 'home' ? {} : { x, y }),
      ...(action.kind === 'swipe' ? { x2: px(action.x2, size.width), y2: px(action.y2, size.height) } : {}),
      label: elementLabel,
    }, ts);
    if (this.journey && action.kind !== 'home') {
      this.appendJourneyStep({
        kind: action.kind,
        ...(action.kind === 'back' ? {} : { x: action.x, y: action.y }),
        ...(action.kind === 'swipe' ? { x2: action.x2, y2: action.y2, durationMs: action.durationMs ?? 300 } : {}),
        ...(selector ? { selector } : {}),
      });
    }
  }

  screenshot(): Promise<Buffer> {
    return this.adb.screencap();
  }

  async ui(): Promise<UiSnapshot> {
    return parseUiDump(await this.adb.uiDump(), await this.screenSize());
  }

  mark(name: string): void {
    this.addEvents([{ ts: Date.now(), type: 'MARK', source: 'host', metadata: { name: name.slice(0, 200) } }], true);
  }

  /* --------------------------------- journeys ------------------------------- */

  startJourneyRecording(name: string): SessionView {
    if (this.journey) throw conflict('JOURNEY_ACTIVE', 'A journey is already being recorded');
    this.journey = { name, steps: [], lastAt: Date.now() };
    this.notify();
    return this.view();
  }

  private appendJourneyStep(step: Omit<JourneyStep, 'delayMs'>): void {
    if (!this.journey || this.journey.steps.length >= 500) return;
    const now = Date.now();
    this.journey.steps.push({ ...step, delayMs: Math.min(10_000, now - this.journey.lastAt) });
    this.journey.lastAt = now;
    this.notify();
  }

  stopJourneyRecording(): JourneyRecord {
    if (!this.journey) throw conflict('NO_JOURNEY', 'No journey is being recorded');
    const journey: JourneyRecord = {
      id: randomUUID(),
      name: this.journey.name,
      packageName: this.record.packageName,
      createdAt: Date.now(),
      steps: this.journey.steps,
    };
    this.journey = null;
    this.deps.store.saveJourney(journey);
    this.notify();
    return journey;
  }

  replayJourney(journey: JourneyRecord, repeat: number, restart: boolean): void {
    if (journey.packageName !== this.record.packageName) throw conflict('JOURNEY_MISMATCH', 'This journey was recorded for a different app');
    this.background('replaying', async (signal) => {
      await this.startRecording();
      const size = await this.screenSize();
      for (let r = 1; r <= repeat; r++) {
        this.log('info', `Replaying "${journey.name}" (${r}/${repeat})`);
        if (restart) {
          await this.launchInternal('cold', null, signal);
          await sleep(3000, signal);
        }
        this.host('MARK', { name: 'journey:start', journey: journey.name, repetition: r });
        for (const [index, step] of journey.steps.entries()) {
          await sleep(Math.min(10_000, Math.max(300, step.delayMs)), signal);
          let x = Math.round((step.x ?? 0) * (size.width - 1));
          let y = Math.round((step.y ?? 0) * (size.height - 1));
          let stepLabel: string | undefined;
          if (step.selector && step.kind !== 'back') {
            try {
              const snap = parseUiDump(await this.adb.uiDump(), size);
              const s = step.selector;
              const node = snap.nodes.find((n) => (s.resourceId && n.resourceId === s.resourceId) || (s.text && n.text === s.text) || (s.contentDesc && n.contentDesc === s.contentDesc));
              if (node) {
                ({ x, y } = center(node));
                stepLabel = label(node);
              }
            } catch {
              /* fall back to recorded coordinates */
            }
          }
          const meta = { origin: 'journey', journey: journey.name, repetition: r, step: index, label: stepLabel };
          if (step.kind === 'back') {
            this.host('USER_ACTION', { kind: 'back', ...meta });
            await this.adb.keyevent('KEYCODE_BACK');
          } else if (step.kind === 'swipe') {
            const x2 = Math.round((step.x2 ?? step.x ?? 0) * (size.width - 1));
            const y2 = Math.round((step.y2 ?? step.y ?? 0) * (size.height - 1));
            this.host('USER_ACTION', { kind: 'swipe', x, y, x2, y2, ...meta });
            await this.adb.swipe(x, y, x2, y2, Math.min(5000, Math.max(50, step.durationMs ?? 300)));
          } else if (step.kind === 'long_press') {
            this.host('USER_ACTION', { kind: 'long_press', x, y, ...meta });
            await this.adb.swipe(x, y, x, y, 700);
          } else {
            this.host('USER_ACTION', { kind: 'tap', x, y, ...meta });
            await this.adb.tap(x, y);
          }
        }
        this.host('MARK', { name: 'journey:end', journey: journey.name, repetition: r });
        await sleep(2000, signal);
      }
      this.log('info', `Journey "${journey.name}" finished`);
    });
  }

  /* -------------------------------- exploration ----------------------------- */

  startExploration(maxSteps: number, maxDurationSec: number): void {
    this.background('exploring', async (signal) => {
      await this.startRecording();
      this.host('MARK', { name: 'explore:start', maxSteps, maxDurationSec });
      const result = await explore(
        this.adb,
        { maxSteps, maxDurationMs: maxDurationSec * 1000, settleMs: 1500, signal },
        {
          packageName: this.record.packageName,
          launch: async () => {
            await this.launchInternal('cold', null, signal);
            await sleep(3000, signal);
          },
          onAction: (a) => this.host('USER_ACTION', { kind: a.kind, origin: 'explorer', x: a.x, y: a.y, x2: a.x2, y2: a.y2, label: a.label }),
          log: (message) => this.log('info', message),
        },
      );
      this.host('MARK', { name: 'explore:end', ...result });
      this.log('info', `Exploration finished: ${result.steps} actions across ${result.states} screen states`);
    });
  }

  /* --------------------------------- profiling ------------------------------ */

  importProfile(json: unknown, anchor?: number): number {
    const profile = parseCpuProfile(json);
    const hostStart = looksLikeEpochMicros(profile)
      ? profile.startTime / 1000 - this.clockOffset
      : (anchor ?? this.record.recordingStartedAt ?? Date.now() - (profile.endTime - profile.startTime) / 1000);
    const events = profileToEvents(profile, { hostStart });
    this.addEvents(events, true);
    this.log('info', `Imported ${events.length} function samples from the CPU profile`);
    return events.length;
  }

  async startCdpProfiling(): Promise<void> {
    if (this.profiler) throw conflict('PROFILING', 'Profiling is already running');
    const url = await HermesProfiler.findTarget(this.deps.metroUrl, this.record.packageName);
    const profiler = new HermesProfiler(this.deps.metroUrl);
    await profiler.connect(url);
    await profiler.start();
    this.profiler = profiler;
    this.activity = 'profiling';
    this.notify();
    this.log('info', 'Hermes sampling profiler started');
  }

  async stopCdpProfiling(): Promise<number> {
    const profiler = this.profiler;
    if (!profiler) throw conflict('NOT_PROFILING', 'Profiling is not running');
    this.profiler = null;
    try {
      const { profile, hostStart, hostEnd } = await profiler.stop();
      const events = profileToEvents(parseCpuProfile(profile), { hostStart, hostEnd });
      this.addEvents(events, true);
      this.log('info', `Captured ${events.length} function samples`);
      return events.length;
    } finally {
      if (this.activity === 'profiling') this.activity = null;
      this.notify();
    }
  }

  /* ---------------------------------- teardown ------------------------------ */

  async dispose(): Promise<void> {
    this.cancel();
    this.profiler?.close();
    await this.stopRecording().catch(() => undefined);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.disposed = true;
    this.listeners.clear();
  }
}
