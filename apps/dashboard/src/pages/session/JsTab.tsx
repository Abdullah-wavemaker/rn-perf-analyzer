import type { ReactElement } from 'react';
import type { AnalysisReport, FunctionSummary, LongTask, TimerKind } from '@rnpa/shared';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatGrid, StatTile } from '../../components/StatTile';
import { DataTable, type Column } from '../../components/Table';
import { BarChart } from '../../charts/BarChart';
import { fmtMs, fmtNum, fmtOffset } from '../../lib/format';

const TIMER_KINDS: TimerKind[] = ['timeout', 'interval', 'raf', 'immediate'];

type HeavyCallback = AnalysisReport['js']['timers']['heavyCallbacks'][number];

export function JsTab({ report }: { report: AnalysisReport }): ReactElement {
  const js = report.js;
  const origin = report.window?.start ?? 0;
  const longTasks = js?.longTasks ?? [];
  const functions = js?.functions ?? [];
  const timers = js?.timers;
  const hasTimers = timers && (Object.keys(timers.created ?? {}).length > 0 || Object.keys(timers.fired ?? {}).length > 0);

  if (!report.coverage?.agent && !js?.profileImported && longTasks.length === 0 && functions.length === 0) {
    return (
      <EmptyState icon="cpu" title="No JS thread data">
        Long tasks, function timings and timers come from the in-app agent. Build an instrumented APK or integrate{' '}
        <span className="mono">@rnpa/agent</span>. For function-level CPU data you can also import a Hermes <span className="mono">.cpuprofile</span>{' '}
        on the Control tab.
      </EmptyState>
    );
  }

  const ltCols: Column<LongTask>[] = [
    { key: 'ts', header: 'At', sortValue: (t) => t.ts, render: (t) => <span className="mono small">{fmtOffset(t.ts - origin)}</span> },
    { key: 'dur', header: 'Duration', align: 'right', sortValue: (t) => t.duration, render: (t) => <span className="num strong">{fmtMs(t.duration)}</span> },
    { key: 'screen', header: 'Screen', sortValue: (t) => t.screen, render: (t) => t.screen ?? <span className="muted">—</span> },
    {
      key: 'sus',
      header: 'Suspects',
      sortValue: (t) => t.suspects?.length ?? 0,
      render: (t) =>
        t.suspects?.length ? (
          <ul className="suspects">
            {t.suspects
              .slice()
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 4)
              .map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  <span className="mono small">{s.name}</span> <span className="muted small">{fmtMs(s.duration)}</span>
                </li>
              ))}
            {t.suspects.length > 4 ? <li className="muted small">+{t.suspects.length - 4} more</li> : null}
          </ul>
        ) : (
          <span className="muted small">unknown — wrap callbacks with measure() or import a profile</span>
        ),
    },
  ];

  const fnCols: Column<FunctionSummary>[] = [
    { key: 'name', header: 'Function', sortValue: (f) => f.name, render: (f) => <span className="mono small break">{f.name}</span> },
    { key: 'origin', header: 'Origin', sortValue: (f) => f.origin, render: (f) => <Badge tone="neutral">{f.origin}</Badge> },
    { key: 'count', header: 'Calls', align: 'right', sortValue: (f) => f.count, render: (f) => <span className="num">{fmtNum(f.count)}</span> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (f) => f.total, render: (f) => <span className="num">{fmtMs(f.total)}</span> },
    { key: 'max', header: 'Max', align: 'right', sortValue: (f) => f.max, render: (f) => <span className="num">{fmtMs(f.max)}</span> },
    { key: 'mean', header: 'Mean', align: 'right', sortValue: (f) => f.mean, render: (f) => <span className="num">{fmtMs(f.mean)}</span> },
    {
      key: 'block',
      header: 'Blocking hits',
      align: 'right',
      title: 'Times this function overlapped a dropped frame or long task',
      sortValue: (f) => f.blockingHits,
      render: (f) => <span className={`num${f.blockingHits ? ' strong' : ''}`}>{fmtNum(f.blockingHits)}</span>,
    },
  ];

  const heavyCols: Column<HeavyCallback>[] = [
    { key: 'name', header: 'Callback', sortValue: (h) => h.name, render: (h) => <span className="mono small">{h.name}</span> },
    { key: 'kind', header: 'Kind', sortValue: (h) => h.kind, render: (h) => h.kind },
    { key: 'count', header: 'Runs', align: 'right', sortValue: (h) => h.count, render: (h) => <span className="num">{fmtNum(h.count)}</span> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (h) => h.total, render: (h) => <span className="num">{fmtMs(h.total)}</span> },
    { key: 'max', header: 'Max', align: 'right', sortValue: (h) => h.max, render: (h) => <span className="num">{fmtMs(h.max)}</span> },
  ];

  const topFns = functions
    .slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)
    .map((f) => ({ key: `${f.name}-${f.origin}`, label: f.name, value: f.total, detail: `${fmtNum(f.count)} calls · max ${fmtMs(f.max)}` }));

  return (
    <div className="stack">
      <StatGrid>
        <StatTile label="Long tasks" value={fmtNum(longTasks.length)} tone={longTasks.length ? 'warning' : undefined} sub={longTasks.length ? `longest ${fmtMs(Math.max(...longTasks.map((t) => t.duration)))}` : 'none over threshold'} />
        <StatTile label="JS thread blocked" value={fmtMs(js?.blockedMs ?? 0)} />
        <StatTile label="Functions measured" value={fmtNum(functions.length)} sub={js?.profileImported ? 'CPU profile imported' : 'No CPU profile'} />
        <StatTile label="Late timers" value={fmtNum(timers?.late ?? 0)} sub={timers ? `max lateness ${fmtMs(timers.maxLatenessMs)}` : undefined} />
        <StatTile label="Max active intervals" value={fmtNum(timers?.maxActiveIntervals ?? 0)} tone={(timers?.maxActiveIntervals ?? 0) > 5 ? 'warning' : undefined} />
      </StatGrid>

      <Card title="Long tasks" subtitle="JS thread blocked over the threshold, with callbacks known to have run inside" flush>
        {longTasks.length ? (
          <DataTable columns={ltCols} rows={longTasks} rowKey={(t) => t.id} initialSort={{ key: 'dur', dir: 'desc' }} maxRows={300} />
        ) : (
          <EmptyState icon="check" title="No long tasks" compact />
        )}
      </Card>

      {topFns.length ? <BarChart title="Hottest functions by total time" data={topFns} format={fmtMs} valueHeader="Total time" color="var(--series-4)" labelWidth={240} /> : null}

      <Card title="Function hot list" subtitle={js?.profileImported ? 'Includes samples from the imported CPU profile' : 'From wrapped callbacks and measure() calls'} flush>
        {functions.length ? (
          <DataTable columns={fnCols} rows={functions} rowKey={(f, i) => `${f.name}-${f.origin}-${i}`} initialSort={{ key: 'total', dir: 'desc' }} maxRows={500} dense />
        ) : (
          <EmptyState icon="cpu" title="No function timings" compact>
            Import a .cpuprofile or use CDP profiling on the Control tab for function-level data.
          </EmptyState>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Timers" subtitle={hasTimers ? undefined : 'No timer activity recorded'} flush>
          {hasTimers && timers ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col" className="align-right">
                      Created
                    </th>
                    <th scope="col" className="align-right">
                      Fired
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {TIMER_KINDS.map((k) => (
                    <tr key={k}>
                      <th scope="row" className="row-head">
                        {k}
                      </th>
                      <td className="align-right num">{fmtNum(timers.created?.[k] ?? 0)}</td>
                      <td className="align-right num">{fmtNum(timers.fired?.[k] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="kv-grid card-pad">
                <dt>Late callbacks</dt>
                <dd>{fmtNum(timers.late)}</dd>
                <dt>Max lateness</dt>
                <dd>{fmtMs(timers.maxLatenessMs)}</dd>
                <dt>Max concurrent intervals</dt>
                <dd>{fmtNum(timers.maxActiveIntervals)}</dd>
              </dl>
            </div>
          ) : (
            <EmptyState icon="info" title="No timer data" compact />
          )}
        </Card>
        <Card title="Heavy timer callbacks" flush>
          {timers?.heavyCallbacks?.length ? (
            <DataTable columns={heavyCols} rows={timers.heavyCallbacks} rowKey={(h, i) => `${h.name}-${i}`} initialSort={{ key: 'total', dir: 'desc' }} />
          ) : (
            <EmptyState icon="check" title="No heavy callbacks" compact />
          )}
        </Card>
      </div>
    </div>
  );
}
