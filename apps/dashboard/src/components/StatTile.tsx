import type { ReactElement, ReactNode } from 'react';
import type { Tone } from '../lib/colors';

export function StatTile({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional status tone: shown as a small marker beside the label, never as text color. */
  tone?: Tone;
  title?: string;
}): ReactElement {
  return (
    <div className="stat-tile" title={title}>
      <div className="stat-label">
        {tone ? <span className={`stat-marker tone-${tone}`} aria-hidden="true" /> : null}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }): ReactElement {
  return <div className="stat-grid">{children}</div>;
}
