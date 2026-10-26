/**
 * DTOs for the HTTP/SSE contract in docs/API.md. Analysis and event types
 * come from @rnpa/shared (type-only import, nothing bundled).
 */
import type { AnalysisReport, PerfEvent } from '@rnpa/shared';

export type { AnalysisReport, PerfEvent };

export interface ToolStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}

export type ToolName = 'adb' | 'emulator' | 'apksigner' | 'zipalign' | 'keytool' | 'apktool';

export interface EnvInfo {
  version: string;
  dataDir: string;
  tools: Record<ToolName, ToolStatus>;
  ingest: { url: string; token: string };
  metroInspectorUrl: string;
}

export interface Device {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | (string & {});
  model: string | null;
  sdk: number | null;
  release: string | null;
  abi: string | null;
  isEmulator: boolean;
  screen: { width: number; height: number; density: number | null } | null;
}

export type InstrumentStatus = 'none' | 'running' | 'ready' | 'failed';

export interface AppRecord {
  id: string;
  fileName: string;
  sha256: string;
  size: number;
  uploadedAt: number;
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  launchActivity: string | null;
  isReactNative: boolean;
  jsEngine: 'hermes' | 'jsc' | 'unknown';
  bundleFormat: 'hbc' | 'js' | 'none';
  bundleSize: number | null;
  abis: string[];
  instrumentation: { supported: boolean; strategy: 'bundle' | 'loader' | null; reason: string };
  instrumented: {
    status: InstrumentStatus;
    strategy: 'bundle' | 'loader' | null;
    error: string | null;
    builtAt: number | null;
    channel: string | null;
  };
}

export type SessionStatus = 'idle' | 'recording' | 'stopped';
export type SessionActivity = null | 'installing' | 'launching' | 'benchmark' | 'exploring' | 'replaying' | 'profiling';
export type Variant = 'original' | 'instrumented';

export interface Session {
  id: string;
  name: string;
  appId: string;
  packageName: string;
  serial: string;
  deviceModel: string | null;
  variant: Variant;
  createdAt: number;
  status: SessionStatus;
  recordingStartedAt: number | null;
  recordingStoppedAt: number | null;
  eventCount: number;
  activity: SessionActivity;
  agentConnected: boolean;
  /** Timeline contains agent events, even if the agent is not live right now. */
  hasAgentData?: boolean;
  lastAgentEventAt: number | null;
  journeyRecording: { name: string; steps: number } | null;
}

export interface CreateSessionBody {
  appId: string;
  serial: string;
  variant: Variant;
  name?: string;
}

export interface StartupResult {
  kind: 'cold' | 'warm' | 'hot';
  totalTime: number | null;
  waitTime: number | null;
  launchState: string | null;
  activity: string | null;
  iteration: number | null;
}

export type InputAction =
  | { kind: 'tap' | 'long_press'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; x2: number; y2: number; durationMs?: number }
  | { kind: 'back' | 'home' };

export interface UiNode {
  id: number;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  clickable: boolean;
  scrollable: boolean;
  bounds: [number, number, number, number];
}

export interface UiSnapshot {
  width: number;
  height: number;
  foregroundPackage: string | null;
  nodes: UiNode[];
}

export interface JourneyStep {
  kind: 'tap' | 'long_press' | 'swipe' | 'back';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  delayMs: number;
  selector?: { resourceId?: string; text?: string; contentDesc?: string };
}

export interface Journey {
  id: string;
  name: string;
  packageName: string;
  createdAt: number;
  steps: JourneyStep[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogMessage {
  ts: number;
  level: LogLevel;
  message: string;
}

export interface OkResponse {
  ok: true;
}

export interface ProfileResult {
  functions: number;
}
