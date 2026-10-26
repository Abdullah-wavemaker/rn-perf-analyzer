import { LOGCAT_CHUNK_SIZE, LOGCAT_PREFIX, type WireBatch } from '@rnpa/shared/events';
import type { AgentConfig } from './config.js';
import { g, originals } from './env.js';

export interface Transport {
  readonly kind: 'logcat' | 'http' | 'none';
  /** Returns false when the transport cannot accept data right now (batch is kept). */
  send(batch: WireBatch): boolean;
}

/**
 * Writes batches through `nativeLoggingHook`, React Native's JS→logcat bridge
 * (tag `ReactNativeJS`). Works in release builds, needs no network permission
 * and no cleartext exception, and the host reads it with `adb logcat`.
 * Lines are chunked to stay under the kernel logger's ~4 KB payload limit:
 *   RNPA1|<instance>|<seq>|<index>|<count>|<payload-chunk>
 */
function createLogcatTransport(): Transport | null {
  if (typeof g.nativeLoggingHook !== 'function') return null;
  return {
    kind: 'logcat',
    send(batch) {
      const hook = g.nativeLoggingHook as (message: string, level: number) => void;
      const json = JSON.stringify(batch);
      const count = Math.ceil(json.length / LOGCAT_CHUNK_SIZE) || 1;
      for (let i = 0; i < count; i++) {
        const chunk = json.slice(i * LOGCAT_CHUNK_SIZE, (i + 1) * LOGCAT_CHUNK_SIZE);
        hook(LOGCAT_PREFIX + '|' + batch.i + '|' + batch.q + '|' + i + '|' + count + '|' + chunk, 1);
      }
      return true;
    },
  };
}

/**
 * POSTs batches to the collector. Uses the *uninstrumented* XMLHttpRequest so
 * the agent's own traffic never appears on the timeline. Requires
 * `adb reverse tcp:<port> tcp:<port>` and a build that permits cleartext to
 * localhost (debug builds do).
 */
function createHttpTransport(config: AgentConfig): Transport | null {
  if (!config.httpUrl || !config.httpToken) return null;
  const url = config.httpUrl;
  const token = config.httpToken;
  let inFlight = 0;
  return {
    kind: 'http',
    send(batch) {
      const Xhr = originals.XMLHttpRequest;
      if (!Xhr || inFlight >= 4) return false;
      const xhr = new Xhr();
      xhr.__rnpaInternal = true;
      inFlight++;
      const done = function done() {
        inFlight--;
      };
      const target = xhr as unknown as { onloadend: (() => void) | null };
      target.onloadend = done;
      try {
        xhr.open('POST', url);
        xhr.timeout = 10000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(JSON.stringify(batch));
      } catch {
        done();
        return false;
      }
      return true;
    },
  };
}

export function createTransport(config: AgentConfig): Transport {
  const preferHttp = config.transport === 'http';
  const http = preferHttp ? createHttpTransport(config) : null;
  if (http) return http;
  const logcat = createLogcatTransport();
  if (logcat) return logcat;
  return { kind: 'none', send: () => true };
}
