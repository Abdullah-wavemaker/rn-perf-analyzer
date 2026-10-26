import { useMemo, useState, type ReactElement } from 'react';
import type { LogMessage, PerfEvent } from '../../api/types';
import { LIVE_EVENT_CAP } from '../../api/sse';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { EVENT_GROUPS, eventColor, eventGroup, type EventGroup } from '../../lib/colors';
import { summarizeEvent } from '../../lib/eventSummary';
import { fmtCompact, fmtTime } from '../../lib/format';

const RENDER_CAP = 300;

export function LiveFeed({
  events,
  received,
  onClear,
  connected,
}: {
  events: PerfEvent[];
  received: number;
  onClear: () => void;
  connected: boolean;
}): ReactElement {
  const [hidden, setHidden] = useState<Set<EventGroup>>(() => new Set(['resources']));
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<PerfEvent[] | null>(null);

  const source = paused && frozen ? frozen : events;

  const counts = useMemo(() => {
    const m = new Map<EventGroup, number>();
    for (const e of source) {
      const g = eventGroup(e.type)?.id;
      if (g) m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  }, [source]);

  const rows = useMemo(() => {
    const out: PerfEvent[] = [];
    for (let i = source.length - 1; i >= 0 && out.length < RENDER_CAP; i--) {
      const e = source[i];
      if (!e) continue;
      const g = eventGroup(e.type)?.id;
      if (g && hidden.has(g)) continue;
      out.push(e);
    }
    return out;
  }, [source, hidden]);

  const toggle = (g: EventGroup) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <Card
      title="Live events"
      subtitle={
        <>
          <span className={`status-dot ${connected ? 'tone-good' : 'tone-neutral'}`} aria-hidden="true" /> {connected ? 'Streaming' : 'Disconnected'} ·{' '}
          {fmtCompact(received)} received · last {LIVE_EVENT_CAP.toLocaleString()} kept
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={paused ? 'play' : 'stop'}
            onClick={() => {
              setFrozen(paused ? null : events);
              setPaused((p) => !p);
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={onClear}>
            Clear
          </Button>
        </>
      }
      flush
    >
      <div className="chip-row" role="group" aria-label="Filter event types">
        {EVENT_GROUPS.map((g) => {
          const on = !hidden.has(g.id);
          return (
            <button key={g.id} type="button" className={`chip${on ? ' active' : ''}`} aria-pressed={on} onClick={() => toggle(g.id)}>
              <span className="chip-dot" style={{ background: g.color }} aria-hidden="true" />
              {g.label}
              <span className="chip-count">{fmtCompact(counts.get(g.id) ?? 0)}</span>
            </button>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="timeline" title={source.length ? 'All events filtered out' : 'No events yet'} compact>
          {source.length ? 'Enable more filters above.' : 'Start recording and use the app — events stream in here as they are collected.'}
        </EmptyState>
      ) : (
        <ol className="feed" aria-label="Newest events first">
          {rows.map((e) => (
            <li key={e.id} className="feed-row">
              <span className="feed-time mono">{fmtTime(e.ts)}</span>
              <span className="feed-type" style={{ borderColor: eventColor(e.type) }}>
                <span className="type-dot" style={{ background: eventColor(e.type) }} aria-hidden="true" />
                {e.type}
              </span>
              <span className="feed-screen truncate" title={e.screen ?? undefined}>
                {e.screen ?? ''}
              </span>
              <span className="feed-summary truncate" title={summarizeEvent(e)}>
                {summarizeEvent(e)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {rows.length >= RENDER_CAP ? <div className="table-footnote">Showing newest {RENDER_CAP} matching events</div> : null}
    </Card>
  );
}

export function LogPanel({ logs }: { logs: LogMessage[] }): ReactElement {
  const rows = useMemo(() => logs.slice(-200).reverse(), [logs]);
  return (
    <Card title="Server log" subtitle="Orchestrator messages for this session" flush>
      {rows.length === 0 ? (
        <EmptyState icon="info" title="No messages" compact>
          Install, launch and automation progress appears here.
        </EmptyState>
      ) : (
        <ol className="log-list" aria-label="Log messages, newest first">
          {rows.map((l, i) => (
            <li key={`${l.ts}-${i}`} className={`log-row log-${l.level}`}>
              <span className="feed-time mono">{fmtTime(l.ts)}</span>
              <span className={`log-level ${l.level}`}>{l.level}</span>
              <span className="log-msg">{l.message}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
