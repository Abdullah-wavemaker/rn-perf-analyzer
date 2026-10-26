import type { ReactElement } from 'react';

/** Text-only JSON viewer for untrusted metadata. Never interprets strings. */
export function JsonTree({ value, label, depth = 0, defaultOpenDepth = 2 }: { value: unknown; label?: string; depth?: number; defaultOpenDepth?: number }): ReactElement {
  const keyEl = label !== undefined ? <span className="json-key">{label}: </span> : null;

  if (value === null || value === undefined) {
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-null">{value === null ? 'null' : 'undefined'}</span>
      </div>
    );
  }
  if (typeof value === 'string') {
    const shown = value.length > 2000 ? `${value.slice(0, 2000)}… (${value.length} chars)` : value;
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-str">"{shown}"</span>
      </div>
    );
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-num">{String(value)}</span>
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-bool">{String(value)}</span>
      </div>
    );
  }
  if (typeof value !== 'object') {
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-null">{typeof value}</span>
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).slice(0, 500).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>).slice(0, 500);
  const total = isArr ? (value as unknown[]).length : Object.keys(value as object).length;
  const summary = isArr ? `Array(${total})` : `{${total} ${total === 1 ? 'key' : 'keys'}}`;

  if (total === 0) {
    return (
      <div className="json-line">
        {keyEl}
        <span className="json-null">{isArr ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <details className="json-node" open={depth < defaultOpenDepth}>
      <summary>
        {keyEl}
        <span className="json-summary">{summary}</span>
      </summary>
      <div className="json-children">
        {entries.map(([k, v]) => (
          <JsonTree key={k} label={k} value={v} depth={depth + 1} defaultOpenDepth={defaultOpenDepth} />
        ))}
        {total > entries.length ? <div className="json-line json-null">… {total - entries.length} more</div> : null}
      </div>
    </details>
  );
}
