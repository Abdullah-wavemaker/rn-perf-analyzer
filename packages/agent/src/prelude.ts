/**
 * Prelude entry: bundled to a self-contained IIFE (dist/prelude.js) that the
 * analyzer injects ahead of the app's JS bundle. The server prepends
 * `var __RNPA_CONFIG__ = {...};` with build-specific settings.
 */
import { createAgent } from './agent.js';
import type { AgentOptions } from './config.js';
import { g } from './env.js';

const config = g.__RNPA_CONFIG__ as AgentOptions | undefined;
try {
  delete g.__RNPA_CONFIG__;
} catch {
  g.__RNPA_CONFIG__ = undefined;
}

try {
  createAgent(config, 'prelude');
} catch (error) {
  // Instrumentation must never prevent the app from starting.
  if (typeof g.nativeLoggingHook === 'function') {
    g.nativeLoggingHook('RNPA1|init-failed|' + String(error && (error as Error).message), 2);
  }
}
