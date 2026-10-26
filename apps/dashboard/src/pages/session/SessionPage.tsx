import { useEffect, useState, type ReactElement } from 'react';
import type { AnalysisReport } from '@rnpa/shared';
import { api, errorMessage, seg } from '../../api/client';
import { useApi, type ApiState } from '../../api/hooks';
import { useSessionStream } from '../../api/sse';
import type { OkResponse, Session } from '../../api/types';
import { Badge, SessionStatusBadge } from '../../components/Badge';
import { Button, LinkButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { LoadingBlock, Spinner } from '../../components/Spinner';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { fmtCompact, fmtDateTime } from '../../lib/format';
import { navigate, paths, type SessionTab } from '../../router';
import { ACTIVITY_LABEL, ControlTab } from './ControlTab';
import { JsTab } from './JsTab';
import { MemoryTab } from './MemoryTab';
import { NetworkTab } from './NetworkTab';
import { OverviewTab } from './OverviewTab';
import { RenderingTab } from './RenderingTab';
import { ScreensTab } from './ScreensTab';
import { StartupTab } from './StartupTab';
import { TimelineTab } from './TimelineTab';

const TAB_LABELS: Record<SessionTab, string> = {
  control: 'Control',
  overview: 'Overview',
  startup: 'Startup',
  screens: 'Screens',
  network: 'Network',
  js: 'JS',
  rendering: 'Rendering',
  memory: 'Memory & CPU',
  timeline: 'Timeline',
};

export function SessionPage({ id, tab, query }: { id: string; tab: SessionTab; query: URLSearchParams }): ReactElement {
  const base = `/api/sessions/${seg(id)}`;
  const fetched = useApi<Session>(base);
  const stream = useSessionStream(id);
  const [override, setOverride] = useState<Session | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  // Newest wins: SSE status, then explicit responses, then the initial GET.
  useEffect(() => {
    if (stream.session) setOverride(stream.session);
  }, [stream.session]);
  const session = override ?? fetched.data;

  const recording = session?.status === 'recording';
  const analysisTab = tab !== 'control';
  const analysis = useApi<AnalysisReport>(analysisTab ? `${base}/analysis` : null, {
    pollMs: recording && analysisTab ? 5000 : null,
    pollWhile: () => recording,
  });

  if (fetched.initialLoading && !session) return <div className="page"><LoadingBlock label="Loading session…" /></div>;
  if (!session) {
    return (
      <div className="page">
        <EmptyState icon="alert" title="Session not available" action={<a className="btn btn-default btn-md" href={paths.sessions()}>Back to sessions</a>}>
          {fetched.error ? errorMessage(fetched.error) : 'This session does not exist.'}
        </EmptyState>
      </div>
    );
  }

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete session?',
      body: <>Permanently delete “{session.name}” and all {session.eventCount.toLocaleString()} recorded events?</>,
      confirmLabel: 'Delete session',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del<OkResponse>(base);
      navigate(paths.sessions());
    } catch (err) {
      toast.error(err, 'Delete failed');
    }
  };

  const tabs = (Object.keys(TAB_LABELS) as SessionTab[]).map((t) => ({ id: t, label: TAB_LABELS[t], href: paths.session(id, t) }));

  return (
    <div className="page session-page">
      <div className="session-header">
        <div className="session-heading">
          <div className="crumbs">
            <a href={paths.sessions()}>Sessions</a>
            <span aria-hidden="true">/</span>
          </div>
          <h1 className="page-title">{session.name || 'Untitled session'}</h1>
          <div className="session-meta">
            <SessionStatusBadge status={session.status} />
            <Badge tone={session.variant === 'instrumented' ? 'accent' : 'neutral'}>{session.variant}</Badge>
            {session.agentConnected ? (
              <Badge tone="good" icon="check">
                Agent connected
              </Badge>
            ) : session.hasAgentData ? (
              <Badge tone="neutral" icon="check" title="This session contains in-app agent data">
                Agent data
              </Badge>
            ) : (
              <Badge tone="neutral" title="No agent events — native metrics only">
                Native only
              </Badge>
            )}
            {session.activity ? (
              <Badge tone="accent">
                <Spinner size={10} /> {ACTIVITY_LABEL[session.activity] ?? session.activity}
              </Badge>
            ) : null}
            <span className="meta-item mono">{session.packageName}</span>
            <span className="meta-item">{session.deviceModel ?? session.serial}</span>
            <span className="meta-item muted">{fmtCompact(session.eventCount)} events</span>
            <span className="meta-item muted">created {fmtDateTime(session.createdAt)}</span>
          </div>
        </div>
        <div className="page-actions">
          {analysisTab ? (
            <Button icon="refresh" onClick={analysis.reload} loading={analysis.loading}>
              Re-analyze
            </Button>
          ) : null}
          <LinkButton href={`${base}/export.json`} icon="download" download title="Download session, app, events and analysis as JSON">
            Export JSON
          </LinkButton>
          <LinkButton href={`${base}/report.html`} icon="file" download title="Self-contained HTML report">
            HTML report
          </LinkButton>
          <Button variant="ghost" icon="trash" onClick={() => void remove()} aria-label="Delete session" title="Delete session" />
        </div>
      </div>

      <Tabs items={tabs} active={tab} label="Session views" />

      <div className="tab-panel">
        {tab === 'control' ? (
          <ControlTab session={session} stream={stream} onSession={setOverride} />
        ) : (
          <AnalysisView tab={tab} analysis={analysis} sessionId={id} session={session} query={query} />
        )}
      </div>
    </div>
  );
}

function AnalysisView({
  tab,
  analysis,
  sessionId,
  session,
  query,
}: {
  tab: Exclude<SessionTab, 'control'>;
  analysis: ApiState<AnalysisReport>;
  sessionId: string;
  session: Session;
  query: URLSearchParams;
}): ReactElement {
  if (analysis.initialLoading) return <LoadingBlock label="Analyzing session…" />;
  if (!analysis.data) {
    return <ErrorState error={analysis.error ? errorMessage(analysis.error) : 'No analysis available'} onRetry={analysis.reload} />;
  }
  const report = analysis.data;
  return (
    <div className={analysis.loading ? 'refetching' : undefined}>
      {analysis.error ? <ErrorState error={`Refresh failed: ${errorMessage(analysis.error)}`} onRetry={analysis.reload} /> : null}
      {tab === 'overview' ? <OverviewTab report={report} sessionId={sessionId} session={session} /> : null}
      {tab === 'startup' ? <StartupTab report={report} sessionId={sessionId} /> : null}
      {tab === 'screens' ? <ScreensTab report={report} /> : null}
      {tab === 'network' ? <NetworkTab report={report} /> : null}
      {tab === 'js' ? <JsTab report={report} /> : null}
      {tab === 'rendering' ? <RenderingTab report={report} /> : null}
      {tab === 'memory' ? <MemoryTab report={report} /> : null}
      {tab === 'timeline' ? <TimelineTab report={report} sessionId={sessionId} recording={session.status === 'recording'} query={query} /> : null}
    </div>
  );
}
