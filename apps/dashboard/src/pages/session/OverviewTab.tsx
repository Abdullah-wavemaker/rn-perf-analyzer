import { useMemo, useState, type ReactElement } from 'react';
import type { AnalysisReport, Bottleneck, Coverage, ScoreCategory, Severity } from '@rnpa/shared';
import type { Session } from '../../api/types';
import { Badge, SeverityBadge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { StatGrid, StatTile } from '../../components/StatTile';
import { Segmented } from '../../components/Tabs';
import { Gauge, ScoreMeter } from '../../charts/Gauge';
import { scoreLabel, scoreTone } from '../../lib/colors';
import { fmtCompact, fmtFps, fmtKb, fmtMetric, fmtMs, fmtNum, plural } from '../../lib/format';
import { navigate, paths } from '../../router';

const CATEGORY_ORDER: ScoreCategory[] = ['startup', 'navigation', 'network', 'js', 'rendering', 'memory', 'stability'];
const CATEGORY_LABEL: Record<string, string> = {
  startup: 'Startup',
  navigation: 'Navigation',
  network: 'Network',
  js: 'JS thread',
  rendering: 'Rendering',
  memory: 'Memory',
  stability: 'Stability',
  cpu: 'CPU',
};

const COVERAGE: { key: keyof Coverage; label: string; missing: string }[] = [
  { key: 'agent', label: 'Agent', missing: 'No in-app agent events. Build an instrumented APK or integrate @rnpa/agent to capture JS metrics.' },
  { key: 'device', label: 'Device', missing: 'No device collectors ran (memory/CPU/FPS). Start recording while the app is in the foreground.' },
  { key: 'profiler', label: 'Profiler', missing: 'No CPU profile. Import a .cpuprofile or use CDP profiling for function-level data.' },
  { key: 'navigation', label: 'Navigation', missing: 'No screen events. Requires the agent and React Navigation (or markScreen calls).' },
  { key: 'network', label: 'Network', missing: 'No API calls captured. Requires the agent (fetch/XHR/axios hooks).' },
  { key: 'rendering', label: 'Rendering', missing: 'No FPS/render data. Record while interacting with the app.' },
];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function OverviewTab({ report, sessionId, session }: { report: AnalysisReport; sessionId: string; session: Session }): ReactElement {
  const coverage = report.coverage ?? ({} as Partial<Coverage>);
  const missingAgent = !coverage.agent;

  if (!report.window) {
    return (
      <EmptyState
        icon="timeline"
        title="Nothing recorded yet"
        action={
          <a className="btn btn-primary btn-md" href={paths.session(sessionId, 'control')}>
            Go to Control
          </a>
        }
      >
        Install the app on the device, start recording and use the app (or run a startup benchmark, journey replay or auto-explore). The
        analysis appears here as events arrive{session.status === 'recording' ? ' — it refreshes every 5 s while recording' : ''}.
      </EmptyState>
    );
  }

  const cold = report.startup?.cold;
  const visits = report.navigation?.visits ?? [];
  const uniqueScreens = new Set(visits.map((v) => v.screen)).size;
  const crashes = report.stability?.crashes?.length ?? 0;
  const errors = report.stability?.errors?.length ?? 0;

  return (
    <div className="stack">
      {missingAgent ? (
        <div className="callout">
          <Icon name="info" size={16} />
          <div>
            <strong>Native metrics only.</strong> No events from the in-app agent were recorded, so screens, network and JS metrics are missing.
            Build an instrumented APK on the Apps page or integrate <span className="mono">@rnpa/agent</span> in the app to capture them.
          </div>
        </div>
      ) : null}

      <div className="overview-top">
        <Card title="Performance score" className="score-card">
          <div className="score-body">
            <Gauge value={report.score?.overall ?? null} />
            <ul className="category-list" aria-label="Category scores">
              {CATEGORY_ORDER.map((c) => {
                const cat = report.score?.categories?.[c];
                const v = cat?.score ?? null;
                return (
                  <li key={c} className="category-row" title={cat?.note || undefined}>
                    <span className="category-name">{CATEGORY_LABEL[c]}</span>
                    <ScoreMeter value={v} />
                    <span className={`category-score${v === null ? ' muted' : ''}`}>{v === null ? 'no data' : Math.round(v)}</span>
                    <span className={`category-tone tone-text-${scoreTone(v)}`}>{v === null ? '' : scoreLabel(v)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
        <Card title="Data coverage" subtitle="Which signal sources contributed to this analysis">
          <ul className="coverage-list">
            {COVERAGE.map((c) => {
              const ok = Boolean(coverage[c.key]);
              return (
                <li key={c.key} className="coverage-row">
                  <Badge tone={ok ? 'good' : 'neutral'} icon={ok ? 'check' : 'close'}>
                    {c.label}
                  </Badge>
                  <span className="muted small">{ok ? 'Captured' : c.missing}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <StatGrid>
        <StatTile label="Cold start TTID (p50)" value={fmtMs(cold?.ttid?.p50)} sub={cold?.ttid ? `p90 ${fmtMs(cold.ttid.p90)} · ${plural(cold.ttid.count, 'run')}` : 'Run a cold launch or benchmark'} />
        <StatTile label="Cold start TTI (p50)" value={fmtMs(cold?.tti?.p50)} sub={cold?.tti ? `p90 ${fmtMs(cold.tti.p90)}` : missingAgent ? 'Needs the agent' : 'No TTI measured'} />
        <StatTile label="Screens visited" value={fmtNum(visits.length)} sub={visits.length ? `${uniqueScreens} unique` : missingAgent ? 'Needs the agent' : 'No navigation'} />
        <StatTile label="API calls" value={fmtCompact(report.network?.calls?.length ?? 0)} sub={`${report.network?.failed?.length ?? 0} failed · ${report.network?.slow?.length ?? 0} slow`} />
        <StatTile label="Long tasks" value={fmtNum(report.js?.longTasks?.length ?? 0)} sub={`${fmtMs(report.js?.blockedMs ?? 0)} blocked`} />
        <StatTile label="Avg UI FPS" value={fmtFps(report.rendering?.uiFpsAvg)} sub={report.rendering?.uiJankPct !== null && report.rendering?.uiJankPct !== undefined ? `${report.rendering.uiJankPct.toFixed(1)}% janky frames` : 'No frame data'} />
        <StatTile label="Peak memory (PSS)" value={fmtKb(report.memory?.peakKb)} sub={report.memory?.growthKb !== null && report.memory?.growthKb !== undefined ? `${report.memory.growthKb >= 0 ? '+' : ''}${fmtKb(report.memory.growthKb)} over session` : 'No samples'} />
        <StatTile label="Crashes / errors" value={`${crashes} / ${errors}`} tone={crashes ? 'critical' : errors ? 'warning' : undefined} sub={`Recorded ${fmtMs(report.window.duration)}`} />
      </StatGrid>

      <Bottlenecks items={report.bottlenecks ?? []} sessionId={sessionId} />
    </div>
  );
}

function Bottlenecks({ items, sessionId }: { items: Bottleneck[]; sessionId: string }): ReactElement {
  const [filter, setFilter] = useState<'all' | 'high'>('all');
  const ranked = useMemo(
    () =>
      items
        .map((b, i) => ({ b, i }))
        .sort((x, y) => (SEVERITY_RANK[x.b.severity] ?? 9) - (SEVERITY_RANK[y.b.severity] ?? 9) || x.i - y.i)
        .map((x) => x.b)
        .filter((b) => filter === 'all' || b.severity === 'critical' || b.severity === 'high'),
    [items, filter],
  );

  const open = (b: Bottleneck) => {
    const q: Record<string, string> = {};
    if (b.ts !== null && Number.isFinite(b.ts)) q.t = String(Math.round(b.ts));
    if (b.evidence?.length) q.ids = b.evidence.slice(0, 50).join(',');
    navigate(paths.session(sessionId, 'timeline', q));
  };

  return (
    <Card
      title="Bottlenecks"
      subtitle={items.length ? `${items.length} finding${items.length === 1 ? '' : 's'}, ranked by severity. Select one to see its evidence on the timeline.` : undefined}
      actions={
        items.length ? (
          <Segmented
            label="Severity filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'high', label: 'Critical & high' },
            ]}
          />
        ) : undefined
      }
      flush
    >
      {ranked.length === 0 ? (
        <EmptyState icon="check" title={items.length ? 'No critical or high findings' : 'No bottlenecks found'} compact>
          {items.length ? 'Switch to “All” to see lower-severity findings.' : 'Nothing crossed a threshold in the recorded data. More coverage (agent, longer recording) may reveal more.'}
        </EmptyState>
      ) : (
        <ol className="bottleneck-list">
          {ranked.map((b) => (
            <li key={b.id}>
              <button type="button" className="bottleneck" onClick={() => open(b)}>
                <div className="bn-head">
                  <SeverityBadge severity={b.severity} />
                  <Badge tone="neutral">{CATEGORY_LABEL[b.category] ?? b.category}</Badge>
                  <span className="bn-title">{b.title}</span>
                  {b.metric ? (
                    <span className="bn-metric">
                      <strong>{fmtMetric(b.metric.value, b.metric.unit)}</strong>
                      <span className="muted"> vs {fmtMetric(b.metric.threshold, b.metric.unit)} threshold</span>
                    </span>
                  ) : null}
                </div>
                <p className="bn-detail">{b.detail}</p>
                {b.recommendation ? (
                  <p className="bn-rec">
                    <Icon name="bolt" size={12} /> {b.recommendation}
                  </p>
                ) : null}
                <div className="bn-foot muted small">
                  {b.screen ? <span>Screen: {b.screen}</span> : null}
                  {b.metric ? <span>{b.metric.name}</span> : null}
                  {b.evidence?.length ? <span>{plural(b.evidence.length, 'evidence event')}</span> : null}
                  <span className="bn-go">
                    View on timeline <Icon name="chevronRight" size={12} />
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
