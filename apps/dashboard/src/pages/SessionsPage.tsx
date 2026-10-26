import { useState, type ReactElement } from 'react';
import { api, errorMessage, seg } from '../api/client';
import { useApi } from '../api/hooks';
import type { OkResponse, Session } from '../api/types';
import { Badge, SessionStatusBadge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { useConfirm } from '../components/Confirm';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { LoadingBlock } from '../components/Spinner';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { fmtCompact, fmtDateTime, fmtRelative } from '../lib/format';
import { navigate, paths } from '../router';
import { NewSessionModal } from './NewSessionModal';

export function SessionsPage(): ReactElement {
  const sessions = useApi<Session[]>('/api/sessions', { pollMs: 5000 });
  const confirm = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const list = sessions.data ?? [];

  const remove = async (s: Session) => {
    const ok = await confirm({
      title: 'Delete session?',
      body: (
        <>
          Permanently delete “{s.name}” and its {s.eventCount.toLocaleString()} recorded events? This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete session',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del<OkResponse>(`/api/sessions/${seg(s.id)}`);
      sessions.setData((prev) => prev?.filter((x) => x.id !== s.id));
      toast.success('Session deleted');
    } catch (err) {
      toast.error(err, 'Delete failed');
    }
  };

  const columns: Column<Session>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (s) => s.name,
      render: (s) => (
        <a className="strong" href={paths.session(s.id, s.status === 'stopped' ? 'overview' : 'control')} onClick={(e) => e.stopPropagation()}>
          {s.name || 'Untitled session'}
        </a>
      ),
    },
    { key: 'app', header: 'App', sortValue: (s) => s.packageName, render: (s) => <span className="mono small">{s.packageName}</span> },
    {
      key: 'device',
      header: 'Device',
      sortValue: (s) => s.deviceModel ?? s.serial,
      render: (s) => (
        <span className="cell-stack">
          <span>{s.deviceModel ?? '—'}</span>
          <span className="muted small mono">{s.serial}</span>
        </span>
      ),
    },
    {
      key: 'variant',
      header: 'Variant',
      sortValue: (s) => s.variant,
      render: (s) => <Badge tone={s.variant === 'instrumented' ? 'accent' : 'neutral'}>{s.variant}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (s) => s.status,
      render: (s) => (
        <span className="inline-gap">
          <SessionStatusBadge status={s.status} />
          {s.activity ? <Badge tone="accent">{s.activity}</Badge> : null}
        </span>
      ),
    },
    { key: 'events', header: 'Events', align: 'right', sortValue: (s) => s.eventCount, render: (s) => <span className="num">{fmtCompact(s.eventCount)}</span> },
    {
      key: 'created',
      header: 'Created',
      sortValue: (s) => s.createdAt,
      render: (s) => <span title={fmtDateTime(s.createdAt)}>{fmtRelative(s.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (s) => (
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          aria-label={`Delete session ${s.name}`}
          title="Delete session"
          onClick={(e) => {
            e.stopPropagation();
            void remove(s);
          }}
        />
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-sub">Each session binds one app build to one device and owns one timeline.</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={sessions.reload}>
            Refresh
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New session
          </Button>
        </div>
      </div>
      <Card flush>
        {sessions.initialLoading ? (
          <LoadingBlock />
        ) : sessions.error && !sessions.data ? (
          <ErrorState error={errorMessage(sessions.error)} onRetry={sessions.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            icon="sessions"
            title="No sessions yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                New session
              </Button>
            }
          >
            Upload an APK on the <a href={paths.apps()}>Apps</a> page, connect a device, then create a session to install, drive and record the app.
          </EmptyState>
        ) : (
          <DataTable
            columns={columns}
            rows={list}
            rowKey={(s) => s.id}
            initialSort={{ key: 'created', dir: 'desc' }}
            onRowClick={(s) => navigate(paths.session(s.id, s.status === 'stopped' ? 'overview' : 'control'))}
            caption="Sessions"
          />
        )}
      </Card>
      {creating ? <NewSessionModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
