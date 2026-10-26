import { useMemo, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { useElementSize } from '../api/hooks';
import { ChartFrame } from './ChartFrame';
import { FloatingTooltip, TipRow, TipTitle, useTooltip } from './Tooltip';
import { hBarPath, linearScale, niceDomain, niceTicks } from './scale';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Extra tooltip line. */
  detail?: string;
}

/**
 * Horizontal bar chart. One series → one color for every bar. With
 * `diverging`, bars extend from a zero baseline: positive = warm pole,
 * negative = cool pole (e.g. memory growth vs release).
 */
export function BarChart({
  title,
  subtitle,
  data,
  format,
  diverging = false,
  color = 'var(--series-1)',
  valueHeader = 'Value',
  maxBars = 20,
  emptyText = 'No data',
  labelWidth = 160,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  data: BarDatum[];
  format: (v: number) => string;
  diverging?: boolean;
  color?: string;
  valueHeader?: string;
  maxBars?: number;
  emptyText?: string;
  labelWidth?: number;
  actions?: ReactNode;
}): ReactElement {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const rows = data.slice(0, maxBars);
  const ROW = 26;
  const BAR = 14;
  const valuePad = 64;
  const height = rows.length * ROW + 24;
  const plotX0 = Math.min(labelWidth, Math.max(80, width * 0.35));
  const plotW = Math.max(0, width - plotX0 - valuePad);

  const geo = useMemo(() => {
    if (rows.length === 0 || plotW <= 0) return null;
    let min = 0;
    let max = 0;
    for (const r of rows) {
      min = Math.min(min, r.value);
      max = Math.max(max, r.value);
    }
    const [d0, d1] = diverging ? niceDomain(min, max, 4) : niceDomain(0, max, 4);
    const xs = linearScale([d0, d1 === d0 ? d0 + 1 : d1], [0, plotW]);
    const ticks = niceTicks(d0, d1, Math.max(2, Math.floor(plotW / 80)));
    return { xs, ticks };
  }, [rows, plotW, diverging]);

  const table = () => (
    <div className="table-wrap table-scroll">
      <table className="data-table dense">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col" className="align-right">
              {valueHeader}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <td>{d.label}</td>
              <td className="align-right num">{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <ChartFrame title={title} subtitle={subtitle} table={data.length ? table : undefined} actions={actions}>
      <div ref={ref} className="chart-plot">
        {rows.length === 0 ? (
          <div className="chart-empty">{emptyText}</div>
        ) : geo ? (
          <svg width={width} height={height} role="img" aria-label={`${title}: ${rows.length} bars`} className="chart-svg">
            {geo.ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={plotX0 + geo.xs(t)} x2={plotX0 + geo.xs(t)} y1={0} y2={height - 20} />
                <text className="axis-text" x={plotX0 + geo.xs(t)} y={height - 6} textAnchor="middle">
                  {format(t)}
                </text>
              </g>
            ))}
            <line className="axis-line" x1={plotX0 + geo.xs(0)} x2={plotX0 + geo.xs(0)} y1={0} y2={height - 20} />
            {rows.map((r, i) => {
              const y = i * ROW + (ROW - BAR) / 2;
              const x0 = plotX0 + geo.xs(0);
              const x1 = plotX0 + geo.xs(r.value);
              const fill = diverging ? (r.value >= 0 ? 'var(--div-pos)' : 'var(--div-neg)') : color;
              const maxChars = Math.max(4, Math.floor((plotX0 - 14) / 6.6));
              const label = r.label.length > maxChars ? `${r.label.slice(0, maxChars - 1)}…` : r.label;
              const onEnter = (e: PointerEvent<SVGGElement> | FocusEvent<SVGGElement>) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = 'clientX' in e ? e.clientX : rect.right;
                const cy = 'clientY' in e ? e.clientY : rect.top;
                show(
                  cx,
                  cy,
                  <>
                    <TipTitle>{r.label}</TipTitle>
                    <TipRow color={fill} label={valueHeader} value={format(r.value)} />
                    {r.detail ? <div className="tip-detail">{r.detail}</div> : null}
                  </>,
                );
              };
              return (
                <g
                  key={r.key}
                  className="bar-row"
                  tabIndex={0}
                  aria-label={`${r.label}: ${format(r.value)}`}
                  onPointerMove={onEnter}
                  onPointerLeave={hide}
                  onFocus={onEnter}
                  onBlur={hide}
                >
                  <rect className="bar-hit" x={0} y={i * ROW} width={width} height={ROW} />
                  <title>{`${r.label}: ${format(r.value)}`}</title>
                  <text className="bar-label" x={plotX0 - 8} y={y + BAR / 2} dy="0.32em" textAnchor="end">
                    {label}
                  </text>
                  <path className="bar-mark" d={hBarPath(x0, x1, y, BAR)} style={{ fill }} />
                  <text
                    className="bar-value"
                    x={r.value >= 0 ? Math.max(x0, x1) + 6 : Math.min(x0, x1) - 6}
                    y={y + BAR / 2}
                    dy="0.32em"
                    textAnchor={r.value >= 0 ? 'start' : 'end'}
                  >
                    {format(r.value)}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}
        {data.length > rows.length ? <div className="chart-footnote">Top {rows.length} of {data.length} shown — see table view for all</div> : null}
      </div>
      <FloatingTooltip state={tip} />
    </ChartFrame>
  );
}
