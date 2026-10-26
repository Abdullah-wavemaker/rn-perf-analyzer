import { useState, type ReactElement, type ReactNode } from 'react';

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'line' | 'rect';
}

/**
 * Figure wrapper: title, legend (≥ 2 series), and the table-view twin of the
 * chart (the accessible equivalent, toggled by the reader).
 */
export function ChartFrame({
  title,
  subtitle,
  legend,
  table,
  children,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  table?: () => ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}): ReactElement {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption className="chart-header">
        <div>
          <div className="chart-title">{title}</div>
          {subtitle ? <div className="chart-sub">{subtitle}</div> : null}
        </div>
        <div className="chart-actions">
          {actions}
          {table ? (
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
              <span className="btn-label">{showTable ? 'Chart' : 'Table'}</span>
            </button>
          ) : null}
        </div>
      </figcaption>
      {legend && legend.length >= 2 ? (
        <ul className="chart-legend" aria-label="Legend">
          {legend.map((l) => (
            <li key={l.label} className="legend-item">
              <span className={l.shape === 'rect' ? 'legend-rect' : 'legend-line'} style={{ background: l.color }} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      {showTable && table ? <div className="chart-table">{table()}</div> : children}
    </figure>
  );
}
