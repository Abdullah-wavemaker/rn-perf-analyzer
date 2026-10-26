import type { ReactElement, ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  href: string;
  badge?: ReactNode;
}

/** Route-driven tab strip (each tab is a link; the URL is the state). */
export function Tabs({ items, active, label }: { items: TabItem[]; active: string; label: string }): ReactElement {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((t) => (
        <a key={t.id} href={t.href} className={`tab${t.id === active ? ' active' : ''}`} aria-current={t.id === active ? 'page' : undefined}>
          {t.label}
          {t.badge !== undefined ? <span className="tab-badge">{t.badge}</span> : null}
        </a>
      ))}
    </nav>
  );
}

/** Local segmented control (state held by the caller). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}): ReactElement {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`segment${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
