import type { ReactElement } from 'react';
import type { AnalysisReport } from '@rnpa/shared';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatGrid, StatTile } from '../../components/StatTile';
import { DataTable, type Column } from '../../components/Table';
import { BarChart } from '../../charts/BarChart';
import { LineChart } from '../../charts/LineChart';
import { fmtKb, fmtNum, fmtOffset, fmtPct, fmtSignedKb } from '../../lib/format';

type LeakSuspect = AnalysisReport['memory']['leakSuspects'][number];

export function MemoryTab({ report }: { report: AnalysisReport }): ReactElement {
  const mem = report.memory;
  const cpu = report.cpu;
  const origin = report.window?.start ?? 0;
  const series = mem?.series ?? [];
  const cpuSeries = cpu?.series ?? [];

  if (series.length === 0 && cpuSeries.length === 0) {
    return (
      <EmptyState icon="cpu" title="No memory or CPU samples">
        Memory (dumpsys meminfo) and CPU are sampled from the device while a session is recording. Start recording on the Control tab with the
        app in the foreground. JS heap size additionally needs the in-app agent.
      </EmptyState>
    );
  }

  const transitions = (mem?.byTransition ?? []).map((t, i) => ({
    key: `${t.ts}-${i}`,
    label: `${t.from ?? 'start'} → ${t.to}`,
    value: t.deltaKb,
    detail: `at ${fmtOffset(t.ts - origin)}`,
  }));

  const cpuByScreen = Object.entries(cpu?.byScreen ?? {})
    .map(([screen, v]) => ({ key: screen, label: screen, value: v }))
    .sort((a, b) => b.value - a.value);

  const leakCols: Column<LeakSuspect>[] = [
    { key: 'screen', header: 'Screen', sortValue: (l) => l.screen, render: (l) => <span className="strong">{l.screen}</span> },
    { key: 'visits', header: 'Visits', align: 'right', sortValue: (l) => l.visits, render: (l) => <span className="num">{l.visits}</span> },
    { key: 'growth', header: 'Growth per visit', align: 'right', sortValue: (l) => l.growthPerVisitKb, render: (l) => <span className="num strong">{fmtSignedKb(l.growthPerVisitKb)}</span> },
  ];

  return (
    <div className="stack">
      <StatGrid>
        <StatTile label="Peak PSS" value={fmtKb(mem?.peakKb)} sub={mem?.peakTs ? `at ${fmtOffset(mem.peakTs - origin)}` : undefined} />
        <StatTile label="End of session" value={fmtKb(mem?.endKb)} sub={`started at ${fmtKb(mem?.startKb)}`} />
        <StatTile label="Growth" value={fmtSignedKb(mem?.growthKb)} tone={(mem?.growthKb ?? 0) > 50 * 1024 ? 'warning' : undefined} />
        <StatTile label="Leak suspects" value={fmtNum(mem?.leakSuspects?.length ?? 0)} tone={mem?.leakSuspects?.length ? 'serious' : undefined} />
        <StatTile label="CPU avg / peak" value={`${fmtPct(cpu?.avg, 0)} / ${fmtPct(cpu?.peak, 0)}`} sub="100% = one core" />
        <StatTile label="UI / JS thread avg" value={`${fmtPct(cpu?.uiAvg, 0)} / ${fmtPct(cpu?.jsAvg, 0)}`} />
      </StatGrid>

      <LineChart
        title="Memory"
        subtitle="Process PSS, Java heap and native heap from dumpsys; JS heap from the agent"
        origin={origin}
        series={[
          { id: 'pss', label: 'PSS', color: 'var(--series-1)', points: series.map((p) => ({ x: p.ts, y: p.pssKb })) },
          { id: 'java', label: 'Java heap', color: 'var(--series-2)', points: series.map((p) => ({ x: p.ts, y: p.javaHeapKb })) },
          { id: 'native', label: 'Native heap', color: 'var(--series-3)', points: series.map((p) => ({ x: p.ts, y: p.nativeHeapKb })) },
          { id: 'js', label: 'JS heap', color: 'var(--series-4)', points: series.map((p) => ({ x: p.ts, y: p.jsHeapKb })) },
        ]}
        yFormat={fmtKb}
        yMin={0}
        height={240}
        emptyText="No memory samples"
      />

      <div className="grid-2">
        <BarChart
          title="Memory change per navigation"
          subtitle="Warm = grew, cool = released"
          data={transitions}
          format={fmtSignedKb}
          diverging
          valueHeader="Δ memory"
          labelWidth={220}
          emptyText="No navigation transitions with memory samples"
        />
        <Card title="Leak suspects" subtitle="Screens whose memory keeps growing across repeat visits" flush>
          {mem?.leakSuspects?.length ? (
            <DataTable columns={leakCols} rows={mem.leakSuspects} rowKey={(l) => l.screen} initialSort={{ key: 'growth', dir: 'desc' }} />
          ) : (
            <EmptyState icon="check" title="No leak suspects" compact>
              Revisit screens several times (e.g. journey replay with repeat) to detect growth.
            </EmptyState>
          )}
        </Card>
      </div>

      <LineChart
        title="CPU"
        subtitle="Process CPU % (100% = one core fully busy)"
        origin={origin}
        series={[
          { id: 'total', label: 'Total', color: 'var(--series-1)', points: cpuSeries.map((p) => ({ x: p.ts, y: p.total })) },
          { id: 'ui', label: 'UI thread', color: 'var(--series-2)', points: cpuSeries.map((p) => ({ x: p.ts, y: p.ui })) },
          { id: 'js', label: 'JS thread', color: 'var(--series-3)', points: cpuSeries.map((p) => ({ x: p.ts, y: p.js })) },
        ]}
        yFormat={(v) => fmtPct(v)}
        yTickFormat={(v) => `${Math.round(v)}%`}
        yMin={0}
        emptyText="No CPU samples"
      />

      <BarChart title="Average CPU by screen" data={cpuByScreen} format={(v) => fmtPct(v)} valueHeader="CPU %" emptyText="No CPU samples attributed to screens" />
    </div>
  );
}
