import type { ComponentRenderSummary, FrameDrop, RenderingReport, SeriesPoint } from '@rnpa/shared';
import { type Ctx, visitAt } from './context.js';
import { mean, num, round, str } from './util.js';

export function analyzeRendering(ctx: Ctx): RenderingReport {
  const { by, options } = ctx;

  const uiFps: SeriesPoint[] = [];
  const jsFps: SeriesPoint[] = [];
  let uiFrames = 0;
  let uiJanky = 0;
  for (const e of by.FPS) {
    const fps = num(e.metadata.fps);
    if (fps === null) continue;
    if (e.metadata.thread === 'ui') {
      uiFps.push({ ts: e.ts, value: fps });
      uiFrames += num(e.metadata.frames) ?? 0;
      uiJanky += num(e.metadata.janky) ?? 0;
    } else {
      jsFps.push({ ts: e.ts, value: fps });
    }
  }

  const frameDrops: FrameDrop[] = by.FRAME_DROP.map((e) => ({
    id: e.id,
    ts: e.ts,
    thread: e.metadata.thread === 'ui' ? 'ui' : 'js',
    droppedFrames: num(e.metadata.droppedFrames) ?? 0,
    screen: e.screen ?? (() => {
      const i = visitAt(ctx.visits, e.ts);
      return i !== null ? (ctx.visits[i]?.screen ?? null) : null;
    })(),
    culprits: [],
  }));

  const droppedFramesByScreen: Record<string, number> = {};
  const hasUiDrops = frameDrops.some((f) => f.thread === 'ui');
  for (const f of frameDrops) {
    if (hasUiDrops && f.thread !== 'ui') continue;
    const key = f.screen ?? '(no screen)';
    droppedFramesByScreen[key] = (droppedFramesByScreen[key] ?? 0) + f.droppedFrames;
  }

  // Component re-render aggregation.
  interface Acc {
    renders: number;
    screens: Set<string>;
    perSecond: Map<number, number>;
    perVisit: Map<number, number>;
  }
  const components = new Map<string, Acc>();
  let commits = 0;
  for (const e of by.RENDER) {
    commits += num(e.metadata.commit) ?? 1;
    const list = Array.isArray(e.metadata.components) ? (e.metadata.components as unknown[]) : [];
    const second = Math.floor(e.ts / 1000);
    const visit = visitAt(ctx.visits, e.ts);
    for (const item of list) {
      const name = str((item as { name?: unknown })?.name);
      const count = num((item as { count?: unknown })?.count) ?? 1;
      if (!name) continue;
      const acc = components.get(name) ?? { renders: 0, screens: new Set(), perSecond: new Map(), perVisit: new Map() };
      acc.renders += count;
      if (e.screen) acc.screens.add(e.screen);
      acc.perSecond.set(second, (acc.perSecond.get(second) ?? 0) + count);
      if (visit !== null) acc.perVisit.set(visit, (acc.perVisit.get(visit) ?? 0) + count);
      components.set(name, acc);
    }
  }
  const componentSummaries: ComponentRenderSummary[] = [...components.entries()]
    .map(([name, acc]) => {
      const peakPerSecond = Math.max(0, ...acc.perSecond.values());
      const peakPerVisit = Math.max(0, ...acc.perVisit.values());
      return {
        name,
        renders: acc.renders,
        screens: [...acc.screens].slice(0, 20),
        peakPerSecond,
        excessive: peakPerSecond >= options.excessiveRendersPerSecond || peakPerVisit >= options.excessiveRendersPerVisit,
      };
    })
    .sort((a, b) => b.renders - a.renders)
    .slice(0, 200);

  return {
    uiFps,
    jsFps,
    uiFpsAvg: mean(uiFps.map((p) => p.value)),
    jsFpsAvg: mean(jsFps.map((p) => p.value)),
    uiJankPct: uiFrames > 0 ? round((uiJanky / uiFrames) * 100) : null,
    frameDrops,
    droppedFramesByScreen,
    commits,
    components: componentSummaries,
  };
}
