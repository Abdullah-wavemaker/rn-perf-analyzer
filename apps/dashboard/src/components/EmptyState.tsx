import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon = 'info',
  title,
  children,
  action,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}): ReactElement {
  return (
    <div className={`empty-state${compact ? ' empty-compact' : ''}`}>
      <div className="empty-icon">
        <Icon name={icon} size={compact ? 18 : 24} />
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }): ReactElement {
  return (
    <div className="error-state" role="alert">
      <Icon name="alert" size={16} />
      <span className="error-text">{error}</span>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
