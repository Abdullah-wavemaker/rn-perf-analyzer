/**
 * @rnpa/agent — SDK entry point.
 *
 * Import this as the FIRST line of your app entry (index.js) to capture JS,
 * network, render and navigation metrics in any build:
 *
 *   import { initAgent } from '@rnpa/agent';
 *   initAgent({ channel: 'my-app' });
 *
 * If the APK was instrumented by the analyzer, the prelude agent is already
 * running; these functions then delegate to it.
 */
import { AppState } from 'react-native';
import { type NavigationRefLike, type RnpaAgent, createAgent, getAgent } from './agent.js';
import type { AgentOptions } from './config.js';
import type { AxiosLike } from './network.js';

export type { AgentOptions, AgentConfig } from './config.js';
export type { NavigationRefLike, RnpaAgent } from './agent.js';
export type { AxiosLike } from './network.js';

let appStateSubscribed = false;

export function initAgent(options?: AgentOptions): RnpaAgent {
  const agent = getAgent() || createAgent(options, 'sdk');
  if (!appStateSubscribed && AppState && typeof AppState.addEventListener === 'function') {
    appStateSubscribed = true;
    AppState.addEventListener('change', function onAppStateChange(state: string) {
      agent.appState(state);
    });
  }
  return agent;
}

function agentOrNull(): RnpaAgent | null {
  return getAgent();
}

export function markAppReady(metadata?: Record<string, unknown>): void {
  agentOrNull()?.markAppReady(metadata);
}

export function markScreenReady(screen?: string): void {
  agentOrNull()?.markScreenReady(screen);
}

export function mark(name: string, metadata?: Record<string, unknown>): void {
  agentOrNull()?.mark(name, metadata);
}

export function measure<T>(name: string, fn: () => T): T {
  const agent = agentOrNull();
  return agent ? agent.measure(name, fn) : fn();
}

export function startSpan(name: string): () => void {
  const agent = agentOrNull();
  return agent ? agent.startSpan(name) : () => undefined;
}

export function setScreen(name: string): void {
  agentOrNull()?.setScreen(name);
}

export function instrumentNavigation(ref: NavigationRefLike): void {
  agentOrNull()?.instrumentNavigation(ref);
}

export function instrumentAxios(instance: AxiosLike): void {
  agentOrNull()?.instrumentAxios(instance);
}
