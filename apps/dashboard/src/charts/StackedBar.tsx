import type { ReactElement } from 'react';
import { FloatingTooltip, TipRow, TipTitle, useTooltip } from './Tooltip';

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Single horizontal stacked bar (HTML, so it stays crisp and responsive).
 * Segments are separated by a 2px surface gap; only the data end is rounded.
 * `scaleMax` lets several bars share one scale (rows of a per-run table).
 */
export function StackedBar({
  segments,
  scaleMax,
  format,
  label,
  height = 12,
}: {
  segments: StackSegment[];
  scaleMax?: number;
  format: (v: number) => string;
  label: string;
  height?: number;
}): ReactElement {
  const { tip, show, hide } = useTooltip();
  const visible = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = visible.reduce((a, s) => a + s.value, 0);
  const max = scaleMax && scaleMax > 0 ? scaleMax : total;
  const summary = `${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(', ') || 'no data'}`;

  return (
    <div className="stacked-bar" style={{ height }} role="img" aria-label={summary}>
      {total > 0 && max > 0 ? (
        <div className="stacked-fill" style={{ width: `${Math.min(100, (total / max) * 100)}%` }}>
          {visible.map((s) => (
            <span
              key={s.key}
              className="stacked-seg"
              style={{ flexGrow: s.value, background: s.color }}
              onPointerMove={(e) =>
                show(
                  e.clientX,
                  e.clientY,
                  <>
                    <TipTitle>{label}</TipTitle>
                    {visible.map((v) => (
                      <TipRow key={v.key} color={v.color} label={v.label} value={format(v.value)} />
                    ))}
                    <div className="tip-detail">Total {format(total)}</div>
                  </>,
                )
              }
              onPointerLeave={hide}
            />
          ))}
        </div>
      ) : (
        <span className="stacked-none">—</span>
      )}
      <FloatingTooltip state={tip} />
    </div>
  );
}

export function StackLegend({ items }: { items: { label: string; color: string }[] }): ReactElement {
  return (
    <ul className="chart-legend inline" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="legend-item">
          <span className="legend-rect" style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
