import { describe, expect, it } from 'vitest';
import type { EventType, PerfEvent } from '@rnpa/shared';
import { analyze, scoreValue } from '@rnpa/analyzer';

let seq = 0;
function ev(type: EventType, ts: number, extra: Partial<PerfEvent> = {}): PerfEvent {
  return { id: `e${++seq}`, ts, type, screen: null, duration: null, source: 'agent', metadata: {}, ...extra };
}
function api(requestId: string, start: number, duration: number, url: string, screen: string, status = 200): PerfEvent[] {
  const m = { requestId, method: 'GET', url, client: 'fetch' };
  return [
    ev('API_START', start, { screen, metadata: m }),
    ev('API_END', start + duration, { screen, duration, metadata: { ...m, status } }),
  ];
}

const T = 1_700_000_000_000;

function timeline(): PerfEvent[] {
  return [
    ev('APP_START', T, { source: 'host', metadata: { kind: 'cold' } }),
    ev('STARTUP', T, { source: 'host', duration: 900, metadata: { kind: 'cold', totalTime: 900 } }),
    ev('JS_INIT', T + 300),
    ev('FIRST_RENDER', T + 700),
    // Home: enter, render, sequential API chain, render after data.
    ev('SCREEN_ENTER', T + 700, { screen: 'Home', metadata: { key: 'home-1' } }),
    ev('SCREEN_RENDER', T + 700, { screen: 'Home' }),
    ...api('a', T + 720, 400, 'https://api.test/session', 'Home'),
    ...api('b', T + 1130, 600, 'https://api.test/feed', 'Home'),
    ...api('c', T + 1740, 300, 'https://api.test/feed/42/comments', 'Home'),
    ev('RENDER', T + 2060, { screen: 'Home', metadata: { commit: 1, components: [{ name: 'FeedItem', count: 30 }], totalComponents: 30 } }),
    // Tap → Details with a duplicated request and a long task overlapping a frame drop.
    ev('USER_ACTION', T + 5000, { source: 'device', metadata: { kind: 'tap', origin: 'device' } }),
    ev('SCREEN_ENTER', T + 5200, { screen: 'Details', metadata: { key: 'details-1', previous: 'Home' } }),
    ev('SCREEN_RENDER', T + 5250, { screen: 'Details' }),
    ...api('d', T + 5260, 200, 'https://api.test/item/7', 'Details'),
    ...api('e', T + 5270, 210, 'https://api.test/item/7', 'Details'),
    ev('FUNCTION', T + 5500, { screen: 'Details', duration: 180, metadata: { name: 'parseHugeJson', origin: 'callback', timer: 'timeout' } }),
    ev('LONG_TASK', T + 5500, { screen: 'Details', duration: 190, metadata: { suspects: [{ name: 'parseHugeJson', duration: 180 }] } }),
    ev('FRAME_DROP', T + 5520, { screen: 'Details', duration: 150, source: 'device', metadata: { thread: 'ui', droppedFrames: 8 } }),
    ev('RENDER', T + 5700, { screen: 'Details', metadata: { commit: 1, components: [{ name: 'Gallery', count: 5 }], totalComponents: 5 } }),
    ev('MEMORY', T + 1000, { source: 'device', metadata: { origin: 'device', totalPssKb: 100_000 } }),
    ev('MEMORY', T + 5100, { source: 'device', metadata: { origin: 'device', totalPssKb: 104_000 } }),
    ev('MEMORY', T + 9000, { source: 'device', metadata: { origin: 'device', totalPssKb: 150_000 } }),
    ev('CPU', T + 5600, { source: 'device', metadata: { total: 80, ui: 30, js: 45 } }),
  ];
}

describe('analyze', () => {
  const report = analyze(timeline());

  it('builds startup runs with phase breakdown and derived TTI', () => {
    const run = report.startup.runs[0];
    expect(run?.kind).toBe('cold');
    expect(run?.ttid).toBe(900);
    expect(run?.jsInit).toBe(300);
    expect(run?.firstRender).toBe(700);
    // Home becomes interactive after its last commit (T+2060).
    expect(run?.tti).toBe(2060);
    expect(run?.ttiReason).toBe('derived');
  });

  it('derives per-screen TTI from network and commits', () => {
    const home = report.navigation.visits.find((v) => v.screen === 'Home');
    expect(home?.tti).toBe(1360);
    expect(home?.apiCount).toBe(3);
    expect(home?.breakdown?.network).toBeGreaterThan(1000);
    const details = report.navigation.visits.find((v) => v.screen === 'Details');
    expect(details?.transition).toBe(250);
    expect(details?.firstRender).toBe(50);
    expect(details?.memoryDeltaKb).toBe(46_000);
  });

  it('detects sequential chains and duplicates', () => {
    const chain = report.network.sequentialChains.find((c) => c.screen === 'Home');
    expect(chain?.requestIds).toHaveLength(3);
    expect(chain?.totalMs).toBe(1320);
    expect(chain?.parallelMs).toBe(600);
    expect(report.network.duplicates[0]?.count).toBe(2);
    expect(report.network.endpoints.map((e) => e.endpoint)).toContain('GET https://api.test/feed/:id/comments');
  });

  it('correlates frame drops with the work that overlapped them', () => {
    const drop = report.rendering.frameDrops[0];
    expect(drop?.culprits).toContain('parseHugeJson');
    expect(report.js.functions.find((f) => f.name === 'parseHugeJson')?.blockingHits).toBe(1);
    expect(report.correlations.map((c) => c.kind)).toEqual(
      expect.arrayContaining(['api-render-tti', 'function-frame-drop', 'timer-js-block', 'memory-navigation']),
    );
  });

  it('ranks bottlenecks and scores categories', () => {
    expect(report.bottlenecks.length).toBeGreaterThan(0);
    const titles = report.bottlenecks.map((b) => b.title);
    expect(titles.some((t) => t.startsWith('Sequential request waterfall'))).toBe(true);
    expect(titles.some((t) => t.startsWith('Slow screen: Home'))).toBe(true);
    expect(report.score.overall).not.toBeNull();
    expect(report.score.categories.network.score).not.toBeNull();
    expect(report.derivedEvents.some((e) => e.type === 'SCREEN_READY')).toBe(true);
  });

  it('honours explicit readiness from the app', () => {
    const events = timeline();
    events.push(ev('SCREEN_READY', T + 900, { screen: 'Home', metadata: { reason: 'explicit', screen: 'Home' } }));
    const r = analyze(events);
    const home = r.navigation.visits.find((v) => v.screen === 'Home');
    expect(home?.tti).toBe(200);
    expect(home?.ttiReason).toBe('explicit');
  });

  it('derives cold-start TTI from the first render when there is no navigation data', () => {
    const r = analyze([
      ev('STARTUP', T, { source: 'host', duration: 800, metadata: { kind: 'cold', totalTime: 800 } }),
      ev('JS_INIT', T + 200),
      ev('FIRST_RENDER', T + 600),
      ev('RENDER', T + 600, { metadata: { commit: 1, components: [], totalComponents: 3 } }),
      ...api('x', T + 650, 300, 'https://api.test/config', ''),
      ev('RENDER', T + 1000, { metadata: { commit: 1, components: [], totalComponents: 9 } }),
      ev('RENDER', T + 9000, { metadata: { commit: 1, components: [], totalComponents: 1 } }),
    ]);
    expect(r.startup.runs[0]?.tti).toBe(1000);
    expect(r.startup.runs[0]?.ttiReason).toBe('derived');
  });

  it('handles an empty timeline', () => {
    const r = analyze([]);
    expect(r.window).toBeNull();
    expect(r.score.overall).toBeNull();
    expect(r.bottlenecks).toEqual([]);
  });
});

describe('scoreValue', () => {
  it('maps budgets onto 0–100', () => {
    expect(scoreValue(0, { good: 100, poor: 200 })).toBe(100);
    expect(scoreValue(100, { good: 100, poor: 200 })).toBe(90);
    expect(scoreValue(200, { good: 100, poor: 200 })).toBe(50);
    expect(scoreValue(1000, { good: 100, poor: 200 })).toBe(0);
  });
});
