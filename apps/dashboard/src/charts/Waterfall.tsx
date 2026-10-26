import { useMemo, useState, type ReactElement } from 'react';
import type { ApiCall } from '@rnpa/shared';
import { useElementSize } from '../api/hooks';
import { TONE_VAR, httpTone } from '../lib/colors';
import { fmtBytes, fmtMs, urlPath } from '../lib/format';
import { ChartFrame } from './ChartFrame';
import { FloatingTooltip, TipRow, TipTitle, useTooltip } from './Tooltip';
import { fmtTickOffset, timeStep, timeTicks } from './scale';

const PAGE = 200;
const LABEL_W = 280;

/** Request waterfall: one row per call, bars on a shared time axis. */
export function Waterfall({
  calls,
  origin,
  selectedId,
  onSelect,
}: {
  calls: ApiCall[];
  origin: number;
  selectedId?: string | null;
  onSelect?: (call: ApiCall) => void;
}): ReactElement {
  const [limit, setLimit] = useState(PAGE);
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();

  const sorted = useMemo(() => calls.slice().sort((a, b) => a.start - b.start), [calls]);
  const domain = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of sorted) {
      lo = Math.min(lo, c.start);
      const end = c.end ?? (c.duration !== null ? c.start + c.duration : c.start);
      hi = Math.max(hi, end);
    }
    if (!Number.isFinite(lo)) return null;
    if (hi - lo < 1) hi = lo + 1;
    return { lo, hi };
  }, [sorted]);

  const trackW = Math.max(40, width - LABEL_W - 80);
  const ticks = domain ? timeTicks(domain.lo, domain.hi, Math.max(2, Math.floor(trackW / 100)), origin) : [];
  const step = domain ? timeStep(domain.hi - domain.lo, Math.max(2, Math.floor(trackW / 100))) : 1;
  const pct = (t: number) => (domain ? ((t - domain.lo) / (domain.hi - domain.lo)) * 100 : 0);
  const rows = sorted.slice(0, limit);

  const legend = [
    { label: '2xx', color: TONE_VAR.good, shape: 'rect' as const },
    { label: '3xx', color: TONE_VAR.info, shape: 'rect' as const },
    { label: '4xx', color: TONE_VAR.serious, shape: 'rect' as const },
    { label: '5xx / failed', color: TONE_VAR.critical, shape: 'rect' as const },
    { label: 'No response', color: TONE_VAR.neutral, shape: 'rect' as const },
  ];

  return (
    <ChartFrame title="Request waterfall" subtitle={`${calls.length.toLocaleString()} requests on a shared time axis, colored by status`} legend={legend}>
      <div ref={ref} className="waterfall">
        {!domain ? (
          <div className="chart-empty">No requests captured</div>
        ) : (
          <>
            <div className="wf-axis" aria-hidden="true">
              <div className="wf-label-col" />
              <div className="wf-track">
                {ticks.map((t) => (
                  <span key={t} className="wf-tick" style={{ left: `${pct(t)}%` }}>
                    {fmtTickOffset(t - origin, step)}
                  </span>
                ))}
              </div>
              <div className="wf-dur-col">Duration</div>
            </div>
            <ul className="wf-rows" aria-label="Requests">
              {rows.map((c) => {
                const tone = httpTone(c.status, c.error);
                const end = c.end ?? (c.duration !== null ? c.start + c.duration : null);
                const left = pct(c.start);
                const w = end !== null ? Math.max(0.15, pct(end) - left) : 100 - left;
                const label = `${c.method} ${urlPath(c.url)}`;
                const status = c.error ? 'failed' : c.status !== null ? String(c.status) : 'pending';
                const tipContent = (
                  <>
                    <TipTitle>{label}</TipTitle>
                    <TipRow color={TONE_VAR[tone]} label="status" value={status} />
                    <TipRow label="duration" value={fmtMs(c.duration)} />
                    <TipRow label="start" value={fmtTickOffset(c.start - origin, 1)} />
                    <TipRow label="response" value={fmtBytes(c.responseSize)} />
                    {c.screen ? <div className="tip-detail">Screen: {c.screen}</div> : null}
                    {c.error ? <div className="tip-detail">Error: {c.error}</div> : null}
                  </>
                );
                return (
                  <li key={c.requestId}>
                    <button
                      type="button"
                      className={`wf-row${selectedId === c.requestId ? ' selected' : ''}`}
                      onClick={() => onSelect?.(c)}
                      onPointerMove={(e) => show(e.clientX, e.clientY, tipContent)}
                      onPointerLeave={hide}
                      onFocus={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        show(r.left + LABEL_W, r.bottom, tipContent);
                      }}
                      onBlur={hide}
                      aria-label={`${label}, ${status}, ${fmtMs(c.duration)}`}
                    >
                      <span className="wf-label-col">
                        <span className={`wf-method method-${c.method.toLowerCase()}`}>{c.method}</span>
                        <span className="wf-url truncate">{urlPath(c.url)}</span>
                      </span>
                      <span className="wf-track">
                        <span
                          className={`wf-bar${end === null ? ' pending' : ''}`}
                          style={{ left: `${left}%`, width: `${w}%`, background: TONE_VAR[tone] }}
                        />
                      </span>
                      <span className="wf-dur-col num">{fmtMs(c.duration)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {sorted.length > limit ? (
              <div className="wf-more">
                <span>
                  Showing {limit.toLocaleString()} of {sorted.length.toLocaleString()}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
                  <span className="btn-label">Show {Math.min(PAGE, sorted.length - limit)} more</span>
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <FloatingTooltip state={tip} />
    </ChartFrame>
  );
}
