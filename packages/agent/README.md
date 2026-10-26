# @rnpa/agent

In-app instrumentation for RN Performance Analyzer. It is used in two ways:

- **Prelude**: the analyzer injects `dist/prelude.js` into an APK, so no code changes are needed.
- **SDK**: import it in your app for full metrics in any build, including debug builds that load JS from Metro, plus precise readiness marks.

## SDK usage

Make it the **first import** of your entry file, so it runs before anything that
uses `fetch` or timers:

```js
// index.js
import { initAgent } from '@rnpa/agent';
initAgent({ channel: 'my-app' });

import { AppRegistry } from 'react-native';
import App from './App';
AppRegistry.registerComponent('MyApp', () => App);
```

Optional APIs:

```js
import {
  markAppReady, markScreenReady, instrumentNavigation, instrumentAxios,
  measure, startSpan, mark, setScreen,
} from '@rnpa/agent';

// Exact navigation timing (otherwise React Navigation is detected automatically)
<NavigationContainer ref={navigationRef} onReady={() => instrumentNavigation(navigationRef)}>

// Exact readiness (otherwise TTI is derived from network/render quiet time)
useEffect(() => { if (data) markScreenReady(); }, [data]);
markAppReady();                      // once, when the first screen is usable

// Attribution for expensive code
const result = measure('parseFeed', () => parse(json));
const end = startSpan('hydrateStore'); /* … */ end();

instrumentAxios(apiClient);          // labels axios traffic (captured either way)
setScreen('Checkout');               // apps without React Navigation
```

All functions are no-ops when the agent is not initialized. When an
instrumented APK already contains the prelude, they use that instance.

## Transports

- **logcat** (default): batches go through React Native's native logger to logcat, tag `ReactNativeJS`. Works in release builds and needs no network access.
- **http**: `initAgent({ transport: 'http', httpUrl, httpToken })`. Start the server with `--ingest-port`; the dashboard's environment info shows the URL and token. Requires a build that allows cleartext to localhost (debug builds do).

## What is captured

`fetch`, `XMLHttpRequest`, axios (method, redacted URL, status, timings, sizes;
never bodies or headers), timer and rAF outliers, event-loop long tasks,
JS-thread FPS and dropped frames, React commits with per-component render
counts, React Navigation routes, the Hermes heap, uncaught errors, and startup
milestones.

## Compatibility

ES2017 output with no classes or async functions, so it runs on old Hermes and
JSC builds. Works with the old architecture and the new one (bridgeless/Fabric).
React DevTools keeps working in debug builds.
