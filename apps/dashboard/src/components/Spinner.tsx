import type { ReactElement } from 'react';

export function Spinner({ size = 16, label }: { size?: number; label?: string }): ReactElement {
  return (
    <span className="spinner" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }): ReactElement {
  return (
    <div className="loading-block" role="status">
      <Spinner size={18} />
      <span>{label}</span>
    </div>
  );
}
