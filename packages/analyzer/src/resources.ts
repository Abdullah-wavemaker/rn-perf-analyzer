import type { CpuPoint, CpuReport, MemoryPoint, MemoryReport, Stability } from '@rnpa/shared';
import { type Ctx, visitAt } from './context.js';
import { mean, num, round, str } from './util.js';

export function analyzeMemory(ctx: Ctx): MemoryReport {
  const series: MemoryPoint[] = ctx.by.MEMORY.map((e) => ({
    ts: e.ts,
    pssKb: num(e.metadata.totalPssKb),
    javaHeapKb: num(e.metadata.javaHeapKb),
    nativeHeapKb: num(e.metadata.nativeHeapKb),
    jsHeapKb: num(e.metadata.jsHeapKb),
  }));

  // Prefer device PSS; fall back to the JS heap when only the agent reported memory.
  const primary = series.filter((p) => p.pssKb !== null);
  const values = primary.length > 0 ? primary.map((p) => ({ ts: p.ts, kb: p.pssKb as number })) : series.filter((p) => p.jsHeapKb !== null).map((p) => ({ ts: p.ts, kb: p.jsHeapKb as number }));

  let peak: { ts: number; kb: number } | null = null;
  for (const v of values) if (!peak || v.kb > peak.kb) peak = v;
  const startKb = values[0]?.kb ?? null;
  const endKb = values[values.length - 1]?.kb ?? null;

  const byTransition: MemoryReport['byTransition'] = [];
  ctx.visits.forEach((v, i) => {
    if (v.memoryDeltaKb === null) return;
    byTransition.push({ ts: v.enterTs, from: i > 0 ? (ctx.visits[i - 1]?.screen ?? null) : null, to: v.screen, deltaKb: v.memoryDeltaKb });
  });

  // Leak suspects: memory at entry keeps climbing across repeated visits of the same screen.
  const entryMemory = new Map<string, number[]>();
  for (const v of ctx.visits) {
    const sample = values.filter((p) => p.ts <= v.enterTs).pop();
    if (!sample) continue;
    const list = entryMemory.get(v.screen) ?? [];
    list.push(sample.kb);
    entryMemory.set(v.screen, list);
  }
  const leakSuspects: MemoryReport['leakSuspects'] = [];
  for (const [screen, list] of entryMemory) {
    if (list.length < 3) continue;
    let increasing = 0;
    for (let i = 1; i < list.length; i++) if ((list[i] as number) > (list[i - 1] as number)) increasing++;
    const growthPerVisit = ((list[list.length - 1] as number) - (list[0] as number)) / (list.length - 1);
    if (increasing >= list.length - 2 && growthPerVisit >= ctx.options.leakGrowthKbPerVisit) {
      leakSuspects.push({ screen, visits: list.length, growthPerVisitKb: Math.round(growthPerVisit) });
    }
  }
  leakSuspects.sort((a, b) => b.growthPerVisitKb - a.growthPerVisitKb);

  return {
    series,
    startKb,
    endKb,
    peakKb: peak?.kb ?? null,
    peakTs: peak?.ts ?? null,
    growthKb: startKb !== null && endKb !== null ? endKb - startKb : null,
    byTransition,
    leakSuspects,
  };
}

export function analyzeCpu(ctx: Ctx): CpuReport {
  const series: CpuPoint[] = [];
  const byScreenAcc = new Map<string, number[]>();
  for (const e of ctx.by.CPU) {
    const total = num(e.metadata.total);
    if (total === null) continue;
    series.push({ ts: e.ts, total, ui: num(e.metadata.ui), js: num(e.metadata.js) });
    const i = visitAt(ctx.visits, e.ts);
    const screen = i !== null ? ctx.visits[i]?.screen : e.screen;
    if (screen) {
      const list = byScreenAcc.get(screen) ?? [];
      list.push(total);
      byScreenAcc.set(screen, list);
    }
  }
  const byScreen: Record<string, number> = {};
  for (const [screen, list] of byScreenAcc) byScreen[screen] = mean(list) ?? 0;
  return {
    series,
    avg: mean(series.map((p) => p.total)),
    peak: series.length > 0 ? round(series.reduce((m, p) => Math.max(m, p.total), 0)) : null,
    uiAvg: mean(series.map((p) => p.ui).filter((v): v is number => v !== null)),
    jsAvg: mean(series.map((p) => p.js).filter((v): v is number => v !== null)),
    byScreen,
  };
}

export function analyzeStability(ctx: Ctx): Stability {
  return {
    crashes: ctx.by.CRASH.map((e) => ({
      ts: e.ts,
      id: e.id,
      kind: str(e.metadata.kind) ?? 'native',
      message: (str(e.metadata.message) ?? 'Crash').slice(0, 500),
    })),
    errors: ctx.by.ERROR.map((e) => ({
      ts: e.ts,
      id: e.id,
      screen: e.screen,
      message: (str(e.metadata.message) ?? 'Error').slice(0, 500),
    })),
  };
}
