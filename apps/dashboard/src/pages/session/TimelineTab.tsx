import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AnalysisReport, PerfEvent } from '@rnpa/shared';
import { api, errorMessage, isAbort, seg } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { LoadingBlock } from '../../components/Spinner';
import { Timeline } from '../../timeline/Timeline';
import { navigate, paths } from '../../router';
import { fmtCompact } from '../../lib/format';

const INCREMENTAL_MS = 5000;

function mergeEvents(prev: PerfEvent[], next: PerfEvent[]): PerfEvent[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.id));
  const add = next.filter((e) => e && typeof e.id === 'string' && !seen.has(e.id));
  return add.length ? prev.concat(add) : prev;
}

export function TimelineTab({
  report,
  sessionId,
  recording,
  query,
}: {
  report: AnalysisReport;
  sessionId: string;
  recording: boolean;
  query: URLSearchParams;
}): ReactElement {
  const [events, setEvents] = useState<PerfEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const maxTs = useRef(0);

  // Full load.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api
      .get<PerfEvent[]>(`/api/sessions/${seg(sessionId)}/events`, { signal: ctrl.signal })
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        maxTs.current = arr.reduce((m, e) => Math.max(m, e.ts ?? 0), 0);
        setEvents(arr);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!isAbort(err)) setError(err);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [sessionId, nonce]);

  // Incremental tail while recording.
  useEffect(() => {
    if (!recording || events === null) return;
    let disposed = false;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      const from = Math.max(0, maxTs.current - 1);
      api
        .get<PerfEvent[]>(`/api/sessions/${seg(sessionId)}/events?from=${from}`)
        .then((list) => {
          if (disposed || !Array.isArray(list) || list.length === 0) return;
          maxTs.current = list.reduce((m, e) => Math.max(m, e.ts ?? 0), maxTs.current);
          setEvents((prev) => mergeEvents(prev ?? [], list));
        })
        .catch(() => undefined);
    }, INCREMENTAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [recording, sessionId, events === null]);

  const all = useMemo(() => mergeEvents(events ?? [], report.derivedEvents ?? []), [events, report.derivedEvents]);

  const focusTs = useMemo(() => {
    const t = Number(query.get('t'));
    return query.has('t') && Number.isFinite(t) ? t : null;
  }, [query]);
  const highlightIds = useMemo(
    () =>
      (query.get('ids') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200),
    [query],
  );

  if (loading && events === null) return <LoadingBlock label="Loading events…" />;
  if (error && events === null) return <ErrorState error={errorMessage(error)} onRetry={() => setNonce((n) => n + 1)} />;
  if (all.length === 0) {
    return (
      <EmptyState icon="timeline" title="No events to show">
        Record a session on the Control tab — every collected event (screens, API calls, JS tasks, frames, memory, CPU, lifecycle) is laid out here
        on one time axis.
      </EmptyState>
    );
  }

  return (
    <Card
      title="Timeline"
      subtitle={`${fmtCompact(all.length)} events${recording ? ' · live (refreshes every 5 s)' : ''}`}
      actions={
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => setNonce((n) => n + 1)} loading={loading}>
          Reload events
        </Button>
      }
      flush
    >
      <Timeline
        events={all}
        focusTs={focusTs}
        highlightIds={highlightIds}
        onClearFocus={() => navigate(paths.session(sessionId, 'timeline'), { replace: true })}
      />
    </Card>
  );
}
