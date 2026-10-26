import { useMemo, useState, type ReactElement } from 'react';
import type { AnalysisReport, ScreenSummary, ScreenVisit } from '@rnpa/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { DataTable, type Column } from '../../components/Table';
import { StackedBar, StackLegend, type StackSegment } from '../../charts/StackedBar';
import { scoreTone } from '../../lib/colors';
import { fmtMs, fmtNum, fmtOffset, fmtSignedKb } from '../../lib/format';

const BREAKDOWN = [
  { key: 'network', label: 'Network', color: 'var(--series-3)' },
  { key: 'js', label: 'JS', color: 'var(--series-4)' },
  { key: 'render', label: 'Render', color: 'var(--series-5)' },
  { key: 'other', label: 'Other', color: 'var(--series-other)' },
] as const;

function breakdownSegments(v: ScreenVisit): StackSegment[] {
  const b = v.breakdown;
  if (!b) return [];
  return BREAKDOWN.map((d) => ({ key: d.key, label: d.label, value: b[d.key] ?? 0, color: d.color }));
}

export function ScreensTab({ report }: { report: AnalysisReport }): ReactElement {
  const nav = report.navigation;
  const visits = nav?.visits ?? [];
  const screens = nav?.screens ?? [];
  const [focus, setFocus] = useState<string | null>(null);
  const origin = report.window?.start ?? 0;

  const shownVisits = useMemo(() => (focus ? visits.filter((v) => v.screen === focus) : visits), [visits, focus]);
  const maxTti = useMemo(() => Math.max(1, ...visits.map((v) => v.tti ?? 0)), [visits]);

  if (visits.length === 0 && screens.length === 0) {
    return (
      <EmptyState icon="compass" title="No screen data">
        Screen metrics need the in-app agent: build an instrumented APK or integrate <span className="mono">@rnpa/agent</span> (React Navigation
        is detected automatically). Then record while navigating, or use journey replay / auto-explore.
      </EmptyState>
    );
  }

  const summaryCols: Column<ScreenSummary>[] = [
    { key: 'screen', header: 'Screen', sortValue: (s) => s.screen, render: (s) => <span className="strong">{s.screen}</span> },
    { key: 'visits', header: 'Visits', align: 'right', sortValue: (s) => s.visits, render: (s) => <span className="num">{s.visits}</span> },
    { key: 'tti50', header: 'TTI p50', align: 'right', sortValue: (s) => s.tti?.p50, render: (s) => <span className="num">{fmtMs(s.tti?.p50)}</span> },
    { key: 'tti90', header: 'TTI p90', align: 'right', sortValue: (s) => s.tti?.p90, render: (s) => <span className="num">{fmtMs(s.tti?.p90)}</span> },
    { key: 'fr', header: 'First render', align: 'right', sortValue: (s) => s.firstRender?.p50, render: (s) => <span className="num">{fmtMs(s.firstRender?.p50)}</span> },
    { key: 'tr', header: 'Transition', align: 'right', sortValue: (s) => s.transition?.p50, render: (s) => <span className="num">{fmtMs(s.transition?.p50)}</span> },
    { key: 'api', header: 'API calls', align: 'right', sortValue: (s) => s.apiCalls, render: (s) => <span className="num">{fmtNum(s.apiCalls)}</span> },
    { key: 'df', header: 'Dropped frames', align: 'right', sortValue: (s) => s.droppedFrames, render: (s) => <span className="num">{fmtNum(s.droppedFrames)}</span> },
    { key: 'lt', header: 'Long-task time', align: 'right', sortValue: (s) => s.longTaskTime, render: (s) => <span className="num">{fmtMs(s.longTaskTime)}</span> },
    { key: 'mem', header: 'Memory Δ', align: 'right', sortValue: (s) => s.memoryDeltaKb?.mean, title: 'Mean memory change per visit', render: (s) => <span className="num">{fmtSignedKb(s.memoryDeltaKb?.mean)}</span> },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      sortValue: (s) => s.score,
      render: (s) => (s.score === null ? <span className="muted">—</span> : <Badge tone={scoreTone(s.score)}>{Math.round(s.score)}</Badge>),
    },
  ];

  const visitCols: Column<ScreenVisit>[] = [
    { key: 'i', header: '#', sortValue: (v) => v.index, render: (v) => <span className="num">{v.index + 1}</span>, width: 44 },
    { key: 'screen', header: 'Screen', sortValue: (v) => v.screen, render: (v) => v.screen },
    { key: 'at', header: 'Entered', sortValue: (v) => v.enterTs, render: (v) => <span className="mono small">{fmtOffset(v.enterTs - origin)}</span> },
    { key: 'tti', header: 'TTI', align: 'right', sortValue: (v) => v.tti, render: (v) => <span className="num">{fmtMs(v.tti)}{v.ttiReason === 'derived' ? <sup className="muted">*</sup> : null}</span> },
    { key: 'fr', header: 'First render', align: 'right', sortValue: (v) => v.firstRender, render: (v) => <span className="num">{fmtMs(v.firstRender)}</span> },
    { key: 'tr', header: 'Transition', align: 'right', sortValue: (v) => v.transition, render: (v) => <span className="num">{fmtMs(v.transition)}</span> },
    { key: 'api', header: 'APIs', align: 'right', sortValue: (v) => v.apiCount, render: (v) => <span className="num">{v.apiCount}</span> },
    { key: 'lt', header: 'Long tasks', align: 'right', sortValue: (v) => v.longTaskTime, render: (v) => <span className="num">{v.longTasks ? `${v.longTasks} · ${fmtMs(v.longTaskTime)}` : '0'}</span> },
    { key: 'df', header: 'Dropped', align: 'right', sortValue: (v) => v.droppedFrames, render: (v) => <span className="num">{v.droppedFrames}</span> },
    { key: 'mem', header: 'Memory Δ', align: 'right', sortValue: (v) => v.memoryDeltaKb, render: (v) => <span className="num">{fmtSignedKb(v.memoryDeltaKb)}</span> },
    {
      key: 'bd',
      header: 'TTI breakdown',
      width: '22%',
      render: (v) => (v.breakdown ? <StackedBar segments={breakdownSegments(v)} scaleMax={maxTti} format={fmtMs} label={`${v.screen} visit ${v.index + 1}`} /> : <span className="muted small">—</span>),
    },
  ];

  return (
    <div className="stack">
      <Card title="Navigation flow" subtitle={`${visits.length} visits in order`}>
        <NavFlow visits={visits} focus={focus} onFocus={setFocus} />
      </Card>

      <Card title="Screens" subtitle="Select a screen to filter the visit list" flush>
        <DataTable
          columns={summaryCols}
          rows={screens}
          rowKey={(s) => s.screen}
          initialSort={{ key: 'tti50', dir: 'desc' }}
          onRowClick={(s) => setFocus((f) => (f === s.screen ? null : s.screen))}
          selectedKey={focus}
          caption="Per-screen summary"
        />
      </Card>

      <Card
        title={focus ? `Visits · ${focus}` : 'Visits'}
        subtitle="Where each screen's time-to-interactive went. * = TTI derived."
        actions={focus ? <Button size="sm" variant="ghost" icon="close" onClick={() => setFocus(null)}>Clear filter</Button> : undefined}
        flush
      >
        <div className="card-pad">
          <StackLegend items={BREAKDOWN.map((b) => ({ label: b.label, color: b.color }))} />
        </div>
        <DataTable columns={visitCols} rows={shownVisits} rowKey={(v) => `${v.index}`} initialSort={{ key: 'i', dir: 'asc' }} maxRows={500} caption="Screen visits" />
      </Card>
    </div>
  );
}

function NavFlow({ visits, focus, onFocus }: { visits: ScreenVisit[]; focus: string | null; onFocus: (s: string | null) => void }): ReactElement {
  const LIMIT = 80;
  const shown = visits.slice(0, LIMIT);
  return (
    <ol className="nav-flow" aria-label="Screen sequence">
      {shown.map((v, i) => (
        <li key={v.index} className="nav-flow-item">
          {i > 0 ? (
            <span className="nav-arrow" aria-hidden="true">
              →
            </span>
          ) : null}
          <button
            type="button"
            className={`nav-chip${focus === v.screen ? ' active' : ''}`}
            onClick={() => onFocus(focus === v.screen ? null : v.screen)}
            title={`Visit ${v.index + 1}: TTI ${fmtMs(v.tti)}`}
          >
            {v.screen}
            {v.tti !== null ? <span className="nav-chip-meta">{fmtMs(v.tti)}</span> : null}
          </button>
        </li>
      ))}
      {visits.length > LIMIT ? <li className="muted small">+{visits.length - LIMIT} more</li> : null}
    </ol>
  );
}
