import { createHash } from 'node:crypto';
import type { Adb } from '../android/adb.js';
import { errorMessage } from '../errors.js';
import { area, center, label, parseUiDump, type UiNode, type UiSnapshot } from './ui.js';

/**
 * Automated exploration: a bounded depth-first walk of the app's UI.
 *
 * Each distinct screen state (signature of its interactive elements) keeps a
 * list of untried actions. The explorer taps unexplored elements, scrolls
 * scrollables once, presses Back when a state is exhausted, and relaunches
 * the app if it leaves it. It never types text and skips elements whose
 * label suggests a destructive or external action.
 */

export interface ExploreOptions {
  maxSteps: number;
  maxDurationMs: number;
  settleMs: number;
  signal: AbortSignal;
}

export interface ExploreHooks {
  packageName: string;
  launch: () => Promise<void>;
  /** Records the action on the timeline before it is performed. */
  onAction: (action: { kind: 'tap' | 'swipe' | 'back'; x?: number; y?: number; x2?: number; y2?: number; label: string }) => void;
  log: (message: string) => void;
}

const DESTRUCTIVE =
  /\b(log ?out|sign ?out|delete|remove|uninstall|deactivate|close account|pay|payment|purchase|buy|checkout|place order|subscribe|transfer|send money|call|dial|reset|erase|wipe|unsubscribe|report|block|logout|signout|cancel order|confirm)\b/i;

interface StateInfo {
  actions: Action[];
  tried: number;
}

type Action = { kind: 'tap'; node: UiNode } | { kind: 'scroll'; node: UiNode };

function signature(snapshot: UiSnapshot): string {
  const parts = snapshot.nodes
    .filter((n) => n.clickable || n.scrollable)
    .map((n) => `${n.className}|${n.resourceId}|${n.text.slice(0, 40)}|${n.contentDesc.slice(0, 40)}`)
    .sort();
  return createHash('sha1').update(`${snapshot.foregroundPackage}\n${parts.join('\n')}`).digest('hex');
}

function candidateActions(snapshot: UiSnapshot, packageName: string): Action[] {
  const minArea = snapshot.width * snapshot.height * 0.0004;
  const actions: Action[] = [];
  for (const n of snapshot.nodes) {
    if (n.packageName !== packageName || !n.enabled || area(n) < minArea) continue;
    if (n.className.endsWith('EditText')) continue;
    const text = `${n.text} ${n.contentDesc} ${n.resourceId}`;
    if (DESTRUCTIVE.test(text)) continue;
    const [x1, y1, x2, y2] = n.bounds;
    if (x2 <= 0 || y2 <= 0 || x1 >= snapshot.width || y1 >= snapshot.height) continue;
    if (n.clickable) actions.push({ kind: 'tap', node: n });
    if (n.scrollable) actions.push({ kind: 'scroll', node: n });
  }
  // Prefer elements with a label (likely meaningful navigation), top-to-bottom.
  const labelled = (n: UiNode) => Number(!!(n.text || n.contentDesc));
  return actions.sort((a, b) => labelled(b.node) - labelled(a.node) || a.node.bounds[1] - b.node.bounds[1]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export async function explore(adb: Adb, options: ExploreOptions, hooks: ExploreHooks): Promise<{ steps: number; states: number }> {
  const deadline = Date.now() + options.maxDurationMs;
  const states = new Map<string, StateInfo>();
  const screen = await adb.screenSize();
  let steps = 0;
  let consecutiveOutside = 0;

  while (steps < options.maxSteps && Date.now() < deadline && !options.signal.aborted) {
    let snapshot: UiSnapshot;
    try {
      snapshot = parseUiDump(await adb.uiDump(), screen);
    } catch (error) {
      hooks.log(`UI dump failed (${errorMessage(error)}); retrying`);
      await sleep(options.settleMs, options.signal);
      continue;
    }

    if (snapshot.foregroundPackage !== hooks.packageName) {
      consecutiveOutside++;
      if (consecutiveOutside >= 2) {
        hooks.log('Left the app — relaunching');
        await hooks.launch();
        consecutiveOutside = 0;
      } else {
        hooks.onAction({ kind: 'back', label: 'Back (outside app)' });
        await adb.keyevent('KEYCODE_BACK');
      }
      steps++;
      await sleep(options.settleMs, options.signal);
      continue;
    }
    consecutiveOutside = 0;

    const sig = signature(snapshot);
    let state = states.get(sig);
    if (!state) {
      state = { actions: candidateActions(snapshot, hooks.packageName), tried: 0 };
      states.set(sig, state);
    }

    const action = state.actions[state.tried];
    if (!action) {
      hooks.onAction({ kind: 'back', label: 'Back (state exhausted)' });
      await adb.keyevent('KEYCODE_BACK');
    } else {
      state.tried++;
      const name = label(action.node);
      if (action.kind === 'tap') {
        const { x, y } = center(action.node);
        hooks.onAction({ kind: 'tap', x, y, label: name });
        await adb.tap(x, y);
      } else {
        const [x1, y1, x2, y2] = action.node.bounds;
        const x = Math.round((x1 + x2) / 2);
        const from = Math.round(y1 + (y2 - y1) * 0.75);
        const to = Math.round(y1 + (y2 - y1) * 0.25);
        hooks.onAction({ kind: 'swipe', x, y: from, x2: x, y2: to, label: `Scroll ${name}` });
        await adb.swipe(x, from, x, to, 300);
      }
    }
    steps++;
    await sleep(options.settleMs, options.signal);
  }
  return { steps, states: states.size };
}
