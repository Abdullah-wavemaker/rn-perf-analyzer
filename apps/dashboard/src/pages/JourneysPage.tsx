import type { ReactElement } from 'react';
import { api, errorMessage, seg } from '../api/client';
import { useApi } from '../api/hooks';
import type { Journey, JourneyStep, OkResponse } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { useConfirm } from '../components/Confirm';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { LoadingBlock } from '../components/Spinner';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { fmtDateTime, fmtMs, fmtRelative } from '../lib/format';

export function journeyDuration(j: Journey): number {
  return (j.steps ?? []).reduce((a, s) => a + (s.delayMs ?? 0) + (s.durationMs ?? 0), 0);
}

export function stepSummary(steps: JourneyStep[]): string {
  const counts = new Map<string, number>();
  for (const s of steps ?? []) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return Array.from(counts, ([k, n]) => `${n} ${k.replace('_', ' ')}`).join(' · ') || 'no steps';
}

export function JourneysPage(): ReactElement {
  const journeys = useApi<Journey[]>('/api/journeys');
  const confirm = useConfirm();
  const toast = useToast();

  const remove = async (j: Journey) => {
    const ok = await confirm({ title: 'Delete journey?', body: <>Delete the recorded journey “{j.name}” ({j.steps?.length ?? 0} steps)?</>, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.del<OkResponse>(`/api/journeys/${seg(j.id)}`);
      journeys.setData((prev) => prev?.filter((x) => x.id !== j.id));
    } catch (err) {
      toast.error(err, 'Delete failed');
    }
  };

  const columns: Column<Journey>[] = [
    { key: 'name', header: 'Name', sortValue: (j) => j.name, render: (j) => <span className="strong">{j.name}</span> },
    { key: 'pkg', header: 'App', sortValue: (j) => j.packageName, render: (j) => <span className="mono small">{j.packageName}</span> },
    { key: 'steps', header: 'Steps', align: 'right', sortValue: (j) => j.steps?.length ?? 0, render: (j) => <span className="num">{j.steps?.length ?? 0}</span> },
    { key: 'kinds', header: 'Actions', render: (j) => <span className="muted small">{stepSummary(j.steps)}</span> },
    { key: 'dur', header: 'Duration', align: 'right', sortValue: (j) => journeyDuration(j), render: (j) => <span className="num">{fmtMs(journeyDuration(j))}</span> },
    { key: 'created', header: 'Recorded', sortValue: (j) => j.createdAt, render: (j) => <span title={fmtDateTime(j.createdAt)}>{fmtRelative(j.createdAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (j) => <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete journey ${j.name}`} onClick={() => void remove(j)} />,
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Journeys</h1>
          <p className="page-sub">Recorded user flows that can be replayed on any session of the same app for repeatable measurements.</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={journeys.reload}>
            Refresh
          </Button>
        </div>
      </div>
      <Card flush>
        {journeys.initialLoading ? (
          <LoadingBlock />
        ) : journeys.error && !journeys.data ? (
          <ErrorState error={errorMessage(journeys.error)} onRetry={journeys.reload} />
        ) : (journeys.data ?? []).length === 0 ? (
          <EmptyState icon="journeys" title="No journeys recorded">
            Open a session's <strong>Control</strong> tab, start “Record journey”, interact with the device mirror, then stop. Replay it later from
            any session of the same app.
          </EmptyState>
        ) : (
          <DataTable columns={columns} rows={journeys.data ?? []} rowKey={(j) => j.id} initialSort={{ key: 'created', dir: 'desc' }} caption="Journeys" />
        )}
      </Card>
    </div>
  );
}
