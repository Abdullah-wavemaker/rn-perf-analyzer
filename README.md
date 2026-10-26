# RN Performance Analyzer

Record, correlate and analyze the performance of a **React Native Android app
from its APK**. Upload an APK, let the tool instrument it, run it on an emulator
or device, and get a single timeline that lines up startup, navigation, network,
JS-thread work, rendering, memory and CPU, plus ranked bottlenecks with
recommendations.

Everything runs locally. No data leaves your machine.

```
Upload APK → Instrument → Install → Launch → Record journey → Collect → Correlate → Analyze → Report
```

## Contents

- [What it measures](#what-it-measures)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Capture modes](#capture-modes)
- [Metric definitions](#metric-definitions)
- [Project layout](#project-layout)
- [Development](#development)
- [Limitations](#limitations)
- [Security](#security)

## What it measures

| Area | Signals | Source |
| --- | --- | --- |
| Startup | Cold / warm / hot start, TTID (`am start -W` / `Displayed`), JS bundle start, first React commit, TTI | host, device, agent |
| Navigation | Screen enter, first render, time-to-interactive per screen, transition time from the user's tap | agent (React Navigation detected automatically) |
| Network | Every `fetch`, `XMLHttpRequest` and axios call: method, redacted URL, status, timings, TTFB, sizes, screen | agent |
| Network issues | Slow endpoints, duplicate requests, sequential waterfalls (with the parallel-time saving), failures | analyzer |
| JS thread | Long tasks (event-loop blocking) with suspects, slow timer/rAF callbacks, late timers, active intervals, explicit `measure()` spans, Hermes CPU profiles | agent, profiler |
| Rendering | UI-thread frame timing and jank (`gfxinfo framestats`), JS-thread FPS and dropped frames, React commits, per-component re-render counts | device, agent |
| Native | Process PSS / Java / native / graphics memory, Hermes heap, CPU per process and per thread (UI, JS, native modules, RenderThread) | device, agent |
| Stability | Java crashes, native crashes, ANRs, uncaught JS errors | device, agent |
| Interaction | Taps, long presses, swipes and Back, whether made on the device, from the dashboard mirror, a replayed journey or the explorer | device, host |

All signals are normalized into one event format and stored on one timeline per
session. The analyzer then correlates them:

- **API → render → TTI**: which requests sat on a screen's critical path, and how soon the render followed the last response.
- **Function → frame drop**: JS work (callbacks, long tasks, profiled functions, commits) that overlapped dropped frames.
- **Timer → JS block**: timer and interval callbacks that ran inside long tasks.
- **Memory → navigation**: memory growth attributed to screen visits, plus leak suspects across repeated visits.

## Quick start

Requirements: Node.js **22.13+**, Android SDK platform-tools (`adb`) and build-tools (`apksigner`, `zipalign`), a JDK 17+ (`keytool`). Optional: the Android Emulator, and `apktool` for Hermes-bytecode builds.

```bash
npm install
npm run build
npm run doctor        # checks the toolchain
npm start             # prints a sign-in URL; open it
```

Then, in the dashboard:

1. **Apps → Upload** an `.apk`. The tool inspects it: package, SDK levels, launcher activity, JS engine and bundle format, ABIs.
2. **Build instrumented APK** (when supported). The result is signed with a local test key.
3. **New session**: pick a device or emulator and the *instrumented* variant.
4. **Control tab**: *Install* (if the original app is installed, you are asked before replacing it, because replacing wipes its data), then *Cold launch*. Recording starts automatically.
5. Use the app: on the device itself, through the mirror in the dashboard, by replaying a recorded **journey**, or with **auto-explore**. Run the **startup benchmark** for repeatable cold/hot starts.
6. **Stop recording** and open **Overview**, **Startup**, **Screens**, **Network**, **JS**, **Rendering**, **Memory & CPU** or **Timeline**. Export the session as JSON or a self-contained HTML report.

CLI options:

```
rnpa [serve] [--port 4310] [--ingest-port <n>] [--data-dir ~/.rnpa] [--open] [--dev]
rnpa doctor
```

Data (APKs, builds, the signing key and the SQLite database) lives in `~/.rnpa`
(override with `--data-dir` or `RNPA_HOME`), with owner-only permissions.

## How it works

```
                    ┌──────────────────────────── host (127.0.0.1) ────────────────────────────┐
  dashboard  ◀─SSE──┤  Fastify API ─ SessionRuntime ─┬─ adb: install / am start -W / input      │
  (React)    ──API─▶│       │                         ├─ collectors: logcat · meminfo · /proc     │
                    │       │                         │              gfxinfo · getevent           │
                    │       ▼                         └─ automation: journeys · explorer · CDP    │
                    │  SQLite timeline ──▶ analyzer (pure) ──▶ metrics · correlations · score    │
                    └──────────────────────────────▲───────────────────────────────────────────────┘
                                                   │ logcat (ReactNativeJS tag, chunked JSON)
                    ┌──────────── device ──────────┴───────────────┐
                    │  app JS runtime: @rnpa/agent prelude          │
                    │  fetch/XHR/axios · timers/rAF · React commits │
                    │  navigation · long tasks · FPS · Hermes heap  │
                    └───────────────────────────────────────────────┘
```

- **Agent** (`packages/agent`): about 19 KB of dependency-free JS that runs before React Native boots. It hooks globals lazily as RN defines them, and observes React through the DevTools global hook, which React calls on every commit, production builds included. It writes compact batches through RN's native logger to logcat, so it needs no network permission and no cleartext exception, and it works in release builds.
- **Collectors** (`apps/server/src/collectors`): native metrics read over adb at fixed intervals, plus logcat parsing for agent batches, crashes, ANRs and launch timings, and kernel input events for manual interaction.
- **Clock alignment**: device timestamps are converted to host time with an offset measured over adb (lowest-latency of several round trips, refreshed every 30 s). Frame timestamps use the `Uptime` reference that `dumpsys` prints.
- **Analyzer** (`packages/analyzer`): a pure, deterministic function from events to report. Results are cached until new events arrive.

The full event model is in [`packages/shared/src/events.ts`](packages/shared/src/events.ts). The HTTP API is documented in [`docs/API.md`](docs/API.md).

## Capture modes

| Mode | When | What you get |
| --- | --- | --- |
| **Bundle injection** | APK with a plain-JS `index.android.bundle` (JSC, or Hermes running source) | Everything. The agent is prepended to the bundle by a pure ZIP rewrite (other entries copied byte-for-byte), then zipaligned (16 KB pages) and signed. |
| **Loader patch** *(experimental)* | APK with a Hermes **bytecode** bundle (most release builds since RN 0.70) | Everything. Needs `apktool`: the agent ships as a separate asset and React Native's `loadScriptFromAssets` (smali) is patched to evaluate it before the app bundle. |
| **SDK** | You own the app source | Everything, in any build. Add `@rnpa/agent` (see [its README](packages/agent/README.md)) and optionally call `markAppReady()` / `markScreenReady()` for exact TTI. |
| **Native only** | Any APK, including non-RN apps or debug builds that load JS from Metro | Startup (TTID), UI frames and jank, memory, CPU, crashes and interaction. No JS, network or screen data. |

Hermes CPU profiles add function-level attribution in every mode: import a
`.cpuprofile` (for example from `npx react-native profile-hermes`) or, for debug
builds connected to Metro, start and stop sampling from the Control tab.

## Metric definitions

| Metric | Definition |
| --- | --- |
| **TTID** | Android's time to initial display: `TotalTime` from `am start -W`, or the `Displayed +Xms` logcat line when `am` times out. |
| **JS init** | Launch → the JS bundle starts evaluating (agent start, or `__BUNDLE_START_TIME__`). |
| **First render** | Launch → the first React commit. |
| **Screen TTI** | Screen enter → interactive. The app's `markScreenReady()` wins when present. Otherwise it is *derived*: starting at the screen's first render, the ready point moves forward while, within a 500 ms quiet window, a request is in flight or starts, a React commit lands, or a long task blocks the JS thread. The cap is 30 s (protects against polling screens). |
| **App TTI (cold)** | Launch → first screen interactive (as above). Without navigation data, it is derived the same way from the first render. `markAppReady()` wins. |
| **Transition** | The user's tap (within 3 s before) → the new screen's first render. |
| **Long task** | The JS event loop was blocked for ≥ 50 ms (measured by a 50 ms heartbeat on the untouched `setTimeout`). |
| **Dropped frames** | UI thread: frames from `gfxinfo framestats` taking ≥ 2 vsync intervals. JS thread: `requestAnimationFrame` gaps. |
| **Score** | Each category maps a key metric onto 0–100 (90 at the "good" budget, 50 at "poor"). The overall score is the weighted mean of categories that have data. Budgets are in [`packages/analyzer/src/options.ts`](packages/analyzer/src/options.ts). |

## Project layout

```
packages/shared     Event model, wire schema (zod), redaction, report types
packages/agent      In-app instrumentation: prelude (injected) + SDK
packages/analyzer   Metrics, correlations, bottleneck rules, scoring
apps/server         CLI, Fastify API, adb orchestration, APK pipeline, collectors, automation
apps/dashboard      React dashboard (built to static files served by the server)
docs/API.md         HTTP / SSE API
SECURITY.md         Threat model and controls
```

## Development

```bash
npm test                       # vitest: agent (in a VM simulating RN), analyzer, parsers, validators
npm run typecheck
npm run dev:server             # tsx watch on :4310 (pass --dev to allow the Vite origin)
npm run dev:dashboard          # Vite on :5173, proxies /api and /auth to :4310
```

The agent test runs the real built prelude in a `node:vm` context that mimics
React Native's lazy global polyfills, XHR-backed `fetch`, and the DevTools hook.

## Limitations

- **Android only.** iOS is not supported.
- **Instrumented builds are re-signed** with a local test key. Installing one replaces an app signed with another key, which wipes that app's data (the dashboard asks first). They are for testing, never for distribution.
- **Component names** come from function names in the bundle. Bundles minified without `keep_fnames` show short names (`t`, `o`).
- **Navigation** is detected automatically for React Navigation (v5+). Other navigators need `setScreen()` from the SDK.
- **The loader patch** depends on React Native's `JSBundleLoaderDelegate` surviving R8 obfuscation, and on the app's Hermes build being able to compile source. The tool checks the first; check the Timeline for agent events to confirm the second.
- **Timing precision**: device-to-host alignment is good to within half an adb round trip (typically under 20 ms). UI frame timestamps are aligned per `dumpsys` sample.
- **Overhead**: the agent samples the JS thread continuously (a 50 ms heartbeat and an rAF loop). Compare instrumented builds with each other, not with uninstrumented ones.
- **Touch recording** from the device assumes portrait orientation for coordinate mapping.

## Security

The server binds to loopback only, requires a per-run secret, protects against
CSRF and DNS rebinding, validates every value that reaches a device shell, and
treats APKs, device output and agent data as untrusted. See [SECURITY.md](SECURITY.md).
