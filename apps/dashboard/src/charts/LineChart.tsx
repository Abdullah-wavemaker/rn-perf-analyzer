import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { useElementSize } from '../api/hooks';
import { ChartFrame } from './ChartFrame';
import { FloatingTooltip, TipRow, TipTitle, useTooltip } from './Tooltip';
import { decimate, fmtTickOffset, linearScale, nearestIndex, niceDomain, niceTicks, timeStep, timeTicks } from './scale';

export interface LinePoint {
  x: number;
  y: number | null;
}

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  points: LinePoint[];
}

export interface RefLine {
  y: number;
  label: string;
}

export interface LineChartProps {
  title: string;
  subtitle?: ReactNode;
  series: LineSeries[];
  /** Time origin; x axis shows offsets from it. */
  origin: number;
  yFormat: (v: number) => string;
  /** Short unit suffix for axis ticks (e.g. "fps"). */
  yTickFormat?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  refLines?: RefLine[];
  height?: number;
  emptyText?: string;
  actions?: ReactNode;
  /** Soft area wash under a single series. */
  area?: boolean;
}

const M = { top: 12, right: 16, bottom: 24, left: 52 };

export function LineChart({
  title,
  subtitle,
  series,
  origin,
  yFormat,
  yTickFormat,
  yMin,
  yMax,
  refLines = [],
  height = 220,
  emptyText = 'No samples recorded',
  actions,
  area = false,
}: LineChartProps): ReactElement {
  const [wrapRef, { width }] = useElementSize<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const [hoverX, setHoverX] = useState<number | null>(null);

  const nonEmpty = useMemo(
    () =>
      series
        .map((s) => ({ ...s, points: s.points.filter((p) => Number.isFinite(p.x)).sort((a, b) => a.x - b.x) }))
        .filter((s) => s.points.some((p) => p.y !== null)),
    [series],
  );

  const extent = useMemo(() => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of nonEmpty)
      for (const p of s.points) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y !== null) {
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
        }
      }
    for (const r of refLines) {
      y0 = Math.min(y0, r.y);
      y1 = Math.max(y1, r.y);
    }
    if (!Number.isFinite(x0)) return null;
    if (x0 === x1) x1 = x0 + 1000;
    const [ny0, ny1] = niceDomain(yMin ?? Math.min(0, y0), yMax ?? y1, 4);
    return { x0, x1, y0: yMin ?? ny0, y1: yMax ?? ny1 };
  }, [nonEmpty, refLines, yMin, yMax]);

  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;

  const geo = useMemo(() => {
    if (!extent || plotW <= 0) return null;
    const xs = linearScale([extent.x0, extent.x1], [0, plotW]);
    const ys = linearScale([extent.y0, extent.y1], [plotH, 0]);
    const paths = nonEmpty.map((s) => {
      const pts = decimate(s.points, extent.x0, extent.x1, Math.max(1, Math.floor(plotW)));
      let d = '';
      let pen = false;
      let firstX: number | null = null;
      let lastX: number | null = null;
      for (const p of pts) {
        if (p.y === null) {
          pen = false;
          continue;
        }
        const px = xs(p.x).toFixed(1);
        const py = ys(Math.min(extent.y1, Math.max(extent.y0, p.y))).toFixed(1);
        d += `${pen ? 'L' : 'M'}${px},${py}`;
        pen = true;
        if (firstX === null) firstX = xs(p.x);
        lastX = xs(p.x);
      }
      const areaD = area && firstX !== null && lastX !== null ? `${d}L${lastX.toFixed(1)},${plotH}L${firstX.toFixed(1)},${plotH}Z` : null;
      return { id: s.id, color: s.color, d, areaD };
    });
    const tickTarget = Math.max(2, Math.floor(plotW / 90));
    const xTicks = timeTicks(extent.x0, extent.x1, tickTarget, origin);
    const xStep = timeStep(extent.x1 - extent.x0, tickTarget);
    const yTicks = niceTicks(extent.y0, extent.y1, 4);
    return { xs, ys, paths, xTicks, xStep, yTicks };
  }, [extent, plotW, plotH, nonEmpty, origin, area]);

  /** Readout at a data-x: nearest sample per series. */
  const readout = (x: number) =>
    nonEmpty.map((s) => {
      const i = nearestIndex(s.points, x, (p) => p.x);
      const p = s.points[i];
      return { s, p };
    });

  const showAt = (x: number, clientX: number, clientY: number) => {
    if (!geo || !extent) return;
    const rows = readout(x);
    // Snap the crosshair to the nearest actual sample.
    let snap = x;
    let best = Infinity;
    for (const r of rows) if (r.p && Math.abs(r.p.x - x) < best) {
      best = Math.abs(r.p.x - x);
      snap = r.p.x;
    }
    setHoverX(snap);
    show(
      clientX,
      clientY,
      <>
        <TipTitle>{fmtTickOffset(snap - origin, 1)}</TipTitle>
        {rows.map(({ s, p }) => (
          <TipRow key={s.id} color={s.color} label={s.label} value={p && p.y !== null ? yFormat(p.y) : '—'} />
        ))}
      </>,
    );
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    showAt(geo.xs.invert(e.clientX - rect.left), e.clientX, e.clientY);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!geo || !extent) return;
    const base = nonEmpty[0]?.points ?? [];
    if (base.length === 0) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hoverX === null ? -1 : nearestIndex(base, hoverX, (p) => p.x);
    const next = Math.min(base.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    const p = base[next];
    if (!p) return;
    const r = e.currentTarget.getBoundingClientRect();
    showAt(p.x, r.left + M.left + geo.xs(p.x), r.top + M.top + 20);
  };

  const legend = nonEmpty.map((s) => ({ label: s.label, color: s.color, shape: 'line' as const }));

  const table = () => {
    const base = nonEmpty[0]?.points ?? [];
    const rows = base.filter((p) => p.y !== null).slice(0, 500);
    return (
      <div className="table-wrap table-scroll">
        <table className="data-table dense">
          <thead>
            <tr>
              <th scope="col">Time</th>
              {nonEmpty.map((s) => (
                <th key={s.id} scope="col" className="align-right">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.x}>
                <td className="mono">{fmtTickOffset(p.x - origin, 1)}</td>
                {nonEmpty.map((s) => {
                  const q = s.points[nearestIndex(s.points, p.x, (pp) => pp.x)];
                  return (
                    <td key={s.id} className="align-right num">
                      {q && q.y !== null ? yFormat(q.y) : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={nonEmpty.length ? table : undefined} actions={actions}>
      <div ref={wrapRef} className="chart-plot" style={{ height }}>
        {nonEmpty.length === 0 || !extent ? (
          <div className="chart-empty">{emptyText}</div>
        ) : geo ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}. ${nonEmpty.map((s) => s.label).join(', ')} over time. Use left and right arrow keys to read values.`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => {
              hide();
              setHoverX(null);
            }}
            className="chart-svg"
          >
            <g transform={`translate(${M.left},${M.top})`}>
              {geo.yTicks.map((t) => (
                <g key={t}>
                  <line className="grid-line" x1={0} x2={plotW} y1={geo.ys(t)} y2={geo.ys(t)} />
                  <text className="axis-text" x={-8} y={geo.ys(t)} dy="0.32em" textAnchor="end">
                    {(yTickFormat ?? yFormat)(t)}
                  </text>
                </g>
              ))}
              <line className="axis-line" x1={0} x2={plotW} y1={plotH} y2={plotH} />
              {geo.xTicks.map((t) => (
                <text key={t} className="axis-text" x={geo.xs(t)} y={plotH + 16} textAnchor="middle">
                  {fmtTickOffset(t - origin, geo.xStep)}
                </text>
              ))}
              {refLines.map((r) =>
                r.y >= (extent?.y0 ?? 0) && r.y <= (extent?.y1 ?? 0) ? (
                  <g key={r.label}>
                    <line className="ref-line" x1={0} x2={plotW} y1={geo.ys(r.y)} y2={geo.ys(r.y)} />
                    <text className="ref-text" x={plotW - 4} y={geo.ys(r.y) - 4} textAnchor="end">
                      {r.label}
                    </text>
                  </g>
                ) : null,
              )}
              {geo.paths.map((p) =>
                p.areaD ? <path key={`${p.id}-area`} d={p.areaD} className="series-area" style={{ fill: p.color }} /> : null,
              )}
              {geo.paths.map((p) => (
                <path key={p.id} d={p.d} className="series-line" style={{ stroke: p.color }} />
              ))}
              {hoverX !== null ? (
                <>
                  <line className="crosshair" x1={geo.xs(hoverX)} x2={geo.xs(hoverX)} y1={0} y2={plotH} />
                  {readout(hoverX).map(({ s, p }) =>
                    p && p.y !== null ? (
                      <circle key={s.id} className="hover-dot" cx={geo.xs(p.x)} cy={geo.ys(p.y)} r={4} style={{ fill: s.color }} />
                    ) : null,
                  )}
                </>
              ) : null}
              <rect
                className="hit-layer"
                x={0}
                y={0}
                width={plotW}
                height={plotH}
                onPointerMove={onMove}
                onPointerLeave={() => {
                  hide();
                  setHoverX(null);
                }}
              />
            </g>
          </svg>
        ) : null}
      </div>
      <FloatingTooltip state={tip} />
    </ChartFrame>
  );
}
