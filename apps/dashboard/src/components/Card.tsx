import type { ReactElement, ReactNode } from 'react';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  flush = false,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** No body padding (tables, charts that own their padding). */
  flush?: boolean;
  id?: string;
}): ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ''}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {title || actions ? (
        <header className="card-header">
          <div className="card-heading">
            {title ? <h2 className="card-title">{title}</h2> : null}
            {subtitle ? <p className="card-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'card-body card-body-flush' : 'card-body'}>{children}</div>
    </section>
  );
}
