# HTTP API

The server listens on `127.0.0.1:4310` by default. All JSON. All routes under
`/api` require authentication; see [SECURITY.md](../SECURITY.md).

## Authentication & request rules

| Rule | Detail |
| --- | --- |
| Launch URL | The CLI prints `http://127.0.0.1:4310/auth?token=<launch-token>`. Visiting it sets an `HttpOnly; SameSite=Strict` cookie and redirects to `/`. |
| Programmatic access | `Authorization: Bearer <launch-token>` is accepted instead of the cookie. |
| State-changing requests | `POST`/`PUT`/`DELETE` must send `X-RNPA-Request: 1`. Requests with a foreign `Origin` are rejected. |
| Host header | Only `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` are accepted (DNS-rebinding protection). |
| Errors | `{ "error": { "code": "STRING_CODE", "message": "human readable" } }` with a 4xx/5xx status. |

## Environment

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/env` | `EnvInfo` (`?refresh=1` re-scans the toolchain) |
| GET | `/api/devices` | `Device[]` |
| GET | `/api/avds` | `string[]` |
| POST | `/api/avds/:name/start` | `{ ok: true }` |

```ts
interface ToolStatus { available: boolean; path: string | null; version: string | null }
interface EnvInfo {
  version: string;
  dataDir: string;
  tools: { adb: ToolStatus; emulator: ToolStatus; apksigner: ToolStatus; zipalign: ToolStatus; keytool: ToolStatus; apktool: ToolStatus };
  // HTTP agent transport (only when started with --ingest-port); url/token are '' when disabled.
  ingest: { enabled: boolean; url: string; token: string };
  metroInspectorUrl: string;
}
interface Device {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | string;
  model: string | null;
  sdk: number | null;
  release: string | null;
  abi: string | null;
  isEmulator: boolean;
  screen: { width: number; height: number; density: number | null } | null;
}
```

## Apps (uploaded APKs)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/apps` | `multipart/form-data`, single field `file` (`.apk`). Returns `AppRecord`. |
| GET | `/api/apps` | `AppRecord[]`, newest first |
| GET | `/api/apps/:id` | `AppRecord` |
| DELETE | `/api/apps/:id` | `{ ok: true }` |
| POST | `/api/apps/:id/instrument` | Starts building the instrumented APK. Returns `AppRecord` (poll it). |

```ts
interface AppRecord {
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
    status: 'none' | 'running' | 'ready' | 'failed';
    strategy: 'bundle' | 'loader' | null;
    error: string | null;
    builtAt: number | null;
    channel: string | null;
  };
}
```

## Sessions

A session binds one app build to one device and owns one timeline.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/sessions` | `{ appId, serial, variant: 'original' \| 'instrumented', name? }` | `Session` |
| GET | `/api/sessions` | | `Session[]` |
| GET | `/api/sessions/:id` | | `Session` |
| DELETE | `/api/sessions/:id` | | `{ ok: true }` |
| POST | `/api/sessions/:id/install` | `{ replace?: boolean, grantPermissions?: boolean }` | `{ ok: true }` — `409 SIGNATURE_MISMATCH` when the installed app was signed with another key; retry with `replace: true` (uninstalls, wiping app data). |
| POST | `/api/sessions/:id/launch` | `{ cold?: boolean }` | `StartupResult` |
| POST | `/api/sessions/:id/hot-start` | | `StartupResult` |
| POST | `/api/sessions/:id/startup-benchmark` | `{ iterations: 1..10, includeHot?: boolean }` | `{ runs: StartupResult[] }` |
| POST | `/api/sessions/:id/record/start` | | `Session` |
| POST | `/api/sessions/:id/record/stop` | | `Session` |
| POST | `/api/sessions/:id/input` | `InputAction` | `{ ok: true }` |
| POST | `/api/sessions/:id/marks` | `{ name }` | `{ ok: true }` |
| POST | `/api/sessions/:id/cancel` | | Cancels the running activity (benchmark, explorer, replay). |
| GET | `/api/sessions/:id/screenshot` | | `image/png` |
| GET | `/api/sessions/:id/ui` | | `UiSnapshot` |
| POST | `/api/sessions/:id/explore` | `{ maxSteps?: 1..500, maxDurationSec?: 10..3600 }` | `{ ok: true }` (runs in background) |
| GET | `/api/sessions/:id/events` | query `types=A,B&from=<ms>&to=<ms>&limit=<n>` | `PerfEvent[]` |
| GET | `/api/sessions/:id/analysis` | | `AnalysisReport` (see `packages/shared/src/report.ts`) |
| GET | `/api/sessions/:id/export.json` | | `{ session, app, events, analysis }` download |
| GET | `/api/sessions/:id/report.html` | | Self-contained HTML report download |
| POST | `/api/sessions/:id/profile` | `.cpuprofile` JSON (≤ 64 MB), optional `?anchor=<epoch ms>` for profiles with a non-epoch clock | `{ functions: number }` |
| POST | `/api/sessions/:id/profile/cdp/start` | | Starts Hermes sampling via Metro's inspector (debug builds). |
| POST | `/api/sessions/:id/profile/cdp/stop` | | `{ functions: number }` |
| GET | `/api/sessions/:id/stream` | | Server-Sent Events, see below |

```ts
interface Session {
  id: string;
  name: string;
  appId: string;
  packageName: string;
  serial: string;
  deviceModel: string | null;
  variant: 'original' | 'instrumented';
  createdAt: number;
  status: 'idle' | 'recording' | 'stopped';
  recordingStartedAt: number | null;
  recordingStoppedAt: number | null;
  eventCount: number;
  activity: null | 'installing' | 'launching' | 'benchmark' | 'exploring' | 'replaying' | 'profiling';
  agentConnected: boolean;          // agent events received in the last 15 s
  hasAgentData: boolean;            // timeline contains agent events from any recording
  lastAgentEventAt: number | null;
  journeyRecording: { name: string; steps: number } | null;
}

interface StartupResult {
  kind: 'cold' | 'warm' | 'hot';
  totalTime: number | null;   // ms, TTID
  waitTime: number | null;
  launchState: string | null;
  activity: string | null;
  iteration: number | null;
}

// Coordinates are normalized to 0..1 of the device screen.
type InputAction =
  | { kind: 'tap' | 'long_press'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; x2: number; y2: number; durationMs?: number }
  | { kind: 'back' | 'home' };

interface UiNode {
  id: number;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  clickable: boolean;
  scrollable: boolean;
  bounds: [number, number, number, number]; // device pixels x1,y1,x2,y2
}
interface UiSnapshot { width: number; height: number; foregroundPackage: string | null; nodes: UiNode[] }
```

### Server-Sent Events (`/api/sessions/:id/stream`)

| Event | Data |
| --- | --- |
| `status` | `Session` (sent on connect and on every change) |
| `events` | `PerfEvent[]` — newly stored events, batched (≤ 4/s) |
| `log` | `{ ts: number, level: 'info' \| 'warn' \| 'error', message: string }` |

## Journeys

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/journeys` | | `Journey[]` |
| DELETE | `/api/journeys/:id` | | `{ ok: true }` |
| POST | `/api/sessions/:id/journey-recording/start` | `{ name }` | `Session` |
| POST | `/api/sessions/:id/journey-recording/stop` | | `Journey` |
| POST | `/api/sessions/:id/journeys/:journeyId/replay` | `{ repeat?: 1..20, restart?: boolean }` | `{ ok: true }` (runs in background; `restart` cold-launches before each repetition, default true) |

```ts
interface JourneyStep {
  kind: 'tap' | 'long_press' | 'swipe' | 'back';
  x?: number; y?: number; x2?: number; y2?: number;   // normalized 0..1
  durationMs?: number;
  delayMs: number;                                     // pause before this step
  selector?: { resourceId?: string; text?: string; contentDesc?: string };
}
interface Journey { id: string; name: string; packageName: string; createdAt: number; steps: JourneyStep[] }
```

## Agent ingest (HTTP transport)

`POST /ingest` with `Authorization: Bearer <ingest-token>` and a `WireBatch` body
(`packages/shared/src/events.ts`). Not cookie-authenticated, and only reachable
through `adb reverse` from the device. The default transport is logcat, which
needs no network access from the app.
