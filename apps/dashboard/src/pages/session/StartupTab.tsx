import type { ReactElement } from 'react';
import type { AnalysisReport, Stat, StartupPhaseStats, StartupRun } from '@rnpa/shared';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatGrid, StatTile } from '../../components/StatTile';
import { DataTable, type Column } from '../../components/Table';
import { StackedBar, StackLegend, type StackSegment } from '../../charts/StackedBar';
import { fmtMs, fmtTime } from '../../lib/format';
import { paths } from '../../router';

const PHASES: { key: keyof StartupPhaseStats; label: string; hint: string }[] = [
  { key: 'ttid', label: 'TTID', hint: 'Launch → first frame (am start -W TotalTime)' },
  { key: 'jsInit', label: 'JS init', hint: 'Launch → JS bundle starts evaluating' },
  { key: 'firstRender', label: 'First render', hint: 'Launch → first React commit' },
  { key: 'tti', label: 'TTI', hint: 'Launch → first screen interactive' },
];

const SEG = {
  js: { label: 'Launch → JS init', color: 'var(--series-1)' },
  render: { label: 'JS init → first render', color: 'var(--series-3)' },
  tti: { label: 'First render → TTI', color: 'var(--series-7)' },
  ttid: { label: 'Launch → first frame (TTID, native only)', color: 'var(--series-other)' },
};

export function runSegments(r: StartupRun): StackSegment[] {
  const out: StackSegment[] = [];
  if (r.jsInit !== null || r.firstRender !== null || r.tti !== null) {
    const js = r.jsInit ?? 0;
    const fr = r.firstRender ?? js;
    const tti = r.tti ?? fr;
    if (r.jsInit !== null) out.push({ key: 'js', label: SEG.js.label, value: js, color: SEG.js.color });
    if (r.firstRender !== null) out.push({ key: 'render', label: SEG.render.label, value: Math.max(0, fr - js), color: SEG.render.color });
    if (r.tti !== null) out.push({ key: 'tti', label: SEG.tti.label, value: Math.max(0, tti - fr), color: SEG.tti.color });
  } else if (r.ttid !== null) {
    out.push({ key: 'ttid', label: SEG.ttid.label, value: r.ttid, color: SEG.ttid.color });
  }
  return out;
}

function runTotal(r: StartupRun): number {
  return Math.max(r.tti ?? 0, r.firstRender ?? 0, r.jsInit ?? 0, r.ttid ?? 0);
}

function statCell(s: Stat | null | undefined, k: 'p50' | 'p90'): string {
  return s ? fmtMs(s[k]) : '—';
}

export function StartupTab({ report, sessionId }: { report: AnalysisReport; sessionId: string }): ReactElement {
  const st = report.startup;
  const runs = st?.runs ?? [];
  if (runs.length === 0) {
    return (
      <EmptyState
        icon="gauge"
        title="No startup runs recorded"
        action={
          <a className="btn btn-primary btn-md" href={paths.session(sessionId, 'control')}>
            Open Control
          </a>
        }
      >
        Use <strong>Cold launch</strong>, <strong>Hot start</strong> or <strong>Startup benchmark</strong> on the Control tab. Native TTID is measured
        for every build; JS init, first render and TTI need the agent.
      </EmptyState>
    );
  }

  const maxTotal = Math.max(1, ...runs.map(runTotal));
  const kinds = (['cold', 'warm', 'hot'] as const).filter((k) => runs.some((r) => r.kind === k));
  const hasJsPhases = runs.some((r) => r.jsInit !== null || r.tti !== null);

  const columns: Column<StartupRun>[] = [
    { key: 'i', header: '#', sortValue: (r) => r.ts, render: (r) => <span className="num">{r.iteration ?? '—'}</span>, width: 48 },
    { key: 'kind', header: 'Kind', sortValue: (r) => r.kind, render: (r) => r.kind, width: 64 },
    { key: 'ts', header: 'Time', sortValue: (r) => r.ts, render: (r) => <span className="mono small">{fmtTime(r.ts)}</span> },
    { key: 'ttid', header: 'TTID', align: 'right', sortValue: (r) => r.ttid, render: (r) => <span className="num">{fmtMs(r.ttid)}</span> },
    { key: 'js', header: 'JS init', align: 'right', sortValue: (r) => r.jsInit, render: (r) => <span className="num">{fmtMs(r.jsInit)}</span> },
    { key: 'fr', header: 'First render', align: 'right', sortValue: (r) => r.firstRender, render: (r) => <span className="num">{fmtMs(r.firstRender)}</span> },
    {
      key: 'tti',
      header: 'TTI',
      align: 'right',
      sortValue: (r) => r.tti,
      render: (r) => (
        <span className="num" title={r.ttiReason ? `TTI ${r.ttiReason}` : undefined}>
          {fmtMs(r.tti)}
          {r.ttiReason === 'derived' ? <sup className="muted">*</sup> : null}
        </span>
      ),
    },
    {
      key: 'bar',
      header: 'Phases',
      width: '34%',
      render: (r) => <StackedBar segments={runSegments(r)} scaleMax={maxTotal} format={fmtMs} label={`${r.kind} run ${r.iteration ?? ''}`.trim()} />,
    },
  ];

  return (
    <div className="stack">
      <StatGrid>
        <StatTile label="Cold TTID (p50)" value={fmtMs(st.cold?.ttid?.p50)} sub={st.cold?.ttid ? `p90 ${fmtMs(st.cold.ttid.p90)}` : 'No cold runs'} />
        <StatTile label="Cold JS init (p50)" value={fmtMs(st.cold?.jsInit?.p50)} sub={st.cold?.jsInit ? `p90 ${fmtMs(st.cold.jsInit.p90)}` : 'Needs the agent'} />
        <StatTile label="Cold first render (p50)" value={fmtMs(st.cold?.firstRender?.p50)} sub={st.cold?.firstRender ? `p90 ${fmtMs(st.cold.firstRender.p90)}` : 'Needs the agent'} />
        <StatTile label="Cold TTI (p50)" value={fmtMs(st.cold?.tti?.p50)} sub={st.cold?.tti ? `p90 ${fmtMs(st.cold.tti.p90)}` : 'Needs the agent'} />
        <StatTile label="Warm TTID (p50)" value={fmtMs(st.warm?.ttid?.p50)} sub={st.warm?.ttid ? `${st.warm.ttid.count} runs` : 'No warm runs'} />
        <StatTile label="Hot TTID (p50)" value={fmtMs(st.hot?.ttid?.p50)} sub={st.hot?.ttid ? `${st.hot.ttid.count} runs` : 'No hot runs'} />
      </StatGrid>

      <Card title="Phase statistics" subtitle="Milliseconds from launch. p50 / p90 across runs of each kind." flush>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Phase</th>
                {kinds.map((k) => (
                  <th key={k} scope="col" className="align-right" colSpan={2}>
                    {k} (p50 / p90)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PHASES.map((p) => (
                <tr key={p.key}>
                  <th scope="row" title={p.hint} className="row-head">
                    {p.label}
                    <span className="muted small"> {p.hint}</span>
                  </th>
                  {kinds.map((k) => (
                    <td key={k} className="align-right num" colSpan={2}>
                      {statCell(st[k]?.[p.key], 'p50')} <span className="muted">/ {statCell(st[k]?.[p.key], 'p90')}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Runs"
        subtitle={hasJsPhases ? 'Each bar is one launch on a shared scale. * = TTI derived (no explicit markReady).' : 'Native TTID only — integrate the agent for JS phases.'}
        flush
      >
        <div className="card-pad">
          <StackLegend items={hasJsPhases ? [SEG.js, SEG.render, SEG.tti, ...(runs.some((r) => r.jsInit === null && r.tti === null) ? [SEG.ttid] : [])] : [SEG.ttid]} />
        </div>
        <DataTable columns={columns} rows={runs} rowKey={(r, i) => `${r.ts}-${i}`} initialSort={{ key: 'ts', dir: 'asc' }} caption="Startup runs" />
      </Card>
    </div>
  );
}
