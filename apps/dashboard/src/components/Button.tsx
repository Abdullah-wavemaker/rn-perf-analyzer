import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'record';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  const cls = ['btn', `btn-${variant}`, `btn-${size}`, children ? '' : 'btn-icon-only', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children ? <span className="btn-label">{children}</span> : null}
    </button>
  );
}

/** Anchor styled as a button (for downloads / links). */
export function LinkButton({
  href,
  icon,
  children,
  size = 'md',
  download,
  variant = 'default',
  title,
}: {
  href: string;
  icon?: IconName;
  children: ReactNode;
  size?: 'sm' | 'md';
  download?: boolean;
  variant?: 'default' | 'ghost' | 'primary';
  title?: string;
}): ReactElement {
  return (
    <a className={`btn btn-${variant} btn-${size}`} href={href} download={download || undefined} title={title} rel="noopener">
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      <span className="btn-label">{children}</span>
    </a>
  );
}
