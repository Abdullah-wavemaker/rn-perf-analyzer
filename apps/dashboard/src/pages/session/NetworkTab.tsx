import { useMemo, useState, type ReactElement } from 'react';
import type { AnalysisReport, ApiCall, DuplicateGroup, EndpointSummary, SequentialChain } from '@rnpa/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatGrid, StatTile } from '../../components/StatTile';
import { DataTable, type Column } from '../../components/Table';
import { Waterfall } from '../../charts/Waterfall';
import { httpTone } from '../../lib/colors';
import { fmtBytes, fmtMs, fmtNum, fmtOffset, urlPath } from '../../lib/format';

function StatusBadge({ c }: { c: ApiCall }): ReactElement {
  const label = c.error ? 'failed' : c.status !== null ? String(c.status) : 'pending';
  return <Badge tone={httpTone(c.status, c.error)}>{label}</Badge>;
}

export function NetworkTab({ report }: { report: AnalysisReport }): ReactElement {
  const net = report.network;
  const calls = useMemo(() => net?.calls ?? [], [net]);
  const byId = useMemo(() => new Map(calls.map((c) => [c.requestId, c])), [calls]);
  const [selected, setSelected] = useState<ApiCall | null>(null);
  const origin = report.window?.start ?? (calls[0]?.start ?? 0);

  if (calls.length === 0) {
    return (
      <EmptyState icon="compass" title="No API calls captured">
        Network metrics come from the in-app agent's fetch/XHR/axios hooks. Use the instrumented build (or integrate{' '}
        <span className="mono">@rnpa/agent</span>) and record while the app loads data.
      </EmptyState>
    );
  }

  const failed = (net.failed ?? []).map((id) => byId.get(id)).filter((c): c is ApiCall => Boolean(c));
  const slow = (net.slow ?? []).map((id) => byId.get(id)).filter((c): c is ApiCall => Boolean(c));
  const dupWaste = (net.duplicates ?? []).reduce((a, d) => a + (d.wastedMs ?? 0), 0);
  const chainSaving = (net.sequentialChains ?? []).reduce((a, c) => a + Math.max(0, c.totalMs - c.parallelMs), 0);
  const durations = calls.map((c) => c.duration).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor(durations.length * 0.5)] : null;

  const endpointCols: Column<EndpointSummary>[] = [
    { key: 'ep', header: 'Endpoint', sortValue: (e) => e.endpoint, render: (e) => <span className="mono small break">{e.endpoint}</span> },
    { key: 'n', header: 'Count', align: 'right', sortValue: (e) => e.count, render: (e) => <span className="num">{e.count}</span> },
    { key: 'err', header: 'Errors', align: 'right', sortValue: (e) => e.errors, render: (e) => <span className={`num${e.errors ? ' text-critical' : ''}`}>{e.errors}</span> },
    { key: 'slow', header: 'Slow', align: 'right', sortValue: (e) => e.slow, render: (e) => <span className="num">{e.slow}</span> },
    { key: 'dup', header: 'Dupes', align: 'right', sortValue: (e) => e.duplicates, render: (e) => <span className="num">{e.duplicates}</span> },
    { key: 'p50', header: 'p50', align: 'right', sortValue: (e) => e.duration?.p50, render: (e) => <span className="num">{fmtMs(e.duration?.p50)}</span> },
    { key: 'p90', header: 'p90', align: 'right', sortValue: (e) => e.duration?.p90, render: (e) => <span className="num">{fmtMs(e.duration?.p90)}</span> },
    { key: 'max', header: 'Max', align: 'right', sortValue: (e) => e.duration?.max, render: (e) => <span className="num">{fmtMs(e.duration?.max)}</span> },
    { key: 'bytes', header: 'Bytes ↓', align: 'right', sortValue: (e) => e.responseBytes, render: (e) => <span className="num">{fmtBytes(e.responseBytes)}</span> },
  ];

  const callCols: Column<ApiCall>[] = [
    { key: 'start', header: 'Start', sortValue: (c) => c.start, render: (c) => <span className="mono small">{fmtOffset(c.start - origin)}</span> },
    { key: 'method', header: 'Method', sortValue: (c) => c.method, render: (c) => <span className="mono small">{c.method}</span> },
    { key: 'url', header: 'URL', sortValue: (c) => c.url, render: (c) => <span className="mono small truncate block" title={c.url}>{urlPath(c.url)}</span> },
    { key: 'status', header: 'Status', sortValue: (c) => c.status ?? (c.error ? 0 : -1), render: (c) => <StatusBadge c={c} /> },
    { key: 'dur', header: 'Duration', align: 'right', sortValue: (c) => c.duration, render: (c) => <span className="num">{fmtMs(c.duration)}</span> },
    { key: 'size', header: 'Size', align: 'right', sortValue: (c) => c.responseSize, render: (c) => <span className="num">{fmtBytes(c.responseSize)}</span> },
    { key: 'screen', header: 'Screen', sortValue: (c) => c.screen, render: (c) => c.screen ?? <span className="muted">—</span> },
  ];

  const dupCols: Column<DuplicateGroup>[] = [
    { key: 'ep', header: 'Endpoint', sortValue: (d) => d.endpoint, render: (d) => <span className="mono small break" title={d.url}>{d.endpoint}</span> },
    { key: 'screen', header: 'Screen', sortValue: (d) => d.screen, render: (d) => d.screen ?? '—' },
    { key: 'n', header: 'Requests', align: 'right', sortValue: (d) => d.count, render: (d) => <span className="num">{d.count}×</span> },
    { key: 'w', header: 'Wasted', align: 'right', sortValue: (d) => d.wastedMs, render: (d) => <span className="num">{fmtMs(d.wastedMs)}</span> },
  ];

  const chainCols: Column<SequentialChain>[] = [
    { key: 'screen', header: 'Screen', sortValue: (c) => c.screen, render: (c) => c.screen ?? '—' },
    {
      key: 'eps',
      header: 'Chain',
      render: (c) => (
        <span className="chain">
          {c.endpoints.map((e, i) => (
            <span key={`${e}-${i}`} className="chain-step">
              {i > 0 ? <span className="nav-arrow" aria-hidden="true">→</span> : null}
              <span className="mono small">{e}</span>
            </span>
          ))}
        </span>
      ),
    },
    { key: 'total', header: 'Sequential', align: 'right', sortValue: (c) => c.totalMs, render: (c) => <span className="num">{fmtMs(c.totalMs)}</span> },
    { key: 'par', header: 'If parallel', align: 'right', sortValue: (c) => c.parallelMs, render: (c) => <span className="num">{fmtMs(c.parallelMs)}</span> },
    {
      key: 'save',
      header: 'Potential saving',
      align: 'right',
      sortValue: (c) => c.totalMs - c.parallelMs,
      render: (c) => <span className="num strong">{fmtMs(Math.max(0, c.totalMs - c.parallelMs))}</span>,
    },
  ];

  return (
    <div className="stack">
      <StatGrid>
        <StatTile label="Requests" value={fmtNum(calls.length)} sub={`${net.endpoints?.length ?? 0} endpoints`} />
        <StatTile label="Median duration" value={fmtMs(p50)} sub={durations.length ? `max ${fmtMs(durations[durations.length - 1])}` : undefined} />
        <StatTile label="Failed" value={fmtNum(failed.length)} tone={failed.length ? 'critical' : undefined} sub="errors & 4xx/5xx" />
        <StatTile label="Slow" value={fmtNum(slow.length)} tone={slow.length ? 'warning' : undefined} sub="over the slow threshold" />
        <StatTile label="Duplicate waste" value={fmtMs(dupWaste)} sub={`${net.duplicates?.length ?? 0} duplicate groups`} />
        <StatTile label="Parallelizable" value={fmtMs(chainSaving)} sub={`${net.sequentialChains?.length ?? 0} sequential chains`} />
        <StatTile label="Transferred" value={fmtBytes(net.totalBytes)} />
      </StatGrid>

      <Card title="Endpoints" flush>
        <DataTable columns={endpointCols} rows={net.endpoints ?? []} rowKey={(e) => e.endpoint} initialSort={{ key: 'p90', dir: 'desc' }} caption="Endpoint summary" />
      </Card>

      <Card flush>
        <Waterfall calls={calls} origin={origin} selectedId={selected?.requestId ?? null} onSelect={setSelected} />
      </Card>

      {selected ? <CallDetail call={selected} origin={origin} onClose={() => setSelected(null)} /> : null}

      <div className="grid-2">
        <Card title="Duplicate requests" subtitle="Same request repeated on one screen visit" flush>
          {(net.duplicates ?? []).length ? (
            <DataTable columns={dupCols} rows={net.duplicates} rowKey={(d, i) => `${d.endpoint}-${i}`} initialSort={{ key: 'w', dir: 'desc' }} />
          ) : (
            <EmptyState icon="check" title="No duplicate requests" compact />
          )}
        </Card>
        <Card title="Sequential chains" subtitle="Independent requests awaited one after another" flush>
          {(net.sequentialChains ?? []).length ? (
            <DataTable columns={chainCols} rows={net.sequentialChains} rowKey={(c, i) => `${c.requestIds.join('|')}-${i}`} initialSort={{ key: 'save', dir: 'desc' }} />
          ) : (
            <EmptyState icon="check" title="No sequential chains detected" compact />
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Failed requests" flush>
          {failed.length ? (
            <DataTable columns={callCols} rows={failed} rowKey={(c) => c.requestId} onRowClick={setSelected} initialSort={{ key: 'start', dir: 'asc' }} dense />
          ) : (
            <EmptyState icon="check" title="No failed requests" compact />
          )}
        </Card>
        <Card title="Slow requests" flush>
          {slow.length ? (
            <DataTable columns={callCols} rows={slow} rowKey={(c) => c.requestId} onRowClick={setSelected} initialSort={{ key: 'dur', dir: 'desc' }} dense />
          ) : (
            <EmptyState icon="check" title="No slow requests" compact />
          )}
        </Card>
      </div>

      <Card title="All requests" flush>
        <DataTable columns={callCols} rows={calls} rowKey={(c) => c.requestId} onRowClick={setSelected} selectedKey={selected?.requestId ?? null} initialSort={{ key: 'start', dir: 'asc' }} maxRows={1000} dense />
      </Card>
    </div>
  );
}

function CallDetail({ call, origin, onClose }: { call: ApiCall; origin: number; onClose: () => void }): ReactElement {
  return (
    <Card
      title={`${call.method} ${urlPath(call.url)}`}
      actions={<Button size="sm" variant="ghost" icon="close" onClick={onClose} aria-label="Close request details" />}
    >
      <dl className="kv-grid">
        <dt>URL</dt>
        <dd className="mono small break">{call.url}</dd>
        <dt>Endpoint</dt>
        <dd className="mono small">{call.endpoint}</dd>
        <dt>Status</dt>
        <dd>
          <StatusBadge c={call} /> {call.error ? <span className="error-text">{call.error}</span> : null}
        </dd>
        <dt>Client</dt>
        <dd>{call.client}</dd>
        <dt>Start</dt>
        <dd className="mono">{fmtOffset(call.start - origin)}</dd>
        <dt>Duration</dt>
        <dd>{fmtMs(call.duration)}</dd>
        <dt>Request / response</dt>
        <dd>
          {fmtBytes(call.requestSize)} / {fmtBytes(call.responseSize)}
        </dd>
        <dt>Screen</dt>
        <dd>
          {call.screen ?? '—'}
          {call.visitIndex !== null ? <span className="muted"> (visit {call.visitIndex + 1})</span> : null}
        </dd>
        <dt>Request id</dt>
        <dd className="mono small">{call.requestId}</dd>
      </dl>
    </Card>
  );
}
