import type { ReactElement, ReactNode } from 'react';
import type { Severity } from '@rnpa/shared';
import type { Tone } from '../lib/colors';
import { Icon, type IconName } from './Icon';

export function Badge({
  tone = 'neutral',
  children,
  icon,
  dot = false,
  title,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: IconName;
  dot?: boolean;
  title?: string;
  className?: string;
}): ReactElement {
  return (
    <span className={`badge badge-${tone}${className ? ` ${className}` : ''}`} title={title}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: 'critical',
  high: 'serious',
  medium: 'warning',
  low: 'info',
  info: 'neutral',
};
const SEVERITY_ICON: Record<Severity, IconName> = {
  critical: 'alert',
  high: 'alert',
  medium: 'alert',
  low: 'info',
  info: 'info',
};

export function SeverityBadge({ severity }: { severity: Severity }): ReactElement {
  return (
    <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'} icon={SEVERITY_ICON[severity] ?? 'info'} className="badge-severity">
      {severity}
    </Badge>
  );
}

export function SessionStatusBadge({ status }: { status: string }): ReactElement {
  if (status === 'recording')
    return (
      <Badge tone="critical" dot className="badge-live">
        Recording
      </Badge>
    );
  if (status === 'stopped') return <Badge tone="neutral">Stopped</Badge>;
  return <Badge tone="info">Idle</Badge>;
}
