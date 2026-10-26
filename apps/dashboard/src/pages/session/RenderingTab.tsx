import type { ReactElement } from 'react';
import type { AnalysisReport, ComponentRenderSummary, FrameDrop } from '@rnpa/shared';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatGrid, StatTile } from '../../components/StatTile';
import { DataTable, type Column } from '../../components/Table';
import { BarChart } from '../../charts/BarChart';
import { LineChart } from '../../charts/LineChart';
import { fmtFps, fmtNum, fmtOffset, fmtPct } from '../../lib/format';

export function RenderingTab({ report }: { report: AnalysisReport }): ReactElement {
  const r = report.rendering;
  const origin = report.window?.start ?? 0;
  const uiFps = r?.uiFps ?? [];
  const jsFps = r?.jsFps ?? [];
  const drops = r?.frameDrops ?? [];
  const components = r?.components ?? [];
  const byScreen = Object.entries(r?.droppedFramesByScreen ?? {})
    .map(([screen, n]) => ({ key: screen, label: screen, value: n }))
    .sort((a, b) => b.value - a.value);
  const totalDropped = drops.reduce((a, d) => a + (d.droppedFrames ?? 0), 0);

  if (uiFps.length === 0 && jsFps.length === 0 && drops.length === 0 && components.length === 0 && !r?.commits) {
    return (
      <EmptyState icon="gauge" title="No rendering data">
        UI-thread FPS comes from device collectors while recording (keep the app in the foreground). JS FPS, commits and component re-renders need
        the in-app agent — build an instrumented APK or integrate <span className="mono">@rnpa/agent</span>.
      </EmptyState>
    );
  }

  const dropCols: Column<FrameDrop>[] = [
    { key: 'ts', header: 'At', sortValue: (d) => d.ts, render: (d) => <span className="mono small">{fmtOffset(d.ts - origin)}</span> },
    { key: 'thread', header: 'Thread', sortValue: (d) => d.thread, render: (d) => <Badge tone="neutral">{d.thread.toUpperCase()}</Badge> },
    { key: 'n', header: 'Dropped', align: 'right', sortValue: (d) => d.droppedFrames, render: (d) => <span className="num strong">{d.droppedFrames}</span> },
    { key: 'screen', header: 'Screen', sortValue: (d) => d.screen, render: (d) => d.screen ?? <span className="muted">—</span> },
    {
      key: 'culprits',
      header: 'Likely culprits',
      render: (d) =>
        d.culprits?.length ? (
          <span className="mono small">
            {d.culprits.slice(0, 4).join(', ')}
            {d.culprits.length > 4 ? ` +${d.culprits.length - 4}` : ''}
          </span>
        ) : (
          <span className="muted small">—</span>
        ),
    },
  ];

  const compCols: Column<ComponentRenderSummary>[] = [
    { key: 'name', header: 'Component', sortValue: (c) => c.name, render: (c) => <span className="mono small">{c.name}</span> },
    { key: 'renders', header: 'Renders', align: 'right', sortValue: (c) => c.renders, render: (c) => <span className="num">{fmtNum(c.renders)}</span> },
    { key: 'peak', header: 'Peak / s', align: 'right', sortValue: (c) => c.peakPerSecond, render: (c) => <span className="num">{fmtNum(c.peakPerSecond)}</span> },
    { key: 'screens', header: 'Screens', sortValue: (c) => c.screens?.length ?? 0, render: (c) => <span className="small">{(c.screens ?? []).slice(0, 3).join(', ')}{(c.screens?.length ?? 0) > 3 ? ` +${c.screens.length - 3}` : ''}</span> },
    {
      key: 'excessive',
      header: 'Flag',
      sortValue: (c) => (c.excessive ? 1 : 0),
      render: (c) => (c.excessive ? <Badge tone="serious" icon="alert">Excessive</Badge> : null),
    },
  ];

  return (
    <div className="stack">
      <StatGrid>
        <StatTile label="Avg UI FPS" value={fmtFps(r.uiFpsAvg)} />
        <StatTile label="Avg JS FPS" value={fmtFps(r.jsFpsAvg)} sub={jsFps.length ? undefined : 'Needs the agent'} />
        <StatTile label="UI jank" value={fmtPct(r.uiJankPct)} tone={(r.uiJankPct ?? 0) > 10 ? 'warning' : undefined} sub="of frames over budget" />
        <StatTile label="Dropped frames" value={fmtNum(totalDropped)} sub={`${drops.length} drop events`} />
        <StatTile label="React commits" value={fmtNum(r.commits)} />
        <StatTile label="Excessive re-renders" value={fmtNum(components.filter((c) => c.excessive).length)} sub={`${components.length} components tracked`} />
      </StatGrid>

      <LineChart
        title="Frame rate"
        subtitle="Frames per second over the recording; 60 fps reference"
        origin={origin}
        series={[
          { id: 'ui', label: 'UI thread', color: 'var(--series-1)', points: uiFps.map((p) => ({ x: p.ts, y: p.value })) },
          { id: 'js', label: 'JS thread', color: 'var(--series-2)', points: jsFps.map((p) => ({ x: p.ts, y: p.value })) },
        ]}
        yFormat={fmtFps}
        yTickFormat={(v) => String(Math.round(v))}
        yMin={0}
        refLines={[{ y: 60, label: '60 fps' }]}
        emptyText="No FPS samples recorded"
      />

      <div className="grid-2">
        <BarChart title="Dropped frames by screen" data={byScreen} format={(v) => fmtNum(v)} valueHeader="Dropped frames" emptyText="No dropped frames attributed to screens" />
        <BarChart
          title="Most re-rendered components"
          data={components
            .slice()
            .sort((a, b) => b.renders - a.renders)
            .slice(0, 15)
            .map((c) => ({ key: c.name, label: c.name, value: c.renders, detail: `peak ${c.peakPerSecond}/s${c.excessive ? ' · excessive' : ''}` }))}
          format={(v) => fmtNum(v)}
          valueHeader="Renders"
          color="var(--series-5)"
          emptyText="No component render data (needs the agent)"
        />
      </div>

      <Card title="Frame drops" flush>
        {drops.length ? (
          <DataTable columns={dropCols} rows={drops} rowKey={(d) => d.id} initialSort={{ key: 'n', dir: 'desc' }} maxRows={300} />
        ) : (
          <EmptyState icon="check" title="No frame drops" compact />
        )}
      </Card>

      <Card title="Component re-renders" subtitle="Excessive = many renders within one second" flush>
        {components.length ? (
          <DataTable columns={compCols} rows={components} rowKey={(c) => c.name} initialSort={{ key: 'renders', dir: 'desc' }} maxRows={300} />
        ) : (
          <EmptyState icon="info" title="No component data" compact>
            Requires the in-app agent's render tracking.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
